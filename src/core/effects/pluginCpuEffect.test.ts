/**
 * The CPU twin on the bake path.
 *
 * The failure being closed: a plugin effect on a BAKED layer used to vanish.
 * The bake drops the layer's GPU effect list wholesale, and there was nothing
 * in the chain that could draw a plugin effect — so adding an inner shadow
 * beside a plugin glow deleted the glow, from that layer only, silently.
 *
 * Two claims here, and they are the ones that decide whether an author can
 * trust the twin: the kernel runs IN ORDER with the built-in effects around it,
 * and a kernel that is not ready (or that throws) leaves the canvas untouched
 * rather than producing a broken frame.
 */

import { applyEffectChain } from './effectBake';
import {
  applyPluginCpuEffect,
  isPluginEffectType,
  pluginEffectNeedsCpuBake,
  resetPluginCpuEffectsForTests,
  pluginEffectSpreadPx,
} from './pluginCpuEffect';
import { effectsNeedCpuBake } from './effectBake';
import { registerEffects, resetEffectsForTests } from '@core/plugins/pluginEffects';
import { setPackageReader, resetKernelHostForTests, loadKernelModule } from '@core/plugins/kernel/kernelHost';
import { loadKernel, resetKernelWorkerForTests } from '@core/plugins/kernel/kernelWorkerCore';
import { setWebgpuAvailable } from '@core/plugins/capabilities';
import type { EffectContribution } from '@core/plugins/effectSchema';
import type { Effect } from './effects';

const PLUGIN = 'studio.acme.kern';
const TYPE = `${PLUGIN}.invert`;

/** A kernel that inverts RGB, leaving alpha alone. */
const INVERT = `
exports.render = function (input, output, width, height, params, host) {
  for (var i = 0; i < input.length; i += 4) {
    var a = input[i + 3];
    output[i] = a - input[i];
    output[i + 1] = a - input[i + 1];
    output[i + 2] = a - input[i + 2];
    output[i + 3] = a;
  }
};`;

const contribution = (over: Partial<EffectContribution> = {}): EffectContribution => ({
  id: 'invert',
  label: 'Invert',
  shader: '',
  params: {},
  cpu: { module: 'kernels/invert.js', format: 'js', entry: 'render' },
  ...over,
});

/** A 2×1 canvas seeded with two opaque colours. */
function canvas2x1(): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 1;
  const ctx = c.getContext('2d')!;
  const seed = ctx.createImageData(2, 1);
  seed.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
  ctx.putImageData(seed, 0, 0);
  return ctx;
}

const fx = (type: string, params: Record<string, unknown> = {}): Effect =>
  ({ id: 'fx_1', type, params }) as unknown as Effect;

beforeEach(async () => {
  resetEffectsForTests();
  resetKernelHostForTests();
  resetKernelWorkerForTests();
  resetPluginCpuEffectsForTests();
  setWebgpuAvailable(true);
  registerEffects(PLUGIN, 'Acme Kernels', [contribution()]);
  setPackageReader({ read: async () => INVERT });
});
afterEach(() => setWebgpuAvailable(true));

/** Warm the module the way the first frame does, then wait for it. */
async function warm(): Promise<void> {
  const source = await loadKernelModule(PLUGIN, contribution());
  await loadKernel(source!);
}

describe('recognising a plugin effect', () => {
  it('keys off the dot, the way the scene walk does', () => {
    expect(isPluginEffectType(TYPE)).toBe(true);
    expect(isPluginEffectType('gaussian-blur')).toBe(false);
  });
});

describe('running the kernel', () => {
  it('leaves the canvas untouched before the module is warm', () => {
    // The one-frame warm-up. Instantiating a module is asynchronous and the
    // chain is not; blocking the render thread on a WASM compile would be a
    // stall on the frame a user adds the effect.
    const ctx = canvas2x1();
    expect(applyPluginCpuEffect(ctx, 2, 1, fx(TYPE))).toBe(false);
    expect([...ctx.getImageData(0, 0, 2, 1).data].slice(0, 4)).toEqual([255, 0, 0, 255]);
  });

  it('draws once it is', async () => {
    await warm();
    const ctx = canvas2x1();
    expect(applyPluginCpuEffect(ctx, 2, 1, fx(TYPE))).toBe(true);
    const px = [...ctx.getImageData(0, 0, 2, 1).data];
    expect(px.slice(0, 4)).toEqual([0, 255, 255, 255]);
    expect(px.slice(4, 8)).toEqual([255, 0, 255, 255]);
  });

  it('leaves the canvas untouched when the kernel throws', async () => {
    resetEffectsForTests();
    registerEffects(PLUGIN, 'Acme Kernels', [contribution({ cpu: { module: 'kernels/boom.js', format: 'js', entry: 'render' } })]);
    setPackageReader({ read: async () => 'exports.render = function () { throw new Error("no"); };' });
    const source = await loadKernelModule(PLUGIN, contribution({ cpu: { module: 'kernels/boom.js', format: 'js', entry: 'render' } }));
    await loadKernel(source!);
    jest.spyOn(console, 'warn').mockImplementation(() => '');

    const ctx = canvas2x1();
    expect(applyPluginCpuEffect(ctx, 2, 1, fx(TYPE))).toBe(false);
    // The same degradation a failed shader compile gets: an effect that does
    // nothing, not a layer that disappears.
    expect([...ctx.getImageData(0, 0, 2, 1).data].slice(0, 4)).toEqual([255, 0, 0, 255]);
    jest.restoreAllMocks();
  });

  it('does nothing for an effect with no CPU kernel', async () => {
    resetEffectsForTests();
    registerEffects(PLUGIN, 'Acme Kernels', [contribution({ cpu: undefined })]);
    expect(applyPluginCpuEffect(canvas2x1(), 2, 1, fx(TYPE))).toBe(false);
  });
});

describe('inside the bake chain', () => {
  it('runs in order with the built-in effects around it', async () => {
    /*
      The claim that makes the twin usable: effects composite, so an effect
      between two others has to run between them. A kernel lifted out of that
      order would be a wrong picture rather than a slow one.

      Invert, then invert again, is the identity — which only holds if both ran,
      and in sequence.
    */
    await warm();
    const ctx = canvas2x1();
    applyEffectChain(ctx, 2, 1, [fx(TYPE), fx(TYPE)], (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }, 1);
    expect([...ctx.getImageData(0, 0, 2, 1).data].slice(0, 4)).toEqual([255, 0, 0, 255]);
  });
});

describe('what forces a bake', () => {
  it('a kernel-only effect does, because nothing else can draw it', () => {
    // No WGSL and no GLSL: without the bake it would draw nowhere at all.
    expect(effectsNeedCpuBake([fx(TYPE)])).toBe(true);
    expect(pluginEffectNeedsCpuBake(TYPE)).toBe(true);
  });

  it('an effect with a kernel for the LIVE backend does not', () => {
    // Routing every plugin effect through a bake because one might need it
    // would put a colour grade on the CPU at 100 ms a frame.
    resetEffectsForTests();
    registerEffects(PLUGIN, 'Acme Kernels', [contribution({
      shader: '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
    })]);
    expect(effectsNeedCpuBake([fx(TYPE)])).toBe(false);
  });

  it('follows the backend: WGSL-only needs the bake on WebGL2', () => {
    resetEffectsForTests();
    registerEffects(PLUGIN, 'Acme Kernels', [contribution({
      shader: '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
    })]);
    setWebgpuAvailable(false);
    expect(pluginEffectNeedsCpuBake(TYPE)).toBe(true);
  });

  it('pads a baked layer by the effect’s declared reach', () => {
    /*
      The failure this prevents: a plugin glow on a BAKED layer clipped flat at
      the layer box, while the identical effect on an unbaked layer bled
      correctly — which reads as the bake being broken rather than as a missing
      budget. The number comes from the same declaration the GPU path reads.
    */
    resetEffectsForTests();
    registerEffects(PLUGIN, 'Acme Kernels', [contribution({
      params: { radius: { type: 'number', default: 8 } },
      spread: { param: 'radius', factor: 2 },
    })]);
    expect(pluginEffectSpreadPx(fx(TYPE, { radius: 10 }))).toBe(20);
  });

  it('takes the widest side when the effect declared `expand` instead', () => {
    // An effect with only `expand` has no `spread`, so reading `spread` alone
    // would budget it ZERO — the very failure `spread` was added to fix,
    // reintroduced for the newer field.
    resetEffectsForTests();
    registerEffects(PLUGIN, 'Acme Kernels', [contribution({
      params: { d: { type: 'number', default: 4 } },
      expand: { right: { param: 'd', factor: 3 }, bottom: 5 },
    })]);
    expect(pluginEffectSpreadPx(fx(TYPE, { d: 4 }))).toBe(12);
  });

  it('pads nothing for an effect whose plugin is not installed', () => {
    resetEffectsForTests();
    expect(pluginEffectSpreadPx(fx('studio.nobody.thing'))).toBe(0);
  });

  it('an effect with no kernel at all does not — there is nothing to bake', () => {
    resetEffectsForTests();
    registerEffects(PLUGIN, 'Acme Kernels', [contribution({ cpu: undefined })]);
    expect(effectsNeedCpuBake([fx(TYPE)])).toBe(false);
  });
});
