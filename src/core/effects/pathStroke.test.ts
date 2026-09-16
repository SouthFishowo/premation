/**
 * AE Stroke (`path-stroke`) — dabs along mask paths, revealed by Start/End.
 *
 * Paths are given in RASTER px directly, so every pixel asserted below can be
 * located on paper: a 40×40 buffer, horizontal lines through pixel-row centres.
 */

import { pathStrokeData, dabStep, pathStrokeEffectData, type PathStrokeOptions } from './pathStroke';
import { packMaskPaths } from './strokePaint';
import { applyCanvas2dEffect, hasCanvas2dImplementation, isCanvas2dOnlyEffect } from './canvas2dEffects';
import { defaultParams, effectDefFor, type Effect } from './effects';
import type { MaskPath } from './mask';

const W = 40;
const H = 40;
const blank = (): Uint8ClampedArray => new Uint8ClampedArray(W * H * 4);
const green = (): Uint8ClampedArray => {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < d.length; i += 4) { d[i + 1] = 255; d[i + 3] = 255; }
  return d;
};
const px = (d: Uint8ClampedArray, x: number, y: number): number[] => [...d.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
const alpha = (d: Uint8ClampedArray, x: number, y: number): number => d[(y * W + x) * 4 + 3]!;

/** (5, 20.5) → (35, 20.5): row 20's centres, length 30. */
const LINE = { points: [{ x: 5, y: 20.5 }, { x: 35, y: 20.5 }], closed: false };

const opts = (over: Partial<PathStrokeOptions> = {}): PathStrokeOptions => ({
  rgb: [255, 0, 0], brushSize: 6, hardness: 100, opacity: 100, start: 0, end: 100,
  spacing: 10, paintStyle: 0, sequential: false, ...over,
});

describe('pathStrokeData', () => {
  it('draws a continuous hard line along the path and nothing off it', () => {
    const out = pathStrokeData(blank(), W, H, [LINE], opts());
    expect(px(out, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(alpha(out, 20, 24)).toBe(0); // centre 4 px down: past the 3 px radius and its ½ px rim
    expect(alpha(out, 20, 10)).toBe(0);
    // Continuous: every column between the ends is painted on the path row.
    for (let x = 6; x <= 34; x++) expect(alpha(out, x, 20)).toBe(255);
  });

  it('Start/End reveal by arc length, in either order', () => {
    // 50 → 100 % of 30 px: x from 20 to 35.
    const half = pathStrokeData(blank(), W, H, [LINE], opts({ start: 50, end: 100 }));
    expect(alpha(half, 10, 20)).toBe(0);
    expect(alpha(half, 30, 20)).toBe(255);
    const swapped = pathStrokeData(blank(), W, H, [LINE], opts({ start: 100, end: 50 }));
    expect([...swapped]).toEqual([...half]);
  });

  it('a soft brush keeps a solid core and a partial rim', () => {
    const out = pathStrokeData(blank(), W, H, [LINE], opts({ brushSize: 12, hardness: 0 }));
    expect(alpha(out, 20, 20)).toBeGreaterThan(240);
    const rim = alpha(out, 20, 24);
    expect(rim).toBeGreaterThan(0);
    expect(rim).toBeLessThan(200);
  });

  it('Paint Style On Transparent discards the layer; Reveal shows it only under the stroke', () => {
    const t = pathStrokeData(green(), W, H, [LINE], opts({ paintStyle: 1 }));
    expect(px(t, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(alpha(t, 2, 2)).toBe(0);
    const r = pathStrokeData(green(), W, H, [LINE], opts({ paintStyle: 2 }));
    expect(px(r, 20, 20)).toEqual([0, 255, 0, 255]);
    expect(alpha(r, 2, 2)).toBe(0);
    const o = pathStrokeData(green(), W, H, [LINE], opts({ paintStyle: 0 }));
    expect(px(o, 2, 2)).toEqual([0, 255, 0, 255]);
  });

  it('Opacity is the whole stroke’s, not each overlapping dab’s', () => {
    const out = pathStrokeData(blank(), W, H, [LINE], opts({ opacity: 50, paintStyle: 1 }));
    const a = alpha(out, 20, 20);
    expect(a).toBeGreaterThanOrEqual(127);
    expect(a).toBeLessThanOrEqual(128);
  });

  describe('two masks', () => {
    // Two 30 px lines, rows 10 and 30. Start 0 → End 50.
    const TOP = { points: [{ x: 5, y: 10.5 }, { x: 35, y: 10.5 }], closed: false };
    const BOT = { points: [{ x: 5, y: 30.5 }, { x: 35, y: 30.5 }], closed: false };

    it('non-sequential: each mask is revealed over the same percentage', () => {
      const out = pathStrokeData(blank(), W, H, [TOP, BOT], opts({ end: 50 }));
      expect(alpha(out, 10, 10)).toBe(255);
      expect(alpha(out, 10, 30)).toBe(255);
      expect(alpha(out, 30, 10)).toBe(0);
    });

    it('Stroke Sequentially: 50 % of the combined 60 px is the whole first mask and none of the second', () => {
      const out = pathStrokeData(blank(), W, H, [TOP, BOT], opts({ end: 50, sequential: true }));
      expect(alpha(out, 30, 10)).toBe(255);
      expect(alpha(out, 10, 30)).toBe(0);
    });
  });

  it('spacing is a percentage of the brush, floored so 0 % is dense rather than infinite', () => {
    expect(dabStep(20, 15)).toBeCloseTo(3, 9);
    expect(dabStep(20, 0)).toBe(0.5);
  });
});

describe('the Stroke effect end to end (resolved masks → pixels)', () => {
  const corner = (x: number, y: number): MaskPath['points'][number] => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  // A centred 20×20 square mask: raster edges at 10 and 30 on a 40×40 layer.
  const square: MaskPath = {
    id: 'sq', mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false,
    points: [corner(-10, -10), corner(10, -10), corner(10, 10), corner(-10, 10)],
  };
  const effect = (over: Record<string, unknown>): Effect => {
    const packed = packMaskPaths([square]);
    return {
      id: 's', type: 'path-stroke',
      params: { ...defaultParams(effectDefFor('path-stroke')!), brushSize: 4, brushHardness: 100, maskPathsMeta: packed.meta, maskPathsXY: packed.xy, pathMaskIndex: -1, ...over },
    } as Effect;
  };

  it('an unset Path strokes the first mask, closing edge included', () => {
    const out = pathStrokeEffectData(blank(), W, H, effect({ pathMaskId: '' }));
    expect(alpha(out, 20, 10)).toBe(255); // top edge
    expect(alpha(out, 10, 20)).toBe(255); // left edge = the closing edge
    expect(alpha(out, 20, 20)).toBe(0); // interior untouched
  });

  it('a Path naming a mask the layer no longer has draws nothing', () => {
    const out = pathStrokeEffectData(blank(), W, H, effect({ pathMaskId: 'deleted', pathMaskIndex: -1 }));
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('is a Canvas2D-only effect the bake can dispatch', () => {
    expect(isCanvas2dOnlyEffect('path-stroke')).toBe(true);
    expect(hasCanvas2dImplementation('path-stroke')).toBe(true);
    expect(typeof applyCanvas2dEffect).toBe('function');
  });
});
