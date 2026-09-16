/**
 * A plugin effect on the CPU raster path — the twin that makes preview and
 * export agree.
 *
 * ── The failure this closes ──────────────────────────────────────────────────
 *
 * A plugin effect was a GPU pass and nothing else. The moment a layer was baked
 * — a mask-scoped effect beside it, fill opacity, a path-following style — its
 * GPU effect list was dropped wholesale and the plugin effect vanished with it.
 * Not degraded: gone, from that layer only, for a reason nothing on screen
 * explained. The built-in effects avoid this by keeping a CPU twin (`deepGlow`
 * is the worked example); a plugin had no way to ship one.
 *
 * ── Why this runs the kernel SYNCHRONOUSLY, having built a worker pool ───────
 *
 * The bake applies effects in order, because effects composite: an effect
 * between two others must run between them. A kernel that could only be awaited
 * would have to be lifted out of that order — a wrong picture rather than a
 * slow one — so inside the chain it runs in place.
 *
 * What is asynchronous is INSTANTIATING the module, once. So the first frame a
 * kernel effect appears on, this warms it and leaves the layer unchanged; every
 * frame after that runs it in order. The pool is what serves the OTHER caller
 * (a GPU-less backend, where a whole-layer pass can be awaited off-thread) and
 * what the warm-up shares its module registry with.
 *
 * That one-frame warm-up is visible and is the honest trade: the alternative
 * shapes are an await inside a synchronous chain (impossible), or blocking the
 * render thread on a WASM compile (a stall on the frame a user adds an effect).
 */

import type { Effect } from './effects';
import { effectById } from '@core/plugins/pluginEffects';
import { paramsOf } from './effects';
import { pluginHostFrame, seedFromId } from '@core/rendering/pluginHostFrame';
import { hasCapability } from '@core/plugins/capabilities';
import { effectExpandFor, effectSpreadFor, type EffectBackend } from '@core/plugins/effectSchema';
import { loadKernelModule } from '@core/plugins/kernel/kernelHost';
import { loadedKernel, runLoadedKernel, KernelRunError } from '@core/plugins/kernel/kernelWorkerCore';
import type { KernelJob } from '@core/plugins/kernel/kernelTypes';

/**
 * A plugin effect's type contains a dot; no built-in type does.
 *
 * The same test `extractSpatialEffects` uses, and deliberately the same one
 * rather than a lookup against the registry: the set of installed plugins is
 * not knowable here, and a predicate that answered "no" for an effect whose
 * plugin is still loading would route it down the built-in path.
 */
export function isPluginEffectType(type: string): boolean {
  return type.includes('.');
}

/** Warm-ups already started, so a chain does not queue one per frame. */
const warming = new Set<string>();
/** Modules that will never load — a package missing its kernel file. */
const missing = new Set<string>();
let onWarm: (() => void) | null = null;

/**
 * Called when a module finishes warming, so the caller can repaint.
 *
 * Injected rather than imported: this module is reached from the bake, which
 * runs inside a worker in some configurations and has no business knowing about
 * the app's repaint scheduler.
 */
export function setPluginKernelWarmHandler(fn: (() => void) | null): void {
  onWarm = fn;
}

/**
 * Does this effect have a CPU kernel the bake could run?
 *
 * Used by the bake TRIGGER as well as by the chain: an effect with a CPU kernel
 * and no kernel for the live backend has to force a bake, or it would draw
 * nowhere at all — which is the failure the whole item exists to remove.
 */
export function pluginEffectHasCpuKernel(type: string): boolean {
  return !!effectById(type)?.contribution.cpu;
}

/**
 * Must this plugin effect be CPU-baked to draw at all?
 *
 * True only when the author shipped a CPU kernel AND the live backend has no
 * GPU kernel for the effect. The two halves are both load-bearing:
 *
 *   • With a GPU kernel for this backend, the effect belongs on the GPU. Baking
 *     every plugin effect just in case would put a colour grade on the CPU at
 *     100 ms a frame.
 *   • With no CPU kernel there is nothing for a bake to run, so forcing one
 *     would cost the layer its GPU path and still draw nothing.
 */
export function pluginEffectNeedsCpuBake(type: string): boolean {
  if (!isPluginEffectType(type)) return false;
  const registered = effectById(type);
  if (!registered?.contribution.cpu) return false;
  const backend: EffectBackend = hasCapability('webgpu') ? 'webgpu' : 'webgl2';
  // `effectKernelFor` answers "can this backend run it", and a CPU kernel makes
  // that true for every backend — so the question here is the narrower one the
  // GPU pass actually asks: is there a kernel in the backend's own language?
  const contribution = registered.contribution;
  const passes = contribution.passes;
  const hasGpu = backend === 'webgpu'
    ? (passes ? passes.every((p) => !!p.wgsl) : !!contribution.shader.trim())
    : (passes ? passes.every((p) => !!p.glsl) : !!contribution.glsl?.trim());
  return !hasGpu;
}

/**
 * Run a plugin effect's CPU kernel over the canvas, in place.
 *
 * Returns false when it did not run — no kernel, not warmed yet, or the kernel
 * itself failed — and in every one of those cases the canvas is untouched,
 * which is the same degradation a failed shader compile gets on the GPU path.
 */
export function applyPluginCpuEffect(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  e: Effect,
): boolean {
  const registered = effectById(e.type);
  const cpu = registered?.contribution.cpu;
  if (!registered || !cpu) return false;

  const moduleId = `${registered.pluginId}/${cpu.module}`;
  if (missing.has(moduleId)) return false;

  const render = loadedKernel(moduleId);
  if (!render) {
    warmKernel(registered.pluginId, registered.contribution, moduleId);
    return false;
  }

  const frame = pluginHostFrame();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const image = oc.getImageData(0, 0, w, h);
  const job: KernelJob = {
    effectId: registered.id,
    module: { id: moduleId, format: cpu.format ?? 'js', entry: cpu.entry ?? 'render', code: '' },
    pixels: image.data,
    width: w,
    height: h,
    params: paramsOf(e),
    host: {
      compWidth: frame.compWidth || w,
      compHeight: frame.compHeight || h,
      layerWidth: w,
      layerHeight: h,
      /*
        The comp's time on this path, not the layer's.

        The bake is handed pixels and a chain, with no layer beside them — the
        layer's own clock is known in `snapshotToFrameScene`, which is a
        different call stack. Stated rather than quietly passed as `time`
        because a retimed layer's kernel WILL differ between the GPU and CPU
        paths until the bake carries a layer time, and an author debugging that
        deserves to find this comment rather than a discrepancy.
      */
      time: frame.compTime,
      compTime: frame.compTime,
      frame: frame.fps > 0 ? Math.round(frame.compTime * frame.fps) : 0,
      fps: frame.fps,
      pixelScale: frame.pixelScale,
      downsample: frame.downsample,
      seed: seedFromId(e.id ?? registered.id),
    },
    instanceId: e.id ?? registered.id,
  };

  let out: Uint8ClampedArray;
  try {
    out = runLoadedKernel(job, render);
  } catch (err) {
    // A kernel that threw is the plugin's problem and must not be a broken
    // frame. Reported once per effect rather than per frame — a kernel that
    // throws throws 60 times a second, and a log that scrolls is a log nobody
    // reads.
    if (!reported.has(moduleId)) {
      reported.add(moduleId);
      const why = err instanceof KernelRunError || err instanceof Error ? err.message : String(err);
      console.warn(`[plugins] the CPU kernel of "${registered.id}" (${registered.pluginName}) failed: ${why}`);
    }
    return false;
  }

  image.data.set(out);
  oc.putImageData(image, 0, 0);
  return true;
}

const reported = new Set<string>();

/**
 * Read and instantiate a kernel module, once.
 *
 * Fire-and-forget by design: the caller is a synchronous chain that has already
 * decided to leave this effect out of THIS frame. What it must not do is queue
 * a second warm-up per frame, which `warming` prevents, or retry forever a
 * module the package does not contain, which `missing` prevents.
 */
function warmKernel(pluginId: string, contribution: NonNullable<ReturnType<typeof effectById>>['contribution'], moduleId: string): void {
  if (warming.has(moduleId)) return;
  warming.add(moduleId);
  void (async (): Promise<void> => {
    try {
      const source = await loadKernelModule(pluginId, contribution);
      if (!source) {
        missing.add(moduleId);
        return;
      }
      const { loadKernel } = await import('@core/plugins/kernel/kernelWorkerCore');
      await loadKernel(source);
      // The next frame can draw it. Without this the layer stays unchanged
      // until something else happens to invalidate it, which on a paused
      // playhead is "until the user touches something".
      onWarm?.();
    } catch {
      // A module that cannot be instantiated is not retried. It is a fact about
      // the package, not about this frame, and retrying it per frame would be
      // one failed compile per frame forever.
      missing.add(moduleId);
    } finally {
      warming.delete(moduleId);
    }
  })();
}

/**
 * Warm every kernel a chain will need, and resolve when they are ready.
 *
 * For the caller that CAN wait — an export, which must not write a frame with
 * an effect missing from it. A preview never calls this; it takes the
 * one-frame warm-up instead.
 */
export async function warmPluginKernels(effects: ReadonlyArray<Effect> | undefined): Promise<void> {
  for (const e of effects ?? []) {
    if (e.enabled === false || !isPluginEffectType(e.type)) continue;
    const registered = effectById(e.type);
    if (!registered?.contribution.cpu) continue;
    const moduleId = `${registered.pluginId}/${registered.contribution.cpu.module}`;
    if (loadedKernel(moduleId) || missing.has(moduleId)) continue;
    try {
      const source = await loadKernelModule(registered.pluginId, registered.contribution);
      if (!source) {
        missing.add(moduleId);
        continue;
      }
      const { loadKernel } = await import('@core/plugins/kernel/kernelWorkerCore');
      await loadKernel(source);
    } catch {
      missing.add(moduleId);
    }
  }
}

/**
 * How far a plugin effect reaches outside its layer, for a BAKED layer.
 *
 * The same number `extractSpatialEffects` computes for the GPU path, from the
 * same declaration and the same live parameter values — asked here so a baked
 * layer's raster is padded by it. Without this a plugin glow on a baked layer
 * was clipped flat at the layer box while the identical effect on an unbaked
 * one bled correctly.
 *
 * Zero for an unregistered effect: a document carrying an effect whose plugin
 * is not installed pads nothing, because nothing will draw.
 */
export function pluginEffectSpreadPx(e: Effect): number {
  const registered = effectById(e.type);
  if (!registered) return 0;
  const params = paramsOf(e);
  const contribution = registered.contribution;
  if (contribution.expand) {
    const sides = effectExpandFor(contribution, params);
    return Math.max(sides.left, sides.top, sides.right, sides.bottom);
  }
  return effectSpreadFor(contribution, params);
}

/**
 * Warm every registered effect's kernel, without waiting for a frame to ask.
 *
 * Called when the set of registered effects changes — the same moment the
 * shaders are compiled, and for the same reason. Without it the first frame an
 * effect appears on renders without it, which for a paused playhead means
 * "until the user touches something" and for a single-frame render (the golden
 * harness, a thumbnail) means never.
 *
 * Fire-and-forget: `warmKernel` deduplicates, remembers what is missing, and
 * repaints when something lands.
 */
export function warmRegisteredKernels(
  effects: ReadonlyArray<{ pluginId: string; contribution: { cpu?: { module: string } } }>,
): void {
  for (const registered of effects) {
    const cpu = registered.contribution.cpu;
    if (!cpu) continue;
    const moduleId = `${registered.pluginId}/${cpu.module}`;
    if (loadedKernel(moduleId) || missing.has(moduleId)) continue;
    warmKernel(
      registered.pluginId,
      registered.contribution as NonNullable<ReturnType<typeof effectById>>['contribution'],
      moduleId,
    );
  }
}

/** Test seam: forget warm-up state. The module registry is reset separately. */
export function resetPluginCpuEffectsForTests(): void {
  warming.clear();
  missing.clear();
  reported.clear();
  onWarm = null;
}
