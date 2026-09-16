/**
 * The effect bake worker — runs `runBakeJob` off the main thread.
 *
 * All logic lives in `bakeWorkerCore.handleBakeRequest`, which the main-thread
 * fallback and the determinism test call directly; this file only binds it to
 * the worker scope. See bakeWorkerPool.ts for scheduling.
 */

import './bakeWorkerShim';
import { handleBakeRequest, type BakeRequestMessage, type BakeResponseMessage } from './bakeWorkerCore';

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<BakeRequestMessage>) => void) | null;
  postMessage(msg: BakeResponseMessage, transfer: Transferable[]): void;
};

const makeCanvas = (w: number, h: number): HTMLCanvasElement =>
  new OffscreenCanvas(Math.max(1, w), Math.max(1, h)) as unknown as HTMLCanvasElement;

scope.onmessage = (ev): void => {
  handleBakeRequest(ev.data, makeCanvas, (reply, transfer) => scope.postMessage(reply, transfer));
};
