import { findMatches, replaceAllInString, replaceAllWithRuns } from './findReplaceText';

describe('findMatches', () => {
  it('case-insensitive by default, non-overlapping, left to right', () => {
    expect(findMatches('Cat cat CAT', 'cat')).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 }]);
    expect(findMatches('aaaa', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });

  it('Match case', () => {
    expect(findMatches('Cat cat CAT', 'cat', { matchCase: true })).toEqual([{ start: 4, end: 7 }]);
  });

  it('Whole word, in any script', () => {
    expect(findMatches('cat concat cat_ cat.', 'cat', { wholeWord: true })).toEqual([{ start: 0, end: 3 }, { start: 16, end: 19 }]);
    expect(findMatches('кот котик кот', 'кот', { wholeWord: true })).toHaveLength(2);
  });

  it('indexes grapheme clusters — a match never splits an emoji', () => {
    expect(findMatches('👨‍👩‍👧 hi', 'hi')).toEqual([{ start: 2, end: 4 }]);
    expect(findMatches('ée', 'e')).toEqual([{ start: 1, end: 2 }]); // "é" is one cluster, not an "e"
  });

  it('empty find matches nothing', () => {
    expect(findMatches('abc', '')).toEqual([]);
  });
});

describe('replaceAllInString', () => {
  it('replaces every match and reports the edits in ORIGINAL indices', () => {
    const r = replaceAllInString('a b a', 'a', 'xyz');
    expect(r.text).toBe('xyz b xyz');
    expect(r.count).toBe(2);
    expect(r.edits).toEqual([{ start: 0, end: 1, insertLength: 3 }, { start: 4, end: 5, insertLength: 3 }]);
  });

  it('no match returns the text untouched', () => {
    expect(replaceAllInString('abc', 'z', 'q')).toEqual({ text: 'abc', count: 0, edits: [] });
  });
});

describe('replaceAllWithRuns — styling stays on the right characters', () => {
  it('shifts runs after a longer replacement, and a run over the word covers the replacement', () => {
    // "red cat, blue cat" — "cat" styled at 4..7, "blue" at 9..13
    const runs = [
      { start: 4, end: 7, style: { fill: '#f00' } },
      { start: 9, end: 13, style: { fill: '#00f' } },
    ];
    const r = replaceAllWithRuns('red cat, blue cat', runs, 'cat', 'tiger');
    expect(r.text).toBe('red tiger, blue tiger');
    expect(r.count).toBe(2);
    expect(r.runs).toEqual([
      { start: 4, end: 9, style: { fill: '#f00' } },
      { start: 11, end: 15, style: { fill: '#00f' } },
    ]);
  });

  it('a shorter replacement pulls later runs back', () => {
    const r = replaceAllWithRuns('Hello world!', [{ start: 6, end: 11, style: { fontSize: 9 } }], 'Hello', 'Hi');
    expect(r.text).toBe('Hi world!');
    expect(r.runs).toEqual([{ start: 3, end: 8, style: { fontSize: 9 } }]);
  });
});
