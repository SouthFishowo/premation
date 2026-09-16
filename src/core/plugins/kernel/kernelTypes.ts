/**
 * The CPU kernel contract: what a plugin's `render` is handed, and what it owes.
 *
 * ── The shape, and why it is this shape ──────────────────────────────────────
 *
 *   render(input, output, width, height, params, host)
 *
 * Two buffers rather than one mutated in place, because an effect that reads a
 * neighbourhood — every blur, every displacement — reads pixels it has already
 * written if there is only one buffer, and the result is a smear that depends
 * on iteration order. Separate buffers make the common case correct by default
 * and cost one allocation the host reuses anyway.
 *
 * `Float32Array`, not bytes, and PREMULTIPLIED. 32-bit float is what After
 * Effects routes Smart Render through and what the GPU path already works in,
 * so a kernel and its GPU twin can be the same arithmetic; premultiplied is
 * what compositing needs (`a + b·(1−a)` is only linear in premultiplied form)
 * and what the GPU pass hands its shaders. The conversion from and back to the
 * raster path's 8-bit straight-alpha bytes happens at the worker boundary, off
 * the main thread, so a kernel never sees it.
 *
 * ── What `host` is for ───────────────────────────────────────────────────────
 *
 * The same values the GPU kernels read out of the uniform block — the time, the
 * sizes, the rate, a seed — plus the two things only a CPU kernel can have: a
 * compute cache for expensive precomputation, and neighbouring frames.
 *
 * ── What a kernel may NOT do ─────────────────────────────────────────────────
 *
 * Reach anything. The worker it runs in has no host API, no document, no
 * network and no storage; a kernel is a pure function over pixels. That is not
 * a sandbox in the security sense — it is the same structural constraint that
 * keeps effects out of the frame loop: a kernel that could ask the host a
 * question would have to await an answer, inside a render that cannot wait.
 */

/** Everything the host fills in, as a CPU kernel sees it. */
export interface KernelHost {
  /** Composition size in px. */
  compWidth: number;
  compHeight: number;
  /** The layer's size in px — usually, but not always, the buffer size. */
  layerWidth: number;
  layerHeight: number;
  /** The LAYER's own time in seconds. A retimed layer does not share the comp's. */
  time: number;
  /** The playhead, in composition seconds. */
  compTime: number;
  frame: number;
  fps: number;
  /** Raster px per composition px. */
  pixelScale: number;
  /** 1 at full quality, 2 at half, 4 at quarter. */
  downsample: number;
  /** Stable per effect instance, across frames and machines. */
  seed: number;
  /**
   * Neighbouring frames of this layer's own source, when the effect declared a
   * temporal window and the provider could supply them.
   *
   * Keyed by OFFSET — `-1` is the previous frame — and sparse: an offset the
   * provider could not supply is absent rather than zero-filled, because a
   * kernel differencing against a black frame produces a flash at exactly the
   * moments (the first frame, a seek) where the provider is most likely to
   * miss. A kernel must handle a missing neighbour; see `docs/PLUGINS.md`.
   */
  frames?: Record<number, Float32Array>;
  /**
   * Memoised precomputation, scoped to this effect instance.
   *
   * For the work that does not depend on the pixels: a lookup table built from
   * the parameters, a noise field, a kernel of weights. AE has the same thing
   * (`PF_ComputeCacheSuite`) for the same reason — without it every frame of a
   * scrub rebuilds a table that has not changed.
   *
   * The cache lives in the WORKER, so it is per worker rather than global: two
   * workers running the same instance each build their own copy once. Bounded
   * by bytes and evicted least-recently-used, so an effect that keys its cache
   * on something unstable degrades to "no cache" rather than to a leak.
   */
  cache: KernelComputeCache;
}

export interface KernelComputeCache {
  get(key: string): unknown;
  /**
   * @param bytes Roughly how much `value` costs. Used for the budget; a wrong
   *   number is a worse-behaved cache, never a wrong picture. Defaults to a
   *   guess from typed-array byte lengths.
   */
  set(key: string, value: unknown, bytes?: number): void;
}

/** The function a kernel module exports. */
export type KernelRender = (
  input: Float32Array,
  output: Float32Array,
  width: number,
  height: number,
  params: Record<string, unknown>,
  host: KernelHost,
) => void;

/** How a kernel's module arrives at the worker. */
export interface KernelModuleSource {
  /** `<pluginId>/<path>` — the cache key for a compiled module inside a worker. */
  id: string;
  format: 'wasm' | 'js';
  entry: string;
  /** WASM bytes, or JS source text. */
  code: ArrayBuffer | string;
}

/** One unit of work: one layer's pixels through one effect at one time. */
export interface KernelJob {
  /** `<pluginId>.<effectId>` — for attribution in an error. */
  effectId: string;
  module: KernelModuleSource;
  /**
   * The layer's pixels, 8-bit RGBA with STRAIGHT alpha — an `ImageData` buffer.
   *
   * Transferred to the worker, which converts to premultiplied float on the
   * way in and back on the way out. Bytes cross the wire rather than floats
   * because that is a quarter of the copy, and the conversion is a linear scan
   * the worker was going to make anyway.
   */
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  /** Plain, cloneable values — numbers, booleans, `{x, y}` points, colour arrays. */
  params: Record<string, unknown>;
  host: Omit<KernelHost, 'cache' | 'frames'>;
  /** Neighbour frames, as 8-bit straight-alpha buffers of the same size. */
  neighbours?: Array<{ offset: number; pixels: Uint8ClampedArray }>;
  /**
   * Cache identity: the effect INSTANCE.
   *
   * The compute cache is scoped to this, not to the effect type — two copies of
   * one effect with different parameters would otherwise fight over one entry
   * and rebuild it alternately, which is slower than no cache at all.
   */
  instanceId: string;
  /** Bytes this instance's cache may hold inside one worker. */
  cacheBudgetBytes?: number;
}

export interface KernelRequestMessage {
  id: number;
  job: KernelJob;
}

export type KernelResponseMessage =
  | { id: number; ok: true; pixels: Uint8ClampedArray }
  | { id: number; ok: false; error: string };
