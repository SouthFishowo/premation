/**
 * Running one plugin CPU kernel: the part that has no Worker in it.
 *
 * Everything here is callable on the main thread, which is what makes the
 * fallback path (no workers — jsdom, a browser without them, every worker dead)
 * the SAME code rather than a second implementation that drifts. `bakeWorkerCore`
 * is the same arrangement for the same reason.
 *
 * ── The three jobs this does ─────────────────────────────────────────────────
 *
 *   1. Instantiate the module ONCE per worker and keep it. A WASM compile is
 *      tens of milliseconds; doing it per frame would make the kernel path
 *      slower than the thing it replaced.
 *   2. Convert at the boundary. Bytes with straight alpha cross the wire;
 *      premultiplied floats reach the kernel. Off the main thread, so the cost
 *      lands on the worker that was going to scan the buffer anyway.
 *   3. Contain the kernel's failures. A kernel that throws, loops past its
 *      budget or writes nothing must not produce a broken frame — it produces
 *      its INPUT, which is the same degradation a failed shader compile gets.
 */

import { ComputeCacheStore } from './computeCache';
import type {
  KernelHost,
  KernelJob,
  KernelModuleSource,
  KernelRender,
  KernelRequestMessage,
  KernelResponseMessage,
} from './kernelTypes';

/**
 * How long one kernel call may take before it is called a hang.
 *
 * ★ This CANNOT be enforced from outside — JavaScript has no way to interrupt a
 * running function, and neither does a WASM instance without an explicit fuel
 * mechanism the kernel would have to opt into. So the timeout is enforced by
 * the SCHEDULER, on the main thread, by giving up on the worker and killing it
 * (`kernelPool.ts`). Recorded here because "why is there no timeout in the
 * worker" is a reasonable question with a real answer: there is nowhere to put
 * one that the runaway kernel does not also block.
 */
export const KERNEL_HANG_MS = 8000;

/** Compiled modules, keyed by `<pluginId>/<path>`. One map per worker. */
const modules = new Map<string, KernelRender>();
const caches = new ComputeCacheStore();

/**
 * Instantiate a kernel module and return its entry point.
 *
 * ── WASM ────────────────────────────────────────────────────────────────────
 *
 * Instantiated with a SINGLE import: the memory the host owns. The kernel's
 * `render(inPtr, outPtr, width, height, paramPtr, …)` works in that memory, and
 * this wrapper copies the pixels in and out of it. A design that handed the
 * kernel a pointer into a shared buffer would be faster and would need
 * `SharedArrayBuffer`, which needs cross-origin isolation, which the app does
 * not have on every deployment — so the copy stays, and the contract does not
 * depend on a header.
 *
 * ── JS ──────────────────────────────────────────────────────────────────────
 *
 * Evaluated with `new Function`, in the worker, with nothing in scope. Not
 * `import()`: a data-URL import in a worker is a module with the worker's own
 * global reachable through it, and the point of a kernel is that it cannot
 * reach anything. The function is called with the buffers and nothing else.
 *
 * This is NOT a security boundary against a determined author — a kernel is
 * still the plugin's own code running in the plugin's own worker — and it is
 * not claimed as one. It is a shape: a kernel that CANNOT ask the host
 * anything is a kernel that cannot be in the frame loop's way.
 */
export async function loadKernel(source: KernelModuleSource): Promise<KernelRender> {
  const cached = modules.get(source.id);
  if (cached) return cached;

  let render: KernelRender;
  if (source.format === 'wasm') {
    render = await instantiateWasm(source);
  } else {
    const text = typeof source.code === 'string'
      ? source.code
      : new TextDecoder().decode(source.code);
    /*
      The module's exports are collected from an object the source assigns to,
      rather than from ESM exports, because `new Function` has no module
      semantics. Both shapes authors reach for are accepted: assigning to
      `exports.render`, and declaring a bare `function render(...)`.
    */
    const factory = new Function('exports', `${text}\n;return typeof ${source.entry} === "function" ? ${source.entry} : exports.${source.entry};`);
    const exported = factory({}) as unknown;
    if (typeof exported !== 'function') {
      throw new Error(
        `The kernel module exports no "${source.entry}" function. `
        + `Export it as \`exports.${source.entry} = …\` or declare \`function ${source.entry}(…)\`.`,
      );
    }
    render = exported as KernelRender;
  }

  modules.set(source.id, render);
  return render;
}

/**
 * Wrap a WASM module's flat-memory entry point in the buffer-shaped contract.
 *
 * The exported function is called with byte offsets into the module's own
 * memory; the wrapper copies the input in, calls it, and copies the output
 * back. The module must export `memory` and, optionally, an allocator — with no
 * allocator the wrapper places the buffers immediately after the module's own
 * static data, growing the memory as needed, which is what a kernel compiled
 * with no runtime (`-nostdlib`, or a `#[no_mangle]` Rust `cdylib`) gives.
 */
async function instantiateWasm(source: KernelModuleSource): Promise<KernelRender> {
  const bytes = typeof source.code === 'string'
    ? new TextEncoder().encode(source.code).buffer as ArrayBuffer
    : source.code;
  const { instance } = await WebAssembly.instantiate(bytes, {
    // Deliberately empty but for the maths a kernel compiled from C is likely
    // to import. Nothing here can observe or affect anything outside the
    // instance, which is the property that makes an empty import object the
    // right answer rather than a lazy one.
    env: {
      abort: (): void => { throw new Error('The kernel called abort().'); },
      cos: Math.cos, sin: Math.sin, tan: Math.tan, atan2: Math.atan2,
      exp: Math.exp, log: Math.log, pow: Math.pow, sqrt: Math.sqrt,
    },
  });
  const exports = instance.exports as Record<string, unknown>;
  const entry = exports[source.entry];
  const memory = exports.memory;
  if (typeof entry !== 'function') {
    throw new Error(`The WASM module exports no "${source.entry}" function.`);
  }
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('The WASM module exports no "memory". A kernel works in memory the host writes its pixels into.');
  }
  const alloc = typeof exports.alloc === 'function' ? exports.alloc as (n: number) => number : null;
  // Where the buffers go with no allocator: past whatever the module placed in
  // its own data segments. `__heap_base` is what LLVM emits for exactly this;
  // 64 KiB is a conservative stand-in when it is absent.
  const heapBase = typeof exports.__heap_base === 'number' ? exports.__heap_base as number : 65536;

  return (input, output, width, height, params, host): void => {
    const floats = input.length;
    const needed = floats * 4 * 2;
    let inPtr: number;
    let outPtr: number;
    if (alloc) {
      inPtr = alloc(floats * 4);
      outPtr = alloc(floats * 4);
    } else {
      inPtr = heapBase;
      outPtr = heapBase + floats * 4;
      const have = (memory as WebAssembly.Memory).buffer.byteLength;
      if (heapBase + needed > have) {
        // Pages, rounded up. A kernel handed a buffer that does not fit writes
        // past the end of memory, which WASM traps on — an error, but one that
        // names nothing. Growing first turns it into a frame that renders.
        (memory as WebAssembly.Memory).grow(Math.ceil((heapBase + needed - have) / 65536));
      }
    }
    // Re-read after every possible grow: `Memory.grow` DETACHES the old buffer,
    // so a view taken before it throws on use. This is the single most common
    // way a WASM host breaks.
    new Float32Array((memory as WebAssembly.Memory).buffer, inPtr, floats).set(input);
    (entry as (...a: number[]) => void)(inPtr, outPtr, width, height, host.time, host.seed);
    output.set(new Float32Array((memory as WebAssembly.Memory).buffer, outPtr, floats));
    void params;
  };
}

/**
 * Run one job to completion and hand back the pixels.
 *
 * Never throws for a kernel's own misbehaviour — a kernel that throws, or that
 * writes nothing, yields its INPUT unchanged, which is the same degradation a
 * shader that fails to compile gets. It DOES throw when the module itself
 * cannot be loaded, because that is a fact about the package rather than about
 * one frame, and the caller disables the effect rather than retrying it 30
 * times a second.
 */
export async function runKernelJob(job: KernelJob): Promise<Uint8ClampedArray> {
  return runLoadedKernel(job, await loadKernel(job.module));
}

/**
 * A module already instantiated in THIS realm, or null.
 *
 * ── Why a synchronous lookup exists at all ──────────────────────────────────
 *
 * The CPU raster path — the bake — applies an effect chain synchronously, in
 * order, because the effects composite: an effect between two others has to run
 * between them. A kernel that could only be awaited would have to be lifted out
 * of that order, and an effect that silently reorders itself is a wrong picture
 * rather than a slow one.
 *
 * Instantiating a module is asynchronous (a WASM compile is), but CALLING one
 * is not. So the bake warms the module once — asynchronously, off the critical
 * path — and from then on runs it in place, in order, deterministically. That
 * is also what makes preview and export agree: after warm-up both take the same
 * synchronous path and produce the same bytes.
 */
export function loadedKernel(id: string): KernelRender | null {
  return modules.get(id) ?? null;
}

/** Run a job against an already-instantiated kernel. See {@link loadedKernel}. */
export function runLoadedKernel(job: KernelJob, render: KernelRender): Uint8ClampedArray {
  const count = job.width * job.height * 4;
  const input = new Float32Array(count);
  toPremultipliedFloat(job.pixels, input);

  const output = new Float32Array(count);
  const host: KernelHost = {
    ...job.host,
    cache: caches.for(job.instanceId, job.cacheBudgetBytes),
    ...(job.neighbours && job.neighbours.length > 0
      ? {
        frames: Object.fromEntries(job.neighbours.map((n) => {
          const buf = new Float32Array(count);
          toPremultipliedFloat(n.pixels, buf);
          return [n.offset, buf];
        })),
      }
      : {}),
  };

  try {
    render(input, output, job.width, job.height, job.params, host);
  } catch (err) {
    // The kernel's failure, not the host's. Reported once by the caller and
    // then the frame goes out with the layer unchanged.
    throw new KernelRunError(err instanceof Error ? err.message : String(err));
  }

  const out = new Uint8ClampedArray(count);
  fromPremultipliedFloat(output, out);
  return out;
}

/** A kernel threw. Distinguished so the caller can blame the plugin by name. */
export class KernelRunError extends Error {}

/**
 * 8-bit straight-alpha bytes → premultiplied floats in 0..1.
 *
 * Straight in, premultiplied out, because that is the direction the two worlds
 * actually sit in: `ImageData` — what the raster path and every canvas hand
 * over — is straight, and compositing arithmetic is only linear in
 * premultiplied form. Doing it here rather than asking kernels to do it means
 * a kernel and its GPU twin see the same numbers, which is the whole point of
 * having a twin.
 *
 * NOT a colour-space conversion. The values stay in display sRGB, exactly as
 * the GPU effect path works in them — converting to linear here would make the
 * CPU twin of every effect disagree with its shader.
 */
export function toPremultipliedFloat(src: Uint8ClampedArray, out: Float32Array): void {
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]! / 255;
    out[i] = (src[i]! / 255) * a;
    out[i + 1] = (src[i + 1]! / 255) * a;
    out[i + 2] = (src[i + 2]! / 255) * a;
    out[i + 3] = a;
  }
}

/** The inverse. Out-of-range values are clamped, not wrapped. */
export function fromPremultipliedFloat(src: Float32Array, out: Uint8ClampedArray): void {
  for (let i = 0; i < src.length; i += 4) {
    const a = clamp01(src[i + 3]!);
    out[i + 3] = Math.round(a * 255);
    if (a <= 0) {
      // A fully transparent pixel has no colour to recover — dividing by the
      // alpha would be 0/0. Zeroed rather than left as whatever the buffer
      // held, so a kernel that clears a region produces transparent black
      // rather than transparent noise (which shows the moment anything
      // composites it with a non-zero alpha).
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      continue;
    }
    out[i] = Math.round(clamp01(src[i]! / a) * 255);
    out[i + 1] = Math.round(clamp01(src[i + 1]! / a) * 255);
    out[i + 2] = Math.round(clamp01(src[i + 2]! / a) * 255);
  }
}

const clamp01 = (n: number): number => (n > 1 ? 1 : n < 0 || Number.isNaN(n) ? 0 : n);

/** The worker's message handler, bound to a scope by `kernel.worker.ts`. */
export async function handleKernelRequest(
  message: KernelRequestMessage,
  reply: (msg: KernelResponseMessage, transfer: Transferable[]) => void,
): Promise<void> {
  try {
    const pixels = await runKernelJob(message.job);
    reply({ id: message.id, ok: true, pixels }, [pixels.buffer as ArrayBuffer]);
  } catch (err) {
    reply({ id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) }, []);
  }
}

/** Test seam: forget compiled modules and every instance's cache. */
export function resetKernelWorkerForTests(): void {
  modules.clear();
  caches.clear();
}

/** Diagnostics: how many instances hold a cache in this worker. */
export function kernelCacheInstances(): number {
  return caches.instanceCount;
}
