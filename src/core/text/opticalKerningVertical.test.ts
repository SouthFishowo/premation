/**
 * Optical kerning in vertical columns (rotated Latin along its run, upright
 * CJK from top/bottom ink) and the cross-size pair cache.
 */

import {
  BAND_COUNT,
  isProportionalCjk,
  opticalKernPx,
  opticalKernVerticalPx,
  profileFromContours,
  resetOpticalKerningForTest,
  setOpticalRasterizer,
  setOpticalVerticalRasterizer,
  verticalProfileFromAlpha,
  type InkProfile,
  type OpticalFace,
} from './opticalKerning';
import { layoutVerticalText, isUprightInVertical } from './verticalLayout';
import type { TextStyle } from './textLayout';

const face: OpticalFace = { css: '400 128px "Synthetic"', family: 'Synthetic' };

/** A vertical profile whose ink spans [top, bottom] em down the em box, across the whole column. */
function verticalInk(top: number, bottom: number): InkProfile {
  const W = 20;
  const H = 20;
  const rgba = new Uint8Array(W * H * 4);
  for (let row = Math.round(top * H); row < Math.round(bottom * H); row++) {
    for (let col = 2; col < W - 2; col++) rgba[(row * W + col) * 4 + 3] = 255;
  }
  return verticalProfileFromAlpha(rgba, W, H, 0, 0, W);
}

describe('vertical ink profiles', () => {
  it('reads the topmost and bottommost ink per band across the column, advance one em', () => {
    const p = verticalInk(0.25, 0.75);
    expect(p.advance).toBe(1);
    const inked = p.left.map((v, i) => [v, p.right[i]!] as const).filter(([v]) => !Number.isNaN(v));
    expect(inked.length).toBeGreaterThan(BAND_COUNT / 2);
    for (const [t, b] of inked) {
      expect(t).toBeCloseTo(0.25, 6);
      expect(b).toBeCloseTo(0.75, 6);
    }
  });
});

describe('vertical optical pairs (upright CJK)', () => {
  // Ideographs fill the em (ink 0.1..0.9); the ideographic comma's ink sits in
  // its top-right quarter (vertical form); kana are a little shorter.
  const COMMA = '︑';
  const KANA = 'あ';
  const IDEO = '国';
  const shapes: Record<string, [number, number]> = {
    [IDEO]: [0.1, 0.9], '口': [0.1, 0.9], [KANA]: [0.15, 0.85], [COMMA]: [0.1, 0.35],
  };
  beforeEach(() => {
    resetOpticalKerningForTest();
    setOpticalVerticalRasterizer((_css, c) => (shapes[c] ? verticalInk(...shapes[c]!) : null));
  });
  afterAll(() => resetOpticalKerningForTest());

  it('tightens a punctuation pair: the white under a vertical comma closes up', () => {
    const k = opticalKernVerticalPx(face, COMMA, 40, face, KANA, 40);
    expect(k).toBeLessThan(0);
    // Clamped as a horizontal pair: never past MAX_TIGHTEN_EM (0.15 em).
    expect(k).toBeGreaterThanOrEqual(-0.15 * 40 - 1e-9);
  });

  it('never loosens, and leaves fixed-pitch ideograph pairs alone', () => {
    expect(opticalKernVerticalPx(face, IDEO, 40, face, IDEO, 40)).toBe(0);
    expect(opticalKernVerticalPx(face, KANA, 40, face, KANA, 40)).toBeLessThanOrEqual(0);
    expect(opticalKernVerticalPx(face, ' ', 40, face, KANA, 40)).toBe(0);
  });

  it('classifies proportional units: kana, punctuation and vertical forms, not ideographs', () => {
    expect(isProportionalCjk(KANA)).toBe(true);
    expect(isProportionalCjk('ー')).toBe(true);
    expect(isProportionalCjk('、')).toBe(true);
    expect(isProportionalCjk(COMMA)).toBe(true);
    expect(isProportionalCjk(IDEO)).toBe(false);
    expect(isProportionalCjk('　')).toBe(false);
  });

  it('scales with size: the same pair at twice the size is twice the px', () => {
    const a = opticalKernVerticalPx(face, COMMA, 20, face, KANA, 20);
    expect(opticalKernVerticalPx(face, COMMA, 40, face, KANA, 40)).toBeCloseTo(a * 2, 9);
  });
});

describe('cross-size pair cache (horizontal)', () => {
  const rect = (x0: number, x1: number) => [{
    points: [
      { x: x0, y: 0, inX: x0, inY: 0, outX: x0, outY: 0 },
      { x: x1, y: 0, inX: x1, inY: 0, outX: x1, outY: 0 },
      { x: x1, y: 700, inX: x1, inY: 700, outX: x1, outY: 700 },
      { x: x0, y: 700, inX: x0, inY: 700, outX: x0, outY: 700 },
    ],
  }];
  const glyphs: Record<string, InkProfile> = {
    A: profileFromContours(rect(0, 500), 520, 1000),
    V: profileFromContours(rect(150, 550), 600, 1000),
    n: profileFromContours(rect(50, 450), 500, 1000),
    o: profileFromContours(rect(50, 450), 500, 1000),
    H: profileFromContours(rect(80, 520), 600, 1000),
    O: profileFromContours(rect(60, 540), 600, 1000),
    x: profileFromContours(rect(20, 480), 500, 1000),
  };
  let calls = 0;
  beforeEach(() => {
    resetOpticalKerningForTest();
    calls = 0;
    setOpticalRasterizer((_css, c) => {
      calls++;
      return glyphs[c] ?? null;
    });
  });
  afterAll(() => resetOpticalKerningForTest());

  it('a mixed-size pair is computed once per size RATIO and reused at any absolute size', () => {
    const big = opticalKernPx(face, 'A', 40, face, 'V', 60);
    const profiled = calls;
    const small = opticalKernPx(face, 'A', 20, face, 'V', 30);
    expect(calls).toBe(profiled); // no new profile, and no new pair computation needed
    expect(small).toBe(big / 2);
  });

  it('same-size pairs keep their size-independent em value', () => {
    const at20 = opticalKernPx(face, 'A', 20, face, 'V', 20);
    expect(opticalKernPx(face, 'A', 50, face, 'V', 50)).toBeCloseTo(at20 * 2.5, 9);
  });
});

describe('verticalLayout optical hooks', () => {
  const measure = (c: string, s: TextStyle): number => (isUprightInVertical(c) ? s.fontSize : s.fontSize / 2);
  const base = { fontSize: 20 };

  it('upright pairs take the vertical hook, sideways pairs the horizontal one; manual kerning adds on top', () => {
    const vertical = jest.fn(() => -3);
    const horizontal = jest.fn(() => -2);
    const text = 'あいab';
    const plain = layoutVerticalText(text, base, measure, { boxWidth: 200 });
    const kerned = layoutVerticalText(text, base, measure, { boxWidth: 200, opticalKern: horizontal, opticalKernVertical: vertical });
    expect(vertical).toHaveBeenCalledTimes(1);
    expect(vertical.mock.calls[0]!.slice(0, 1)).toEqual(['あ']);
    expect(horizontal).toHaveBeenCalledTimes(1);
    expect(kerned.glyphs[0]!.advance).toBe(plain.glyphs[0]!.advance - 3);
    expect(kerned.glyphs[2]!.advance).toBe(plain.glyphs[2]!.advance - 2);
    // The mixed pair (upright kana above sideways Latin) is not kerned.
    expect(kerned.glyphs[1]!.advance).toBe(plain.glyphs[1]!.advance);

    const manual = layoutVerticalText(text, base, measure, {
      boxWidth: 200, opticalKernVertical: vertical, runs: [{ start: 0, end: 1, style: { kerning: 100 } }],
    });
    expect(manual.glyphs[0]!.advance).toBe(plain.glyphs[0]!.advance - 3 + 2);
  });

  it('tate-chu-yoko units are never kerned', () => {
    const vertical = jest.fn(() => -3);
    layoutVerticalText('あい', base, measure, {
      boxWidth: 200, opticalKernVertical: vertical, runs: [{ start: 1, end: 2, style: { tateChuYoko: true } }],
    });
    expect(vertical).not.toHaveBeenCalled();
  });
});
