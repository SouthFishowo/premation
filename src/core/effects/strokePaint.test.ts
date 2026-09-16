/**
 * The shared brush machinery under Stroke, Write-on and Scribble.
 *
 * Every expected number is worked by hand from the fixture in the comment
 * above it — the dab profile, the max-alpha accumulation, the three Paint
 * Styles, the cursor walk and the packed mask hand-off.
 */

import {
  dabCoverage, PaintBuffer, compositePaint, walkPolyline, polylineLength,
  packMaskPaths, unpackMaskPaths, pickMaskPaths, effectWantsAllMaskPaths, PAINT_STYLE,
} from './strokePaint';
import type { MaskPath } from './mask';

const corner = (x: number, y: number): MaskPath['points'][number] => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const mask = (over: Partial<MaskPath> = {}): MaskPath => ({
  id: 'm', mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false,
  points: [corner(-10, -10), corner(10, -10), corner(10, 10), corner(-10, 10)],
  ...over,
});

describe('dabCoverage', () => {
  it('a 100 %-hard dab is solid to r − ½ and antialiased over one pixel', () => {
    // r = 5, hardness 1 → soft band 0 < 1 → clamp(5.5 − d).
    expect(dabCoverage(0, 5, 1)).toBe(1);
    expect(dabCoverage(4.5, 5, 1)).toBe(1);
    expect(dabCoverage(5, 5, 1)).toBe(0.5);
    expect(dabCoverage(5.5, 5, 1)).toBe(0);
  });

  it('a 0 %-hard dab falls off on a smoothstep from the centre', () => {
    // r = 10, inner 0: d = 5 → t = .5 → 1 − .25·2 = .5; d = 2.5 → t = .25 → 1 − .0625·2.5 = .84375.
    expect(dabCoverage(5, 10, 0)).toBeCloseTo(0.5, 9);
    expect(dabCoverage(2.5, 10, 0)).toBeCloseTo(0.84375, 9);
    expect(dabCoverage(10, 10, 0)).toBe(0);
  });

  it('50 % hardness keeps the inner half solid', () => {
    expect(dabCoverage(4.9, 10, 0.5)).toBe(1);
    expect(dabCoverage(7.5, 10, 0.5)).toBeCloseTo(0.5, 9);
  });
});

describe('PaintBuffer', () => {
  it('overlapping dabs do NOT build up past their own opacity', () => {
    // Two identical 50 % dabs: source-over would give .75 at the centre.
    const b = new PaintBuffer(9, 9);
    b.stampDab(4.5, 4.5, 6, 1, 0.5, [255, 0, 0]);
    b.stampDab(4.5, 4.5, 6, 1, 0.5, [255, 0, 0]);
    expect(b.a[4 * 9 + 4]).toBeCloseTo(0.5, 6);
  });

  it('a later dab drags the colour toward its own by its coverage', () => {
    const b = new PaintBuffer(9, 9);
    b.stampDab(4.5, 4.5, 6, 1, 1, [255, 0, 0]);
    b.stampDab(4.5, 4.5, 6, 1, 1, [0, 0, 255]);
    const i = 4 * 9 + 4;
    expect([b.r[i], b.g[i], b.b[i]]).toEqual([0, 0, 255]);
  });

  it('clips a dab at the buffer edge instead of wrapping or throwing', () => {
    const b = new PaintBuffer(4, 4);
    b.stampDab(-1, -1, 6, 1, 1, [255, 255, 255]);
    expect(b.a[0]).toBe(1);
    expect(b.a[15]).toBe(0);
  });
});

describe('compositePaint — the three Paint Styles', () => {
  // Two pixels of opaque green; red paint at full alpha on pixel 0 only.
  const src = (): Uint8ClampedArray => new Uint8ClampedArray([0, 255, 0, 255, 0, 255, 0, 255]);
  const paint = (): PaintBuffer => {
    const b = new PaintBuffer(2, 1);
    b.paint(0, 1, 1, [255, 0, 0]);
    return b;
  };

  it('On Original Image paints over the layer', () => {
    expect([...compositePaint(src(), paint(), PAINT_STYLE.onOriginal, 1)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('On Transparent keeps only the paint', () => {
    expect([...compositePaint(src(), paint(), PAINT_STYLE.onTransparent, 1)]).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
  });

  it('Reveal Original Image shows the LAYER where painted, and nothing elsewhere', () => {
    expect([...compositePaint(src(), paint(), PAINT_STYLE.revealOriginal, 1)]).toEqual([0, 255, 0, 255, 0, 255, 0, 0]);
  });

  it('Opacity scales the whole stroke once', () => {
    // pa = .5 over da = 1 → oa 1, r = 255·.5 = 127.5, g = 255·.5 = 127.5.
    const out = compositePaint(src(), paint(), PAINT_STYLE.onOriginal, 0.5);
    expect(out[0]).toBeGreaterThanOrEqual(127);
    expect(out[0]).toBeLessThanOrEqual(128);
    expect(out[1]).toBeGreaterThanOrEqual(127);
    expect(out[3]).toBe(255);
  });
});

describe('walkPolyline', () => {
  const SQ = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it('visits every step round a closed square, closing edge included', () => {
    // Perimeter 40, step 5: 0, 5, …, 40 — nine visits, the last back at (0,0).
    const seen: Array<[number, number]> = [];
    walkPolyline(SQ, true, 0, 40, 5, (x, y) => seen.push([x, y]));
    expect(seen).toHaveLength(9);
    expect(seen[3]).toEqual([10, 5]);
    expect(seen[7]).toEqual([0, 5]);
    expect(seen[8]).toEqual([0, 0]);
  });

  it('puts a final dab exactly on the end when the steps fall short of it', () => {
    // Open, length 30, step 7 over [0, 20]: 0, 7, 14, then the end at 20 → (10, 10).
    const seen: number[] = [];
    walkPolyline(SQ, false, 0, 20, 7, (_x, _y, s) => seen.push(s));
    expect(seen).toEqual([0, 7, 14, 20]);
  });

  it('a range past the end of the path visits nothing', () => {
    const seen: number[] = [];
    walkPolyline(SQ, false, 35, 40, 1, (_x, _y, s) => seen.push(s));
    expect(seen).toEqual([]);
  });

  it('measures open and closed lengths', () => {
    expect(polylineLength(SQ, false)).toBe(30);
    expect(polylineLength(SQ, true)).toBe(40);
  });
});

describe('the packed all-masks hand-off', () => {
  it('round-trips order, closed flag, mode and inversion, shifted to raster px', () => {
    const packed = packMaskPaths([
      mask({ id: 'a', mode: 'subtract', inverted: true }),
      mask({ id: 'b', closed: false, points: [corner(0, 0), corner(20, 0)] }),
    ]);
    // Closed square: 4 cubics × 16 + 1 = 65 points. Open line: 1 × 16 + 1 = 17.
    expect(packed.meta).toEqual([65, 1, 2, 1, 17, 0, 1, 0]);
    expect(packed.xy).toHaveLength((65 + 17) * 2);
    const back = unpackMaskPaths(packed.meta, packed.xy, 100, 60);
    expect(back.map((m) => [m.points.length, m.closed, m.mode, m.inverted])).toEqual([
      [65, true, 'subtract', true],
      [17, false, 'add', false],
    ]);
    expect(back[0]!.points[0]).toEqual({ x: 40, y: 20 });
    expect(back[1]!.points[16]).toEqual({ x: 70, y: 30 });
  });

  it('keeps a row for an unflattenable mask so indices stay the stack indices', () => {
    const packed = packMaskPaths([mask({ points: [corner(0, 0)] }), mask()]);
    expect(packed.meta.slice(0, 4)).toEqual([0, 1, 1, 0]);
    expect(unpackMaskPaths(packed.meta, packed.xy, 10, 10)).toHaveLength(2);
  });

  it('picks the first mask for an empty Path, the index for a set one, nothing for a missing one', () => {
    const packed = packMaskPaths([mask({ id: 'a' }), mask({ id: 'b', points: [corner(0, 0), corner(5, 0)], closed: false })]);
    const base = { maskPathsMeta: packed.meta, maskPathsXY: packed.xy };
    expect(pickMaskPaths({ ...base, pathMaskId: '' }, 10, 10, false)[0]!.closed).toBe(true);
    expect(pickMaskPaths({ ...base, pathMaskId: 'b', pathMaskIndex: 1 }, 10, 10, false)[0]!.closed).toBe(false);
    expect(pickMaskPaths({ ...base, pathMaskId: 'gone', pathMaskIndex: -1 }, 10, 10, false)).toEqual([]);
    expect(pickMaskPaths({ ...base, pathMaskId: 'gone', pathMaskIndex: -1 }, 10, 10, true)).toHaveLength(2);
  });

  it('is requested by Stroke and Scribble always, by Vegas only with All Masks', () => {
    expect(effectWantsAllMaskPaths('path-stroke', {})).toBe(true);
    expect(effectWantsAllMaskPaths('scribble', {})).toBe(true);
    expect(effectWantsAllMaskPaths('vegas', {})).toBe(false);
    expect(effectWantsAllMaskPaths('vegas', { allMasks: true })).toBe(true);
    expect(effectWantsAllMaskPaths('write-on', { allMasks: true })).toBe(false);
  });
});
