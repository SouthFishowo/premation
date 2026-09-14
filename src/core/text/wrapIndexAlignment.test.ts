/**
 * The one seam between logical (stored-text) indices and a CJK paragraph's
 * wrapped text, which gains INSERTED soft breaks. buildSnapshot runs it for the
 * static text and for a Source Text expression's text alike.
 */

import { alignIndicesToWrap } from './lineBreak';

describe('alignIndicesToWrap', () => {
  // 日本語の文章 wrapped after 語 by an inserted break.
  const raw = '日本語の文章';
  const wrapped = '日本語\nの文章';

  it('shifts runs and pads animator output past every inserted break', () => {
    const { runs, glyphs } = alignIndicesToWrap(raw, wrapped, [{ start: 2, end: 5, style: {} }], ['a', 'b', 'c', 'd', 'e', 'f'], () => '_');
    expect(runs).toEqual([{ start: 2, end: 6, style: {} }]);
    expect(glyphs).toEqual(['a', 'b', 'c', '_', 'd', 'e', 'f']);
  });

  it('a run starting at the break moves with its first character', () => {
    const { runs } = alignIndicesToWrap(raw, wrapped, [{ start: 3, end: 6, style: {} }], undefined, () => '_');
    expect(runs).toEqual([{ start: 4, end: 7, style: {} }]);
  });

  it('a wrap that only replaced spaces (same length) changes nothing', () => {
    const runs = [{ start: 1, end: 4, style: {} }];
    const glyphs = ['a', 'b', ' ', 'c', 'd'];
    const out = alignIndicesToWrap('ab cd', 'ab\ncd', runs, glyphs, () => '_');
    expect(out.runs).toBe(runs);
    expect(out.glyphs).toBe(glyphs);
  });

  it('with neither runs nor animators there is nothing to map', () => {
    expect(alignIndicesToWrap(raw, wrapped, undefined, undefined, () => '_')).toEqual({ runs: undefined, glyphs: undefined });
  });
});
