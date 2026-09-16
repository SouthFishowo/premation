/**
 * The plugin kernel worker — runs one plugin CPU kernel off the main thread.
 *
 * All logic lives in `kernelWorkerCore`, which the main-thread fallback and the
 * tests call directly; this file only binds it to the worker scope. See
 * `kernelPool.ts` for scheduling, and note that a worker holds its compiled
 * modules and its compute caches for its lifetime — which is why the pool
 * replaces a worker rather than reusing one it had to terminate.
 */

import { handleKernelRequest } from './kernelWorkerCore';
import type { KernelRequestMessage, KernelResponseMessage } from './kernelTypes';

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<KernelRequestMessage>) => void) | null;
  postMessage(msg: KernelResponseMessage, transfer: Transferable[]): void;
};

scope.onmessage = (ev): void => {
  void handleKernelRequest(ev.data, (reply, transfer) => scope.postMessage(reply, transfer));
};
