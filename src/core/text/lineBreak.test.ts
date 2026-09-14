/**
 * Break opportunities, kinsoku shori and the greedy wrap shared by vertical
 * columns and horizontal CJK paragraphs.
 */

import { splitGraphemes } from './graphemes';
import {
  KINSOKU_NO_LINE_END,
  KINSOKU_NO_LINE_START,
  breakOpportunities,
  insertedBreakIndices,
  joinWrapped,
  setWordSegmenterForTest,
  shiftSpansForInsertedBreaks,
  wrapUnits,
} from './lineBreak';
import { softBreakLines } from './textExtras';

const cp = (c: string): number => c.codePointAt(0)!;
const g = splitGraphemes;

describe('kinsoku tables', () => {
  it('forbid closing punctuation, small kana and ー at a line start', () => {
    for (const c of ['」', '』', '）', '、', '。', 'ー', 'ぁ', 'ッ', '！', '々']) expect(KINSOKU_NO_LINE_START.has(cp(c))).toBe(true);
    expect(KINSOKU_NO_LINE_START.has(cp('日'))).toBe(false);
  });

  it('forbid opening brackets at a line end', () => {
    for (const c of ['「', '『', '（', '【', '〔']) expect(KINSOKU_NO_LINE_END.has(cp(c))).toBe(true);
    expect(KINSOKU_NO_LINE_END.has(cp('」'))).toBe(false);
  });
});

describe('breakOpportunities', () => {
  afterEach(() => setWordSegmenterForTest(false));

  it('breaks between any two CJK characters', () => {
    expect(breakOpportunities(g('日本語'))).toEqual([false, true, true]);
  });

  it('never before a line-start-prohibited or after a line-end-prohibited character', () => {
    expect(breakOpportunities(g('日」本'))).toEqual([false, false, true]);
    expect(breakOpportunities(g('日「本'))).toEqual([false, true, false]);
    expect(breakOpportunities(g('日本。'))).toEqual([false, true, false]);
  });

  it('breaks Latin only at word boundaries: after a space, after a hyphen', () => {
    expect(breakOpportunities(g('hello world'))).toEqual([false, false, false, false, false, false, true, false, false, false, false]);
    expect(breakOpportunities(g('foo-bar'))).toEqual([false, false, false, false, true, false, false]);
  });

  it('breaks between Latin and CJK', () => {
    expect(breakOpportunities(g('ab日'))).toEqual([false, false, true]);
  });

  it('falls back to spaces without Intl.Segmenter', () => {
    setWordSegmenterForTest(true);
    expect(breakOpportunities(g('ab cd'))).toEqual([false, false, false, true, false]);
  });
});

describe('wrapUnits', () => {
  const tens = (s: string): [ReadonlyArray<string>, number[]] => [g(s), g(s).map(() => 10)];

  it('wraps at the last word boundary, a trailing space hanging', () => {
    const [u, l] = tens('ab cde');
    expect(wrapUnits(u, l, 45)).toEqual([3]);
  });

  it('breaks a word only when it alone passes the limit', () => {
    const [u, l] = tens('abcdef');
    expect(wrapUnits(u, l, 35)).toEqual([3]);
  });

  it('pushes a character forward rather than start a line with 。 (oidashi)', () => {
    const [u, l] = tens('日本。');
    expect(wrapUnits(u, l, 20)).toEqual([1]);
  });

  it('keeps an opening bracket with the character after it', () => {
    const [u, l] = tens('日「本語');
    expect(wrapUnits(u, l, 20)).toEqual([1, 3]);
  });

  it('takes a per-line limit (first-line indent)', () => {
    const [u, l] = tens('日本語漢字');
    expect(wrapUnits(u, l, (line) => (line === 0 ? 20 : 30))).toEqual([2]);
  });
});

describe('inserted soft breaks', () => {
  it('replaces a space and inserts between CJK characters', () => {
    expect(joinWrapped(g('ab cd'), [3])).toBe('ab\ncd');
    expect(joinWrapped(g('日本語'), [2])).toBe('日本\n語');
  });

  it('finds the inserted breaks and shifts spans past them', () => {
    expect(insertedBreakIndices(g('日本'), g('日\n本'))).toEqual([1]);
    expect(insertedBreakIndices(g('a b'), g('a\nb'))).toEqual([]);
    expect(insertedBreakIndices(g('a b日本'), g('a\nb日\n本'))).toEqual([4]);
    const spans = shiftSpansForInsertedBreaks([{ start: 0, end: 2 }, { start: 1, end: 2 }, { start: 0, end: 1 }], [1]);
    expect(spans).toEqual([{ start: 0, end: 3 }, { start: 2, end: 3 }, { start: 0, end: 1 }]);
  });

  it('softBreakLines reads inserted and replaced breaks as soft, newlines as hard', () => {
    expect(softBreakLines('日本語', '日本\n語')).toEqual([0]);
    expect(softBreakLines('日本\n語', '日\n本\n語')).toEqual([0]);
    expect(softBreakLines('a b日本', 'a\nb日\n本')).toEqual([0, 1]);
    // Same length: the original one-for-one reading.
    expect(softBreakLines('a b\nc', 'a\nb\nc')).toEqual([0]);
  });
});
