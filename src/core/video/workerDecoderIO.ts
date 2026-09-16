/**
 * `DecoderIO` with the `VideoDecoder` in a worker.
 *
 * ## What moves, and what does not
 *
 * The session logic — which chunks to feed, the retain window, latest-wins,
 * streaming — stays in `ExactVideoSource` / `SequentialFrameReader` on the main
 * thread, unchanged: this is the same seam the jest fakes plug into, so every
 * test of that logic still describes what runs in production. What moves is
 * the decoder and, more importantly, the per-frame COPY: `retain` used to draw
 * every kept 4K frame into an OffscreenCanvas on the main thread, inside the
 * decoder's output callback, i.e. in the middle of whatever the UI was doing.
 * In the worker that copy happens there and an ImageBitmap arrives by transfer.
 *
 * The demuxed samples stay on the main thread (see decodeWire for why) and are
 * copied into one transferable buffer per batch of `decode()` calls.
 *
 * ## Failure is part of the contract
 *
 * - No `Worker`, no WebCodecs, a kill switch, or a worker that cannot even
 *   load: every decoder is created on this thread instead (`webCodecsIO`), for
 *   the rest of the session. Callers cannot tell which ran.
 * - The worker crashes or stops answering while work is pending: every open
 *   decoder errors with `TransientDecodeError` (callers retry rather than count
 *   it as a bad file), the worker is replaced on the next decoder request, and
 *   the renderer's next `get()` resumes at whatever frame it wants NOW. More
 *   than `maxRestarts` crashes inside `restartWindowMs` and the worker is
 *   abandoned for the in-thread decoder.
 */

import type { DecodeRequest, DecodeResponse } from './decodeWire';
import { packChunks } from './decodeWire';
import {
  TransientDecodeError,
  isVideoFrame,
  retainFrameCopy,
  webCodecsAvailable,
  webCodecsIO,
  type DecodedFrameLike,
  type DecoderConfig,
  type DecoderHandlers,
  type DecoderIO,
  type EncodedChunkInit,
  type OutputHints,
  type VideoDecoderLike,
} from './exactVideoSource';
import { videoDecodeStats } from './decodeStats';

/** The slice of `Worker` the client uses — structural, for test fakes. */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
}

export interface WorkerDecoderOptions {
  spawn: () => WorkerLike | Promise<WorkerLike>;
  /** Used whenever the worker is unavailable. */
  fallback?: DecoderIO;
  /** Silence (no message) with a flush pending before the worker counts as hung. */
  watchdogMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  now?: () => number;
}

interface Proxy {
  id: number;
  handlers: DecoderHandlers;
  batch: EncodedChunkInit[];
  batchScheduled: boolean;
  flushes: Map<number, { resolve: () => void; reject: (e: unknown) => void }>;
  closed: boolean;
}

function abortError(): Error {
  const e = new Error('decoder reset');
  e.name = 'AbortError';
  return e;
}

export class WorkerDecodeClient implements DecoderIO {
  private worker: WorkerLike | null = null;
  private starting = false;
  private ready = false;
  private disabled = false;
  private disposed = false;
  private outbox: Array<{ msg: DecodeRequest; transfer: Transferable[] }> = [];
  private readonly proxies = new Map<number, Proxy>();
  private seq = 0;
  private flushSeq = 0;
  private pendingAcks = 0;
  private lastHeard = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private suspect = false;
  private restarts: number[] = [];

  private readonly fallback: DecoderIO;
  private readonly watchdogMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: WorkerDecoderOptions) {
    this.fallback = opts.fallback ?? webCodecsIO;
    this.watchdogMs = opts.watchdogMs ?? 20_000;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.restartWindowMs = opts.restartWindowMs ?? 60_000;
    this.now = opts.now ?? (() => performance.now());
  }

  /** False once the client has given up on the worker for this session. */
  get usingWorker(): boolean {
    return !this.disabled;
  }

  createDecoder(config: DecoderConfig, handlers: DecoderHandlers): VideoDecoderLike {
    if (this.disabled || this.disposed) return this.fallback.createDecoder(config, handlers);
    this.ensureWorker();
    // A spawn that throws disables the client synchronously; a proxy made now
    // would talk to nobody and its flush would never settle.
    if (this.disabled) return this.fallback.createDecoder(config, handlers);
    const id = ++this.seq;
    const proxy: Proxy = { id, handlers, batch: [], batchScheduled: false, flushes: new Map(), closed: false };
    this.proxies.set(id, proxy);
    // The description is a few dozen bytes; copying it means the clone never
    // drags along a larger buffer it happens to view.
    const wireConfig: DecoderConfig = {
      ...config,
      ...(config.description ? { description: config.description.slice() } : {}),
    };
    this.send({ op: 'configure', id, config: wireConfig });

    const postBatch = (): void => {
      proxy.batchScheduled = false;
      if (proxy.closed || proxy.batch.length === 0) return;
      const packed = packChunks(proxy.batch);
      proxy.batch = [];
      this.send({ op: 'decode', id, chunks: packed.chunks, bytes: packed.bytes }, [packed.bytes]);
    };

    return {
      decode: (chunk) => {
        if (proxy.closed) throw new Error('decoder is closed');
        proxy.batch.push(chunk as EncodedChunkInit);
        // One post per synchronous feed burst, not per chunk: a GOP prefix is
        // fed in a tight loop and arrives as one transfer.
        if (!proxy.batchScheduled) {
          proxy.batchScheduled = true;
          queueMicrotask(postBatch);
        }
      },
      flush: () => {
        if (proxy.closed) return Promise.reject(new Error('decoder is closed'));
        postBatch();
        const seq = ++this.flushSeq;
        const p = new Promise<void>((resolve, reject) => {
          proxy.flushes.set(seq, { resolve, reject });
        });
        this.send({ op: 'flush', id, seq });
        this.armWatchdog();
        return p;
      },
      reset: () => {
        if (proxy.closed) return;
        proxy.batch = [];
        this.rejectFlushes(proxy, abortError());
        this.send({ op: 'reset', id });
      },
      close: () => {
        if (proxy.closed) return;
        proxy.closed = true;
        proxy.batch = [];
        this.rejectFlushes(proxy, abortError());
        this.proxies.delete(id);
        this.send({ op: 'close', id });
      },
      setOutputHints: (hints: OutputHints) => {
        if (proxy.closed) return;
        postBatch();
        this.send({ op: 'hints', id, floorUs: hints.floorUs, ...(hints.rawUs !== undefined ? { rawUs: hints.rawUs } : {}) });
      },
    };
  }

  createChunk(init: EncodedChunkInit): unknown {
    // The fallback path needs real EncodedVideoChunks; the worker path packs
    // plain inits. A decoder created on the fallback gets the fallback's chunks.
    return this.disabled ? this.fallback.createChunk(init) : init;
  }

  /** Worker frames arrive already copied; only a raw `VideoFrame` (the
   *  worker's no-OffscreenCanvas route, or a fallback decoder) needs one. */
  retain = (frame: DecodedFrameLike): DecodedFrameLike =>
    isVideoFrame(frame) ? retainFrameCopy(frame) : frame;

  /** Terminate the worker and fall back for good. Tests and teardown. */
  dispose(): void {
    this.disposed = true;
    this.failAll(new TransientDecodeError('decode worker disposed'));
    this.teardownWorker();
  }

  // ── Worker lifecycle ───────────────────────────────────────────────

  private ensureWorker(): void {
    if (this.worker || this.starting || this.disabled) return;
    this.starting = true;
    this.ready = false;
    let spawned: WorkerLike | Promise<WorkerLike>;
    try {
      spawned = this.opts.spawn();
    } catch {
      this.starting = false;
      this.disable(new TransientDecodeError('decode worker could not be created'));
      return;
    }
    Promise.resolve(spawned).then(
      (w) => {
        this.starting = false;
        if (this.disposed || this.disabled) {
          w.terminate();
          return;
        }
        this.worker = w;
        this.lastHeard = this.now();
        w.onmessage = (e: MessageEvent) => this.onMessage(e.data as DecodeResponse);
        w.onerror = (e: Event) => {
          e?.preventDefault?.();
          this.crash('decode worker error');
        };
        const queued = this.outbox;
        this.outbox = [];
        for (const { msg, transfer } of queued) w.postMessage(msg, transfer);
      },
      () => {
        this.starting = false;
        this.disable(new TransientDecodeError('decode worker failed to load'));
      },
    );
  }

  private send(msg: DecodeRequest, transfer: Transferable[] = []): void {
    if (this.worker) {
      try {
        this.worker.postMessage(msg, transfer);
      } catch {
        this.crash('decode worker post failed');
      }
    } else if (this.starting) {
      this.outbox.push({ msg, transfer });
    }
    // Neither: the worker is gone and every proxy has already been failed —
    // a message for it has no one to reach.
  }

  private onMessage(msg: DecodeResponse): void {
    this.lastHeard = this.now();
    this.suspect = false;
    switch (msg.op) {
      case 'ready': {
        this.ready = true;
        if (!msg.videoDecoder) {
          this.disable(new TransientDecodeError('decode worker has no VideoDecoder'));
        }
        return;
      }
      case 'frame': {
        this.scheduleAck();
        const proxy = this.proxies.get(msg.id);
        const frame = msg.frame as unknown as DecodedFrameLike;
        if (!proxy || proxy.closed) {
          frame.close();
          return;
        }
        if (!isVideoFrame(frame)) {
          // Transfer carries the pixels, not the session's routing fields.
          Object.assign(frame, {
            timestamp: msg.timestamp,
            displayWidth: msg.displayWidth,
            displayHeight: msg.displayHeight,
          });
        }
        proxy.handlers.output(frame);
        return;
      }
      case 'dropped': {
        this.proxies.get(msg.id)?.handlers.dropped?.(msg.timestamp);
        return;
      }
      case 'flushed': {
        const proxy = this.proxies.get(msg.id);
        const waiter = proxy?.flushes.get(msg.seq);
        if (!proxy || !waiter) return;
        proxy.flushes.delete(msg.seq);
        if (msg.error === undefined) waiter.resolve();
        else waiter.reject(msg.aborted ? abortError() : new Error(msg.error));
        return;
      }
      case 'error': {
        if (msg.unsupported) {
          this.disable(new TransientDecodeError(`decode worker cannot decode: ${msg.message}`));
          return;
        }
        const proxy = this.proxies.get(msg.id);
        if (!proxy) return;
        const err = new Error(msg.message);
        this.rejectFlushes(proxy, err);
        proxy.handlers.error(err);
        return;
      }
    }
  }

  /** Acknowledge received frames once per turn, releasing worker backpressure. */
  private scheduleAck(): void {
    this.pendingAcks += 1;
    if (this.pendingAcks > 1) return;
    queueMicrotask(() => {
      const count = this.pendingAcks;
      this.pendingAcks = 0;
      if (count > 0) this.send({ op: 'ack', count });
    });
  }

  private armWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = setTimeout(() => this.checkWatchdog(), this.watchdogMs);
  }

  private checkWatchdog(): void {
    this.watchdog = null;
    let pending = false;
    for (const p of this.proxies.values()) if (p.flushes.size > 0) pending = true;
    if (!pending || !this.worker) {
      this.suspect = false;
      return;
    }
    const silent = this.now() - this.lastHeard;
    if (silent < this.watchdogMs) {
      this.watchdog = setTimeout(() => this.checkWatchdog(), this.watchdogMs - silent);
      return;
    }
    // Stale — but a main thread that was itself blocked sees EVERY source as
    // silent, with the replies sitting unread in its queue. Look once more
    // after a yield; any message in between clears the suspicion.
    if (!this.suspect) {
      this.suspect = true;
      this.watchdog = setTimeout(() => this.checkWatchdog(), Math.min(1000, this.watchdogMs));
      return;
    }
    this.crash('decode worker stopped responding');
  }

  private crash(reason: string): void {
    const neverRan = !this.ready;
    this.teardownWorker();
    const err = new TransientDecodeError(reason);
    if (neverRan) {
      // A worker that never reported in did not crash — it never ran (bad
      // bundle URL, blocked module). Restarting it would fail the same way.
      this.disable(err);
      return;
    }
    this.failAll(err);
    const t = this.now();
    this.restarts = this.restarts.filter((r) => t - r < this.restartWindowMs);
    this.restarts.push(t);
    if (this.restarts.length > this.maxRestarts) {
      this.disabled = true;
      return;
    }
    videoDecodeStats.workerRestarts += 1;
    // Restart is lazy: the next decoder request spawns a fresh worker.
  }

  private disable(err: Error): void {
    this.disabled = true;
    this.failAll(err);
    this.teardownWorker();
  }

  private teardownWorker(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    const w = this.worker;
    this.worker = null;
    this.ready = false;
    this.outbox = [];
    this.pendingAcks = 0;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      try {
        w.terminate();
      } catch {
        // already gone
      }
    }
  }

  /** Error every open decoder. Their sessions rebuild on the next request. */
  private failAll(err: Error): void {
    const open = [...this.proxies.values()];
    this.proxies.clear();
    for (const p of open) {
      p.closed = true;
      p.batch = [];
      this.rejectFlushes(p, err);
      p.handlers.error(err);
    }
  }

  private rejectFlushes(proxy: Proxy, err: unknown): void {
    const waiters = [...proxy.flushes.values()];
    proxy.flushes.clear();
    for (const w of waiters) w.reject(err);
  }
}

// ── The render path's IO ─────────────────────────────────────────────

let shared: WorkerDecodeClient | null = null;
let workerEnabled = true;

/** Kill switch for the decode worker (diagnostics, bisecting a regression). */
export function setVideoDecodeWorkerEnabled(on: boolean): void {
  workerEnabled = on;
  if (!on && shared) {
    shared.dispose();
    shared = null;
  }
}

function killSwitchSet(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('motion-editor.videoDecodeWorker') === 'off';
  } catch {
    return false;
  }
}

/**
 * The DecoderIO the interactive render path decodes through: the shared
 * decode worker where the platform has one, this thread otherwise.
 */
export function renderDecodeIO(): DecoderIO {
  if (!workerEnabled || typeof Worker === 'undefined' || !webCodecsAvailable() || killSwitchSet()) {
    return webCodecsIO;
  }
  if (!shared) {
    shared = new WorkerDecodeClient({
      spawn: async () => (await import('./spawnDecodeWorker')).spawnDecodeWorker() as unknown as WorkerLike,
    });
  }
  return shared;
}
