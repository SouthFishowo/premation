/**
 * Exact random access to a video's frames: the decoder session over a demuxed
 * MP4. Ask for presentation frame N, get the decoded frame for exactly N —
 * not "wherever the element landed after seeking", which is the contract the
 * HTMLVideoElement path (videoFrameCache.ts) could never make.
 *
 * ── The seek shape ───────────────────────────────────────────────────────────
 *
 * Every request decodes one GOP prefix: configure once, feed samples in decode
 * order from the GOP's keyframe through the target's feed-through index (both
 * from frameIndex.ts), then `flush()`. Flush is doing two jobs there. It
 * forces the decoder to emit everything buffered — without it a conservative
 * decoder holds the target frame hostage waiting for input that never comes —
 * and it resets the decoder to needing a key chunk next, which is exactly what
 * the next random access will feed. Random access and flush-per-request are
 * the same design, not a coincidence.
 *
 * That makes a naive step-forward quadratic in GOP length (frame k re-decodes
 * k+1 samples), which is why every frame the flush emits is CACHED, not just
 * the target: decoding frame 7 of a GOP yields frames 0–7, so stepping
 * forward hits the cache built by the previous step. The cache owns its
 * frames — callers draw them and must NOT close them; eviction and `close()`
 * do. (Unless the caller asks to `take` one — see `FrameRequest`.)
 *
 * ── Latest-wins seeks ────────────────────────────────────────────────────────
 *
 * Requests are serialized — a decoder is one machine, not a pool. Serial is
 * right for a tracker walking frames and wrong for a scrub: a playhead dragged
 * across a 4K clip asks for a new frame every vsync, each one a GOP decode
 * that costs more than a vsync, and a plain queue decodes EVERY one of them in
 * order. The picture then trails the pointer by seconds and keeps moving after
 * the mouse stops. So a request may join the `latest` lane, where a newer seek
 * supersedes the older ones: queued work is dropped before it starts, and an
 * in-flight GOP decode is stopped (decoder `reset()`, or a fresh decoder) when
 * finishing it would cost more than it is worth:
 *
 *   - never when it will produce a target that is still wanted (same GOP, at
 *     or before its own target, inside the retain window);
 *   - never when nothing has been delivered for `starvationMs` — a drag
 *     across long 4K GOPs would otherwise abort every decode on the next
 *     vsync and show nothing at all until the pointer stops;
 *   - otherwise only when its estimated remaining time (a per-source EMA of
 *     decode ms per fed chunk) exceeds `keepInFlightMs`. A decode about to
 *     land is left to land: that frame is real, exact for its own index, and
 *     is the picture the user sees while the newest seek decodes.
 *
 * A kept in-flight decode RESOLVES (its frame is exact for what it asked); an
 * aborted or dropped one rejects. The newest request always runs next, so the
 * session converges on the latest frame either way.
 *
 * "Newer" is decided per synchronous TURN, not per call. One render asks for
 * several frames of the same source at once — Pixel Motion's bracket pair, a
 * pulldown weave's two carriers, the same clip on two layers — and those must
 * not cancel each other or nothing would ever land. Every latest-lane request
 * made before the current turn's microtask checkpoint shares a generation; the
 * checkpoint then drops whatever the turn did not ask for again. A turn that
 * only re-asks for frames already in flight (`renew`) keeps them, which is
 * what lets a convergence loop that re-renders the same frame settle.
 *
 * Superseded requests REJECT with `SupersededError`; they never resolve with a
 * frame. Callers outside the latest lane (export's private caches, the
 * tracker, every walk) are never superseded, so exactness is unchanged there.
 *
 * ── Why the decoder is injected ──────────────────────────────────────────────
 *
 * jsdom has no WebCodecs, and this machine's automation pane cannot composite
 * — so `VideoDecoder` itself is unreachable from any test that runs here. The
 * session therefore talks to a `DecoderIO` seam (same move FrameBlobStore made
 * for IndexedDB): tests pin the ENTIRE feeding discipline — key-first, decode
 * order, right range, flush, cache, eviction, cancellation, error paths —
 * against a fake, and the default IO is a thin adapter over the real WebCodecs
 * globals with nothing in it worth testing. Byte-level decode correctness needs
 * a real Chromium; everything decidable above the codec is decided here. The
 * off-main-thread IO (`workerDecoderIO.ts`) plugs into the same seam.
 */

import { buildFrameIndex, frameAtTime, type VideoFrameIndex } from './frameIndex';
import type { DemuxedVideo } from './mp4Demuxer';
import { videoDecodeStats } from './decodeStats';

/** What the session needs from a decoded frame. The real object is a
 *  `VideoFrame` (drawable via drawImage and carrying displayWidth/Height);
 *  the session itself only routes by timestamp and manages lifetime. */
export interface DecodedFrameLike {
  /** Presentation time, µs — round-trips the chunk timestamp we fed. */
  readonly timestamp: number | null;
  close(): void;
}

export interface EncodedChunkInit {
  type: 'key' | 'delta';
  /** Presentation time µs of the frame this sample displays as. */
  timestamp: number;
  durationUs: number;
  data: Uint8Array;
}

/**
 * Advisory output routing for one decode request. An IO that can act on it
 * early (the decode worker, which would otherwise copy every frame of a long
 * GOP prefix just for the session to close most of them) may; the session
 * enforces the same rules itself either way, so ignoring hints is correct.
 */
export interface OutputHints {
  /** The consumer closes any output presenting before this time. An IO may
   *  drop such frames without delivering them, but must then call the
   *  `dropped` handler so output counts still add up. */
  floorUs: number;
  /** The single output the consumer wants as the decoder's own frame (for a
   *  direct GPU upload) rather than as a retained copy. */
  rawUs?: number;
}

export interface VideoDecoderLike {
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
  /**
   * Abandon everything queued: pending decodes are discarded, a pending
   * `flush()` rejects, and the decoder is ready for a key chunk again (the IO
   * re-applies its configuration). Optional — without it the session closes
   * the decoder and builds a new one, which is correct and merely slower.
   */
  reset?(): void;
  setOutputHints?(hints: OutputHints): void;
}

export interface DecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
  /**
   * WebCodecs acceleration preference. Playback/scrub keep the default
   * (hardware when available — lowest decode latency). The TRACKER asks for
   * 'prefer-software': its per-frame `copyTo` readback of a hardware 4K
   * frame costs ~60ms of GPU sync, while a software frame is already in CPU
   * memory and copies in ~2ms — the decode itself is slower but the total
   * is ~3× faster, with spec-identical pixels.
   */
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
}

export interface DecoderHandlers {
  output: (frame: DecodedFrameLike) => void;
  error: (e: Error) => void;
  /** An output the IO dropped below the hint floor (see `OutputHints`). */
  dropped?: (timestamp: number) => void;
}

/** The injectable seam between the session and WebCodecs. */
export interface DecoderIO {
  createDecoder(config: DecoderConfig, handlers: DecoderHandlers): VideoDecoderLike;
  createChunk(init: EncodedChunkInit): unknown;
  /**
   * Convert a decoder-owned frame into a CACHEABLE one, closing the original.
   *
   * Hardware decoders own a fixed pool of output buffers, and every unclosed
   * `VideoFrame` pins one. Hold ~10 and the decoder's `flush()` stalls FOREVER
   * — which surfaced as Track Motion "freezing at 2–4%" and would hang exact
   * scrubbing the same way. So the session never caches raw VideoFrames —
   * with ONE exception, bounded to a single frame per session: the target a
   * caller asked to `take` as `raw` (see `FrameRequest`).
   *
   * SYNCHRONOUS, and that is the load-bearing half of the contract. This runs
   * inside the decoder's `output` callback and the original frame must be
   * closed before control leaves it — an `await` anywhere between output and
   * `close()` is exactly the pool stall above. That rules out
   * `createImageBitmap`, which is async; see the production adapter for the
   * synchronous route it takes instead.
   *
   * The jsdom tests omit this hook entirely (identity), as fake frames have no
   * pool to exhaust.
   */
  retain?: (frame: DecodedFrameLike) => DecodedFrameLike;
  /**
   * True when `frame` pins a decoder output buffer (a real `VideoFrame`).
   * Defaults to an `instanceof VideoFrame` check; fakes override it to test
   * the raw-frame bookkeeping without WebCodecs.
   */
  isDecoderOwned?: (frame: DecodedFrameLike) => boolean;
}

/** How a caller wants one random-access frame delivered. */
export interface FrameRequest {
  /** Join the latest-wins lane (scrubbing): a newer turn's seeks supersede
   *  this one. See the header. */
  latest?: boolean;
  /** Hand ownership of the frame to the caller. The session forgets it (no
   *  eviction will close it); the caller must `close()` it exactly once. */
  take?: boolean;
  /** With `take`: deliver the target as the decoder's own frame when the IO
   *  produces one, so it can go to the GPU without a CPU-side copy. At most
   *  one such frame is ever held by the session. */
  raw?: boolean;
}

/** Rejection for a latest-lane request a newer seek replaced. Not a decode
 *  failure — callers must not count it toward giving up on a source. */
export class SupersededError extends Error {
  constructor(target: number) {
    super(`frame request #${target} superseded by a newer seek`);
    this.name = 'SupersededError';
  }
}

export function isSuperseded(e: unknown): boolean {
  return e instanceof Error && e.name === 'SupersededError';
}

/**
 * A decode that failed for reasons that say nothing about the bitstream: the
 * decode worker crashed, hung, or could not start. The request is worth
 * repeating (on a restarted worker or on this thread), so callers must not
 * count it as the codec failing.
 */
export class TransientDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientDecodeError';
  }
}

export function isTransientDecodeError(e: unknown): boolean {
  return e instanceof Error && e.name === 'TransientDecodeError';
}

/** True for a real WebCodecs `VideoFrame` (and never in jsdom). */
export function isVideoFrame(frame: unknown): frame is VideoFrame {
  return typeof VideoFrame === 'function' && frame instanceof VideoFrame;
}

/** True when the platform can run the exact path at all. */
export function webCodecsAvailable(): boolean {
  const g = globalThis as { VideoDecoder?: unknown; EncodedVideoChunk?: unknown };
  return typeof g.VideoDecoder === 'function' && typeof g.EncodedVideoChunk === 'function';
}

/**
 * The synchronous copy route shared by the in-thread adapter and the decode
 * worker: VideoFrame → pooled OffscreenCanvas → `transferToImageBitmap()`,
 * closing the original. See `webCodecsIO.retain` for why each step is what
 * it is.
 */
export function retainFrameCopy(frame: DecodedFrameLike): DecodedFrameLike {
  const f = frame as unknown as { displayWidth?: number; displayHeight?: number; codedWidth?: number; codedHeight?: number };
  const w = f.displayWidth || f.codedWidth || 2;
  const h = f.displayHeight || f.codedHeight || 2;
  const timestamp = frame.timestamp;

  // ── The synchronous ImageBitmap route ──────────────────────
  //
  // Draw into a pooled OffscreenCanvas, then `transferToImageBitmap()` —
  // synchronous, and it hands back a CLOSEABLE, TRANSFERABLE bitmap. That
  // matters twice. Holding one 2D canvas per cached frame put the cache
  // against Chromium's accelerated-canvas budget, whose response to pressure
  // is to discard backing stores or drop to software raster SILENTLY, which
  // is what "quality degrades gradually across a long session" looks like
  // from the outside. And a transferable frame is what decoding in a worker
  // needs to hand back — which it now does (decodeWorkerCore.ts).
  //
  // `createImageBitmap` would be the obvious call and cannot be used here:
  // it is async, and an await between the decoder's `output` and
  // `frame.close()` pins a hardware pool slot — the stall this seam exists
  // to avoid, and the one that surfaced as Track Motion freezing at 2–4%.
  //
  // ALPHA IS A NON-ISSUE ON THIS PATH, written down because the two upload
  // routes treat premultiply differently: a 2D canvas is converted at upload,
  // while an ImageBitmap carries its own state and WebGL2's unpack flag is
  // ignored for it. The `drawImage` below is unchanged, so the bitmap
  // inherits the canvas's premultiplied backing store either way — and
  // nothing arriving here has alpha at all. The exact loader REFUSES alpha
  // WebM outright (see `defaultLoader` in exactVideoFrames.ts: "alpha WebM —
  // element path preserves transparency"), so every frame retained here is
  // opaque and premultiply is the identity.
  //
  // `transferToImageBitmap` transfers the backing store and leaves the canvas
  // blank at the same size, so the pool hands back clean surfaces with no
  // clear of its own.
  const off = offscreenFor(w, h);
  if (off) {
    const ctx = off.getContext('2d');
    if (ctx) {
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
      const bitmap = off.transferToImageBitmap();
      frame.close();
      // The bitmap IS the frame: a CanvasImageSource with a real `close()` on
      // its prototype — so eviction frees it explicitly instead of leaving it
      // to GC — plus the session's routing fields.
      return Object.assign(bitmap, {
        timestamp,
        displayWidth: w,
        displayHeight: h,
      }) as unknown as DecodedFrameLike;
    }
  }

  // No OffscreenCanvas (older runtime, jsdom): the original canvas route,
  // which is correct and merely holds more GPU-backed surfaces. A worker has
  // no `document` either; there the frame stays as it is.
  if (typeof document === 'undefined') return frame;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // No 2D context (headless edge case): better a pool-pinned frame than
    // no frame at all — the old behaviour, with its old risk.
    return frame;
  }
  ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
  frame.close();
  return Object.assign(canvas, {
    timestamp,
    displayWidth: w,
    displayHeight: h,
    close(): void { /* plain memory — GC handles it */ },
  }) as unknown as DecodedFrameLike;
}

/** The production adapter: deliberately nothing but plumbing. */
export const webCodecsIO: DecoderIO = {
  createDecoder(config, handlers) {
    type Native = VideoDecoderLike & { configure(c: object): void; reset(): void };
    type Ctor = new (init: {
      output: (frame: DecodedFrameLike) => void;
      error: (e: Error) => void;
    }) => Native;
    const g = globalThis as unknown as { VideoDecoder: Ctor };
    const decoder = new g.VideoDecoder({ output: handlers.output, error: handlers.error });
    const native = {
      codec: config.codec,
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      ...(config.description ? { description: config.description } : {}),
      ...(config.hardwareAcceleration ? { hardwareAcceleration: config.hardwareAcceleration } : {}),
    };
    decoder.configure(native);
    return {
      decode: (chunk) => decoder.decode(chunk),
      flush: () => decoder.flush(),
      close: () => decoder.close(),
      // WebCodecs `reset()` leaves the decoder UNCONFIGURED; the session's
      // contract is "ready for a key chunk", so the configuration goes back on.
      reset: () => {
        decoder.reset();
        decoder.configure(native);
      },
    };
  },
  createChunk(init) {
    type Ctor = new (i: object) => unknown;
    const g = globalThis as unknown as { EncodedVideoChunk: Ctor };
    return new g.EncodedVideoChunk({
      type: init.type,
      timestamp: init.timestamp,
      duration: init.durationUs,
      data: init.data,
    });
  },
  retain: retainFrameCopy,
};

/**
 * Pooled draw surfaces for {@link retainFrameCopy}.
 *
 * `transferToImageBitmap` empties the canvas without resizing it, so a surface
 * is reusable the instant its bitmap has been taken. Pooling matters because
 * streaming playback retains 30–60 frames a second, and allocating a full-res
 * OffscreenCanvas per frame is pure allocator churn — the same reasoning as the
 * canvas pool in `exactVideoFrames`, and the same small ceiling: a handful of
 * distinct frame sizes is all any project has on screen at once.
 */
const offscreenPool: OffscreenCanvas[] = [];
const OFFSCREEN_POOL_MAX = 4;

/** Drop the pooled surfaces. Tests only — production has one implementation
 *  of `OffscreenCanvas` and never needs to forget it. */
export function resetRetainSurfacePool(): void {
  offscreenPool.length = 0;
}

function offscreenFor(w: number, h: number): OffscreenCanvas | null {
  if (typeof OffscreenCanvas !== 'function') return null;
  for (const c of offscreenPool) {
    if (c.width === w && c.height === h) return c;
  }
  let c: OffscreenCanvas;
  try {
    c = new OffscreenCanvas(w, h);
  } catch {
    return null;
  }
  // `transferToImageBitmap` is what makes the synchronous route possible; a
  // runtime with OffscreenCanvas but without it falls back to the canvas.
  if (typeof c.transferToImageBitmap !== 'function') return null;
  if (offscreenPool.length >= OFFSCREEN_POOL_MAX) offscreenPool.shift();
  offscreenPool.push(c);
  return c;
}

/** Tuning for the latest-wins in-flight policy (see the header). */
export interface SeekPolicy {
  /** An in-flight decode estimated to land within this many ms is kept. */
  keepInFlightMs?: number;
  /** With nothing delivered for this long, in-flight decodes are never
   *  aborted — continuous scrubbing still shows intermediate frames. */
  starvationMs?: number;
  now?: () => number;
}

const DEFAULT_KEEP_IN_FLIGHT_MS = 120;
const DEFAULT_STARVATION_MS = 400;
/** Decode cost per fed chunk before anything was measured: a mid-range
 *  hardware 4K decode. Refined per source by an EMA of real flushes. */
const INITIAL_MS_PER_CHUNK = 4;

/** Frames a single flush can strand in cache beyond the configured budget:
 *  the budget must never evict frames of the GOP being decoded RIGHT NOW, or
 *  a long GOP would evict its own target before frameAt returns it. */
const MIN_CACHE = 4;

/** The timestamp-routing tables both session classes need, built once per
 *  demux. A SequentialFrameReader used to rebuild the whole index — an
 *  O(n log n) sort over every sample — on EVERY construction, i.e. every
 *  loop wrap of every playing clip, although ExactVideoSource had already
 *  built the identical structure. Keyed weakly so a dropped demux frees it. */
interface DemuxRouting {
  index: VideoFrameIndex;
  /** decode index → presentation time µs (the chunk timestamp to feed). */
  timeUsOfDecodeIndex: number[];
  /** presentation time µs → presentation index (output frame routing). */
  presIndexByTimeUs: Map<number, number>;
}

const routingCache = new WeakMap<DemuxedVideo, DemuxRouting>();

function routingFor(demuxed: DemuxedVideo): DemuxRouting {
  let r = routingCache.get(demuxed);
  if (!r) {
    const index = buildFrameIndex(demuxed.samples, demuxed.timescale);
    const timeUsOfDecodeIndex = new Array<number>(demuxed.samples.length).fill(0);
    const presIndexByTimeUs = new Map<number, number>();
    index.frames.forEach((f, presIdx) => {
      timeUsOfDecodeIndex[f.decodeIndex] = f.timeUs;
      presIndexByTimeUs.set(f.timeUs, presIdx);
    });
    r = { index, timeUsOfDecodeIndex, presIndexByTimeUs };
    routingCache.set(demuxed, r);
  }
  return r;
}

/** One queued or running random-access request. */
interface SeekJob {
  target: number;
  req: FrameRequest;
  /** Latest-lane turn this job was last asked for in. */
  gen: number;
  /** Settled early (superseded or closed): the decode may still finish, but
   *  must neither resolve this job nor hand it a frame. */
  settled: boolean;
  promise: Promise<DecodedFrameLike>;
  resolve: (f: DecodedFrameLike) => void;
  reject: (e: unknown) => void;
}

export class ExactVideoSource {
  readonly index: VideoFrameIndex;
  private readonly timeUsOfDecodeIndex: number[];
  private readonly presIndexByTimeUs: Map<number, number>;
  private cache = new Map<number, DecodedFrameLike>();
  private lru: number[] = [];
  private decoder: VideoDecoderLike | null = null;
  private failure: Error | null = null;
  private closed = false;

  private currentTarget = -1;

  /** Requests waiting for the decoder, oldest first. */
  private queue: SeekJob[] = [];
  /** The request the decoder is working on. */
  private active: SeekJob | null = null;
  /** Stops the active GOP decode's flush wait (set only while one runs). */
  private stopActive: (() => void) | null = null;
  private pumpScheduled = false;
  /** Latest-lane generation and whether the current turn has opened one. */
  private gen = 0;
  private turnOpen = false;
  /** Presentation index of the ONE decoder-owned frame in cache, or -1. */
  private rawIdx = -1;
  /** In-flight cost estimate inputs (see `shouldAbort`). */
  private activeStartedAt = 0;
  private activeChunks = 0;
  private msPerChunk = INITIAL_MS_PER_CHUNK;
  private costMeasured = false;
  private lastDeliveredAt = -Infinity;
  private readonly keepInFlightMs: number;
  private readonly starvationMs: number;
  private readonly now: () => number;

  constructor(
    private readonly demuxed: DemuxedVideo,
    private readonly io: DecoderIO = webCodecsIO,
    // Cached frames are COPIES in production (an ImageBitmap; see
    // DecoderIO.retain), so the budget is plain memory, not decoder pool slots
    // — but at 1080p each copy is ~8MB, so the budget stays small. The
    // byte-budgeted tier above (exactVideoFrames) is the real cache; this one
    // only smooths stepping.
    private readonly maxCached = 12,
    policy: SeekPolicy = {},
  ) {
    const routing = routingFor(demuxed);
    this.index = routing.index;
    this.timeUsOfDecodeIndex = routing.timeUsOfDecodeIndex;
    this.presIndexByTimeUs = routing.presIndexByTimeUs;
    this.keepInFlightMs = policy.keepInFlightMs ?? DEFAULT_KEEP_IN_FLIGHT_MS;
    this.starvationMs = policy.starvationMs ?? DEFAULT_STARVATION_MS;
    this.now = policy.now ?? (() => performance.now());
  }

  get frameCount(): number {
    return this.index.frames.length;
  }

  get durationUs(): number {
    return this.index.durationUs;
  }

  timeUsOf(presIdx: number): number {
    return this.index.frames[this.clamp(presIdx)]?.timeUs ?? 0;
  }

  frameIndexAt(timeUs: number): number {
    return frameAtTime(this.index, timeUs);
  }

  /**
   * The decoded frame for presentation index `presIdx` (clamped to the clip).
   * Unless `req.take` is set, the returned frame is owned by this source's
   * cache: draw it, don't close it. Requests are serialized — a decoder is one
   * machine, not a pool — and `req.latest` requests are superseded by newer
   * turns (see the header).
   */
  frameAt(presIdx: number, req: FrameRequest = {}): Promise<DecodedFrameLike> {
    if (this.closed) return Promise.reject(new Error('ExactVideoSource is closed'));
    const target = this.clamp(presIdx);
    const request: FrameRequest = { ...req, raw: !!(req.raw && req.take) };
    if (request.latest) {
      this.openTurn();
      const same = this.latestJobFor(target);
      if (same && !!same.req.take === !!request.take && !!same.req.raw === request.raw) {
        same.gen = this.gen;
        return same.promise;
      }
    }
    let resolve!: (f: DecodedFrameLike) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<DecodedFrameLike>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.queue.push({ target, req: request, gen: this.gen, settled: false, promise, resolve, reject });
    videoDecodeStats.seekRequests += 1;
    this.schedulePump();
    return promise;
  }

  /**
   * Mark a latest-lane request as still wanted in the current turn, without
   * issuing a new one. Returns false when no such request is pending (it
   * landed, failed, or was already superseded) — the caller then asks again.
   */
  renew(presIdx: number): boolean {
    if (this.closed) return false;
    this.openTurn();
    const job = this.latestJobFor(this.clamp(presIdx));
    if (!job) return false;
    job.gen = this.gen;
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const closedErr = new Error('ExactVideoSource is closed');
    for (const job of this.queue) this.settleEarly(job, closedErr);
    this.queue = [];
    if (this.active) this.settleEarly(this.active, closedErr);
    this.stopActive?.();
    try {
      this.decoder?.close();
    } catch {
      // A decoder that errored is already closed; closing twice throws.
    }
    this.decoder = null;
    for (const f of this.cache.values()) f.close();
    this.cache.clear();
    this.lru = [];
    this.rawIdx = -1;
  }

  private clamp(i: number): number {
    return Math.max(0, Math.min(this.frameCount - 1, Math.floor(i)));
  }

  // ── Scheduling ─────────────────────────────────────────────────────

  private latestJobFor(target: number): SeekJob | undefined {
    const a = this.active;
    if (a && !a.settled && a.req.latest && a.target === target) return a;
    return this.queue.find((j) => j.req.latest && j.target === target);
  }

  /** Open this turn's generation; its microtask checkpoint sweeps. The sweep
   *  is queued BEFORE any pump this turn schedules, so nothing stale starts. */
  private openTurn(): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.gen += 1;
    queueMicrotask(() => {
      this.turnOpen = false;
      this.sweep();
    });
  }

  /** Drop latest-lane work the newest turn did not ask for. */
  private sweep(): void {
    if (this.closed) return;
    const live = this.gen;
    const kept: SeekJob[] = [];
    for (const job of this.queue) {
      if (job.req.latest && job.gen < live) {
        videoDecodeStats.superseded += 1;
        this.settleEarly(job, new SupersededError(job.target));
      } else {
        kept.push(job);
      }
    }
    this.queue = kept;

    const a = this.active;
    if (!a || a.settled || !a.req.latest || a.gen >= live) return;
    // The running decode emits every frame of its GOP presenting at or before
    // its target (feed-through is the running max — see frameIndex.ts), and
    // keeps the ones inside the retain window. When a request still wanted
    // lands in that span, stopping the decode would only throw away the
    // frame about to be asked for; let it finish and serve it from cache.
    if (this.queue.some((j) => this.covers(a.target, j.target))) return;
    if (!this.shouldAbort()) return;
    videoDecodeStats.superseded += 1;
    this.settleEarly(a, new SupersededError(a.target));
    this.abortInFlight();
  }

  /** Stop a superseded, uncovered in-flight decode? See the header. */
  private shouldAbort(): boolean {
    const t = this.now();
    // 0 disables the guard (tests, and callers that want strict latest-wins).
    if (this.starvationMs > 0 && t - this.lastDeliveredAt >= this.starvationMs) return false;
    const remaining = this.activeChunks * this.msPerChunk - (t - this.activeStartedAt);
    return remaining > this.keepInFlightMs;
  }

  private covers(activeTarget: number, target: number): boolean {
    const a = this.index.frames[activeTarget];
    const f = this.index.frames[target];
    if (!a || !f || f.keyDecodeIndex !== a.keyDecodeIndex) return false;
    return target <= activeTarget && target > activeTarget - this.budget;
  }

  private get budget(): number {
    return Math.max(MIN_CACHE, this.maxCached);
  }

  /** Settle a job before its decode completes. Idempotent. */
  private settleEarly(job: SeekJob, err: unknown): void {
    if (job.settled) return;
    job.settled = true;
    job.reject(err);
  }

  /** Stop the in-flight GOP decode: nothing more is decoded for it. */
  private abortInFlight(): void {
    videoDecodeStats.abortedDecodes += 1;
    const d = this.decoder;
    if (d?.reset) {
      try {
        d.reset();
      } catch {
        this.dropDecoder();
      }
    } else {
      this.dropDecoder();
    }
    this.stopActive?.();
  }

  private dropDecoder(): void {
    try {
      this.decoder?.close();
    } catch {
      // already closed
    }
    this.decoder = null;
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.active) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    while (!this.active && this.queue.length > 0 && !this.closed) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      this.active = job;
      try {
        await this.decodeOp(job);
      } catch (e) {
        this.settleEarly(job, e);
      } finally {
        this.active = null;
      }
    }
  }

  // ── Decoding ───────────────────────────────────────────────────────

  private ensureDecoder(): VideoDecoderLike {
    if (this.decoder) return this.decoder;
    // Handlers are bound to THIS decoder instance: outputs or errors arriving
    // from a decoder the session already abandoned (aborted, errored) close
    // their frame and change nothing.
    let mine: VideoDecoderLike | null = null;
    mine = this.io.createDecoder(
      {
        codec: this.demuxed.codec,
        codedWidth: this.demuxed.codedWidth,
        codedHeight: this.demuxed.codedHeight,
        ...(this.demuxed.description ? { description: this.demuxed.description } : {}),
      },
      {
        output: (frame) => {
          if (mine !== this.decoder) {
            frame.close();
            return;
          }
          this.onOutput(frame);
        },
        error: (e) => {
          if (mine === this.decoder) this.failure = e;
        },
        dropped: () => {
          videoDecodeStats.framesDropped += 1;
        },
      },
    );
    this.decoder = mine;
    return mine;
  }

  private async decodeOp(job: SeekJob): Promise<void> {
    if (this.closed) throw new Error('ExactVideoSource is closed');
    if (this.frameCount === 0) throw new Error('no frames in source');
    const target = job.target;
    if (this.cache.has(target)) {
      videoDecodeStats.seekHits += 1;
      this.touch(target);
      this.deliver(job, target);
      return;
    }

    const entry = this.index.frames[target]!;
    this.failure = null;
    // onOutput's retain window is anchored on the frame being sought.
    this.currentTarget = target;
    const decoder = this.ensureDecoder();
    decoder.setOutputHints?.({
      floorUs: this.timeUsOf(Math.max(0, target - this.budget + 1)),
      ...(job.req.raw ? { rawUs: entry.timeUs } : {}),
    });

    let stopped = false;
    const stop = new Promise<void>((res) => {
      this.stopActive = () => {
        stopped = true;
        res();
      };
    });
    this.activeStartedAt = this.now();
    this.activeChunks = entry.feedThroughDecodeIndex - entry.keyDecodeIndex + 1;
    try {
      for (let d = entry.keyDecodeIndex; d <= entry.feedThroughDecodeIndex; d++) {
        const s = this.demuxed.samples[d]!;
        decoder.decode(
          this.io.createChunk({
            type: s.isKey ? 'key' : 'delta',
            timestamp: this.timeUsOfDecodeIndex[d]!,
            durationUs: Math.round((s.duration * 1e6) / this.demuxed.timescale),
            data: s.data,
          }),
        );
      }
      videoDecodeStats.seekDecodes += 1;
      // A reset decoder rejects its flush; a decoder with no reset is closed
      // and may never settle it at all — `stop` is what ends the wait either
      // way, so an abort can never wedge the queue behind it.
      await Promise.race([decoder.flush(), stop]);
    } catch (e) {
      if (!stopped) this.failure = this.failure ?? (e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.stopActive = null;
    }

    // Aborted or closed: the job is already settled; the frames that did land
    // are exact and stay cached.
    if (stopped || job.settled) return;

    if (this.failure) {
      // An errored decoder is dead; the next request builds a fresh one.
      this.dropDecoder();
      throw this.failure;
    }

    // Measured cost of this GOP prefix, per chunk — the abort policy's
    // estimate. An EMA so one slow outlier (first decode, a GC) fades.
    // The first real measurement replaces the initial guess outright.
    const perChunk = (this.now() - this.activeStartedAt) / Math.max(1, this.activeChunks);
    if (Number.isFinite(perChunk) && perChunk >= 0) {
      this.msPerChunk = this.costMeasured ? this.msPerChunk * 0.7 + perChunk * 0.3 : perChunk;
      this.costMeasured = true;
    }

    this.evictOver(target);
    if (!this.cache.has(target)) {
      // The feed range was right and the decoder still didn't produce the
      // frame — surface it; a silent nearest-neighbour here would rebuild the
      // exact imprecision this subsystem exists to remove.
      throw new Error(`decoder produced no frame for #${target}`);
    }
    this.touch(target);
    this.deliver(job, target);
  }

  /** Resolve a job from cache, handing ownership over when it asked to take. */
  private deliver(job: SeekJob, target: number): void {
    if (job.settled) return;
    let frame = this.cache.get(target)!;
    if (job.req.take) {
      this.cache.delete(target);
      const i = this.lru.indexOf(target);
      if (i >= 0) this.lru.splice(i, 1);
      if (this.rawIdx === target) {
        if (!job.req.raw) {
          // A take that did not ask for the decoder's frame gets a copy.
          frame = this.io.retain ? this.io.retain(frame) : frame;
        }
        this.rawIdx = -1;
      }
    } else if (this.rawIdx === target) {
      // A borrower must never be handed a pool-pinned frame the cache keeps.
      this.demoteRaw();
      frame = this.cache.get(target)!;
    }
    job.settled = true;
    this.lastDeliveredAt = this.now();
    job.resolve(frame);
  }

  private isDecoderOwned(frame: DecodedFrameLike): boolean {
    return this.io.isDecoderOwned ? this.io.isDecoderOwned(frame) : isVideoFrame(frame);
  }

  /** Replace the cached decoder-owned frame with a retained copy. */
  private demoteRaw(): void {
    const idx = this.rawIdx;
    this.rawIdx = -1;
    const f = this.cache.get(idx);
    if (f && this.io.retain) this.cache.set(idx, this.io.retain(f));
  }

  private onOutput(frame: DecodedFrameLike): void {
    videoDecodeStats.framesOutput += 1;
    const presIdx = frame.timestamp === null ? undefined : this.presIndexByTimeUs.get(frame.timestamp);
    if (presIdx === undefined) {
      frame.close();
      return;
    }
    // Close frames outside the retain window IMMEDIATELY — before flush
    // resolves. A long GOP prefix otherwise accumulates dozens of open
    // decoder-owned frames mid-flush, exhausts the hardware output pool, and
    // the flush never returns (the Track Motion freeze). Eviction after the
    // fact cannot fix that; the frames must never pile up in the first place.
    if (this.currentTarget >= 0 && presIdx <= this.currentTarget - this.budget) {
      frame.close();
      return;
    }
    const a = this.active;
    const keepRaw = !!a && !a.settled && !!a.req.raw && presIdx === this.currentTarget && this.isDecoderOwned(frame);
    let kept: DecodedFrameLike;
    if (keepRaw) {
      // Bounded to ONE per session: an older raw frame (a superseded seek's
      // target nobody took) becomes a copy before this one is admitted.
      if (this.rawIdx >= 0 && this.rawIdx !== presIdx) this.demoteRaw();
      kept = frame;
    } else {
      kept = this.io.retain ? this.io.retain(frame) : frame;
    }
    const prior = this.cache.get(presIdx);
    if (prior && prior !== kept) prior.close();
    if (keepRaw) this.rawIdx = presIdx;
    else if (this.rawIdx === presIdx) this.rawIdx = -1;
    this.cache.set(presIdx, kept);
    this.touch(presIdx);
  }

  private touch(presIdx: number): void {
    const i = this.lru.indexOf(presIdx);
    if (i >= 0) this.lru.splice(i, 1);
    this.lru.push(presIdx);
  }

  private evictOver(protect: number): void {
    while (this.lru.length > this.budget) {
      const victimAt = this.lru[0] === protect ? 1 : 0;
      const victim = this.lru[victimAt];
      if (victim === undefined) break;
      this.lru.splice(victimAt, 1);
      const f = this.cache.get(victim);
      if (f) {
        f.close();
        this.cache.delete(victim);
        if (this.rawIdx === victim) this.rawIdx = -1;
      }
    }
  }
}

// ── Sequential streaming reader ──────────────────────────────────────
//
// `frameAt` is RANDOM access: every request decodes its GOP prefix and
// flushes. A tracking walk calling it per frame therefore re-decodes an
// ever-longer prefix each step — quadratic in GOP length, which turned Track
// Motion on real footage (GOPs of 100–300 frames) into a crawl even before
// the pool hang. A sequential consumer needs the opposite shape: feed the
// stream ONCE, receive frames in presentation order, copy, close, next.

/** Fed-but-not-yet-output cap. Must comfortably exceed the codec's reorder
 *  depth (B-pyramids can run past 8) or feeding would stall waiting for
 *  output that needs more input. These are COMPRESSED chunks in flight, not
 *  open frames, so generous is cheap. */
const WALK_FEED_AHEAD = 24;
/** Decoded-and-queued frames waiting for the consumer. Each is an open
 *  decoder-pool frame, so this stays well under the ~10-slot hardware pools. */
const WALK_QUEUE_MAX = 4;

/**
 * Decode presentation frames `from..to` (inclusive, forward only) exactly
 * once each, in order.
 *
 * Contract: requests via {@link SequentialFrameReader.frameAt} must be
 * NON-DECREASING; the returned frame is valid only until the next call
 * (the reader closes it then) — unless the caller claims it with
 * {@link SequentialFrameReader.release}. Copy what you need, immediately.
 */
export class SequentialFrameReader {
  private readonly index: VideoFrameIndex;
  private readonly presIndexByTimeUs: Map<number, number>;
  private readonly timeUsOfDecodeIndex: number[];
  private readonly from: number;
  private readonly to: number;
  private readonly feedEnd: number;
  private decoder: VideoDecoderLike | null = null;
  private d: number; // next decode index to feed
  private fed = 0;
  private outputs = 0;
  private flushCalled = false;
  private flushDone = false;
  private failure: Error | null = null;
  private queue: Array<{ presIndex: number; frame: DecodedFrameLike }> = [];
  private current: { presIndex: number; frame: DecodedFrameLike; released?: boolean } | null = null;
  private notify: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly demuxed: DemuxedVideo,
    from: number,
    to: number,
    private readonly io: DecoderIO = webCodecsIO,
    private readonly opts: { hardwareAcceleration?: DecoderConfig['hardwareAcceleration'] } = {},
  ) {
    const routing = routingFor(demuxed);
    this.index = routing.index;
    this.timeUsOfDecodeIndex = routing.timeUsOfDecodeIndex;
    this.presIndexByTimeUs = routing.presIndexByTimeUs;
    const last = this.index.frames.length - 1;
    this.from = Math.max(0, Math.min(last, Math.floor(from)));
    this.to = Math.max(this.from, Math.min(last, Math.floor(to)));
    this.d = this.index.frames[this.from]!.keyDecodeIndex;
    this.feedEnd = this.index.frames[this.to]!.feedThroughDecodeIndex;
  }

  /**
   * The frame for `presIdx` (clamped to [from..to]). Repeating the previous
   * index returns the same frame (freeze frames / slow stretches re-read
   * source frames); indices between the previous request and this one are
   * decoded and discarded (comp walks may skip source frames).
   */
  async frameAt(presIdx: number): Promise<DecodedFrameLike> {
    if (this.closed) throw new Error('SequentialFrameReader is closed');
    const target = Math.max(this.from, Math.min(this.to, Math.floor(presIdx)));
    if (this.current && this.current.presIndex === target) {
      if (this.current.released) throw new Error(`frame #${target} was released to the caller`);
      return this.current.frame;
    }
    if (this.current && target < this.current.presIndex) {
      throw new Error('SequentialFrameReader requests must be non-decreasing');
    }
    for (;;) {
      if (this.closed) throw new Error('SequentialFrameReader is closed');
      this.pump();
      const item = this.queue.shift();
      if (item) {
        if (item.presIndex < target) {
          item.frame.close(); // skipped by the comp walk — decoded, unwanted
          continue;
        }
        this.closeCurrent();
        this.current = item;
        return item.frame;
      }
      if (this.failure) throw this.failure;
      if (this.flushDone) throw new Error(`decode stream ended before frame #${target}`);
      await new Promise<void>((res) => { this.notify = res; });
    }
  }

  /**
   * Transfer ownership of the most recently returned frame to the caller: the
   * reader will not close it on the next request or on `close()`, and the
   * caller must close it exactly once. Returns null when there is nothing to
   * release (no frame yet, or already released).
   */
  release(): DecodedFrameLike | null {
    const c = this.current;
    if (!c || c.released) return null;
    c.released = true;
    return c.frame;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCurrent();
    this.current = null;
    for (const q of this.queue) q.frame.close();
    this.queue = [];
    try {
      this.decoder?.close();
    } catch {
      // errored decoders are already closed
    }
    this.decoder = null;
    // Release a frameAt() parked on `notify` — without this, a caller awaiting
    // the next frame when the reader is killed (every loop wrap and every
    // seek kills the active stream) waits FOREVER: pump() early-returns on
    // `closed`, so no output/flush/error can ever wake it again. The leaked
    // promise then sits in ExactVideoFrameCache.inflight, and the export
    // convergence loop awaits it without a timeout — one prior loop or scrub
    // deadlocked every later export.
    this.wake();
  }

  private closeCurrent(): void {
    const c = this.current;
    if (c && !c.released) c.frame.close();
  }

  private wake(): void {
    const n = this.notify;
    this.notify = null;
    n?.();
  }

  private pump(): void {
    if (this.failure || this.closed) return;
    if (!this.decoder) {
      this.decoder = this.io.createDecoder(
        {
          codec: this.demuxed.codec,
          codedWidth: this.demuxed.codedWidth,
          codedHeight: this.demuxed.codedHeight,
          ...(this.demuxed.description ? { description: this.demuxed.description } : {}),
          ...(this.opts.hardwareAcceleration
            ? { hardwareAcceleration: this.opts.hardwareAcceleration }
            : {}),
        },
        {
          output: (frame) => this.onOutput(frame),
          error: (e) => {
            this.failure = e;
            this.wake();
          },
          // A lead-in frame the IO closed for us still counts as output, or
          // the feed-ahead window would slowly fill with frames that never come.
          dropped: () => {
            this.outputs += 1;
            videoDecodeStats.framesDropped += 1;
            this.wake();
          },
        },
      );
      // Everything before `from` is GOP lead-in this reader closes anyway.
      this.decoder.setOutputHints?.({ floorUs: this.index.frames[this.from]!.timeUs });
    }
    while (
      this.d <= this.feedEnd
      && this.fed - this.outputs < WALK_FEED_AHEAD
      && this.queue.length < WALK_QUEUE_MAX
    ) {
      const s = this.demuxed.samples[this.d]!;
      this.decoder.decode(
        this.io.createChunk({
          type: s.isKey ? 'key' : 'delta',
          timestamp: this.timeUsOfDecodeIndex[this.d]!,
          durationUs: Math.round((s.duration * 1e6) / this.demuxed.timescale),
          data: s.data,
        }),
      );
      this.d += 1;
      this.fed += 1;
    }
    if (this.d > this.feedEnd && !this.flushCalled) {
      this.flushCalled = true;
      this.decoder.flush().then(
        () => {
          this.flushDone = true;
          this.wake();
        },
        (e: unknown) => {
          this.failure = this.failure ?? (e instanceof Error ? e : new Error(String(e)));
          this.flushDone = true;
          this.wake();
        },
      );
    }
  }

  private onOutput(frame: DecodedFrameLike): void {
    this.outputs += 1;
    videoDecodeStats.framesOutput += 1;
    const presIdx = frame.timestamp === null ? undefined : this.presIndexByTimeUs.get(frame.timestamp);
    if (this.closed || presIdx === undefined || presIdx < this.from || presIdx > this.to) {
      frame.close(); // GOP lead-in before `from`, or routing miss
    } else {
      this.queue.push({ presIndex: presIdx, frame });
    }
    this.wake();
  }
}
