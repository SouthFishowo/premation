/**
 * Getting a package's compiled module to a place it can be loaded from.
 *
 * Two shapes arrive and only one of them is already a file:
 *
 *   **A folder** is a directory on disk. Its binary is loaded where it lies,
 *   and the scanner already measured every declared one's SHA-256 while it was
 *   reading the package (`pluginLoader.ts`). Nothing to do.
 *
 *   **An archive** is a `.mplugin` — a zip. A file inside a zip cannot be
 *   `require`d, so the binary is written out first, into
 *   `userData/PluginNative/<id>/<sha256>/<name>`. The hash names the directory
 *   rather than merely being checked against it, which gives two properties
 *   worth having for free: identical bytes stage once, and a rebuilt binary
 *   lands somewhere new instead of overwriting a file the operating system may
 *   still have mapped into a process.
 *
 * Only the binary for THIS machine is staged. A package supporting four
 * platforms would otherwise write four copies of a 40 MB addon into a user's
 * profile, three of which can never run there.
 */

import type { PluginManifest } from '../manifest';
import { nativePlatformKey, selectNativeBinary } from './nativePlatforms';

type Bridge = NonNullable<Window['motionEditor']>['pluginNative'];

function bridge(): Bridge | null {
  return (typeof window === 'undefined' ? null : window.motionEditor?.pluginNative) ?? null;
}

/** `{ path → sha256 }` out of a folder read. Empty for an archive, or for a
 *  package with no declared binaries — both of which are the common case. */
export function nativeHashesFrom(read: { native?: Array<{ path: string; sha256: string }> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of read.native ?? []) out[entry.path] = entry.sha256;
  return out;
}

export interface StagedNative {
  /** The directory to load from — the staging dir for an archive. */
  dir: string;
  /** `{ package-relative path → sha256 }`, as this machine measured them. */
  hashes: Record<string, string>;
  error?: string;
}

/**
 * Write an archive's binary for this platform, and report what was written.
 *
 * `binaries` is the map the zip reader produced. The hash is computed HERE
 * rather than taken from the manifest, and the main process computes it a third
 * time before writing: the manifest's copy is the author's claim, this one is
 * what the package actually contains, and main's is what landed on disk. They
 * have to agree, and each is measured by a different party.
 */
export async function stageNativeBinary(
  manifest: PluginManifest,
  binaries: Record<string, Uint8Array>,
): Promise<StagedNative | null> {
  const api = bridge();
  if (!api || !manifest.native) return null;

  const selection = selectNativeBinary(manifest.native, api.platform, api.arch);
  if (!selection.ok) return { dir: '', hashes: {}, error: selection.error };

  const bytes = binaries[selection.path];
  if (!bytes) {
    return {
      dir: '',
      hashes: {},
      error: `This package declares ${selection.path} and does not contain it.`,
    };
  }

  const sha256 = await sha256Hex(bytes);
  const staged = await api.stage({
    pluginId: manifest.id,
    version: manifest.version,
    relPath: selection.path,
    bytes,
    sha256,
  });
  if (!staged.ok || !staged.dir) {
    return { dir: '', hashes: {}, error: staged.error ?? 'The native module could not be staged.' };
  }

  /*
    The staged file sits at `<dir>/<basename>`, not at `<dir>/<relPath>`.

    A path inside a zip is the author's directory layout and has no meaning once
    the file is out of it, while the hash directory above it is meaningful and
    unique. So the manifest's platform path is REWRITTEN for the staged copy,
    and the hash map is keyed by the new name — which is what `loadNativePlugin`
    then looks up.
  */
  const name = selection.path.split('/').pop() ?? selection.path;
  return { dir: staged.dir, hashes: { [name]: sha256 } };
}

/**
 * The manifest a staged package is loaded with.
 *
 * Its `native.platforms` entry for this machine is rewritten to the bare file
 * name the staging step produced. Returned as a copy: the installed manifest
 * must keep saying what the author wrote, because that is what a reviewer reads
 * and what the next install compares against.
 */
export function manifestForStaged(manifest: PluginManifest, platformKey: string, fileName: string): PluginManifest {
  if (!manifest.native) return manifest;
  return {
    ...manifest,
    native: {
      ...manifest.native,
      platforms: { ...manifest.native.platforms, [platformKey]: fileName },
    },
  };
}

/**
 * This machine's platform key, as the PRELOAD reports it.
 *
 * The same source `stageNativeBinary` selected the binary with, which is what
 * makes it the right key to rewrite in `manifestForStaged` — two platforms may
 * legitimately declare the same file name, so the staged copy cannot be matched
 * back to its entry by name.
 */
export function stagingPlatformKey(): string {
  const api = bridge();
  return api ? nativePlatformKey(api.platform, api.arch) : '';
}

/**
 * Stop one plugin's process and delete everything staged for it.
 *
 * Uninstall's half of staging. Without it, `userData/PluginNative/<id>` outlives
 * the plugin by the life of the profile — the bytes are named after their own
 * hash, so a plugin installed, removed and reinstalled four times leaves four
 * directories nothing will ever load again.
 *
 * Best effort on the other side: a file the operating system still has mapped
 * cannot be deleted on Windows, and an uninstall that failed over that would
 * leave the user with a plugin they cannot remove.
 */
export async function unstageNativePlugin(pluginId: string): Promise<void> {
  await bridge()?.unstage(pluginId);
}

/**
 * Delete staging directories whose plugin is no longer installed.
 *
 * Called once at boot with the ids that ARE installed, because the one moment
 * an orphan can be recognised is the one where the whole list is known. The
 * cases it collects are the ones `unstageNativePlugin` cannot: an uninstall
 * that happened while the binary was mapped, a plugin removed by a build that
 * did not have this, a profile restored over a different set of plugins.
 *
 * Conservative by construction. It names ids to delete — never paths — so
 * nothing outside the staging root can be reached even if the list is wrong,
 * and the main process independently refuses an id that is not a plain
 * directory name. Bounded per boot, because a sweep is a background tidy and a
 * profile with two hundred orphans is not a reason to spend a boot deleting
 * them; the next one takes the next few.
 */
export const MAX_SWEEPS_PER_BOOT = 8;

export async function sweepStagedNative(installedIds: readonly string[]): Promise<string[]> {
  const api = bridge();
  if (!api?.staged) return [];
  const keep = new Set(installedIds);
  const staged = await api.staged();
  const orphans = staged.filter((id) => !keep.has(id)).slice(0, MAX_SWEEPS_PER_BOOT);
  for (const id of orphans) await api.unstage(id);
  return orphans;
}

/**
 * SHA-256, through WebCrypto.
 *
 * Available in the renderer and in every test environment this project runs
 * (jsdom exposes `crypto.subtle` through Node's implementation). A caller
 * without it gets an empty string, which fails the load with "named no binary
 * hash" — a refusal, which is the right direction for a missing hash.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return '';
  // Copied into a fresh buffer: `digest` wants an ArrayBuffer, and a view into
  // a larger one would hash the whole of it.
  const copy = bytes.slice();
  const digest = await subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
