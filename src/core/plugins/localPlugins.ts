/**
 * Plugins that live in a folder on this machine, as the renderer sees them.
 *
 * The main process finds them and reads their bytes (`electron/pluginLoader.ts`);
 * everything that DECIDES anything is here, because every decision needs things
 * the main process does not have: the manifest grammar, the capability table,
 * the revocation list, what the user already granted, and what the user
 * installed from somewhere else under the same id.
 *
 * Four questions, in order, and they are separate on purpose:
 *
 *   1. **Is it a plugin?** `plugin.json` parses, and the manifest validates.
 *   2. **Which copy wins?** Two folders can hold the same id — a machine-wide
 *      install and a newer one the user dropped in their own folder. Highest
 *      VERSION wins, and the loser is named rather than silently ignored.
 *   3. **May it run?** Signed archives may. Anything unsigned needs Developer
 *      mode, which is the whole reason that switch exists.
 *   4. **Does the user have to be asked?** New id, wider permissions, or a
 *      change of runtime tier → the consent screen. An unchanged reload → no,
 *      because an author saving a file twenty times must not be asked twenty
 *      times, and nothing about what the plugin may do has changed.
 *
 * Nothing here runs plugin code. It produces candidates and decisions; the UI
 * raises consent and calls `pluginHost.install`.
 */

import type {
  DiscoveredLocalPlugin,
  PluginSearchPathInfo,
} from '@app-types/motionEditor';
import { parseManifest, type PluginManifest, type PluginPermission } from './manifest';
import {
  LOCAL_LIMITS,
  readPluginPayload,
  readPluginZip,
  type PluginPackage,
} from './pluginPackage';
import { nativeHashesFrom } from './native/nativeInstall';
import { verifyPackageSignature } from './registry';
import { developerModeEnabled } from './developerMode';
import type { InstalledPlugin } from '@stores/pluginStore';

/** The bridge, or null in the browser build where there is no filesystem. */
function bridge(): NonNullable<Window['motionEditor']>['plugins'] | null {
  return (typeof window === 'undefined' ? null : window.motionEditor?.plugins) ?? null;
}

export function localPluginsAvailable(): boolean {
  return bridge() !== null;
}

/** How a candidate's signature came out. `null` means there was none. */
export interface LocalSignature {
  ok: boolean;
  /** SPKI base64 of the key it verified against. Only set when `ok`. */
  publisherKey?: string;
  /** Why it failed, when it did. */
  reason?: string;
}

export interface LocalPluginCandidate extends DiscoveredLocalPlugin {
  /** Null when the manifest is missing or invalid — see `problems`. */
  manifest: PluginManifest | null;
  problems: string[];
  signature: LocalSignature | null;
}

/** Everything the panel needs, in one object. */
export interface LocalPluginState {
  available: boolean;
  scanning: boolean;
  paths: PluginSearchPathInfo[];
  /** The winners, in scan order. */
  plugins: LocalPluginCandidate[];
  /** Same-id collisions, so the UI can say which copy it is ignoring. */
  conflicts: Array<{ id: string; kept: string; ignored: string[]; keptVersion: string }>;
  /** Candidates that are not usable at all (no manifest, unreadable). */
  broken: LocalPluginCandidate[];
  error: string | null;
}

const EMPTY: LocalPluginState = {
  available: false,
  scanning: false,
  paths: [],
  plugins: [],
  conflicts: [],
  broken: [],
  error: null,
};

let state: LocalPluginState = { ...EMPTY };
const listeners = new Set<() => void>();

export function getLocalPluginState(): LocalPluginState {
  return state;
}

export function subscribeLocalPlugins(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function set(next: Partial<LocalPluginState>): void {
  state = { ...state, ...next };
  for (const fn of [...listeners]) fn();
}

// ── Pure decisions ─────────────────────────────────────────────────────────

/**
 * Compare two semver-ish versions numerically, segment by segment.
 *
 * String comparison is the bug this exists to avoid: `"10.0.0" < "9.0.0"` is
 * true as text and false as a version, which would make an update lose to the
 * copy it replaced. A pre-release suffix (`1.2.0-beta`) sorts BELOW the release
 * it precedes, which is what semver says and what an author expects when they
 * leave a beta in one folder and a release in another.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const [core = '', pre = ''] = v.split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  const len = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < len; i += 1) {
    const d = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * Pick one copy per id.
 *
 * By version, never by which directory was scanned first. Search-path order is
 * an implementation detail nobody can predict from outside, and "the newest one
 * wins" is a rule an author can act on — drop a newer build in your own folder
 * and it takes over from the machine-wide one, which is exactly the shape of
 * every override anyone has ever wanted.
 *
 * A tie is broken by the earlier search path, which is the env override, then
 * the user's folder, then machine-wide. Same version, two files: the more
 * specific location is the one the person meant.
 */
export function resolveConflicts(candidates: readonly LocalPluginCandidate[]): {
  plugins: LocalPluginCandidate[];
  conflicts: LocalPluginState['conflicts'];
} {
  const byId = new Map<string, LocalPluginCandidate[]>();
  for (const c of candidates) {
    if (!c.manifest) continue;
    const list = byId.get(c.manifest.id);
    if (list) list.push(c);
    else byId.set(c.manifest.id, [c]);
  }

  const plugins: LocalPluginCandidate[] = [];
  const conflicts: LocalPluginState['conflicts'] = [];
  for (const [id, list] of byId) {
    let winner = list[0]!;
    for (const c of list.slice(1)) {
      if (compareVersions(c.manifest!.version, winner.manifest!.version) > 0) winner = c;
    }
    plugins.push(winner);
    if (list.length > 1) {
      conflicts.push({
        id,
        kept: winner.path,
        keptVersion: winner.manifest!.version,
        ignored: list.filter((c) => c !== winner).map((c) => c.path),
      });
    }
  }
  return { plugins, conflicts };
}

/** Why a candidate may or may not be loaded right now. */
export type LoadVerdict =
  | { allowed: true; trust: 'signed' | 'developer' }
  | { allowed: false; reason: string };

/**
 * The trust gate.
 *
 * A signed archive is allowed on its signature alone, which is the same
 * evidence a registry install rests on — the bytes were checked here, against a
 * key, before anything was read out of them. Everything else is unsigned code
 * from the filesystem, and the only thing that can vouch for it is the user,
 * once, through Developer mode.
 *
 * The refusal names the switch, because "this plugin did not load" with no
 * reason is the report this whole tier would otherwise generate.
 */
export function loadVerdict(
  candidate: LocalPluginCandidate,
  developerMode = developerModeEnabled(),
): LoadVerdict {
  if (!candidate.manifest) return { allowed: false, reason: candidate.problems.join(' ') || 'Not a plugin.' };
  if (candidate.signature?.ok) return { allowed: true, trust: 'signed' };
  if (developerMode) return { allowed: true, trust: 'developer' };
  if (candidate.signature && !candidate.signature.ok) {
    return {
      allowed: false,
      reason: `Signature check failed (${candidate.signature.reason ?? 'unknown reason'}). This package was not loaded.`,
    };
  }
  return {
    allowed: false,
    reason: 'Unsigned — enable Developer Mode to load plugins from a folder.',
  };
}

/** Whether the user has to be asked before this copy runs. */
export type ConsentNeed = 'none' | 'new' | 'permissions' | 'tier' | 'publisher';

/**
 * Does this candidate need the consent screen?
 *
 * The rule that matters is the third one. Permissions are granted against a
 * manifest, and a folder plugin's manifest is a file its author edits between
 * one reload and the next — so "it was allowed to read my layers yesterday"
 * cannot authorise "it may reach the network today". A wider set re-asks, a
 * narrower one does not (nothing new is being granted), and an unchanged one
 * reloads silently so an edit/run loop stays a loop.
 *
 * `tier` is the escalation `runtimeTier.ts` exists to make impossible by
 * accident: a package that was sandboxed and becomes `runtime: "native"` must
 * ask again, whatever it was granted before.
 *
 * `publisher` is the local half of trust-on-first-use. A signed package whose
 * key is not the one this machine pinned for that id is not an update — it is a
 * different author claiming the same name.
 */
export function consentNeed(
  manifest: PluginManifest,
  existing: InstalledPlugin | undefined,
  signature: LocalSignature | null,
): ConsentNeed {
  if (!existing) return 'new';
  if ((existing.manifest.runtime ?? 'sandboxed') !== (manifest.runtime ?? 'sandboxed')) return 'tier';
  if (existing.publisherKey && signature?.ok && signature.publisherKey !== existing.publisherKey) {
    return 'publisher';
  }
  const granted = new Set<PluginPermission>(existing.granted);
  if (manifest.permissions.some((p) => !granted.has(p))) return 'permissions';
  return 'none';
}

// ── Reading ────────────────────────────────────────────────────────────────

interface SignatureFile {
  signature?: unknown;
  publicKey?: unknown;
}

/**
 * Check `<archive>.sig` against the archive's bytes.
 *
 * The same ECDSA P-256 / SHA-256 over the same exact bytes the registry signs,
 * through the same verifier — `scripts/pack-plugin.mjs --key` and
 * `scripts/sign-plugin.mjs sign` produce interchangeable signatures. What is
 * missing locally, and cannot be supplied, is the registry's trust-on-first-use
 * pin, so the key itself is only evidence of "the same author as last time"
 * once something has pinned it. `consentNeed` is where that lands.
 */
export async function checkLocalSignature(
  bytes: Uint8Array,
  signatureText: string | undefined,
): Promise<LocalSignature | null> {
  if (!signatureText) return null;
  let parsed: SignatureFile;
  try {
    parsed = JSON.parse(signatureText) as SignatureFile;
  } catch {
    return { ok: false, reason: 'the .sig file is not valid JSON' };
  }
  const { signature, publicKey } = parsed;
  if (typeof signature !== 'string' || typeof publicKey !== 'string') {
    return { ok: false, reason: 'the .sig file has no signature or public key' };
  }
  const ok = await verifyPackageSignature(bytes, signature, publicKey);
  return ok ? { ok: true, publisherKey: publicKey } : { ok: false, reason: 'the signature does not match these bytes' };
}

/**
 * Read one candidate into an installable package.
 *
 * The bytes were already bounded while they were read (`pluginLoader.ts`), and
 * they are bounded again here — see `readPluginPayload` for why both.
 */
export async function loadLocalPackage(
  candidate: LocalPluginCandidate,
): Promise<{
  pkg: PluginPackage | null;
  errors: string[];
  signature: LocalSignature | null;
  /**
   * Where a FOLDER's compiled modules are and what they hash to.
   *
   * Absent for an archive, whose binary is not a file yet — it is staged at
   * install time, from the bytes in the package. Absent too for a folder that
   * declared none, which is every plugin published so far. Carried out of here
   * rather than re-read at install time because the scan already measured the
   * hashes and re-hashing a 40 MB addon to learn what it just learnt is a
   * second read of the same file.
   */
  native?: { dir: string; hashes: Record<string, string> };
}> {
  const api = bridge();
  if (!api) return { pkg: null, errors: ['This build cannot read plugins from folders.'], signature: null };

  const read = await api.read(candidate.path);
  if (!read.ok) return { pkg: null, errors: [read.error ?? 'Could not read the package.'], signature: null };

  if (read.kind === 'archive') {
    const bytes = read.bytes ?? new Uint8Array();
    const signature = await checkLocalSignature(bytes, candidate.signatureText);
    const result = readPluginZip(bytes, LOCAL_LIMITS);
    return { ...result, signature };
  }

  const result = readPluginPayload(read.files ?? {}, read.binaries ?? {}, LOCAL_LIMITS);
  const hashes = nativeHashesFrom(read);
  return {
    ...result,
    signature: null,
    ...(Object.keys(hashes).length > 0 ? { native: { dir: candidate.path, hashes } } : {}),
  };
}

// ── Scanning ───────────────────────────────────────────────────────────────

/**
 * Turn one scan result into a candidate.
 *
 * A folder is described by its `plugin.json` alone, which is all the scan read.
 * An archive has to be opened to be described at all — its manifest is inside
 * the zip — so this reads it, which is also when the signature can be checked.
 * That makes an archive more expensive to LIST than a folder; the alternative
 * was a list that cannot show an archive's name, which is not a list.
 */
async function describe(found: DiscoveredLocalPlugin): Promise<LocalPluginCandidate> {
  const base: LocalPluginCandidate = { ...found, manifest: null, problems: [], signature: null };
  if (found.error) return { ...base, problems: [found.error] };

  if (found.kind === 'folder') {
    if (found.manifestText === null) return { ...base, problems: ['No plugin.json could be read.'] };
    let raw: unknown;
    try {
      raw = JSON.parse(found.manifestText);
    } catch (err) {
      return { ...base, problems: [`plugin.json is not valid JSON: ${(err as Error).message}`] };
    }
    const { manifest, errors } = parseManifest(raw);
    return manifest ? { ...base, manifest } : { ...base, problems: errors };
  }

  const loaded = await loadLocalPackage(base);
  return {
    ...base,
    manifest: loaded.pkg?.manifest ?? null,
    problems: loaded.errors,
    signature: loaded.signature,
  };
}

/** Scan every configured folder and publish the result. */
export async function refreshLocalPlugins(): Promise<LocalPluginState> {
  const api = bridge();
  if (!api) {
    set({ ...EMPTY, available: false });
    return state;
  }

  set({ available: true, scanning: true, error: null });
  try {
    const [paths, found] = await Promise.all([api.paths(), api.scan()]);
    const candidates = await Promise.all(found.map(describe));
    const usable = candidates.filter((c) => c.manifest !== null);
    const broken = candidates.filter((c) => c.manifest === null);
    const { plugins, conflicts } = resolveConflicts(usable);
    set({ scanning: false, paths, plugins, conflicts, broken, error: null });
  } catch (err) {
    set({ scanning: false, error: (err as Error).message });
  }
  return state;
}

/** Open the user's plugins folder in the file manager, creating it if needed. */
export async function openPluginsFolder(): Promise<string | null> {
  const api = bridge();
  if (!api) return 'This build has no plugins folder.';
  const result = await api.openFolder();
  return result.ok ? null : (result.error ?? 'The folder could not be opened.');
}

/**
 * Watch the folders while developer mode is on, and re-scan on a change.
 *
 * Returns an unsubscribe. The watch itself lives in the main process — this
 * only asks for it, and asks for it to stop, so a user who turns developer mode
 * off is not left with a recursive filesystem watch running for the session.
 */
export function watchLocalPlugins(onChange: () => void): () => void {
  const api = bridge();
  if (!api) return () => {};
  const off = api.onChanged(onChange);
  void api.watch(true);
  return () => {
    off();
    void api.watch(false);
  };
}
