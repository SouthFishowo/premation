/**
 * Write-on, brush form — the recorded dab history and the kernel that paints it.
 *
 * The animation engine is faked with linear tracks so every sampled value is
 * arithmetic: Brush Position X goes −10 → +10 over one second.
 */

import {
  resolveWriteOnTrail, writeOnBrushData, writeOnUsesBrush, WRITE_ON_MAX_TRAIL, TRAIL_ATTR_STRIDE,
  type WriteOnTrail, type WriteOnBrushOptions,
} from './writeOnBrush';
import { effectsNeedCpuBake } from './effectBake';
import {
  defaultParams, effectDefFor, newInstanceParamsOf, type Effect, type EffectParams, type EffectParamValue,
} from './effects';

const X = 'effect.w1.brushPositionX';
const lerpTrack = (prop: string, t: number): number | undefined => {
  if (prop === X) return -10 + 20 * Math.max(0, Math.min(1, t));
  if (prop === 'effect.w1.brushColor_r') return Math.max(0, Math.min(1, t));
  return undefined;
};
const animated = (props: string[]) => (prop: string): boolean => props.includes(prop);
const params = (over: Record<string, EffectParamValue> = {}): EffectParams => ({
  ...defaultParams(effectDefFor('write-on')!), writeOnMode: 0, brushSpacing: 0.25, ...over,
});
const xs = (tr: WriteOnTrail): number[] => tr.xy.filter((_, i) => i % 2 === 0);

describe('resolveWriteOnTrail', () => {
  it('lays a dab every Brush Spacing seconds from the first keyframe to now', () => {
    // t = 0, .25, .5, .75, 1 → x = −10, −5, 0, 5, 10.
    const tr = resolveWriteOnTrail('w1', params(), 1, lerpTrack, animated([X]), 0);
    expect(xs(tr)).toEqual([-10, -5, 0, 5, 10]);
    expect(tr.filled).toBe(false);
  });

  it('Stroke Length keeps only the last N seconds', () => {
    // 0.5 s: t = .5, .75, 1.
    const tr = resolveWriteOnTrail('w1', params({ strokeLength: 0.5 }), 1, lerpTrack, animated([X]), 0);
    expect(xs(tr)).toEqual([0, 5, 10]);
  });

  it('dab times sit on a fixed grid, plus one dab at the playhead', () => {
    // t = 0.3: grid 0, .25, then the playhead's own at .3 → x = −4.
    const tr = resolveWriteOnTrail('w1', params(), 0.3, lerpTrack, animated([X]), 0);
    expect(xs(tr).map((v) => Number(v.toFixed(6)))).toEqual([-10, -5, -4]);
  });

  it('an unanimated brush is one dab at the current position', () => {
    const tr = resolveWriteOnTrail('w1', params({ brushPositionX: 7 }), 5, lerpTrack, animated([]), 0);
    expect(tr.xy).toEqual([7, 0]);
  });

  it('thins a trail past the sample budget and asks the kernel to fill it', () => {
    const tr = resolveWriteOnTrail('w1', params({ brushSpacing: 0.001 }), 10, lerpTrack, animated([X]), 0);
    expect(tr.xy.length / 2).toBe(WRITE_ON_MAX_TRAIL);
    expect(tr.filled).toBe(true);
  });

  it('records each dab’s colour at the time it was laid', () => {
    const tr = resolveWriteOnTrail('w1', params({ brushColor: '#000000' }), 1, lerpTrack, animated([X, 'effect.w1.brushColor_r']), 0);
    const reds = tr.attr.filter((_, i) => i % TRAIL_ATTR_STRIDE === 2);
    expect(reds.map((v) => Math.round(v))).toEqual([0, 64, 128, 191, 255]);
  });
});

describe('writeOnBrushData', () => {
  const W = 40;
  const H = 20;
  const a = (d: Uint8ClampedArray, x: number, y: number): number => d[(y * W + x) * 4 + 3]!;
  const o = (over: Partial<WriteOnBrushOptions> = {}): WriteOnBrushOptions => ({
    brushX: 0, brushY: 0, rgb: [255, 255, 255], size: 4, hardness: 100, opacity: 100,
    paintTimeProps: 0, brushTimeProps: 0, paintStyle: 1, ...over,
  });
  // Two dabs 20 px apart through the centre row: raster x = 10.5 and 30.5.
  const trail = (filled: boolean): WriteOnTrail => ({
    xy: [-9.5, 0.5, 10.5, 0.5], size: [4, 12], attr: [100, 50, 255, 0, 0, 100, 50, 0, 0, 255], filled,
  });

  it('stamps only the recorded dabs, and fills between them when the trail was thinned', () => {
    const sparse = writeOnBrushData(new Uint8ClampedArray(W * H * 4), W, H, trail(false), o());
    expect(a(sparse, 10, 10)).toBe(255);
    expect(a(sparse, 20, 10)).toBe(0);
    const filled = writeOnBrushData(new Uint8ClampedArray(W * H * 4), W, H, trail(true), o());
    expect(a(filled, 20, 10)).toBe(255);
  });

  it('Paint Time Properties ▸ Opacity keeps each dab’s own opacity; None uses the current one', () => {
    const none = writeOnBrushData(new Uint8ClampedArray(W * H * 4), W, H, trail(false), o());
    expect(a(none, 10, 10)).toBe(255);
    const perDab = writeOnBrushData(new Uint8ClampedArray(W * H * 4), W, H, trail(false), o({ paintTimeProps: 1 }));
    expect(Math.abs(a(perDab, 10, 10) - 128)).toBeLessThanOrEqual(1);
  });

  it('Brush Time Properties ▸ Size draws each dab at its recorded size', () => {
    // The second dab was laid at 12 px: 5 px from its centre is inside it only then.
    const now = writeOnBrushData(new Uint8ClampedArray(W * H * 4), W, H, trail(false), o());
    expect(a(now, 35, 10)).toBe(0);
    const recorded = writeOnBrushData(new Uint8ClampedArray(W * H * 4), W, H, trail(false), o({ brushTimeProps: 1 }));
    expect(a(recorded, 35, 10)).toBe(255);
  });

  it('with no resolved trail it draws one dab at the current Brush Position', () => {
    const out = writeOnBrushData(new Uint8ClampedArray(W * H * 4), W, H, { xy: [], size: [], attr: [], filled: false }, o({ brushX: 5 }));
    expect(a(out, 25, 10)).toBe(255);
    expect(a(out, 10, 10)).toBe(0);
  });
});

describe('Write-on mode and routing', () => {
  const fx = (params: Record<string, unknown>): Effect => ({ id: 'w1', type: 'write-on', params } as Effect);

  it('a stored document with no mode reads Classic, and keeps the GPU shader', () => {
    expect(defaultParams(effectDefFor('write-on')!).writeOnMode).toBe(1);
    expect(effectsNeedCpuBake([fx({ startX: -40, endX: 40 })])).toBe(false);
  });

  it('a NEW instance starts on the brush, which bakes on the CPU', () => {
    const fresh = newInstanceParamsOf(effectDefFor('write-on')!);
    expect(fresh.writeOnMode).toBe(0);
    expect(writeOnUsesBrush(fresh)).toBe(true);
    expect(effectsNeedCpuBake([fx({ ...fresh })])).toBe(true);
  });
});
