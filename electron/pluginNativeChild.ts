/**
 * The entry point of a plugin's own process.
 *
 * One of these per native plugin, started by `pluginNativeHost.ts` with
 * `utilityProcess.fork`. It is deliberately the smallest file in this tier: a
 * port, a switch, and a `require`. Everything worth testing is in
 * `pluginNativeChildCore.ts`, which runs in the test process against a fake
 * addon.
 *
 * ── What this process is allowed to be ───────────────────────────────────────
 *
 * Expendable. It holds no state the editor needs, it is killed on a timeout
 * without ceremony, and the supervisor starts another one. That is what makes
 * a stranger's compiled code safe to run at all: not that it cannot crash, but
 * that its crashing costs one process and one frame.
 *
 * It also blocks freely. `motion_plugin_render` is synchronous and may take the
 * whole core for the length of the call — there is no event loop here that
 * anyone is waiting on except the supervisor, which is holding a timeout.
 *
 * ── Why `process.parentPort` and not `process.send` ──────────────────────────
 *
 * The MessagePort is the half of `utilityProcess` that can TRANSFER an
 * ArrayBuffer. A frame of 4K RGBA is 33 MB, and the difference between
 * transferring it and cloning it is the difference between this tier being
 * worth having and not.
 */

import { NativeAddonRunner, type AddonLoader } from './pluginNativeChildCore';
import type { NativeChildMessage, NativeChildReply } from './pluginNativeAbi';

/**
 * `require` at runtime, by absolute path.
 *
 * The path was resolved, contained inside a plugins root and hashed by the main
 * process before this process was told about it. Nothing here re-decides that —
 * a second, weaker copy of the containment check in the process that has
 * already been handed the file would only ever disagree in the wrong direction.
 */
const loader: AddonLoader = (path: string) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path) as unknown;
};

const runner = new NativeAddonRunner(loader);

type ParentPort = {
  on(event: 'message', handler: (message: { data: NativeChildMessage }) => void): void;
  postMessage(message: NativeChildReply, transfer?: ArrayBufferLike[]): void;
};

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;

if (port) {
  port.on('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'load') {
      const outcome = runner.open(message.binaryPath, message.host);
      port.postMessage(
        outcome.ok
          ? { type: 'loaded', id: message.id, ok: true, abi: outcome.abi ?? 0, describe: outcome.describe }
          : {
            type: 'loaded',
            id: message.id,
            ok: false,
            code: outcome.code ?? 'failed',
            error: outcome.error ?? 'The native module did not load.',
          },
      );
      return;
    }

    if (message.type === 'call') {
      const outcome = runner.call(message.request);
      if (outcome.ok) {
        port.postMessage(
          { type: 'result', id: message.id, ok: true, result: outcome.result },
          outcome.transfer ?? [],
        );
      } else {
        port.postMessage({
          type: 'result',
          id: message.id,
          ok: false,
          code: outcome.code ?? 'failed',
          error: outcome.error ?? 'The native module failed.',
        });
      }
      return;
    }

    if (message.type === 'dispose') {
      runner.dispose();
      port.postMessage({ type: 'disposed', id: message.id });
      // Left to the supervisor to end. Exiting here would race the reply.
    }
  });
}
