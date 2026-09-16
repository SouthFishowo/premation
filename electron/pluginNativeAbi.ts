/**
 * The native ABI, as the MAIN process knows it.
 *
 * A copy of `src/core/plugins/native/nativeAbi.ts`, and duplicated for the same
 * reason `pluginLoader.ts` duplicates the extension allowlist: this directory is
 * compiled alone by `electron/tsconfig.json`, and reaching into `src/` would
 * pull the renderer's whole module graph into the main process.
 *
 * Drift is the obvious risk, so it is pinned:
 * `src/core/plugins/native/nativeAbiPinned.test.ts` reads this file, the
 * renderer's, the SDK's TypeScript and the C header, and fails when the four
 * numbers are not the same number.
 *
 * Nothing about the CONTRACT is decided here — this file holds the version, the
 * export names, and the only check made before a stranger's binary is called.
 */

/** Breaking version. A different one is refused without the binary being called. */
export const NATIVE_ABI_MAJOR = 1;

/** Additive version. An addon may be older; it may not be newer. */
export const NATIVE_ABI_MINOR = 0;

/** What `motion_plugin_abi_version()` returns: `major * 1000 + minor`. */
export const NATIVE_ABI_VERSION = NATIVE_ABI_MAJOR * 1000 + NATIVE_ABI_MINOR;

/** The five exports, by the exact strings they are registered under. */
export const ABI_VERSION_EXPORT = 'motion_plugin_abi_version';
export const REGISTER_EXPORT = 'motion_plugin_register';
export const DESCRIBE_EXPORT = 'motion_plugin_describe';
export const RENDER_EXPORT = 'motion_plugin_render';
export const DISPOSE_EXPORT = 'motion_plugin_dispose';

export const NATIVE_EXPORTS = [
  ABI_VERSION_EXPORT,
  REGISTER_EXPORT,
  DESCRIBE_EXPORT,
  RENDER_EXPORT,
  DISPOSE_EXPORT,
] as const;

export interface AbiCheck {
  ok: boolean;
  error?: string;
}

/**
 * Is this addon's ABI one this build can call?
 *
 * Both directions refuse and both messages name both numbers: a newer addon
 * means the user updates the app, an older one means the author rebuilds, and
 * "incompatible" leaves each of them guessing which. A newer MINOR is refused
 * too — the addon was built expecting request fields this host does not send,
 * and handing it absent keys is how a plugin renders the wrong thing rather
 * than failing.
 */
export function checkAbi(reported: unknown): AbiCheck {
  if (typeof reported !== 'number' || !Number.isInteger(reported) || reported < 0) {
    return {
      ok: false,
      error:
        `${ABI_VERSION_EXPORT}() did not return a whole number. This file is not a Premation `
        + `native module, or it was built against a different SDK. This app speaks ABI `
        + `${NATIVE_ABI_MAJOR}.${NATIVE_ABI_MINOR}.`,
    };
  }
  const major = Math.floor(reported / 1000);
  const minor = reported % 1000;
  if (major !== NATIVE_ABI_MAJOR) {
    return {
      ok: false,
      error:
        `This plugin's native module was built for ABI ${major}.${minor}; this app speaks `
        + `${NATIVE_ABI_MAJOR}.${NATIVE_ABI_MINOR}. `
        + (major > NATIVE_ABI_MAJOR
          ? 'Update the app, or ask the author for a build against the older ABI.'
          : 'Ask the author for a build against the current ABI.'),
    };
  }
  if (minor > NATIVE_ABI_MINOR) {
    return {
      ok: false,
      error:
        `This plugin's native module was built for ABI ${major}.${minor} and this app speaks `
        + `${NATIVE_ABI_MAJOR}.${NATIVE_ABI_MINOR}. It expects to be handed fields this version `
        + 'does not send. Update the app.',
    };
  }
  return { ok: true };
}

// ── The child protocol ───────────────────────────────────────────────────────
//
// What crosses the MessagePort between the supervisor and the plugin's own
// process. Kept here rather than in the child so both sides compile against one
// definition — a protocol defined in the process that implements half of it is
// a protocol with two definitions.

export interface NativeChildLoad {
  type: 'load';
  id: number;
  /** Absolute path to the `.node` file. Already hashed and contained by main. */
  binaryPath: string;
  host: {
    abi: number;
    app: string;
    appVersion: string;
    pluginId: string;
    pluginVersion: string;
    pluginDir: string;
  };
}

export interface NativeChildCall {
  type: 'call';
  id: number;
  /** A `NativeRequest`. Opaque here — the child reshapes it for the addon. */
  request: unknown;
}

export interface NativeChildDispose {
  type: 'dispose';
  id: number;
}

export type NativeChildMessage = NativeChildLoad | NativeChildCall | NativeChildDispose;

export type NativeChildReply =
  | { type: 'loaded'; id: number; ok: true; abi: number; describe: unknown }
  | { type: 'loaded'; id: number; ok: false; code: string; error: string }
  | { type: 'result'; id: number; ok: true; result: unknown }
  | { type: 'result'; id: number; ok: false; code: string; error: string }
  | { type: 'disposed'; id: number };
