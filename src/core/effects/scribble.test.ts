/**
 * Scribble — the region, the pen line, and the determinism contract.
 *
 * Regions are rasterised at pixel centres, so every count below is a count of
 * centres inside a shape, done on paper from the fixture.
 */

import {
  fillPolygon, fillDisc, strokeBand, combineMasksByMode, scribbleStrands, scribbleData, scribbleRegion,
  scribbleWiggleState, wiggleRandom, trimPolyline, LINE_CAP, LINE_JOIN, SCRIBBLE_FILL, SCRIBBLE_MODE, WIGGLE_TYPE,
  type ScribbleOptions,
} from './scribble';
import type { ResolvedMaskPath } from './strokePaint';
import { isCanvas2dOnlyEffect } from './canvas2dEffects';

const count = (m: Uint8Array): number => m.reduce((s, v) => s + v, 0);
const sq = (x0: number, y0: number, x1: number, y1: number, over: Partial<ResolvedMaskPath> = {}): ResolvedMaskPath => ({
  points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  closed: true, mode: 'add', inverted: false, ...over,
});

describe('region rasterisation', () => {
  it('fills a square by pixel centres: 10 × 10 = 100', () => {
    const m = new Uint8Array(30 * 30);
    fillPolygon(m, 30, 30, sq(10, 10, 20, 20).points);
    expect(count(m)).toBe(100);
    expect(m[10 * 30 + 10]).toBe(1);
    expect(m[20 * 30 + 20]).toBe(0);
  });

  it('fills a disc of radius 5 with about π·25 centres', () => {
    const m = new Uint8Array(20 * 20);
    fillDisc(m, 20, 20, 10, 10, 5);
    expect(Math.abs(count(m) - Math.PI * 25)).toBeLessThan(8);
  });

  describe('strokeBand — caps, sides and joins', () => {
    // (5, 15) → (25, 15), half-width 3: rows with centres in [12, 18] are 12..17.
    const LINE = [{ x: 5, y: 15 }, { x: 25, y: 15 }];

    it('butt: exactly the 20 × 6 rectangle', () => {
      const m = new Uint8Array(30 * 30);
      strokeBand(m, 30, 30, LINE, false, 3, 3, LINE_CAP.butt, LINE_JOIN.round, 4);
      expect(count(m)).toBe(120);
    });

    it('projecting: extends each end by the half-width — 26 × 6', () => {
      const m = new Uint8Array(30 * 30);
      strokeBand(m, 30, 30, LINE, false, 3, 3, LINE_CAP.projecting, LINE_JOIN.round, 4);
      expect(count(m)).toBe(156);
    });

    it('round: more than butt, less than projecting', () => {
      const m = new Uint8Array(30 * 30);
      strokeBand(m, 30, 30, LINE, false, 3, 3, LINE_CAP.round, LINE_JOIN.round, 4);
      expect(count(m)).toBeGreaterThan(120);
      expect(count(m)).toBeLessThan(156);
    });

    it('Left Edge puts the whole width on the left of travel — UP for a rightward path', () => {
      const m = new Uint8Array(30 * 30);
      strokeBand(m, 30, 30, LINE, false, 6, 0, LINE_CAP.butt, LINE_JOIN.round, 4);
      expect(m[10 * 30 + 15]).toBe(1);
      expect(m[16 * 30 + 15]).toBe(0);
    });

    /**
     * An L: (5,20) → (20,20) → (20,5), half-width 3. The turn is to the left
     * (up), so the OUTER corner is bottom-right at (23, 23). Pixel (22, 22)'s
     * centre (22.5, 22.5) is inside the miter square but past the bevel's
     * diagonal x + y = 43.
     */
    const L = [{ x: 5, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 5 }];
    it('miter fills the outer corner, bevel cuts it, and a miter past the limit bevels', () => {
      const at = (join: number, limit: number): number => {
        const m = new Uint8Array(30 * 30);
        strokeBand(m, 30, 30, L, false, 3, 3, LINE_CAP.butt, join, limit);
        return m[22 * 30 + 22]!;
      };
      expect(at(LINE_JOIN.miter, 4)).toBe(1);
      expect(at(LINE_JOIN.bevel, 4)).toBe(0);
      // A right angle's miter ratio is √2 ≈ 1.414 > 1.
      expect(at(LINE_JOIN.miter, 1)).toBe(0);
    });
  });

  describe('combineMasksByMode', () => {
    const A = sq(0, 0, 10, 10);
    const B = (mode: ResolvedMaskPath['mode']): ResolvedMaskPath => sq(5, 5, 15, 15, { mode });
    const at = (m: Uint8Array, x: number, y: number): number => m[y * 20 + x]!;

    it('Add then Subtract cuts the overlap out', () => {
      const m = combineMasksByMode([A, B('subtract')], 20, 20);
      expect([at(m, 2, 2), at(m, 7, 7), at(m, 12, 12)]).toEqual([1, 0, 0]);
    });

    it('Difference toggles the overlap', () => {
      const m = combineMasksByMode([A, B('difference')], 20, 20);
      expect([at(m, 2, 2), at(m, 7, 7), at(m, 12, 12)]).toEqual([1, 0, 1]);
    });

    it('a lone first Subtract cuts from the full layer, as AE does', () => {
      const m = combineMasksByMode([B('subtract')], 20, 20);
      expect([at(m, 2, 2), at(m, 7, 7)]).toEqual([1, 0]);
    });

    it('None contributes nothing; Inverted fills the outside', () => {
      expect(count(combineMasksByMode([sq(0, 0, 10, 10, { mode: 'none' })], 20, 20))).toBe(0);
      const inv = combineMasksByMode([sq(0, 0, 10, 10, { inverted: true })], 20, 20);
      expect([at(inv, 2, 2), at(inv, 15, 15)]).toEqual([0, 1]);
    });
  });
});

describe('scribbleStrands', () => {
  const base = {
    angle: 0, spacing: 5, spacingVariation: 0, curviness: 0, curvinessVariation: 0,
    pathOverlap: 0, pathOverlapVariation: 0, seed: 0, wiggleState: 0, smoothWiggle: false,
  };
  const region = (w: number, h: number, ...boxes: Array<[number, number, number, number]>): Uint8Array => {
    const m = new Uint8Array(w * h);
    for (const b of boxes) fillPolygon(m, w, h, sq(...b).points);
    return m;
  };

  /**
   * A 30 × 30 square (pixels 5..34) at angle 0, spacing 5: lines at y = 7.5,
   * 12.5, …, 32.5 — six passes, every span [5, 35], so ONE strand zig-zagging
   * (5,7.5)→(35,7.5), (35,12.5)→(5,12.5), …
   */
  it('zig-zags one strand across a square, line by line', () => {
    const strands = scribbleStrands(region(40, 40, [5, 5, 35, 35]), 40, 40, base);
    expect(strands).toHaveLength(1);
    const s = strands[0]!;
    expect(s).toHaveLength(12);
    expect(s[0]).toEqual({ x: 5, y: 7.5 });
    expect(s[1]).toEqual({ x: 35, y: 7.5 });
    expect(s[2]).toEqual({ x: 35, y: 12.5 });
    expect(s[3]).toEqual({ x: 5, y: 12.5 });
    expect(s[11]!.y).toBe(32.5);
  });

  it('two separate blobs are two strands — the pen never crosses the gap', () => {
    const strands = scribbleStrands(region(60, 20, [2, 2, 18, 18], [40, 2, 58, 18]), 60, 20, base);
    expect(strands).toHaveLength(2);
    for (const s of strands) {
      const xs = s.map((p) => p.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(20);
    }
  });

  it('Path Overlap pushes each end past the edge by a percentage of the spacing', () => {
    // 100 % of 5 px beyond both ends: the first pass runs 0 → 40.
    const s = scribbleStrands(region(40, 40, [5, 5, 35, 35]), 40, 40, { ...base, pathOverlap: 100 })[0]!;
    expect(s[0]).toEqual({ x: 0, y: 7.5 });
    expect(s[1]).toEqual({ x: 40, y: 7.5 });
  });

  it('Curviness adds a curved turn between passes; 0 is a sharp zig-zag', () => {
    const sharp = scribbleStrands(region(40, 40, [5, 5, 35, 35]), 40, 40, base)[0]!;
    const curvy = scribbleStrands(region(40, 40, [5, 5, 35, 35]), 40, 40, { ...base, curviness: 60 })[0]!;
    expect(curvy.length).toBeGreaterThan(sharp.length);
    // The turn bulges OUTWARD past the pass end, not back into the fill.
    expect(Math.max(...curvy.map((p) => p.x))).toBeGreaterThan(35);
  });

  it('is deterministic per seed and state, and a variation moves it with the state', () => {
    const r = region(40, 40, [5, 5, 35, 35]);
    const varied = { ...base, spacingVariation: 2, curviness: 30, curvinessVariation: 50, pathOverlapVariation: 40 };
    expect(scribbleStrands(r, 40, 40, varied)).toEqual(scribbleStrands(r, 40, 40, varied));
    expect(scribbleStrands(r, 40, 40, { ...varied, wiggleState: 3 })).not.toEqual(scribbleStrands(r, 40, 40, varied));
    expect(scribbleStrands(r, 40, 40, { ...varied, seed: 9 })).not.toEqual(scribbleStrands(r, 40, 40, varied));
  });
});

describe('the wiggle', () => {
  it('Smooth meets Jumpy exactly at integer states and eases between them', () => {
    expect(wiggleRandom(7, 1, 2, true)).toBe(wiggleRandom(7, 1, 2, false));
    const a = wiggleRandom(7, 1, 2, false);
    const b = wiggleRandom(7, 1, 3, false);
    const mid = wiggleRandom(7, 1, 2.5, true);
    expect(mid).toBeCloseTo((a + b) / 2, 9); // smoothstep(.5) = .5
  });

  it('resolves the state from the layer clock by Wiggle Type', () => {
    const p = (type: number, wps = 2): Record<string, number> => ({ wiggleType: type, wigglesPerSecond: wps });
    expect(scribbleWiggleState(p(WIGGLE_TYPE.static), 1.3)).toBe(0);
    expect(scribbleWiggleState(p(WIGGLE_TYPE.jumpy), 1.3)).toBe(2);
    expect(scribbleWiggleState(p(WIGGLE_TYPE.smooth), 1.3)).toBeCloseTo(2.6, 9);
    expect(scribbleWiggleState(p(WIGGLE_TYPE.smooth, 0), 1.3)).toBe(0);
    expect(scribbleWiggleState(p(WIGGLE_TYPE.smooth), undefined)).toBe(0);
  });
});

describe('scribbleData', () => {
  const W = 40;
  const H = 40;
  const square = sq(5, 5, 35, 35);
  const o = (over: Partial<ScribbleOptions> = {}): ScribbleOptions => ({
    mode: SCRIBBLE_MODE.singleMask, fillType: SCRIBBLE_FILL.inside, edgeWidth: 4, endCap: LINE_CAP.round, join: LINE_JOIN.round,
    miterLimit: 4, rgb: [255, 255, 255], opacity: 100, angle: 0, strokeWidth: 2, curviness: 0, curvinessVariation: 0,
    spacing: 5, spacingVariation: 0, pathOverlap: 0, pathOverlapVariation: 0, start: 0, end: 100, sequential: true,
    seed: 0, wiggleState: 0, smoothWiggle: false, composite: 1, ...over,
  });
  const a = (d: Uint8ClampedArray, x: number, y: number): number => d[(y * W + x) * 4 + 3]!;

  it('draws the pen lines inside the mask on a transparent ground', () => {
    const out = scribbleData(new Uint8ClampedArray(W * H * 4), W, H, [square], [square], o());
    expect(a(out, 20, 7)).toBe(255); // on the first line, y = 7.5
    expect(a(out, 20, 10)).toBe(0); // between lines 7.5 and 12.5
    expect(a(out, 2, 20)).toBe(0); // outside the mask
  });

  it('Start = End draws nothing, and End reveals the pen from its start', () => {
    expect(scribbleData(new Uint8ClampedArray(W * H * 4), W, H, [square], [square], o({ end: 0 })).every((v) => v === 0)).toBe(true);
    // Six 30 px passes + five 5 px turns = 205 px; 10 % = 20.5 px ends at x ≈ 25.5 on the first pass.
    const part = scribbleData(new Uint8ClampedArray(W * H * 4), W, H, [square], [square], o({ end: 10 }));
    expect(a(part, 10, 7)).toBe(255);
    expect(a(part, 33, 7)).toBe(0);
    expect(a(part, 20, 17)).toBe(0);
  });

  it('Centered Edge scribbles a band on the outline and leaves the middle empty', () => {
    const out = scribbleData(new Uint8ClampedArray(W * H * 4), W, H, [square], [square], o({ fillType: SCRIBBLE_FILL.centeredEdge, edgeWidth: 6 }));
    expect(a(out, 20, 20)).toBe(0);
    let ink = 0;
    for (let i = 3; i < out.length; i += 4) ink += out[i]!;
    expect(ink).toBeGreaterThan(0);
  });

  it('Inside Edge stays inside the outline; Outside Edge stays outside', () => {
    const inside = scribbleRegion([square], (() => { const m = new Uint8Array(W * H); fillPolygon(m, W, H, square.points); return m; })(), W, H, { fillType: SCRIBBLE_FILL.insideEdge, edgeWidth: 4, endCap: 1, join: 1, miterLimit: 4 });
    expect(inside[20 * W + 6]).toBe(1);
    expect(inside[20 * W + 3]).toBe(0);
    const outside = scribbleRegion([square], (() => { const m = new Uint8Array(W * H); fillPolygon(m, W, H, square.points); return m; })(), W, H, { fillType: SCRIBBLE_FILL.outsideEdge, edgeWidth: 4, endCap: 1, join: 1, miterLimit: 4 });
    expect(outside[20 * W + 6]).toBe(0);
    expect(outside[20 * W + 3]).toBe(1);
  });

  it('All Masks Using Modes scribbles the combined region only', () => {
    const cut = sq(15, 0, 40, 40, { mode: 'subtract' });
    const out = scribbleData(new Uint8ClampedArray(W * H * 4), W, H, [square, cut], [square], o({ mode: SCRIBBLE_MODE.allMasksUsingModes }));
    expect(a(out, 10, 7)).toBe(255);
    expect(a(out, 25, 7)).toBe(0);
  });

  it('Composite: On Original keeps the layer, Reveal shows the layer only under the pen', () => {
    const src = new Uint8ClampedArray(W * H * 4).fill(255);
    const over = scribbleData(src, W, H, [square], [square], o({ composite: 0, rgb: [255, 0, 0] }));
    expect(a(over, 2, 2)).toBe(255);
    const reveal = scribbleData(src, W, H, [square], [square], o({ composite: 2 }));
    expect(a(reveal, 2, 2)).toBe(0);
    expect(a(reveal, 20, 7)).toBe(255);
  });

  it('trims a polyline to an arc range', () => {
    expect(trimPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 5, 15)).toEqual([
      { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 },
    ]);
  });

  it('is Canvas2D-only', () => {
    expect(isCanvas2dOnlyEffect('scribble')).toBe(true);
  });
});
