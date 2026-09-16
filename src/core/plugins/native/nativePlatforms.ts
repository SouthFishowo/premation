/**
 * Which binary, out of the several a package ships.
 *
 * A native plugin is a folder with one compiled file per platform-arch pair it
 * supports, and a manifest that names them. Picking one is two lines; the
 * reason this is a module is everything around the pick:
 *
 *   • A package with no binary for THIS machine is not broken. It is a package
 *     built for other machines, and the difference matters to a user deciding
 *     whether to file a bug or wait for a build. It is listed as unavailable
 *     here, with the platforms it does support named.
 *   • The key is `process.platform`-`process.arch` and nothing cleverer. No
 *     "x64 binary on an arm64 machine, Rosetta will cope": Rosetta will not
 *     cope with an Electron utility process, and a silent fallback that works
 *     on the author's machine and not on the user's is worse than a refusal.
 *   • The set of known keys is advisory. A key this build has never heard of is
 *     carried, not refused — a package built for a platform the app grows
 *     support for next year must not be unreadable today.
 */

import type { PluginNative } from '../manifest';

/**
 * The pairs there is a shipped app for today.
 *
 * Used for the message ("this package supports macOS and Windows") and for a
 * packaging-time warning. Never used to REFUSE a key: see the note above.
 */
export const KNOWN_NATIVE_PLATFORMS = [
  'win32-x64',
  'win32-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
] as const;

export type KnownNativePlatform = (typeof KNOWN_NATIVE_PLATFORMS)[number];

/** `win32-x64`. The key a manifest's `native.platforms` is looked up by. */
export function nativePlatformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/** Human names, for the one sentence a user reads when their machine is not covered. */
const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

export function nativePlatformLabel(key: string): string {
  const [platform = '', arch = ''] = key.split('-', 2);
  const os = PLATFORM_LABELS[platform] ?? platform;
  return arch ? `${os} (${arch})` : os;
}

export type NativeSelection =
  | { ok: true; key: string; path: string; sha256?: string }
  | {
    ok: false;
    /** `unsupported-platform` is a state, not a fault. The UI says so. */
    code: 'unsupported-platform' | 'not-declared';
    error: string;
    /** What the package DOES support, so the message can name it. */
    available: string[];
  };

/**
 * Pick the binary for this machine.
 *
 * `sha256` comes back when the manifest recorded one (`pack-plugin --native`
 * writes them). It is not required here and it is not checked here — the check
 * happens in the main process against the bytes on disk, because that is the
 * only place the bytes exist. What this returns is the CLAIM; the host is what
 * verifies it, and the consent sheet shows what the host verified.
 */
export function selectNativeBinary(
  native: PluginNative | undefined,
  platform: string = typeof process !== 'undefined' ? process.platform : 'unknown',
  arch: string = typeof process !== 'undefined' ? process.arch : 'unknown',
): NativeSelection {
  if (!native) {
    return {
      ok: false,
      code: 'not-declared',
      error: 'This plugin does not declare a native module.',
      available: [],
    };
  }

  const available = Object.keys(native.platforms);
  const key = nativePlatformKey(platform, arch);
  const path = native.platforms[key];
  if (!path) {
    const names = available.map(nativePlatformLabel);
    return {
      ok: false,
      code: 'unsupported-platform',
      error: available.length === 0
        ? 'This plugin ships no native module for any platform.'
        : `This plugin's native module is not built for ${nativePlatformLabel(key)}. `
          + `It supports ${names.join(', ')}.`,
      available,
    };
  }

  const sha256 = native.hashes?.[path];
  return { ok: true, key, path, ...(sha256 ? { sha256 } : {}) };
}

/**
 * Does the machine running this code have a native tier at all?
 *
 * False in the browser build and in any renderer without the bridge. Separate
 * from "this plugin has no binary for this platform", because the two produce
 * different messages: one is about the package and one is about the build.
 */
export function nativeTierAvailable(bridge: unknown): boolean {
  return bridge !== null && bridge !== undefined;
}
