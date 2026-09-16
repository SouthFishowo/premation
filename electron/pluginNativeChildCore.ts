/**
 * What runs INSIDE a plugin's own process: load the addon, call it, convert.
 *
 * Separated from `pluginNativeChild.ts` — which is twenty lines of `parentPort`
 * wiring — for the reason every worker in this codebase is split the same way:
 * the interesting half can then be unit-tested against a fake addon, in the
 * same process as the test, with no child to spawn and no binary to compile.
 * `pluginNativeChildCore.test.ts` is that suite, and it is the only coverage
 * the conversion arithmetic will ever get without a real `.node` file.
 *
 * ── The three jobs ───────────────────────────────────────────────────────────
 *
 * 1. **Version, then anything else.** `motion_plugin_abi_version` is called
 *    first and alone, and nothing else is called if it disagrees. That ordering
 *    is the whole point of having a version function: calling `register` on a
 *    binary built against a different struct layout is the crash this avoids.
 *
 * 2. **Convert pixels, here.** The wire carries 8-bit straight-alpha RGBA —
 *    a quarter of the bytes of float, and exactly what C2's kernel jobs carry.
 *    The addon gets what it asked for in `describe().pixelFormat`. Doing this
 *    in the plugin's own process means an addon that wants floats costs the
 *    editor nothing, and one that wants bytes costs it nothing either.
 *
 * 3. **Turn a throw into a value.** An addon that throws, returns nonsense, or
 *    hands back a buffer of the wrong size produces `{ ok: false, error }` with
 *    a sentence naming what was wrong. It never produces a rejected promise in
 *    the supervisor, because the supervisor's job is to keep rendering.
 */

import { checkAbi, ABI_VERSION_EXPORT, DESCRIBE_EXPORT, DISPOSE_EXPORT, REGISTER_EXPORT, RENDER_EXPORT } from './pluginNativeAbi';

export type PixelFormat = 'f32-premul' | 'rgba8-premul' | 'rgba8-straight';

export interface AddonDescribe {
  name: string;
  version: string;
  calls: Array<'effect' | 'generate' | 'invoke'>;
  pixelFormat: PixelFormat;
  threadSafety: 'unsafe' | 'instance' | 'full';
  effects: Array<{ id: string; expand?: { left: number; top: number; right: number; bottom: number } }>;
  generators: string[];
  methods: string[];
}

/** The addon, as loose as it really is: anything may be missing or wrong. */
type RawAddon = Record<string, unknown>;

const PIXEL_FORMATS: PixelFormat[] = ['f32-premul', 'rgba8-premul', 'rgba8-straight'];

/**
 * Fill in what `describe()` did not say, and refuse nothing.
 *
 * A missing field is a default, not an error, at exactly one level of
 * strictness: the values that decide SCHEDULING (`threadSafety`) and MEMORY
 * (`pixelFormat`) fall back to the conservative choice rather than the
 * convenient one. An addon that forgot to declare thread safety is serialised
 * per instance, which is slower and correct.
 */
export function normaliseDescribe(raw: unknown): AddonDescribe {
  const r = (raw && typeof raw === 'object' ? raw : {}) as RawAddon;
  const calls = Array.isArray(r.calls)
    ? r.calls.filter((c): c is 'effect' | 'generate' | 'invoke' =>
      c === 'effect' || c === 'generate' || c === 'invoke')
    : [];
  const format = PIXEL_FORMATS.includes(r.pixelFormat as PixelFormat)
    ? (r.pixelFormat as PixelFormat)
    : 'f32-premul';
  const safety = r.threadSafety === 'unsafe' || r.threadSafety === 'full'
    ? r.threadSafety
    : 'instance';
  const effects = Array.isArray(r.effects)
    ? r.effects
      .filter((e): e is { id: string } => !!e && typeof (e as { id?: unknown }).id === 'string')
      .map((e) => ({ ...e }))
    : [];
  return {
    name: typeof r.name === 'string' ? r.name : 'native module',
    version: typeof r.version === 'string' ? r.version : '0.0.0',
    calls,
    pixelFormat: format,
    threadSafety: safety,
    effects,
    generators: Array.isArray(r.generators) ? r.generators.filter((g): g is string => typeof g === 'string') : [],
    methods: Array.isArray(r.methods) ? r.methods.filter((m): m is string => typeof m === 'string') : [],
  };
}

/**
 * 8-bit straight-alpha RGBA → whatever the addon asked for.
 *
 * Premultiplication is the part worth being careful about, and the direction
 * that matters: `a + b·(1−a)` is only linear in premultiplied form, so a kernel
 * that composites has to be handed premultiplied pixels or its edges are wrong.
 * Alpha itself is never premultiplied by anything, which is the mistake that
 * produces a layer that fades to black instead of to transparent.
 */
export function toAddonPixels(pixels: Uint8ClampedArray, format: PixelFormat): Uint8ClampedArray | Float32Array {
  if (format === 'rgba8-straight') return pixels;
  if (format === 'rgba8-premul') {
    const out = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      const a = pixels[i + 3]! / 255;
      out[i] = pixels[i]! * a;
      out[i + 1] = pixels[i + 1]! * a;
      out[i + 2] = pixels[i + 2]! * a;
      out[i + 3] = pixels[i + 3]!;
    }
    return out;
  }
  const out = new Float32Array(pixels.length);
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3]! / 255;
    out[i] = (pixels[i]! / 255) * a;
    out[i + 1] = (pixels[i + 1]! / 255) * a;
    out[i + 2] = (pixels[i + 2]! / 255) * a;
    out[i + 3] = a;
  }
  return out;
}

/** The way back. Un-premultiplies, because the raster path is straight alpha. */
export function fromAddonPixels(
  buffer: Uint8ClampedArray | Float32Array,
  format: PixelFormat,
): Uint8ClampedArray {
  if (format === 'rgba8-straight') {
    return buffer instanceof Uint8ClampedArray ? buffer : Uint8ClampedArray.from(buffer);
  }
  const out = new Uint8ClampedArray(buffer.length);
  if (format === 'rgba8-premul') {
    for (let i = 0; i + 3 < buffer.length; i += 4) {
      const a = buffer[i + 3]! / 255;
      // A fully transparent pixel has no colour to recover. Zero rather than a
      // division: dividing by a near-zero alpha is how a soft edge grows a
      // bright fringe nobody can trace back to this line.
      if (a <= 0) continue;
      out[i] = buffer[i]! / a;
      out[i + 1] = buffer[i + 1]! / a;
      out[i + 2] = buffer[i + 2]! / a;
      out[i + 3] = buffer[i + 3]!;
    }
    return out;
  }
  for (let i = 0; i + 3 < buffer.length; i += 4) {
    const a = buffer[i + 3]!;
    out[i + 3] = a * 255;
    if (a <= 0) continue;
    out[i] = (buffer[i]! / a) * 255;
    out[i + 1] = (buffer[i + 1]! / a) * 255;
    out[i + 2] = (buffer[i + 2]! / a) * 255;
  }
  return out;
}

function allocLike(sample: Uint8ClampedArray | Float32Array): Uint8ClampedArray | Float32Array {
  return sample instanceof Float32Array
    ? new Float32Array(sample.length)
    : new Uint8ClampedArray(sample.length);
}

export interface LoadOutcome {
  ok: boolean;
  abi?: number;
  describe?: AddonDescribe;
  code?: string;
  error?: string;
}

export interface CallOutcome {
  ok: boolean;
  result?: unknown;
  /** Buffers to transfer back with the reply. */
  transfer?: ArrayBufferLike[];
  code?: string;
  error?: string;
}

/** `require`, injected so a test can hand over a fake addon. */
export type AddonLoader = (path: string) => unknown;

/**
 * One addon, for the life of one process.
 *
 * Holds no per-call state on purpose. Everything a call needs is in the call,
 * which is what makes `threadSafety: "full"` meaningful — the host may have two
 * of these in flight and nothing here is shared between them but the addon's
 * own globals, which are the addon author's problem and are documented as such.
 */
export class NativeAddonRunner {
  private addon: RawAddon | null = null;
  private description: AddonDescribe | null = null;

  constructor(private readonly load: AddonLoader) {}

  describe(): AddonDescribe | null {
    return this.description;
  }

  open(binaryPath: string, host: unknown): LoadOutcome {
    let module: unknown;
    try {
      module = this.load(binaryPath);
    } catch (err) {
      return {
        ok: false,
        code: 'missing-binary',
        // The OS message is the useful part here — "is not a valid Win32
        // application" and "image not found" are different problems with
        // different fixes, and both arrive as this string.
        error: `The native module could not be loaded: ${(err as Error).message}`,
      };
    }

    const addon = (module && typeof module === 'object' ? module : {}) as RawAddon;
    if (typeof addon[ABI_VERSION_EXPORT] !== 'function') {
      return {
        ok: false,
        code: 'abi-mismatch',
        error: `The native module does not export ${ABI_VERSION_EXPORT}(). It is not a Premation plugin module.`,
      };
    }

    let reported: unknown;
    try {
      reported = (addon[ABI_VERSION_EXPORT] as () => unknown)();
    } catch (err) {
      return { ok: false, code: 'abi-mismatch', error: `${ABI_VERSION_EXPORT}() threw: ${(err as Error).message}` };
    }
    const abi = checkAbi(reported);
    if (!abi.ok) return { ok: false, code: 'abi-mismatch', ...(abi.error ? { error: abi.error } : {}) };

    for (const name of [REGISTER_EXPORT, DESCRIBE_EXPORT, RENDER_EXPORT, DISPOSE_EXPORT]) {
      if (typeof addon[name] !== 'function') {
        return {
          ok: false,
          code: 'abi-mismatch',
          error: `The native module reports ABI ${String(reported)} but does not export ${name}().`,
        };
      }
    }

    try {
      const registered = (addon[REGISTER_EXPORT] as (h: unknown) => unknown)(host) as
        { ok?: unknown; error?: unknown } | undefined;
      if (registered && registered.ok === false) {
        return {
          ok: false,
          code: 'register-failed',
          error: typeof registered.error === 'string'
            ? registered.error
            : 'The native module refused to start and gave no reason.',
        };
      }
    } catch (err) {
      return { ok: false, code: 'register-failed', error: `${REGISTER_EXPORT}() threw: ${(err as Error).message}` };
    }

    let described: unknown;
    try {
      described = (addon[DESCRIBE_EXPORT] as () => unknown)();
    } catch (err) {
      return { ok: false, code: 'register-failed', error: `${DESCRIBE_EXPORT}() threw: ${(err as Error).message}` };
    }

    this.addon = addon;
    this.description = normaliseDescribe(described);
    return { ok: true, abi: reported as number, describe: this.description };
  }

  /**
   * One call, all the way through, with every failure turned into a value.
   *
   * The reshaping either side of `motion_plugin_render` is what lets the wire
   * stay 8-bit while an addon works in float, and what lets `identity: true` be
   * a real saving rather than a flag the host has to interpret.
   */
  call(request: unknown): CallOutcome {
    const addon = this.addon;
    const described = this.description;
    if (!addon || !described) {
      return { ok: false, code: 'failed', error: 'The native module has not been loaded.' };
    }

    const req = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    const kind = req.call;
    if (kind !== 'effect' && kind !== 'generate' && kind !== 'invoke') {
      return { ok: false, code: 'no-such-call', error: `Unknown native call "${String(kind)}".` };
    }
    if (!described.calls.includes(kind)) {
      return {
        ok: false,
        code: 'no-such-call',
        error: `${described.name} does not implement the "${kind}" call.`,
      };
    }

    if (kind === 'effect') return this.callEffect(addon, described, req);

    let answer: unknown;
    try {
      answer = (addon[RENDER_EXPORT] as (r: unknown) => unknown)(req);
    } catch (err) {
      return { ok: false, code: 'failed', error: `${described.name} threw: ${(err as Error).message}` };
    }
    const failure = failureOf(answer, described.name);
    if (failure) return failure;

    const out = answer as Record<string, unknown>;
    if (kind === 'generate') {
      if (!(out.instances instanceof Float32Array)) {
        return { ok: false, code: 'failed', error: `${described.name} returned no instance buffer.` };
      }
      const result = { ...out, call: 'generate' };
      delete (result as Record<string, unknown>).ok;
      return { ok: true, result, transfer: transfersOf(result) };
    }
    const result = { call: 'invoke', result: out.result, ...(out.buffers ? { buffers: out.buffers } : {}) };
    return { ok: true, result, transfer: transfersOf(result) };
  }

  private callEffect(
    addon: RawAddon,
    described: AddonDescribe,
    req: Record<string, unknown>,
  ): CallOutcome {
    const pixels = req.pixels;
    if (!(pixels instanceof Uint8ClampedArray)) {
      return { ok: false, code: 'failed', error: 'The effect call carried no pixel buffer.' };
    }
    const input = toAddonPixels(pixels, described.pixelFormat);
    const output = allocLike(input);

    let answer: unknown;
    try {
      answer = (addon[RENDER_EXPORT] as (r: unknown) => unknown)({ ...req, input, output });
    } catch (err) {
      return { ok: false, code: 'failed', error: `${described.name} threw: ${(err as Error).message}` };
    }
    const failure = failureOf(answer, described.name);
    if (failure) return failure;

    const out = answer as Record<string, unknown>;
    if (out.identity === true) {
      // Nothing to send back at all. The host still owns the buffer it handed
      // over — it is about to be told it may keep using it.
      return { ok: true, result: { call: 'effect', identity: true } };
    }

    const written = out.output ?? output;
    if (!(written instanceof Uint8ClampedArray) && !(written instanceof Float32Array)) {
      return { ok: false, code: 'failed', error: `${described.name} returned no output buffer.` };
    }
    if (written.length !== input.length) {
      return {
        ok: false,
        code: 'failed',
        error: `${described.name} returned ${written.length} samples for a ${input.length}-sample buffer.`,
      };
    }

    const result = { call: 'effect', pixels: fromAddonPixels(written, described.pixelFormat) };
    return { ok: true, result, transfer: transfersOf(result) };
  }

  dispose(): void {
    const addon = this.addon;
    this.addon = null;
    this.description = null;
    if (!addon) return;
    try {
      (addon[DISPOSE_EXPORT] as (() => void) | undefined)?.();
    } catch {
      // The process is going away; an addon that throws on its way out has
      // nothing left to break. Swallowed rather than reported, because the
      // report would arrive after the thing it is about has stopped existing.
    }
  }
}

/** `{ ok: false, error }`, or a return value that is not a response at all. */
function failureOf(answer: unknown, name: string): CallOutcome | null {
  if (!answer || typeof answer !== 'object') {
    return { ok: false, code: 'failed', error: `${name} returned ${String(answer)} instead of a response.` };
  }
  const out = answer as Record<string, unknown>;
  if (out.ok === false) {
    return {
      ok: false,
      code: 'failed',
      error: typeof out.error === 'string' ? `${name}: ${out.error}` : `${name} failed and gave no reason.`,
    };
  }
  return null;
}

/** Every typed array in a response, so the reply can hand its memory over. */
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
