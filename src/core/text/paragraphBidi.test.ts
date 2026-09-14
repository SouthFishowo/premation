/**
 * Bidi resolves per PARAGRAPH and reorders per LINE (UAX #9 P1 → wrap → L1/L2),
 * and 'auto' direction takes each paragraph's first strong character.
 *
 * A fixed 10 px metric per cluster so positions are exact arithmetic. Bidi
 * literals are \u-escaped: they are invisible or reorder in an editor.
 */

import { layoutText, paragraphBidiLines, planWholeStringLines, softWrapChangesBidi, type TextLayout } from './textLayout';
import { clusterLevels } from './bidi';
import { compactTextExtras, firstParagraphDirection, readTextExtrasProps, resolveParagraphDirection } from './textExtras';
import { identityGlyphTransform } from './textAnimators';
import { splitGraphemes } from './graphemes';
import type { SceneNode } from '@core/types';

const measure = (): number => 10;
const base = { fontSize: 20 };
const ARABIC = 'مرحبا'; // marhaba
const HEBREW = 'אבג'; // alef bet gimel

/** The visual string of one line: glyphs are emitted left to right. */
const visualLine = (laid: TextLayout, line: number): string =>
  laid.glyphs.filter((g) => g.line === line).map((g) => g.char).join('');

describe('bidi per paragraph, reordered per line', () => {
  it('a neutral at a soft wrap resolves by the paragraph context, not by its line alone', () => {
    // RTL paragraph "abc- def", soft-wrapped at the space. Alone, the line
    // "abc-" ends at eos = R, so the dash takes the embedding direction and
    // sits LEFT of "abc"; in its paragraph the dash is between L and L, so it
    // is L and follows "abc".
    const text = 'abc-\ndef';
    const soft = layoutText(text, base, measure, { boxWidth: 400, direction: 'rtl', softBreakLines: [0] });
    const hard = layoutText(text, base, measure, { boxWidth: 400, direction: 'rtl', softBreakLines: [] });
    expect(visualLine(soft, 0)).toBe('abc-');
    expect(visualLine(hard, 0)).toBe('-abc');
  });

  it('a number after Arabic across a soft wrap is an Arabic number (W2 looks back past the wrap)', () => {
    // "<arabic> 5%" wrapped before "5%": in the paragraph 5 follows AL, becomes
    // AN, and "%" no longer joins it (W5 is for EN only) — it resolves R and
    // sits left of the 5. Resolved alone, the line "5%" is EN EN in reading order.
    const text = `${ARABIC}\n5%`;
    const soft = layoutText(text, base, measure, { boxWidth: 400, direction: 'rtl', softBreakLines: [0] });
    const hard = layoutText(text, base, measure, { boxWidth: 400, direction: 'rtl', softBreakLines: [] });
    expect(visualLine(soft, 1)).toBe('%5');
    expect(visualLine(hard, 1)).toBe('5%');
  });

  it('auto: a wrapped line with no strong character keeps its paragraph direction', () => {
    const laid = layoutText(`${ARABIC}\n123`, base, measure, { boxWidth: 200, direction: 'auto', softBreakLines: [0] });
    expect(laid.lines.map((l) => l.direction)).toEqual(['rtl', 'rtl']);
    // Start (right) edge: 3 digits x 10 px end at the box's right edge.
    expect(laid.lines[1]!.left + laid.lines[1]!.width).toBe(100);
    // Hard-broken, "123" is its own paragraph with no strong character: LTR.
    const hard = layoutText(`${ARABIC}\n123`, base, measure, { boxWidth: 200, direction: 'auto', softBreakLines: [] });
    expect(hard.lines[1]!.left).toBe(-100);
  });

  it('auto: every hard-broken paragraph takes its own first strong character', () => {
    const laid = layoutText(`abc\n${HEBREW}`, base, measure, { boxWidth: 200, direction: 'auto' });
    expect(laid.lines[0]!.direction).toBeUndefined(); // purely LTR: no levels at all
    expect(laid.glyphs.filter((g) => g.line === 0).every((g) => g.level === undefined)).toBe(true);
    expect(laid.lines[1]!.direction).toBe('rtl');
    expect(laid.glyphs.filter((g) => g.line === 1).map((g) => g.index)).toEqual([6, 5, 4]);
    expect(laid.lines[1]!.left).toBe(70);
  });

  it('L1 applies at every line end: trailing whitespace of a wrapped line goes to the paragraph level', () => {
    const lines = [['a', 'b', ' '], [HEBREW[0]!]];
    const [first] = paragraphBidiLines(lines, [false, true], 'rtl');
    expect(first!.levels).toEqual([2, 2, 1]);
  });

  it('a soft break between CJK units (an inserted break) stands for nothing', () => {
    // A replaced space between "1," and "2" makes the comma a neutral (level 1);
    // FULLWIDTH digits and comma are CJK units, so the break between them was
    // inserted and the comma is a separator inside one number (W4, level 2).
    const withSpace = paragraphBidiLines([['1', ','], ['2']], [false, true], 'rtl');
    const inserted = paragraphBidiLines([['１', '，'], ['２']], [false, true], 'rtl');
    expect(withSpace[0]!.levels).toEqual([2, 1]);
    expect(inserted[0]!.levels).toEqual([2, 2]);
  });

  it('logical indices survive: animators and runs address characters, not visual slots', () => {
    const text = `${HEBREW} ab\n${HEBREW}`;
    const chars = splitGraphemes(text);
    const transforms = chars.map((c, i) => identityGlyphTransform(c, { dy: i }));
    const laid = layoutText(text, base, measure, { boxWidth: 400, direction: 'rtl', softBreakLines: [0], transforms });
    for (const g of laid.glyphs) {
      expect(g.transform).toBe(transforms[g.index]);
      expect(g.char).toBe(chars[g.index]);
    }
  });

  it('without soft wraps an RTL layout resolves exactly as per-line resolution did', () => {
    const text = `${HEBREW} 12 (ab)!\n${ARABIC} 3.5`;
    const laid = layoutText(text, base, measure, { boxWidth: 400, direction: 'rtl' });
    text.split('\n').forEach((line, li) => {
      const own = clusterLevels(splitGraphemes(line), 1);
      const glyphs = laid.glyphs.filter((g) => g.line === li).sort((a, b) => a.index - b.index);
      expect(glyphs.map((g) => g.level)).toEqual(own);
    });
  });

  it('horizontal Latin lays out byte-identically under auto and LTR', () => {
    const opts = { boxWidth: 300, padX: 12, softBreakLines: [0] };
    const text = 'Hello wrapped\nworld, again (1-2)';
    expect(layoutText(text, { ...base, align: 'justify' }, measure, { ...opts, direction: 'auto' }))
      .toEqual(layoutText(text, { ...base, align: 'justify' }, measure, opts));
    expect(planWholeStringLines(text, base, (s) => s.length * 10, { ...opts, direction: 'auto' }))
      .toEqual(planWholeStringLines(text, base, (s) => s.length * 10, opts));
  });

  it('the whole-line plan gives an auto RTL paragraph its direction per line', () => {
    const plans = planWholeStringLines(`abc\n${HEBREW}\n123`, base, (s) => [...s].length * 10, { boxWidth: 200, softBreakLines: [1], direction: 'auto' });
    expect(plans.map((p) => p.direction)).toEqual([undefined, 'rtl', 'rtl']);
    expect(plans[2]!.left).toBe(70);
  });

  it('flags a wrapped paragraph for the per-glyph path only when the paragraph changes a level', () => {
    expect(softWrapChangesBidi('abc-\ndef', [0], 'rtl')).toBe(false); // no RTL character: nothing to reorder
    expect(softWrapChangesBidi(`${ARABIC}\n5%`, [0], 'rtl')).toBe(true);
    expect(softWrapChangesBidi(`${ARABIC}\n5%`, [], 'rtl')).toBe(false);
    expect(softWrapChangesBidi(`${ARABIC} ${HEBREW}\n${HEBREW}`, [0], 'rtl')).toBe(false);
    // The digits inherit the paragraph's RTL direction, but the whole-line plan
    // already draws each line under its PARAGRAPH direction — levels agree.
    expect(softWrapChangesBidi(`${ARABIC}\n123`, [0], 'auto')).toBe(false);
    expect(softWrapChangesBidi(`${ARABIC}\n5%`, [0], 'auto')).toBe(true);
  });
});

describe('paragraph direction', () => {
  it('resolves rtl, auto (first strong, LTR when none) and everything else as LTR', () => {
    expect(resolveParagraphDirection('rtl', 'abc')).toBe('rtl');
    expect(resolveParagraphDirection('auto', `12 ${HEBREW} abc`)).toBe('rtl');
    expect(resolveParagraphDirection('auto', `abc ${HEBREW}`)).toBe('ltr');
    expect(resolveParagraphDirection('auto', '123')).toBe('ltr');
    expect(resolveParagraphDirection(undefined, HEBREW)).toBe('ltr');
    expect(resolveParagraphDirection('ltr', HEBREW)).toBe('ltr');
    expect(firstParagraphDirection('auto', `abc\n${HEBREW}`)).toBe('ltr');
    expect(firstParagraphDirection('auto', `${HEBREW}\nabc`)).toBe('rtl');
  });

  it('reads and keeps auto in the text extras; ltr and absent stay absent', () => {
    const nodeWith = (direction: unknown): SceneNode =>
      ({ components: [{ id: 'c', type: 'Text', props: { direction } }] }) as unknown as SceneNode;
    expect(compactTextExtras(readTextExtrasProps(nodeWith('auto')))).toEqual({ direction: 'auto' });
    expect(compactTextExtras(readTextExtrasProps(nodeWith('rtl')))).toEqual({ direction: 'rtl' });
    expect(compactTextExtras(readTextExtrasProps(nodeWith('ltr')))).toBeUndefined();
    expect(compactTextExtras(readTextExtrasProps(nodeWith(undefined)))).toBeUndefined();
  });
});
