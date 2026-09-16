/**
 * Who is allowed to run compiled code on this machine, and what they were told.
 *
 * ── The two gates, and why one is not enough ─────────────────────────────────
 *
 * A native plugin is unsandboxed code. Not "unsandboxed" in the sense the
 * renderer-realm tier means it — that code is at least confined to a browser
 * process — but a real OS process with the user's own privileges: their files,
 * their network, their keychain if they ask for it. The Worker permission list
 * governs a boundary that does not exist here, so it governs nothing here.
 *
 * Two independent things therefore have to be true:
 *
 *   1. **Provenance.** A valid signature over the package's bytes, checked on
 *      this machine, against a key. Or — for an author's own working copy —
 *      Developer Mode, which is the user saying "this is mine" about a folder
 *      they put there themselves.
 *   2. **Consent, worded for what it is.** A separate step that names the
 *      binary, names its hash, and says the sentence: this runs outside the
 *      sandbox with your full privileges. It is never implied by the ordinary
 *      permission list, never inferred from an install, and never granted by
 *      anything except a person answering this question.
 *
 * Neither substitutes for the other. A signature says WHO wrote it, which is
 * worth a great deal and says nothing about what it does. A consent click with
 * no signature says the user agreed to run something that could have been
 * replaced in transit. This is the shape every host that ships native plugins
 * converges on, and the shape AE does not have — its plugins are trusted
 * because they were installed by an installer the user ran, which is a gate
 * made of social convention.
 *
 * ── Why the HASH is pinned ───────────────────────────────────────────────────
 *
 * Because the thing consented to is a specific binary, and a folder plugin's
 * binary is a file on disk that anything on the machine can replace. Version
 * numbers are written by the author; a hash is written by the bytes. Pinning it
 * means "you agreed to THIS code" survives a swap that keeps the version
 * string, which is the only form of this attack worth writing.
 *
 * A changed hash re-asks. It does not silently refuse, and it does not silently
 * allow: an author rebuilding their addon between reloads is the common case,
 * and Developer Mode keeps that to one click per build rather than making it
 * free.
 *
 * ── Revocation ───────────────────────────────────────────────────────────────
 *
 * A revoked plugin's process is killed and its consent is dropped. That is the
 * one decision in this file that is not the user's: a revocation is the
 * operator saying this specific version is known-bad, and a running process of
 * known-bad native code is the exact thing the list exists to stop. See
 * `killNativeConsent`, which the revocation path calls.
 *
 * Persisted in `localStorage`, beside the Developer Mode switch, rather than in
 * the plugin store — this is read while deciding whether to LAUNCH a process,
 * from the main-process bridge path, before any React store has hydrated.
 */

import { isRevoked } from '../revocation';
import type { NativeRefusal } from './nativeAbi';
import type { NativeSelection } from './nativePlatforms';

const KEY = 'motion-editor.plugins.nativeConsent';

/** A recorded decision to run one specific compiled binary. */
export interface NativeConsent {
  /** Epoch ms. Shown to the user, and what makes the record auditable. */
  at: number;
  /** The plugin version that was on disk when consent was given. */
  version: string;
  /** `win32-x64` — consent is per binary, and a binary is per platform. */
  platformKey: string;
  /** Package-relative path to the binary consented to. */
  binaryPath: string;
  /** SHA-256 hex of the bytes. The pin. */
  sha256: string;
  /** How provenance was established at the time. */
  basis: 'signed' | 'developer';
  /** SPKI base64 of the signing key, when there was one. */
  publisherKey?: string;
}

type ConsentMap = Record<string, NativeConsent>;

let cache: ConsentMap | null = null;
const listeners = new Set<() => void>();

function read(): ConsentMap {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    cache = (parsed && typeof parsed === 'object' ? parsed : {}) as ConsentMap;
  } catch {
    // Storage blocked, or a record written by a build that stored something
    // else. Empty is the safe answer everywhere in this file: the failure mode
    // is one extra prompt, and the alternative failure mode is compiled code
    // running because a `JSON.parse` threw.
    cache = {};
  }
  return cache;
}

function write(next: ConsentMap): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* the session still behaves; only the survival is lost */ }
  for (const fn of [...listeners]) fn();
}

export function subscribeNativeConsent(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getNativeConsent(pluginId: string): NativeConsent | null {
  return read()[pluginId] ?? null;
}

/** Record that the user agreed, for exactly these bytes. */
export function recordNativeConsent(pluginId: string, consent: NativeConsent): void {
  write({ ...read(), [pluginId]: consent });
}

/**
 * Drop a plugin's consent.
 *
 * Called on revocation, on uninstall, and from the plugin's own row in the UI.
 * Dropping the record does not by itself stop a running process — the caller
 * unloads it — but it does mean nothing starts one again without asking.
 */
export function killNativeConsent(pluginId: string): void {
  const map = read();
  if (!(pluginId in map)) return;
  const next = { ...map };
  delete next[pluginId];
  write(next);
}

/** Test seam. Never called by the app. */
export function resetNativeConsentForTests(): void {
  cache = {};
  listeners.clear();
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

/** What a consent record is compared against, once a binary has been selected. */
export interface NativeConsentSubject {
  version: string;
  platformKey: string;
  binaryPath: string;
  /** The hash of the bytes ON DISK, not the one the manifest claims. */
  sha256: string;
}

/**
 * Does the user have to be asked before this binary runs?
 *
 * Any of four changes re-asks, and each one is a different binary from the one
 * that was agreed to: a new plugin, a different file, different BYTES in the
 * same file, or the same plugin on a different platform (where the binary is a
 * different build with different code in it).
 *
 * The version alone deliberately does NOT re-ask when the hash is unchanged —
 * a version bump that ships the identical binary is a manifest edit, and
 * prompting for it trains people to click through the prompt that matters.
 */
export function needsNativeConsent(
  consent: NativeConsent | null,
  subject: NativeConsentSubject,
): boolean {
  if (!consent) return true;
  if (consent.sha256 !== subject.sha256) return true;
  if (consent.binaryPath !== subject.binaryPath) return true;
  if (consent.platformKey !== subject.platformKey) return true;
  return false;
}

export interface NativeTrustInput {
  pluginId: string;
  pluginName: string;
  version: string;
  /** The result of `selectNativeBinary`, so this cannot be asked out of order. */
  selection: NativeSelection;
  /** The hash of the bytes on disk. Absent until the host has read them. */
  sha256?: string;
  /** C1's `.sig` verdict for the package. Null when there is no signature. */
  signature: { ok: boolean; publisherKey?: string; reason?: string } | null;
  developerMode: boolean;
  /** Injected so the decision is testable without seeding a revocation list. */
  revoked?: boolean;
}

export type NativeTrustVerdict =
  | { allowed: true; basis: 'signed' | 'developer'; consented: true }
  | { allowed: false; code: NativeRefusal; error: string; askable: boolean };

/**
 * May this plugin's binary be launched right now?
 *
 * The order of the checks is the order in which their answers stop mattering.
 * A revoked plugin is not asked about; a package with no binary for this
 * machine is not asked about; an unsigned package outside Developer Mode is not
 * asked about. Only what survives all three is a question worth putting to a
 * person — which is what `askable` marks, so the UI knows whether to offer the
 * consent sheet or only to explain.
 */
export function nativeTrustVerdict(input: NativeTrustInput): NativeTrustVerdict {
  const revoked = input.revoked ?? isRevoked(input.pluginId, input.version);
  if (revoked) {
    return {
      allowed: false,
      code: 'revoked',
      error: `${input.pluginName} ${input.version} has been revoked. Its native module will not run.`,
      askable: false,
    };
  }

  if (!input.selection.ok) {
    return {
      allowed: false,
      code: input.selection.code,
      error: input.selection.error,
      askable: false,
    };
  }

  const signed = input.signature?.ok === true;
  if (!signed && !input.developerMode) {
    return {
      allowed: false,
      code: 'not-signed',
      error: input.signature
        ? `The signature on ${input.pluginName} does not match its bytes `
          + `(${input.signature.reason ?? 'unknown reason'}), so its native module will not run.`
        : `${input.pluginName} ships a native module and is not signed. Compiled code runs `
          + 'outside the sandbox, so it loads only from a signed package — or from your own '
          + 'folder with Developer Mode on.',
      askable: false,
    };
  }

  if (!input.sha256) {
    // The host reads the bytes and hashes them; being here without one means
    // the caller asked before the file existed. Refusing is the only honest
    // answer — consent is pinned to a hash, and there is nothing to pin to.
    return {
      allowed: false,
      code: 'missing-binary',
      error: `${input.pluginName}'s native module could not be read.`,
      askable: false,
    };
  }

  const consent = getNativeConsent(input.pluginId);
  const subject: NativeConsentSubject = {
    version: input.version,
    platformKey: input.selection.key,
    binaryPath: input.selection.path,
    sha256: input.sha256,
  };
  if (needsNativeConsent(consent, subject)) {
    return {
      allowed: false,
      code: 'no-consent',
      error: consent
        ? `${input.pluginName}'s native module has changed since you allowed it. It has to be allowed again.`
        : `${input.pluginName} has not been allowed to run its native module.`,
      askable: true,
    };
  }

  return { allowed: true, basis: signed ? 'signed' : 'developer', consented: true };
}

/** A short hash, for a sentence a person reads. Full one stays in the record. */
export function shortHash(sha256: string): string {
  return sha256.length > 16 ? `${sha256.slice(0, 8)}…${sha256.slice(-8)}` : sha256;
}

/**
 * The sentence the consent step asks, and it is deliberately not the permission
 * screen's.
 *
 * The permission screen enumerates, because the set is bounded and each line is
 * a real choice. There is no bounded set here. So this names the one thing that
 * is specific — WHICH FILE, by path and by hash — and then says plainly that
 * nothing limits it. A list would read as "these six things" when the truth is
 * "everything", and a user who has agreed to six things has agreed to something
 * they can reason about.
 *
 * The provenance clause is separate and last, because it is the part that
 * differs between a signed package and the author's own folder, and a reader
 * comparing the two prompts should see one changed sentence rather than two
 * different screens.
 */
export function nativeConsentSummary(opts: {
  pluginName: string;
  binaryPath: string;
  sha256: string;
  platformKey: string;
  basis: 'signed' | 'developer';
  publisher?: string;
}): string {
  const provenance = opts.basis === 'signed'
    ? `The package is signed${opts.publisher ? ` by ${opts.publisher}` : ''}, which proves who built it — not what it does.`
    : 'The package is NOT signed. It is running because Developer Mode is on, which means nothing has vouched for these bytes but you.';
  return (
    `${opts.pluginName} wants to run a compiled program on your computer: `
    + `${opts.binaryPath} (${opts.platformKey}, sha256 ${shortHash(opts.sha256)}). `
    + 'It runs OUTSIDE the plugin sandbox, in a separate process, with your full user privileges — '
    + 'it can read and change your files, reach the network, and use your machine however it likes. '
    + 'The plugin permission list does not limit it. '
    + `${provenance} `
    + 'If this binary is replaced or updated, you will be asked again.'
  );
}
