/**
 * Compositing Options ▸ Effect Opacity on the GPU chain (2026-09-15).
 *
 * An unmasked opacity on a single-chain-entry effect used to force the whole
 * layer through the CPU bake — every ported effect on it (blurs, interior
 * styles, deep glow …) then ran as a Canvas2D kernel per frame. The GPU chain
 * now blends the entry back over its input itself. Pinned here:
 *
 *   1. the gate: which opacity-carrying effects still bake, and why
 *   2. the membership is MEASURED — every member emits exactly one chain entry
 *   3. the adapter stamps the blend factor on that entry (and only there)
 *   4. the shader's maths lands on the CPU composite's bytes (±1) on sampled
 *      pixels — the parity the golden tolerance relies on
 */

import type { Effect } from './effects';
import { EFFECT_DEFS, defaultParams, isGpuOnlyEffect, type EffectType } from './effects';
import { effectsNeedCpuBake, gpuBlendsEffectOpacity, gpuBlendedOpacityEffects } from './effectBake';
import { isCanvas2dOnlyEffect } from './canvas2dEffects';
import { extractSpatialEffects } from '@core/rendering/snapshotToFrameScene';
import type { RenderLayer } from '@core/rendering/RenderBackend';

function fx(type: string, extra: Partial<Effect> = {}): Effect {
  const def = EFFECT_DEFS.find((d) => d.type === type)!;
  return { id: `e-${type}`, type, params: defaultParams(def), ...extra } as Effect;
}

const layerWith = (effects: Effect[]): RenderLayer =>
  ({ id: 'l', kind: 'shape', width: 100, height: 100, effects } as unknown as RenderLayer);

describe('effect opacity: which route', () => {
  it('a GPU-blended effect with an opacity stays on the GPU', () => {
    expect(effectsNeedCpuBake([fx('gaussian-blur', { opacity: 50 })])).toBe(false);
    expect(effectsNeedCpuBake([fx('bevel', { opacity: 100 })])).toBe(false);
    expect(effectsNeedCpuBake([fx('deep-glow', { opacity: 0 })])).toBe(false);
  });

  it('a mask scope still bakes, with or without an opacity', () => {
    expect(effectsNeedCpuBake([fx('gaussian-blur', { maskId: 'm1' })])).toBe(true);
    expect(effectsNeedCpuBake([fx('gaussian-blur', { maskId: 'm1', opacity: 50 })])).toBe(true);
  });

  it('an effect that is not a chain entry still bakes its opacity', () => {
    // CSS grade → folded into the colour matrix; Levels → LUT; gpuOnly → never honoured by the bake route.
    expect(effectsNeedCpuBake([fx('brightness', { opacity: 50 })])).toBe(true);
    expect(effectsNeedCpuBake([fx('levels', { opacity: 50 })])).toBe(true);
    expect(effectsNeedCpuBake([fx('displacement-map', { opacity: 50 })])).toBe(true);
  });

  it('the membership is exactly the non-gpuOnly effects that emit ONE chain entry', () => {
    const measured = new Set<string>();
    for (const d of EFFECT_DEFS) {
      if (isCanvas2dOnlyEffect(d.type) || isGpuOnlyEffect(d.type as EffectType)) continue;
      const entries = extractSpatialEffects(layerWith([fx(d.type)])) ?? [];
      if (entries.length === 1) measured.add(d.type);
    }
    const listed = [...gpuBlendedOpacityEffects()];
    expect(listed.filter((t) => !measured.has(t))).toEqual([]); // listed but not one entry
    expect([...measured].filter((t) => !gpuBlendsEffectOpacity(t))).toEqual([]); // one entry but unlisted
  });
});

describe('effect opacity: the adapter stamps the chain entry', () => {
  it('forwards 0 < opacity < 1 as a 0..1 factor on that effect\'s entry only', () => {
    const out = extractSpatialEffects(layerWith([
      fx('gaussian-blur', { opacity: 25 }),
      fx('glow'),
    ]))!;
    expect(out.map((e) => e.type)).toEqual(['gaussian-blur', 'glow']);
    expect(out[0]!.effectOpacity).toBeCloseTo(0.25, 9);
    expect(out[1]!.effectOpacity).toBeUndefined();
  });

  it('opacity 0 drops the entry (the bake skips it too); 100 emits no blend', () => {
    expect(extractSpatialEffects(layerWith([fx('gaussian-blur', { opacity: 0 })]))).toBeUndefined();
    const full = extractSpatialEffects(layerWith([fx('gaussian-blur', { opacity: 100 })]))!;
    expect(full).toHaveLength(1);
    expect(full[0]!.effectOpacity).toBeUndefined();
  });

  it('survives disabled neighbours (the stamp runs past `continue`)', () => {
    const out = extractSpatialEffects(layerWith([
      fx('gaussian-blur', { opacity: 40 }),
      fx('glow', { enabled: false }),
    ]))!;
    expect(out).toHaveLength(1);
    expect(out[0]!.effectOpacity).toBeCloseTo(0.4, 9);
  });

  it('leaves a baked layer\'s GPU-only list untouched', () => {
    const out = extractSpatialEffects(layerWith([fx('displacement-map', { opacity: 50 })]), true) ?? [];
    for (const e of out) expect(e.effectOpacity).toBeUndefined();
  });

  /*
    Regression (golden `effect-light-rays`, 2026-09-15): the Compositing factor
    first rode an `opacity` key, and Light Rays' chain entry already carries an
    `opacity` of its own — the ray strength. The pass read 0.7 ray strength as
    Compositing opacity and blended the rays back over their input: every ray
    dimmed twice, ~40% of the frame a few levels dark on both backends.
  */
  it('an effect\'s OWN opacity parameter is never read as Compositing opacity', () => {
    const rays = (extra: Partial<Effect> = {}): Effect => {
      const e = fx('light-rays', extra);
      return { ...e, params: { ...e.params, opacity: 70 } } as Effect;
    };
    const plain = extractSpatialEffects(layerWith([rays()]))!;
    expect(plain).toHaveLength(1);
    expect((plain[0] as { opacity?: number }).opacity).toBeCloseTo(0.7, 9);
    expect(plain[0]!.effectOpacity).toBeUndefined();

    // A real Compositing opacity stamps its own field and leaves the ray strength alone.
    const faded = extractSpatialEffects(layerWith([rays({ opacity: 50 })]))!;
    expect(faded[0]!.effectOpacity).toBeCloseTo(0.5, 9);
    expect((faded[0] as { opacity?: number }).opacity).toBeCloseTo(0.7, 9);
  });
});

// ── 4. Shader maths vs the CPU composite ──────────────────────────────────

/** IEC 61966-2-1, the numbers linearWorkingSpace.ts and the shaders use. */
const toLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055);

type Px = [number, number, number, number]; // straight RGBA bytes

/** What a chain render target holds for a straight byte pixel: linear, premultiplied. */
const toTarget = ([r, g, b, a]: Px): Px => {
  const al = a / 255;
  return [toLin(r / 255) * al, toLin(g / 255) * al, toLin(b / 255) * al, al];
};

/** fx-effect-opacity, transcribed: displayPremul both taps, lerp, encodeOut. */
function shaderMix(after: Px, before: Px, a: number): Px {
  const displayPremul = (s: Px): Px => {
    if (s[3] <= 0) return [0, 0, 0, 0];
    const c = (v: number): number => toSrgb(Math.min(1, Math.max(0, v / s[3]))) * s[3];
    return [c(s[0]), c(s[1]), c(s[2]), s[3]];
  };
  const o = displayPremul(toTarget(after));
  const i = displayPremul(toTarget(before));
  const m = [0, 1, 2, 3].map((k) => i[k]! * (1 - a) + o[k]! * a) as Px;
  if (m[3] <= 0) return [0, 0, 0, 0];
  // encodeOut then the scene blit's encode back to display bytes, premultiplied.
  const enc = (v: number): number => toSrgb(toLin(Math.min(1, Math.max(0, v / m[3])))) * m[3] * 255;
  return [enc(m[0]), enc(m[1]), enc(m[2]), m[3] * 255];
}

/** The CPU flat composite on an 8-bit premultiplied surface: after·a (destination-in), + before·(1−a) (lighter). */
function cpuMix(after: Px, before: Px, a: number): Px {
  const pm = (p: Px): Px => [p[0] * p[3] / 255, p[1] * p[3] / 255, p[2] * p[3] / 255, p[3]];
  const A = pm(after);
  const B = pm(before);
  return [0, 1, 2, 3].map((k) => Math.min(255, Math.round(A[k]! * a) + Math.round(B[k]! * (1 - a)))) as Px;
}

describe('effect opacity: GPU blend maths match the CPU composite', () => {
  it('within one code, premultiplied, across a sampled grid of pixels and factors', () => {
    let worst = 0;
    const samples: Px[] = [
      [255, 0, 0, 255], [0, 128, 255, 255], [12, 200, 40, 180], [250, 250, 250, 30],
      [0, 0, 0, 0], [90, 60, 30, 255], [128, 128, 128, 128], [255, 255, 0, 5],
    ];
    for (const a of [0.05, 0.25, 0.5, 0.73, 0.95]) {
      for (const after of samples) {
        for (const before of samples) {
          const g = shaderMix(after, before, a);
          const c = cpuMix(after, before, a);
          for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(g[k]! - c[k]!));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1.01);
  });

  it('a LINEAR-light lerp would not have matched (why the shader decodes)', () => {
    // Half red over opaque black: display lerp ≈ 128, linear lerp ≈ 188.
    const a = 0.5;
    const after: Px = [255, 0, 0, 255];
    const before: Px = [0, 0, 0, 255];
    const linear = toSrgb(toLin(1) * a + toLin(0) * (1 - a)) * 255;
    expect(Math.abs(linear - cpuMix(after, before, a)[0])).toBeGreaterThan(40);
    expect(Math.abs(shaderMix(after, before, a)[0] - cpuMix(after, before, a)[0])).toBeLessThanOrEqual(1);
  });
});
