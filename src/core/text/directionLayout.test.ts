/**
 * Right-to-left paragraphs and vertical type: where the glyphs land.
 *
 * A fixed metric (10 px per Latin / Hebrew glyph, the em for CJK) so every
 * position is exact arithmetic.
 */

import { layoutText, planWholeStringLines, type TextStyle } from './textLayout';
import { identityGlyphTransform } from './textAnimators';
import { isUprightInVertical, layoutVerticalText, SIDEWAYS_ANGLE } from './verticalLayout';
import { placeLine, resolveAlignForDirection } from './textExtras';

const measure = (char: string, style: TextStyle): number => (isUprightInVertical(char) ? style.fontSize : 10);

describe('RTL paragraph layout', () => {
  const base = { fontSize: 20 };

  it('defaults to the right edge and keeps Latin in reading order', () => {
    const laid = layoutText('abc', base, measure, { boxWidth: 200, direction: 'rtl' });
    expect(laid.glyphs.map((g) => g.char)).toEqual(['a', 'b', 'c']);
    expect(laid.glyphs.map((g) => g.x)).toEqual([75, 85, 95]);
    expect(laid.glyphs.map((g) => g.level)).toEqual([2, 2, 2]);
  });

  it('reverses Hebrew visually while indices stay logical', () => {
    const laid = layoutText('אבג', base, measure, { boxWidth: 200, direction: 'rtl' });
    expect(laid.glyphs.map((g) => g.index)).toEqual([2, 1, 0]);
    expect(laid.glyphs.map((g) => g.x)).toEqual([75, 85, 95]);
  });

  it('places a mixed Hebrew + number line in bidi visual order', () => {
    const laid = layoutText('אב 12', base, measure, { boxWidth: 200, direction: 'rtl' });
    expect(laid.glyphs.map((g) => g.char)).toEqual(['1', '2', ' ', 'ב', 'א']);
    const xs = laid.glyphs.map((g) => g.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[4]).toBe(95);
  });

  it('mixed Arabic + Latin: the Latin word keeps its order and sits between the Arabic words', () => {
    const laid = layoutText('مرحبا Hi عالم', base, measure, { boxWidth: 400, direction: 'rtl' });
    const visual = laid.glyphs.map((g) => g.char).join('');
    expect(visual).toBe('ملاع Hi ابحرم');
  });

  it('animators address LOGICAL characters', () => {
    const transforms = ['א', 'ב', 'ג'].map((c, i) => identityGlyphTransform(c, { dy: i * 10 }));
    const laid = layoutText('אבג', base, measure, { boxWidth: 200, direction: 'rtl', transforms });
    for (const g of laid.glyphs) expect(g.transform).toBe(transforms[g.index]);
  });

  it('mirrors explicit alignment: stored "right" (end) sits on the left', () => {
    const laid = layoutText('abc', { ...base, align: 'right' }, measure, { boxWidth: 200, padX: 12, direction: 'rtl' });
    expect(laid.lines[0]!.left).toBe(-88);
    const centred = layoutText('abc', { ...base, align: 'center' }, measure, { boxWidth: 200, direction: 'rtl' });
    expect(centred.lines[0]!.left).toBe(-15);
  });

  it('mirrors indents: left + first-line indents apply from the right edge', () => {
    const laid = layoutText('abc', { ...base, leftIndent: 20, rightIndent: 7, firstLineIndent: 5 }, measure, {
      boxWidth: 200, softBreakLines: [], direction: 'rtl',
    });
    expect(laid.lines[0]!.left + laid.lines[0]!.width).toBe(100 - 20 - 5);
    const endAligned = layoutText('abc', { ...base, align: 'right', leftIndent: 20, rightIndent: 7 }, measure, {
      boxWidth: 200, softBreakLines: [], direction: 'rtl',
    });
    expect(endAligned.lines[0]!.left).toBe(-100 + 7);
  });

  it('justify-last-left ends its last line on the right; justify-all stretches it', () => {
    expect(resolveAlignForDirection('justify-left', 'rtl').line).toBe('right');
    expect(resolveAlignForDirection('justify-right', 'rtl').line).toBe('left');
    expect(resolveAlignForDirection(undefined, 'rtl').line).toBe('right');
    expect(resolveAlignForDirection('center', 'rtl').line).toBe('center');
    const last = placeLine({ width: 30, spaces: 1, hardEnd: true, paragraphStart: false }, {
      boxWidth: 200, padX: 0, boxText: true, align: 'justify-left', direction: 'rtl',
    });
    expect(last.left).toBe(70);
    const soft = placeLine({ width: 30, spaces: 1, hardEnd: false, paragraphStart: true }, {
      boxWidth: 200, padX: 0, boxText: true, align: 'justify-left', direction: 'rtl',
    });
    expect(soft.spaceExtra).toBe(170);
  });

  it('the whole-string plan anchors RTL lines on the mirrored edge', () => {
    const plans = planWholeStringLines('abc', { fontSize: 20 }, (s) => s.length * 10, { boxWidth: 200, padX: 12, direction: 'rtl' });
    expect(plans[0]!.segments[0]).toMatchObject({ align: 'right', x: 88, left: 58 });
  });

  it('LTR layout is untouched (no levels, logical order)', () => {
    const laid = layoutText('אבג', base, measure, { boxWidth: 200 });
    expect(laid.glyphs.map((g) => g.index)).toEqual([0, 1, 2]);
    expect(laid.glyphs.every((g) => g.level === undefined)).toBe(true);
  });
});

describe('vertical layout', () => {
  const base = { fontSize: 20 }; // leading 24

  it('stacks CJK top → bottom, upright, one em each', () => {
    const laid = layoutVerticalText('日本語', base, measure, { boxWidth: 100 });
    expect(laid.glyphs.map((g) => [g.x, g.y, g.angle])).toEqual([[0, -20, undefined], [0, 0, undefined], [0, 20, undefined]]);
    expect(laid.width).toBe(24);
    expect(laid.height).toBe(60);
  });

  it('flows columns right → left', () => {
    const laid = layoutVerticalText('日本\n語', base, measure, { boxWidth: 100 });
    const byChar = Object.fromEntries(laid.glyphs.map((g) => [g.char, g]));
    expect(byChar['日']!.x).toBe(12);
    expect(byChar['語']!.x).toBe(-12);
    // Top-aligned columns share the block's top.
    expect(byChar['日']!.y).toBe(-10);
    expect(byChar['語']!.y).toBe(-10);
  });

  it('rotates Latin sideways and advances it by its width', () => {
    const laid = layoutVerticalText('ab', base, measure, { boxWidth: 100 });
    expect(laid.glyphs.map((g) => [g.y, g.angle, g.advance])).toEqual([[-5, SIDEWAYS_ANGLE, 10], [5, SIDEWAYS_ANGLE, 10]]);
  });

  it('Standard Vertical Roman Alignment stands Latin upright', () => {
    const laid = layoutVerticalText('ab', base, measure, { boxWidth: 100, romanUpright: true });
    expect(laid.glyphs.map((g) => [g.y, g.angle, g.advance])).toEqual([[-10, undefined, 20], [10, undefined, 20]]);
  });

  it('mixes upright CJK with a rotated Latin run in one column', () => {
    const laid = layoutVerticalText('日ab本', base, measure, { boxWidth: 100 });
    expect(laid.glyphs.map((g) => g.angle === SIDEWAYS_ANGLE)).toEqual([false, true, true, false]);
    expect(laid.height).toBe(60);
    expect(laid.glyphs.map((g) => g.y)).toEqual([-20, -5, 5, 20]);
  });

  it('tracking acts along the column; leading between columns', () => {
    const laid = layoutVerticalText('日本\n語', { fontSize: 20, letterSpacing: 4, lineHeight: 2 }, measure, { boxWidth: 100 });
    const g = laid.glyphs;
    expect(g[1]!.y - g[0]!.y).toBe(24);
    expect(g[0]!.x - g[2]!.x).toBe(40);
  });

  it('maps alignment to the column axis (center / bottom)', () => {
    const c = layoutVerticalText('日本語\n日', { fontSize: 20, align: 'center' }, measure, { boxWidth: 100 });
    expect(c.glyphs[3]!.y).toBe(0);
    const b = layoutVerticalText('日本語\n日', { fontSize: 20, align: 'right' }, measure, { boxWidth: 100 });
    expect(b.glyphs[3]!.y).toBe(20);
  });

  it('box text wraps by box height into columns from the top-right', () => {
    const laid = layoutVerticalText('日本語漢字', base, measure, { boxWidth: 100, padX: 0, columnLimit: 40 });
    expect(laid.glyphs.map((g) => g.line)).toEqual([0, 0, 1, 1, 2]);
    expect(laid.glyphs.map((g) => g.x)).toEqual([38, 38, 14, 14, -10]);
    expect(laid.glyphs[0]!.y).toBe(-10);
    expect(laid.visibleLines).toBe(3);
    const narrow = layoutVerticalText('日本語漢字', base, measure, { boxWidth: 50, padX: 0, columnLimit: 40 });
    expect(narrow.visibleLines).toBe(2);
  });

  it('classifies upright vs sideways by UAX #50', () => {
    expect(isUprightInVertical('漢')).toBe(true);
    expect(isUprightInVertical('か')).toBe(true);
    expect(isUprightInVertical('한')).toBe(true);
    expect(isUprightInVertical('Ａ')).toBe(true);
    expect(isUprightInVertical('A')).toBe(false);
    expect(isUprightInVertical('1')).toBe(false);
    expect(isUprightInVertical('「')).toBe(false);
    expect(isUprightInVertical('ー')).toBe(false);
  });
});
