/**
 * Per-range character styles in layout (horizontal / vertical scale, baseline
 * shift, super/subscript, leading, tsume, all caps), Line Anchor and Tracking
 * Type — against a fake 10px-per-glyph metric so every number is exact.
 */

import { layoutText, glyphStyleScale, type TextStyle } from './textLayout';
import { identityGlyphTransform } from './textAnimators';
import { SUPER_SUB_SCALE, SUPER_SHIFT, SUB_SHIFT } from './measureText';

const measure = (): number => 10;
const base: TextStyle = { fontSize: 20 };
const lay = (text: string, opts: Partial<Parameters<typeof layoutText>[3]> = {}, style: Partial<TextStyle & { lineHeight: number; align: string }> = {}) =>
  layoutText(text, { ...base, ...style }, measure, { boxWidth: 400, ...opts });

describe('glyphStyleScale', () => {
  it('matches measureText’s super/subscript constants', () => {
    const sup = glyphStyleScale({ fontSize: 100, verticalAlign: 'super' });
    const sub = glyphStyleScale({ fontSize: 100, verticalAlign: 'sub' });
    expect(sup.sx).toBeCloseTo(SUPER_SUB_SCALE);
    expect(sup.dy).toBeCloseTo(-100 * SUPER_SHIFT);
    expect(sub.dy).toBeCloseTo(100 * SUB_SHIFT);
  });

  it('is the identity for a style with no per-range geometry', () => {
    expect(glyphStyleScale({ fontSize: 30 })).toEqual({ sx: 1, sy: 1, dy: 0 });
  });
});

describe('per-range styles in layout', () => {
  it('horizontal scale widens the glyph and its advance; later glyphs move over', () => {
    const plain = lay('abc');
    const scaled = lay('abc', { runs: [{ start: 1, end: 2, style: { horizontalScale: 200 } }] });
    expect(plain.glyphs.map((g) => g.advance)).toEqual([10, 10, 10]);
    expect(scaled.glyphs.map((g) => g.advance)).toEqual([20, 20, 10].map((v, i) => (i === 0 ? 10 : v)));
    expect(scaled.glyphs[1]!.inkWidth).toBe(20);
    expect(scaled.width).toBe(40);
  });

  it('baseline shift raises only the range; super/subscript shrink and shift', () => {
    const l = lay('abc', { runs: [{ start: 0, end: 1, style: { baselineShift: 6 } }, { start: 2, end: 3, style: { verticalAlign: 'sub' } }] });
    const y0 = l.lines[0]!.y;
    expect(l.glyphs[0]!.y).toBeCloseTo(y0 - 6);
    expect(l.glyphs[1]!.y).toBe(y0);
    expect(l.glyphs[2]!.y).toBeCloseTo(y0 + 20 * SUB_SHIFT);
    expect(l.glyphs[2]!.advance).toBeCloseTo(10 * SUPER_SUB_SCALE);
  });

  it('leading takes the LARGEST value on each line (AE)', () => {
    const uniform = lay('a\nb\nc', {}, { lineHeight: 1 });
    expect(uniform.lines.map((ln) => ln.y - uniform.lines[0]!.y)).toEqual([0, 20, 40]);
    // Line 2 gets a 3× leading on one character: only the gap INTO line 2 grows.
    const ranged = lay('a\nbB\nc', { runs: [{ start: 3, end: 4, style: { lineHeight: 3 } }] }, { lineHeight: 1 });
    expect(ranged.lines.map((ln) => ln.y - ranged.lines[0]!.y)).toEqual([0, 60, 80]);
  });

  it('a layer without per-range leading keeps the uniform-gap arithmetic', () => {
    const a = lay('a\nb', { runs: [{ start: 0, end: 1, style: { fill: '#f00' } }] }, { lineHeight: 1.3 });
    const b = lay('a\nb', {}, { lineHeight: 1.3 });
    expect(a.lines.map((l) => l.y)).toEqual(b.lines.map((l) => l.y));
  });

  it('tsume removes that share of the side bearings', () => {
    const bearings = (): { left: number; right: number } => ({ left: 2, right: 4 });
    const l = lay('ab', { measureBearings: bearings, runs: [{ start: 0, end: 1, style: { tsume: 50 } }] });
    expect(l.glyphs[0]!.advance).toBeCloseTo(10 - 3);
    // The ink comes in by the left share.
    expect(l.glyphs[1]!.x - l.glyphs[0]!.x).toBeCloseTo(7 + 1);
  });

  it('all caps draws the range upper-cased without touching the characters', () => {
    const l = lay('abc', { runs: [{ start: 1, end: 3, style: { allCaps: true } }] });
    expect(l.glyphs.map((g) => g.char)).toEqual(['a', 'b', 'c']);
    expect(l.glyphs.map((g) => g.drawn ?? g.char)).toEqual(['a', 'B', 'C']);
  });
});

describe('Line Anchor and Tracking Type in layout', () => {
  const tracked = (lineAnchor?: number) =>
    ['a', 'b'].map((c) => identityGlyphTransform(c, { tracking: 10, ...(lineAnchor !== undefined ? { lineAnchor } : {}) }));

  it('without Line Anchor, centred text centres its tracked width (unchanged)', () => {
    const l = lay('ab', { transforms: tracked() }, { align: 'center' });
    expect(l.lines[0]!.left).toBeCloseTo(-20);
  });

  it('Line Anchor 0 / 0.5 / 1 grows tracking right / both ways / left of the untracked line', () => {
    // Untracked width 20 centred → left −10; tracking adds 20.
    expect(lay('ab', { transforms: tracked(0) }, { align: 'center' }).lines[0]!.left).toBeCloseTo(-10);
    expect(lay('ab', { transforms: tracked(0.5) }, { align: 'center' }).lines[0]!.left).toBeCloseTo(-20);
    expect(lay('ab', { transforms: tracked(1) }, { align: 'center' }).lines[0]!.left).toBeCloseTo(-30);
  });

  it('Tracking Type Before shifts the glyph right of its pen by that amount', () => {
    const t = [identityGlyphTransform('a', { tracking: 10, trackingBefore: 10 }), identityGlyphTransform('b')];
    const l = lay('ab', { transforms: t });
    expect(l.glyphs[0]!.x - (l.lines[0]!.left + 5)).toBeCloseTo(10);
    expect(l.glyphs[1]!.x - l.glyphs[0]!.x).toBeCloseTo(10);
  });
});
