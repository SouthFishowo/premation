/// <reference lib="webworker" />
/**
 * The decode worker: `VideoDecoder` off the main thread.
 *
 * Wiring only — every decision is in `decodeWorkerCore.ts`, where it is
 * tested. This file binds that core to the real WebCodecs globals, the
 * synchronous OffscreenCanvas copy route shared with the in-thread adapter
 * (`retainFrameCopy`), and `self`.
 */

import { createDecodeWorkerCore } from './decodeWorkerCore';
import type { DecodeRequest, DecodeResponse } from './decodeWire';
import { retainFrameCopy, type DecodedFrameLike } from './exactVideoSource';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const hasDecoder = typeof VideoDecoder === 'function';
const hasOffscreen = typeof OffscreenCanvas === 'function';

const core = createDecodeWorkerCore({
  createDecoder: (init) => new VideoDecoder(init as unknown as VideoDecoderInit) as never,
  createChunk: (init) => new EncodedVideoChunk(init),
  copyFrame: (frame) => {
    if (!hasOffscreen) return null;
    const copy = retainFrameCopy(frame as unknown as DecodedFrameLike);
    // retainFrameCopy hands the ORIGINAL back (unclosed) when it cannot copy;
    // the core then transfers that frame itself.
    return copy instanceof ImageBitmap ? copy : null;
  },
  post: (msg: DecodeResponse, transfer: Transferable[]) => ctx.postMessage(msg, transfer),
});

ctx.onmessage = (e: MessageEvent<DecodeRequest>): void => {
  core.handle(e.data);
};

ctx.postMessage({ op: 'ready', videoDecoder: hasDecoder, offscreen: hasOffscreen } satisfies DecodeResponse);
