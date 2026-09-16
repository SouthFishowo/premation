/**
 * The wire format between the decode worker and its client
 * (`workerDecoderIO.ts`). Its own module for the same reason `demuxWire.ts` is:
 * both ends must agree, neither should import the other.
 *
 * ## Why chunks are packed per batch
 *
 * The demuxed samples stay on the main thread — the tracker, the footage
 * preview and every other `SequentialFrameReader` consumer read them there —
 * and each sample's `data` is a VIEW into one packed file buffer (see
 * demuxWire). Posting a view structured-clones its WHOLE backing buffer, i.e.
 * the entire file, per decode call. So a batch of chunks is copied end to end
 * into one fresh ArrayBuffer and that buffer is TRANSFERRED. The copy is the
 * compressed bitstream of one GOP prefix — megabytes at 4K, a memcpy — which is
 * the price of keeping every other consumer's contract unchanged.
 *
 * ## Why frames come back two ways
 *
 * A decoded `VideoFrame` pins a slot in the hardware decoder's output pool
 * until it is closed (see `DecoderIO.retain`). Frames the main thread will
 * CACHE are therefore copied to an ImageBitmap inside the worker and the
 * original closed there, synchronously, in the output callback — the pool
 * never sees them leave. The one frame a seek asked for as `raw` crosses as the
 * `VideoFrame` itself (transfer = move, no pixel copy) so it can be uploaded to
 * the GPU directly; its slot stays pinned until the main thread closes it.
 */

import type { DecoderConfig, EncodedChunkInit } from './exactVideoSource';

/** One chunk minus its bytes — those live in the batch buffer. */
export interface WireChunkMeta {
  type: 'key' | 'delta';
  timestamp: number;
  durationUs: number;
  offset: number;
  length: number;
}

export type DecodeRequest =
  | { op: 'configure'; id: number; config: DecoderConfig }
  | { op: 'decode'; id: number; chunks: WireChunkMeta[]; bytes: ArrayBuffer }
  | { op: 'flush'; id: number; seq: number }
  | { op: 'reset'; id: number }
  | { op: 'hints'; id: number; floorUs: number; rawUs?: number }
  | { op: 'close'; id: number }
  /** Frames received by the main thread — releases worker-side backpressure. */
  | { op: 'ack'; count: number };

export type DecodeResponse =
  /** Posted once the worker module has loaded. A worker that errors before
   *  this never ran at all (bad bundle, blocked URL) and is not restarted. */
  | { op: 'ready'; videoDecoder: boolean; offscreen: boolean }
  | { op: 'frame'; id: number; frame: ImageBitmap | VideoFrame; timestamp: number; displayWidth: number; displayHeight: number }
  /** An output below the hint floor, closed in the worker without a copy. */
  | { op: 'dropped'; id: number; timestamp: number }
  | { op: 'flushed'; id: number; seq: number; error?: string; aborted?: boolean }
  | { op: 'error'; id: number; message: string; unsupported?: boolean };

/** Pack chunks for the wire. The returned buffer is fresh and transferable. */
export function packChunks(chunks: readonly EncodedChunkInit[]): { chunks: WireChunkMeta[]; bytes: ArrayBuffer } {
  let total = 0;
  for (const c of chunks) total += c.data.byteLength;
  const packed = new Uint8Array(total);
  const metas: WireChunkMeta[] = [];
  let offset = 0;
  for (const c of chunks) {
    packed.set(c.data, offset);
    metas.push({ type: c.type, timestamp: c.timestamp, durationUs: c.durationUs, offset, length: c.data.byteLength });
    offset += c.data.byteLength;
  }
  return { chunks: metas, bytes: packed.buffer };
}

/** Rebuild one chunk over the batch buffer (a view — no copy). */
export function unpackChunk(meta: WireChunkMeta, bytes: ArrayBuffer): EncodedChunkInit {
  return {
    type: meta.type,
    timestamp: meta.timestamp,
    durationUs: meta.durationUs,
    data: new Uint8Array(bytes, meta.offset, meta.length),
  };
}
