/**
 * AE paragraph behaviour in `layoutText`: the seven alignments (real
 * justification), indents, space before/after, manual + optical kerning, Auto
 * leading, and grapheme clusters as the per-character unit.
 *
 * The measure makes every glyph exactly as wide as its font size (10px here),
 * so each expected x is checkable by hand. `x` is a glyph's CENTRE; its pen
 * (left edge) is `x − 5`. Box width 100, no padding: the frame is [−50, 50].
 */

import { layoutText, type TextStyle, type ParagraphStyle } from './textLayout';
import { resolveAlign, lineOffsets, softBreakLines, textExtrasForNode } from './textExtras';
import { identityGlyphTransform } from './textAnimators';
import type { SceneNode } from '@core/types';

const measure = (_char: string, style: TextStyle): number => style.fontSize;
const base: TextStyle & ParagraphStyle = { fontSize: 10, fill: '#ffffff' };

const xs = (text: string, over: Partial<ParagraphStyle & TextStyle>, soft?: number[]) =>
  layoutText(text, { ...base, ...over }, measure, { boxWidth: 100, softBreakLines: soft }).glyphs.map((g) => g.x);

describe('justification', () => {
  // Line 0 'ab cd' ends in a SOFT wrap; line 1 'ef gh' is the paragraph's last.
  const TEXT = 'ab cd\nef gh';
  const SOFT = [0];

  it('stretches word spaces so a soft-wrapped line fills the box', () => {
    const l = layoutText(TEXT, { ...base, align: 'justify-left' }, measure, { boxWidth: 100, softBreakLines: SOFT });
    const line0 = l.glyphs.filter((g) => g.line === 0).map((g) => g.x);
    // Natural width 50, one space → the space grows by 50.
    expect(line0).toEqual([-45, -35, -25, 35, 45]);
    // Last glyph's right edge is the box edge.
    expect(line0[4]! + 5).toBe(50);
    expect(l.lines[0]!.spaceExtra).toBe(50);
  });

  it.each([
    ['justify-left', -45],
    ['justify-center', -20],
    ['justify-right', 5],
    ['justify', -45],
  ])('%s aligns the last line per its variant', (align, firstX) => {
    const line1 = layoutText(TEXT, { ...base, align }, measure, { boxWidth: 100, softBreakLines: SOFT })
      .glyphs.filter((g) => g.line === 1);
    expect(line1[0]!.x).toBe(firstX);
  });

  it('justify-all stretches the last line too', () => {
    const line1 = layoutText(TEXT, { ...base, align: 'justify-all' }, measure, { boxWidth: 100, softBreakLines: SOFT })
      .glyphs.filter((g) => g.line === 1).map((g) => g.x);
    expect(line1).toEqual([-45, -35, -25, 35, 45]);
  });

  it('a hard newline ends a paragraph: that line is not stretched', () => {
    // No soft breaks — both lines end paragraphs.
    const g = xs(TEXT, { align: 'justify-left' }, []);
    expect(g.slice(0, 5)).toEqual([-45, -35, -25, -15, -5]);
  });

  it('point text has nothing to justify and takes the last-line alignment', () => {
    expect(xs('ab', { align: 'justify-center' })).toEqual([-5, 5]);
    expect(xs('ab', { align: 'justify-right' })).toEqual([35, 45]);
    expect(xs('ab', { align: 'justify-all' })).toEqual([-45, -35]);
  });

  it('does not stretch trailing spaces', () => {
    const l = layoutText('ab cd \nx', { ...base, align: 'justify-left' }, measure, { boxWidth: 100, softBreakLines: [0] });
    const line0 = l.glyphs.filter((g) => g.line === 0);
    // Natural width 60 (incl. trailing space), one interior space → +40.
    expect(line0.map((g) => g.x)).toEqual([-45, -35, -25, 25, 35, 45]);
  });

  it('a single word cannot be justified and stays left', () => {
    expect(xs('abc\nd', { align: 'justify-left' }, [0]).slice(0, 3)).toEqual([-45, -35, -25]);
  });
});

describe('indents', () => {
  it('left + first-line indent offset the first line of each paragraph', () => {
    const l = layoutText('ab\ncd\nef', { ...base, leftIndent: 10, firstLineIndent: 5 }, measure, {
      boxWidth: 100,
      softBreakLines: [0],
    });
    const firstOf = (line: number) => l.glyphs.find((g) => g.line === line)!.x;
    expect(firstOf(0)).toBe(-50 + 10 + 5 + 5); // paragraph start
    expect(firstOf(1)).toBe(-50 + 10 + 5); // soft-wrapped continuation
    expect(firstOf(2)).toBe(-50 + 10 + 5 + 5); // new paragraph
  });

  it('a negative first-line indent hangs', () => {
    const l = layoutText('ab\ncd', { ...base, leftIndent: 20, firstLineIndent: -20 }, measure, {
      boxWidth: 100,
      softBreakLines: [0],
    });
    expect(l.glyphs[0]!.x).toBe(-45);
    expect(l.glyphs[2]!.x).toBe(-25);
  });

  it('right indent moves right-aligned lines and narrows the justify frame', () => {
    expect(xs('ab', { align: 'right', rightIndent: 20 }, [])).toEqual([15, 25]);
    const l = layoutText('ab cd\nx', { ...base, align: 'justify-left', leftIndent: 10, rightIndent: 20 }, measure, {
      boxWidth: 100,
      softBreakLines: [0],
    });
    const line0 = l.glyphs.filter((g) => g.line === 0);
    expect(line0[0]!.x - 5).toBe(-40);
    expect(line0[4]!.x + 5).toBe(30);
  });

  it('centre alignment centres within the indented frame', () => {
    // Frame [-40, 50] → centre 5.
    expect(xs('ab', { align: 'center', leftIndent: 10 }, [])).toEqual([0, 10]);
  });

  it('point text ignores indents (its box is sized to the glyphs)', () => {
    expect(xs('ab', { leftIndent: 30, firstLineIndent: 10 })).toEqual([-45, -35]);
  });
});

describe('space before / after', () => {
  it('adds space only between paragraphs', () => {
    const style = { ...base, lineHeight: 2, spaceBefore: 3, spaceAfter: 4 };
    const hard = layoutText('a\nb', style, measure, { boxWidth: 100 });
    expect(hard.lines.map((l) => l.y)).toEqual([-13.5, 13.5]);
    // A soft wrap is not a paragraph break.
    const soft = layoutText('a\nb', style, measure, { boxWidth: 100, softBreakLines: [0] });
    expect(soft.lines.map((l) => l.y)).toEqual([-10, 10]);
  });

  it('keeps the legacy per-line paragraphSpacing working', () => {
    const l = layoutText('a\nb', { ...base, lineHeight: 2, paragraphSpacing: 6 }, measure, { boxWidth: 100 });
    expect(l.lines.map((b) => b.y)).toEqual([-13, 13]);
  });

  it('lineOffsets reduces to i × gap with no paragraph space', () => {
    expect(lineOffsets([true, true, true], 7).offsets).toEqual([0, 7, 14]);
    expect(lineOffsets([false, true, true], 10, 1, 2).offsets).toEqual([0, 10, 23]);
  });
});

describe('kerning', () => {
  it('manual kerning (1/1000 em) opens the gap AFTER its character', () => {
    const l = layoutText('abc', base, measure, {
      boxWidth: 100,
      runs: [{ start: 0, end: 1, style: { kerning: 100 } }],
    });
    expect(l.glyphs.map((g) => g.advance)).toEqual([11, 10, 10]);
    expect(l.glyphs.map((g) => g.x)).toEqual([-45, -34, -24]);
  });

  it('negative kerning tightens, and none applies after a line’s last glyph', () => {
    const l = layoutText('ab\nc', base, measure, {
      boxWidth: 100,
      runs: [{ start: 0, end: 2, style: { kerning: -200 } }],
    });
    expect(l.glyphs.map((g) => g.advance)).toEqual([8, 10, 10]);
  });

  it('optical kerning adds the shape-based pair adjustment (opticalKerning.ts)', () => {
    const pair = (a: string, _s: unknown, b: string): number => (a === 'T' && b === 'o' ? -1.5 : 0);
    const l = layoutText('To', base, measure, { boxWidth: 100, kerningMode: 'optical', opticalKern: pair });
    expect(l.glyphs[0]!.advance).toBeCloseTo(8.5);
    // Metrics mode ignores it.
    const m = layoutText('To', base, measure, { boxWidth: 100, opticalKern: pair });
    expect(m.glyphs[0]!.advance).toBe(10);
  });
});

describe('grapheme clusters', () => {
  const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';

  it('an emoji ZWJ sequence is ONE glyph, and indices count clusters', () => {
    const l = layoutText(`${FAMILY}x`, base, measure, { boxWidth: 100 });
    expect(l.glyphs.map((g) => g.char)).toEqual([FAMILY, 'x']);
    expect(l.glyphs.map((g) => g.index)).toEqual([0, 1]);
  });

  it('a decomposed é is one glyph and a run on index 1 styles the next letter', () => {
    const l = layoutText('éb', base, measure, {
      boxWidth: 100,
      runs: [{ start: 1, end: 2, style: { fontSize: 30 } }],
    });
    expect(l.glyphs.map((g) => g.char)).toEqual(['é', 'b']);
    expect(l.glyphs.map((g) => g.advance)).toEqual([10, 30]);
  });

  it('animator transforms line up with clusters', () => {
    const t = [identityGlyphTransform(FAMILY), identityGlyphTransform('x', { tracking: 5 })];
    const l = layoutText(`${FAMILY}x`, base, measure, { boxWidth: 100, transforms: t });
    expect(l.glyphs.map((g) => g.advance)).toEqual([10, 15]);
  });
});

describe('Auto leading', () => {
  it('undefined lineHeight is 120% of the font size', () => {
    const l = layoutText('a\nb', base, measure, { boxWidth: 100 });
    expect(l.lines.map((b) => b.y)).toEqual([-6, 6]);
  });
});

describe('textExtras helpers', () => {
  it('resolveAlign maps the seven Paragraph panel values', () => {
    expect(resolveAlign('justify-center')).toEqual({ line: 'center', justify: true, justifyLast: false });
    expect(resolveAlign('justify-all')).toEqual({ line: 'left', justify: true, justifyLast: true });
    expect(resolveAlign('bogus')).toEqual({ line: 'left', justify: false, justifyLast: false });
  });

  it('softBreakLines finds the spaces wrapping replaced', () => {
    expect(softBreakLines('the quick brown\nfox', 'the quick\nbrown\nfox')).toEqual([0]);
    expect(softBreakLines('abc', 'ab')).toEqual([]);
  });

  it('textExtrasForNode emits nothing for a plain layer', () => {
    const node = { components: [{ id: 't', type: 'Text', props: { content: 'x', align: 'left' } }] } as unknown as SceneNode;
    expect(textExtrasForNode(node, [0])).toBeUndefined();
    const just = { components: [{ id: 't', type: 'Text', props: { content: 'x', align: 'justify-left', fauxBold: true } }] } as unknown as SceneNode;
    expect(textExtrasForNode(just, [0])).toEqual({ softBreakLines: [0], fauxBold: true });
  });
});
