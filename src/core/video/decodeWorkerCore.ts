/**
 * The decode worker's logic, with its environment injected.
 *
 * `decode.worker.ts` is only the wiring between this and `self`. Everything
 * that can be wrong — backpressure, the floor/raw routing, what flush waits
 * for, what a reset discards, closing every frame exactly once — lives here,
 * where jest can drive it with a fake `VideoDecoder` and a recording `post`.
 *
 * ## Backpressure
 *
 * Every frame the worker posts is memory on the main thread until it is
 * received: an ImageBitmap copy (~32 MB at 4K) or, for a `raw` target, a
 * pinned hardware pool slot. If the main thread is busy — which is exactly
 * when scrubbing hurts — an unbounded worker would keep decoding and posting
 * into a message queue nobody is reading. So chunks are fed to the decoder
 * only while `inFlight` (posted, not yet acknowledged) is under
 * `MAX_IN_FLIGHT_FRAMES`; the rest wait here as compressed bytes, which cost
 * nothing. Flush waits until that backlog has drained, so its reply still
 * means "every frame for this request has been delivered".
 */

import type { DecodeRequest, DecodeResponse, WireChunkMeta } from './decodeWire';
import { unpackChunk } from './decodeWire';
import type { DecoderConfig } from './exactVideoSource';

/** Posted-but-unacknowledged frames before the worker stops feeding. */
export const MAX_IN_FLIGHT_FRAMES = 8;
/** Chunks queued INSIDE a decoder before the worker holds the rest back. */
const MAX_DECODE_QUEUE = 16;

interface NativeFrame {
  readonly timestamp: number | null;
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

interface NativeDecoder {
  readonly decodeQueueSize?: number;
  configure(config: object): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

export interface DecodeWorkerEnv {
  createDecoder(init: { output: (f: NativeFrame) => void; error: (e: Error) => void }): NativeDecoder;
  createChunk(init: { type: 'key' | 'delta'; timestamp: number; duration: number; data: Uint8Array }): unknown;
  /** Synchronous VideoFrame → transferable copy, closing the original; null
   *  when the worker cannot copy (no OffscreenCanvas) — the frame then crosses
   *  as itself and the main thread copies it. */
  copyFrame(frame: NativeFrame): ImageBitmap | null;
  post(msg: DecodeResponse, transfer: Transferable[]): void;
}

interface Session {
  id: number;
  decoder: NativeDecoder;
  config: DecoderConfig;
  backlog: Array<{ meta: WireChunkMeta; bytes: ArrayBuffer }>;
  flushes: number[];
  flushing: boolean;
  floorUs: number;
  rawUs: number | undefined;
  closed: boolean;
}

export interface DecodeWorkerCore {
  handle(msg: DecodeRequest): void;
  /** For tests: frames posted and not yet acknowledged. */
  readonly inFlight: number;
}

export function createDecodeWorkerCore(env: DecodeWorkerEnv): DecodeWorkerCore {
  const sessions = new Map<number, Session>();
  let inFlight = 0;

  const nativeConfig = (c: DecoderConfig): object => ({
    codec: c.codec,
    codedWidth: c.codedWidth,
    codedHeight: c.codedHeight,
    ...(c.description ? { description: c.description } : {}),
    ...(c.hardwareAcceleration ? { hardwareAcceleration: c.hardwareAcceleration } : {}),
  });

  function onOutput(s: Session, frame: NativeFrame): void {
    const ts = frame.timestamp;
    if (s.closed || ts === null) {
      frame.close();
      return;
    }
    if (ts < s.floorUs) {
      frame.close();
      env.post({ op: 'dropped', id: s.id, timestamp: ts }, []);
      return;
    }
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    let payload: ImageBitmap | NativeFrame = frame;
    if (ts !== s.rawUs) {
      // Copy and close here, synchronously, inside the output callback — the
      // pool slot is free before this function returns.
      const copy = env.copyFrame(frame);
      if (copy) payload = copy;
    }
    inFlight += 1;
    // Transfer, never clone: a transferred VideoFrame is MOVED (closed on this
    // side, no pixel copy) and a transferred ImageBitmap likewise.
    env.post(
      { op: 'frame', id: s.id, frame: payload as ImageBitmap | VideoFrame, timestamp: ts, displayWidth: w, displayHeight: h },
      [payload as unknown as Transferable],
    );
  }

  function makeSession(id: number, config: DecoderConfig): Session {
    const s: Session = {
      id,
      config,
      decoder: null as unknown as NativeDecoder,
      backlog: [],
      flushes: [],
      flushing: false,
      floorUs: -Infinity,
      rawUs: undefined,
      closed: false,
    };
    s.decoder = env.createDecoder({
      output: (f) => onOutput(s, f),
      error: (e) => {
        if (s.closed) return;
        env.post({ op: 'error', id, message: e?.message ?? String(e) }, []);
      },
    });
    s.decoder.configure(nativeConfig(config));
    return s;
  }

  /** Feed held-back chunks while there is room, then start a waiting flush. */
  function feed(s: Session): void {
    if (s.closed) return;
    while (
      s.backlog.length > 0
      && inFlight < MAX_IN_FLIGHT_FRAMES
      && (s.decoder.decodeQueueSize ?? 0) < MAX_DECODE_QUEUE
    ) {
      const { meta, bytes } = s.backlog.shift()!;
      const c = unpackChunk(meta, bytes);
      try {
        s.decoder.decode(env.createChunk({ type: c.type, timestamp: c.timestamp, duration: c.durationUs, data: c.data }));
      } catch (e) {
        env.post({ op: 'error', id: s.id, message: e instanceof Error ? e.message : String(e) }, []);
        s.backlog = [];
        return;
      }
    }
    if (s.backlog.length === 0 && s.flushes.length > 0 && !s.flushing) startFlush(s);
  }

  function startFlush(s: Session): void {
    const seq = s.flushes.shift()!;
    s.flushing = true;
    s.decoder.flush().then(
      () => {
        s.flushing = false;
        if (!s.closed) env.post({ op: 'flushed', id: s.id, seq }, []);
        feed(s);
      },
      (e: unknown) => {
        s.flushing = false;
        if (!s.closed) {
          const aborted = e instanceof Error && e.name === 'AbortError';
          env.post({ op: 'flushed', id: s.id, seq, error: e instanceof Error ? e.message : String(e), aborted }, []);
        }
        feed(s);
      },
    );
  }

  /** Something freed room: every session may feed again. */
  function feedAll(): void {
    for (const s of sessions.values()) feed(s);
  }

  return {
    get inFlight() {
      return inFlight;
    },
    handle(msg) {
      switch (msg.op) {
        case 'configure': {
          try {
            sessions.set(msg.id, makeSession(msg.id, msg.config));
          } catch (e) {
            env.post({ op: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e), unsupported: true }, []);
          }
          return;
        }
        case 'decode': {
          const s = sessions.get(msg.id);
          if (!s) return;
          for (const meta of msg.chunks) s.backlog.push({ meta, bytes: msg.bytes });
          feed(s);
          return;
        }
        case 'flush': {
          const s = sessions.get(msg.id);
          if (!s) {
            env.post({ op: 'flushed', id: msg.id, seq: msg.seq, error: 'no decoder' }, []);
            return;
          }
          s.flushes.push(msg.seq);
          feed(s);
          return;
        }
        case 'hints': {
          const s = sessions.get(msg.id);
          if (!s) return;
          s.floorUs = msg.floorUs;
          s.rawUs = msg.rawUs;
          return;
        }
        case 'reset': {
          const s = sessions.get(msg.id);
          if (!s) return;
          // Held-back chunks and waiting flushes belong to the abandoned
          // request; the client has already rejected them on its side.
          s.backlog = [];
          const waiting = s.flushes;
          s.flushes = [];
          for (const seq of waiting) env.post({ op: 'flushed', id: s.id, seq, error: 'reset', aborted: true }, []);
          try {
            s.decoder.reset();
            s.decoder.configure(nativeConfig(s.config));
          } catch (e) {
            env.post({ op: 'error', id: s.id, message: e instanceof Error ? e.message : String(e) }, []);
          }
          return;
        }
        case 'close': {
          const s = sessions.get(msg.id);
          if (!s) return;
          s.closed = true;
          s.backlog = [];
          sessions.delete(msg.id);
          try {
            s.decoder.close();
          } catch {
            // already closed by an error
          }
          feedAll();
          return;
        }
        case 'ack': {
          inFlight = Math.max(0, inFlight - msg.count);
          feedAll();
          return;
        }
      }
    },
  };
}
