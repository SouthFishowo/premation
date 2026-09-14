/**
 * Optical kerning from glyph SHAPES (opticalKerning.ts).
 *
 * The glyphs here are hand-drawn polygons in a 1000-unit em — an "A" and a "V"
 * whose diagonals leave a wedge of white between them, an "H" of two stems, a
 * "T" whose bar overhangs a "." — so every assertion is about geometry, not
 * about whichever font the test machine happens to have. The raster path is
 * exercised with an injected rasterizer (no canvas needed).
 */

import type { GlyphContour, GlyphOutline, ParsedFont } from './openType';
import {
  BAND_COUNT,
  MIN_INK_GAP_EM,
  glyphInkProfile,
  measurePairGap,
  opticalKernPx,
  profileFromAlpha,
  profileFromContours,
  registerOpticalOutlineFace,
  resetOpticalKerningForTest,
  setOpticalRasterizer,
  type OpticalFace,
} from './opticalKerning';
import { layoutText, type TextStyle } from './textLayout';

/** A closed straight-edged contour (control points on the vertices). */
const poly = (pts: Array<[number, number]>): GlyphContour => ({
  points: pts.map(([x, y]) => ({ x, y, inX: x, inY: y, outX: x, outY: y })),
});
const rect = (x0: number, y0: number, x1: number, y1: number): GlyphContour => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
const ellipse = (cx: number, cy: number, rx: number, ry: number): GlyphContour =>
  poly(Array.from({ length: 32 }, (_, i) => [cx + rx * Math.cos((i / 32) * 2 * Math.PI), cy + ry * Math.sin((i / 32) * 2 * Math.PI)] as [number, number]));

const GLYPHS: Record<string, GlyphOutline> = {
  H: { advance: 700, contours: [rect(80, 0, 180, 700), rect(520, 0, 620, 700), rect(180, 330, 520, 400)] },
  O: { advance: 720, contours: [ellipse(360, 350, 300, 360)] },
  A: { advance: 660, contours: [poly([[0, 0], [110, 0], [330, 600], [550, 0], [660, 0], [380, 700], [280, 700]])] },
  V: { advance: 660, contours: [poly([[0, 700], [110, 700], [330, 100], [550, 700], [660, 700], [380, 0], [280, 0]])] },
  T: { advance: 600, contours: [rect(20, 630, 580, 700), rect(250, 0, 350, 630)] },
  '.': { advance: 280, contours: [rect(90, 0, 190, 100)] },
  n: { advance: 560, contours: [rect(70, 0, 160, 500), rect(400, 0, 490, 440), rect(160, 430, 490, 500)] },
  o: { advance: 560, contours: [ellipse(280, 250, 220, 260)] },
  x: { advance: 520, contours: [poly([[20, 0], [500, 500], [420, 500], [20, 80]])] },
};

function fakeFont(): ParsedFont & { glyphFor: jest.Mock } {
  return {
    unitsPerEm: 1000,
    ascender: 900,
    descender: -200,
    kind: 'glyf',
    glyphFor: jest.fn((cp: number) => GLYPHS[String.fromCodePoint(cp)] ?? null),
  };
}

const FACE: OpticalFace = { css: '400 128px "Synthetic"', family: 'Synthetic', weight: '400', italic: false };
const SIZE = 100;
const kern = (pair: string, face: OpticalFace = FACE): number => opticalKernPx(face, pair[0]!, SIZE, face, pair[1]!, SIZE);

beforeEach(() => {
  resetOpticalKerningForTest();
  // No canvas unless a test injects one: the outline path must stand alone.
  setOpticalRasterizer(null);
});

describe('ink profiles', () => {
  it('reads a stem as its left and right edge in every band it spans', () => {
    const p = profileFromContours([rect(100, 0, 300, 500)], 400, 1000);
    const inked = p.left.map((l, i) => ({ l, r: p.right[i]! })).filter((b) => !Number.isNaN(b.l));
    expect(inked.length).toBeGreaterThan(5);
    for (const b of inked) {
      expect(b.l).toBeCloseTo(0.1, 6);
      expect(b.r).toBeCloseTo(0.3, 6);
    }
    expect(p.advance).toBeCloseTo(0.4, 6);
    expect(p.top).toBeCloseTo(0.5, 6);
    expect(p.left).toHaveLength(BAND_COUNT);
  });

  it('places raster edges with sub-pixel precision from coverage', () => {
    // A 10-px-em raster: ink from x = 12.5 to 17.25 px on rows 5..9, pen at 10,
    // baseline at row 10 — a stem 0.25 em to 0.725 em right of the pen.
    const W = 30, H = 12;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let row = 5; row < 10; row++) {
      for (let col = 12; col <= 17; col++) {
        const cover = col === 12 ? 0.5 : col === 17 ? 0.25 : 1;
        rgba[(row * W + col) * 4 + 3] = Math.round(cover * 255);
      }
    }
    const p = profileFromAlpha(rgba, W, H, 10, 10, 10, 8);
    const band = p.left.findIndex((v) => !Number.isNaN(v));
    expect(p.left[band]).toBeCloseTo(0.25, 2);
    expect(p.right[band]).toBeCloseTo(0.725, 2);
    expect(p.advance).toBeCloseTo(0.8, 6);
  });
});

describe('optical pair adjustment (outlines)', () => {
  beforeEach(() => registerOpticalOutlineFace('Synthetic', 400, false, fakeFont()));

  it('tucks a diagonal pair: "AV" comes in well past unkerned spacing', () => {
    const av = kern('AV');
    expect(av).toBeLessThan(-0.03 * SIZE);
    // …and much further than a straight pair moves.
    expect(av).toBeLessThan(kern('HH') - 0.03 * SIZE);
  });

  it('leaves the calibration colour alone: "HH" barely moves', () => {
    expect(Math.abs(kern('HH'))).toBeLessThan(0.015 * SIZE);
  });

  it('tightens "T." under the bar without letting ink touch', () => {
    const k = kern('T.');
    expect(k).toBeLessThan(-0.03 * SIZE);
    const t = glyphInkProfile(FACE, 'T')!;
    const dot = glyphInkProfile(FACE, '.')!;
    const gap = measurePairGap(t, SIZE, dot, SIZE)!;
    expect(gap.dmin + k).toBeGreaterThanOrEqual(MIN_INK_GAP_EM * SIZE - 1e-9);
  });

  it('does not kern whitespace', () => {
    expect(opticalKernPx(FACE, 'A', SIZE, FACE, ' ', SIZE)).toBe(0);
  });

  it('is size independent in em, deterministic, and cached per glyph', () => {
    const font = fakeFont();
    resetOpticalKerningForTest();
    setOpticalRasterizer(null);
    registerOpticalOutlineFace('Synthetic', 400, false, font);
    const first = opticalKernPx(FACE, 'A', 50, FACE, 'V', 50);
    const calls = font.glyphFor.mock.calls.length;
    expect(opticalKernPx(FACE, 'A', 50, FACE, 'V', 50)).toBe(first);
    expect(opticalKernPx(FACE, 'A', 200, FACE, 'V', 200)).toBeCloseTo(first * 4, 9);
    expect(font.glyphFor.mock.calls.length).toBe(calls);
  });
});

describe('optical pair adjustment (raster path, injected)', () => {
  /** A stand-in canvas: profiles the same synthetic glyphs, keyed by cluster. */
  const fromTable = (css: string, cluster: string) => {
    void css;
    const g = GLYPHS[cluster];
    return g ? profileFromContours(g.contours, g.advance, 1000) : null;
  };

  it('works for a face with no outline bytes, and agrees with the outline path', () => {
    const rasterize = jest.fn(fromTable);
    setOpticalRasterizer(rasterize);
    const viaRaster = kern('AV');
    expect(rasterize).toHaveBeenCalled();
    resetOpticalKerningForTest();
    setOpticalRasterizer(null);
    registerOpticalOutlineFace('Synthetic', 400, false, fakeFont());
    expect(kern('AV')).toBeCloseTo(viaRaster, 9);
  });

  it('is a no-op where neither outlines nor a canvas are available (jsdom-safe)', () => {
    setOpticalRasterizer(null);
    expect(kern('AV')).toBe(0);
  });

  it('keeps the source a face was first profiled with for the session', () => {
    setOpticalRasterizer(fromTable);
    const before = kern('AV');
    const font = fakeFont();
    registerOpticalOutlineFace('Synthetic', 400, false, font);
    expect(kern('To')).toBeLessThan(0);
    expect(kern('AV')).toBe(before);
    expect(font.glyphFor).not.toHaveBeenCalled();
  });
});

describe('layoutText optical hook', () => {
  const base: TextStyle = { fontSize: 10 };
  const measure = (): number => 10;

  it('adds the pair adjustment to the left glyph; manual kerning adds on top', () => {
    const hook = jest.fn((a: string, _sa: TextStyle, b: string) => (a === 'A' && b === 'V' ? -2 : 0));
    const l = layoutText('AV', base, measure, { boxWidth: 100, kerningMode: 'optical', opticalKern: hook });
    expect(l.glyphs[0]!.advance).toBeCloseTo(8);
    const withManual = layoutText('AV', base, measure, {
      boxWidth: 100, kerningMode: 'optical', opticalKern: hook,
      runs: [{ start: 0, end: 1, style: { kerning: 100 } }],
    });
    expect(withManual.glyphs[0]!.advance).toBeCloseTo(9);
  });

  it('metrics mode ignores the hook, and spaces are never kerned', () => {
    const hook = jest.fn(() => -2);
    expect(layoutText('AV', base, measure, { boxWidth: 100, opticalKern: hook }).glyphs[0]!.advance).toBe(10);
    expect(hook).not.toHaveBeenCalled();
    layoutText('A V', base, measure, { boxWidth: 100, kerningMode: 'optical', opticalKern: hook });
    expect(hook).not.toHaveBeenCalled();
  });
});
