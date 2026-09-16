/**
 * The door to the native tier, and the checks on the privileged side of it.
 *
 * ── Why the renderer cannot be trusted with this ─────────────────────────────
 *
 * Everything else in the plugin system hands the renderer BYTES and lets it
 * decide. That works because the renderer is a sandbox: the worst a compromised
 * one can do with a package is run it in another sandbox. This channel is
 * different in kind — it ends with `require()` on a file path — so the checks
 * that matter are HERE, in the process that does the loading, and they do not
 * consult the renderer about any of them:
 *
 *   1. **Containment.** The directory must be inside a configured plugins root
 *      (`pluginLoader.ts`) or inside this app's own staging directory. Without
 *      this, `pluginNative:load` is "execute any file on the machine",
 *      reachable from any bug that can put a string into an IPC call.
 *   2. **No traversal.** The binary's package-relative path must resolve inside
 *      the package. `../../../../Windows/System32/...` is a plausible manifest.
 *   3. **The hash.** The file on disk is hashed here, and the caller's claimed
 *      hash must match it. The user's consent is pinned to a hash; a load that
 *      did not verify the bytes would make that pin decorative.
 *
 * The renderer's own gate (`native/nativeTrust.ts`) is not redundant with this.
 * It knows the manifest, the signature, the revocation list and what the user
 * was asked — things this process does not have. It decides whether to ASK; this
 * decides whether to LOAD. Both have to say yes.
 *
 * ── Staging ──────────────────────────────────────────────────────────────────
 *
 * A folder plugin's binary is loaded where it lies. A `.mplugin` archive's is
 * not — a file inside a zip cannot be `require`d — so it is written to
 * `userData/PluginNative/<id>/<sha256>/<name>`, under a directory named after
 * its own hash. Two consequences worth stating: the same bytes stage once, and
 * a rebuilt binary lands in a new directory rather than replacing a file that
 * some other process might have mapped.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { app, utilityProcess, type WebContents } from 'electron';
import { handle } from './ipcGuard';
import { isInsideRoots, pluginSearchPaths } from './pluginLoader';
import {
  NativePluginHost,
  type NativeProcessLike,
  type NativeSpawnRequest,
} from './pluginNativeHost';

/**
 * Ceiling on one staged binary.
 *
 * The same 64 MB one file may be in a local package. A native module larger
 * than that is a model that should have shipped as data beside it, and refusing
 * it here is cheaper than discovering it while copying.
 */
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

let host: NativePluginHost | null = null;
/** The renderer to push crash and disable events at. The top frame, or none. */
let sender: WebContents | null = null;

/** `userData/PluginNative` — ours, created on demand, contained like a root. */
export function nativeStagingDir(): string {
  return join(app.getPath('userData'), 'PluginNative');
}

function roots(): string[] {
  const dirs = pluginSearchPaths({
    platform: process.platform,
    appName: app.getName(),
    userData: app.getPath('userData'),
  }).map((p) => p.dir);
  dirs.push(nativeStagingDir());
  return dirs;
}

/**
 * Is `child` really inside `parent`?
 *
 * Compared on resolved paths with a trailing separator, so `…/pkg-evil` is not
 * a child of `…/pkg` — the same rule `isInsideRoots` applies one level up, and
 * spelled out again here because this one is guarding a `require`.
 */
function isInside(parent: string, child: string): boolean {
  const base = resolve(parent);
  const full = resolve(child);
  if (full === base) return false; // the directory itself is not a binary
  const prefix = base.endsWith(sep) ? base : base + sep;
  return process.platform === 'win32'
    ? full.toLowerCase().startsWith(prefix.toLowerCase())
    : full.startsWith(prefix);
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Start one plugin's process.
 *
 * `utilityProcess` rather than a `child_process` fork, because it is the only
 * one of the two whose MessagePort can TRANSFER an ArrayBuffer — and a frame of
 * 4K RGBA is 33 MB, so the difference is the whole point of the tier.
 *
 * `allowLoadingUnsignedLibraries` is set on macOS and nowhere else. The app is
 * signed with the hardened runtime, which otherwise refuses to load a library
 * that is not signed by the same team — and a plugin author's binary never is.
 * It is scoped to THIS process: the main process keeps its own hardened
 * runtime, and only the utility process running a stranger's addon relaxes it.
 */
function spawnNativeProcess(request: NativeSpawnRequest): NativeProcessLike | null {
  const child = join(__dirname, 'pluginNativeChild.js');
  const proc = utilityProcess.fork(child, [], {
    cwd: request.dir,
    // Named after the plugin, so a user looking at Activity Monitor or Task
    // Manager can see WHICH plugin is spending their CPU.
    serviceName: `plugin:${request.pluginId}`,
    stdio: 'ignore',
    ...(process.platform === 'darwin' ? { allowLoadingUnsignedLibraries: true } : {}),
  });
  return proc as unknown as NativeProcessLike;
}

function pluginHost(): NativePluginHost {
  if (host) return host;
  host = new NativePluginHost(spawnNativeProcess);
  host.onEvent((event) => {
    if (sender && !sender.isDestroyed()) sender.send('pluginNative:event', event);
  });
  return host;
}

/** Stop every plugin process. Called from the app's own shutdown. */
export function disposeNativePlugins(): void {
  host?.dispose();
  host = null;
}

interface LoadArgs {
  pluginId?: unknown;
  pluginName?: unknown;
  version?: unknown;
  dir?: unknown;
  binaryPath?: unknown;
  sha256?: unknown;
  abi?: unknown;
  timeoutMs?: unknown;
  idleTimeoutMs?: unknown;
}

const HEX64 = /^[0-9a-f]{64}$/i;

export function registerPluginNativeIpc(): void {
  handle('pluginNative:load', async (event, raw: unknown) => {
    sender = event.sender;
    const args = (raw && typeof raw === 'object' ? raw : {}) as LoadArgs;
    const pluginId = typeof args.pluginId === 'string' ? args.pluginId : '';
    const dir = typeof args.dir === 'string' ? args.dir : '';
    const rel = typeof args.binaryPath === 'string' ? args.binaryPath : '';
    const claimed = typeof args.sha256 === 'string' ? args.sha256 : '';
    if (!pluginId || !dir || !rel) {
      return { ok: false, code: 'failed', error: 'The native load request was incomplete.' };
    }
    if (!HEX64.test(claimed)) {
      // Consent is pinned to a hash. A request without one is a request nobody
      // could have consented to, whatever else it carries.
      return {
        ok: false,
        code: 'hash-mismatch',
        error: 'The native load request named no binary hash.',
      };
    }
    if (!isInsideRoots(dir, roots())) {
      return {
        ok: false,
        code: 'outside-roots',
        error: 'That plugin is not inside a plugins folder.',
      };
    }

    const binaryPath = resolve(join(dir, rel));
    if (!isInside(dir, binaryPath)) {
      return {
        ok: false,
        code: 'outside-roots',
        error: 'The native module path points outside its own package.',
      };
    }

    let bytes: Uint8Array;
    try {
      const info = await stat(binaryPath);
      if (!info.isFile()) throw new Error('not a file');
      if (info.size > MAX_BINARY_BYTES) {
        return {
          ok: false,
          code: 'missing-binary',
          error: `${basename(binaryPath)} is larger than ${MAX_BINARY_BYTES / 1024 / 1024} MB.`,
        };
      }
      bytes = new Uint8Array(await readFile(binaryPath));
    } catch (err) {
      return {
        ok: false,
        code: 'missing-binary',
        error: `The native module could not be read: ${(err as Error).message}`,
      };
    }

    const actual = sha256Of(bytes);
    if (actual !== claimed.toLowerCase()) {
      return {
        ok: false,
        code: 'hash-mismatch',
        error:
          'The native module on disk is not the one this plugin was allowed to run. '
          + 'It has to be allowed again.',
      };
    }

    return pluginHost().load({
      pluginId,
      pluginName: typeof args.pluginName === 'string' ? args.pluginName : pluginId,
      version: typeof args.version === 'string' ? args.version : '0.0.0',
      dir: resolve(dir),
      binaryPath,
      abi: typeof args.abi === 'number' ? args.abi : 0,
      appVersion: app.getVersion(),
      ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
      ...(typeof args.idleTimeoutMs === 'number' ? { idleTimeoutMs: args.idleTimeoutMs } : {}),
    });
  });

  handle('pluginNative:call', async (_event, raw: unknown) => {
    const args = (raw && typeof raw === 'object' ? raw : {}) as { pluginId?: unknown; request?: unknown };
    const pluginId = typeof args.pluginId === 'string' ? args.pluginId : '';
    if (!pluginId) return { ok: false, code: 'failed', error: 'No plugin was named.' };
    if (!host) {
      return { ok: false, code: 'not-declared', error: 'This plugin has no native module loaded.' };
    }
    // The request arrived through a structured clone, so its typed arrays are
    // already this process's own memory. Handing them on to the child TRANSFERS
    // them, which is the copy this tier exists to avoid.
    return host.call(pluginId, args.request, transfersOf(args.request));
  });

  handle('pluginNative:unload', (_event, raw: unknown, reason: unknown) => {
    const pluginId = typeof raw === 'string' ? raw : '';
    if (pluginId) host?.unload(pluginId, typeof reason === 'string' ? reason : 'unload');
    return { ok: true };
  });

  handle('pluginNative:status', () => host?.status() ?? []);

  /**
   * Write an archive's binary to the staging directory.
   *
   * The bytes come from the renderer, which got them out of a package whose
   * signature it verified. This process does not take that on trust: it hashes
   * what it was handed, refuses a mismatch with the caller's own claim, and
   * names the directory after the hash — so the path a load later names is
   * itself evidence about the bytes in it.
   */
  handle('pluginNative:stage', async (_event, raw: unknown) => {
    const args = (raw && typeof raw === 'object' ? raw : {}) as {
      pluginId?: unknown;
      relPath?: unknown;
      bytes?: unknown;
      sha256?: unknown;
    };
    const pluginId = typeof args.pluginId === 'string' ? args.pluginId : '';
    const rel = typeof args.relPath === 'string' ? args.relPath : '';
    const claimed = typeof args.sha256 === 'string' ? args.sha256 : '';
    const bytes = args.bytes instanceof Uint8Array
      ? args.bytes
      : ArrayBuffer.isView(args.bytes)
        ? new Uint8Array((args.bytes as ArrayBufferView).buffer)
        : null;

    if (!pluginId || !rel || !bytes) {
      return { ok: false, error: 'The staging request was incomplete.' };
    }
    // A plugin id is reverse-DNS and becomes a directory name. Anything else is
    // a path fragment wearing an id's clothes.
    if (!/^[a-z0-9][a-z0-9.-]{0,127}$/i.test(pluginId)) {
      return { ok: false, error: 'That plugin id cannot be used as a directory name.' };
    }
    if (bytes.byteLength > MAX_BINARY_BYTES) {
      return { ok: false, error: `The native module is larger than ${MAX_BINARY_BYTES / 1024 / 1024} MB.` };
    }
    const actual = sha256Of(bytes);
    if (!HEX64.test(claimed) || actual !== claimed.toLowerCase()) {
      return { ok: false, error: 'The native module\'s bytes do not match the hash that was claimed for them.' };
    }

    const dir = join(nativeStagingDir(), pluginId, actual);
    const name = basename(rel);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), bytes);
    } catch (err) {
      return { ok: false, error: `The native module could not be staged: ${(err as Error).message}` };
    }
    return { ok: true, dir };
  });

  /**
   * The plugin ids that have a staging directory.
   *
   * Names only — no paths cross, and the renderer cannot ask about a directory
   * it did not learn about here. It is the input to the boot sweep, whose whole
   * job is to spot an id that is staged and no longer installed; the renderer is
   * the only side that knows what is installed, and this side is the only one
   * that knows what is staged, so the question needs both.
   */
  handle('pluginNative:staged', async () => {
    try {
      const entries = await readdir(nativeStagingDir(), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // Nothing has ever been staged on this machine. Not an error: the
      // directory is created by the first `stage` and by nothing else.
      return [];
    }
  });

  /**
   * Drop everything staged for one plugin. Uninstall and revocation call it.
   *
   * Best effort by design: a file the OS still has mapped cannot be deleted on
   * Windows, and failing the uninstall over it would leave the user with a
   * plugin they cannot remove.
   */
  handle('pluginNative:unstage', async (_event, raw: unknown) => {
    const pluginId = typeof raw === 'string' ? raw : '';
    if (!/^[a-z0-9][a-z0-9.-]{0,127}$/i.test(pluginId)) return { ok: false };
    host?.unload(pluginId, 'uninstall');
    try {
      await rm(join(nativeStagingDir(), pluginId), { recursive: true, force: true });
    } catch { /* mapped, or already gone */ }
    return { ok: true };
  });
}

/** Every typed array in a request, so it can be transferred rather than copied. */
export function transfersOf(value: unknown, into: ArrayBufferLike[] = []): ArrayBufferLike[] {
  if (!value || typeof value !== 'object') return into;
  if (ArrayBuffer.isView(value)) {
    if (!into.includes(value.buffer)) into.push(value.buffer);
    return into;
  }
  if (value instanceof ArrayBuffer) {
    if (!into.includes(value)) into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) transfersOf(item, into);
    return into;
  }
  for (const item of Object.values(value)) transfersOf(item, into);
  return into;
}
