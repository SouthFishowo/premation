import {
  splitGraphemes,
  graphemeCount,
  codePointToGraphemeIndex,
  graphemeToCodePointIndex,
  utf16ToGraphemeIndex,
  graphemesAreCodePoints,
  hasComplexScript,
  setGraphemeSegmenterForTest,
} from './graphemes';

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 👨‍👩‍👧 — 5 code points, 8 UTF-16 units
const E_ACUTE = 'é'; // é decomposed — 2 code points
const THUMB = '\u{1F44D}\u{1F3FD}'; // 👍🏽 — skin-tone modifier
const FLAG = '\u{1F1F0}\u{1F1F7}'; // 🇰🇷

describe('splitGraphemes', () => {
  afterEach(() => setGraphemeSegmenterForTest('auto'));

  it('keeps an emoji ZWJ sequence as one character', () => {
    expect(splitGraphemes(`${FAMILY}x`)).toEqual([FAMILY, 'x']);
  });

  it('keeps a combining mark on its base letter', () => {
    expect(splitGraphemes(`${E_ACUTE}b`)).toEqual([E_ACUTE, 'b']);
  });

  it('keeps skin-tone modifiers and flags whole', () => {
    expect(splitGraphemes(`${THUMB}${FLAG}`)).toEqual([THUMB, FLAG]);
  });

  it('is identical to code points for ordinary text', () => {
    expect(splitGraphemes('Hello\nWorld')).toEqual([...'Hello\nWorld']);
    expect(graphemesAreCodePoints('Hello')).toBe(true);
    expect(graphemesAreCodePoints(FAMILY)).toBe(false);
  });

  it('falls back to code points without Intl.Segmenter', () => {
    setGraphemeSegmenterForTest('fallback');
    expect(splitGraphemes(E_ACUTE)).toEqual(['e', '́']);
  });

  it('counts clusters', () => {
    expect(graphemeCount(`a${FAMILY}${E_ACUTE}`)).toBe(3);
    expect(graphemeCount('')).toBe(0);
  });
});

describe('index conversion', () => {
  const text = `a${FAMILY}b`; // graphemes: a | family | b ; code points: 1 + 5 + 1

  it('maps code-point offsets onto clusters, rounding within a cluster', () => {
    expect(codePointToGraphemeIndex(text, 0)).toBe(0);
    expect(codePointToGraphemeIndex(text, 1)).toBe(1);
    expect(codePointToGraphemeIndex(text, 6)).toBe(2);
    expect(codePointToGraphemeIndex(text, 7)).toBe(3);
    // Inside the family: a start rounds down, an end rounds up.
    expect(codePointToGraphemeIndex(text, 3, false)).toBe(1);
    expect(codePointToGraphemeIndex(text, 3, true)).toBe(2);
  });

  it('maps grapheme offsets back to code points', () => {
    expect(graphemeToCodePointIndex(text, 2)).toBe(6);
    expect(graphemeToCodePointIndex(text, 3)).toBe(7);
  });

  it('maps DOM (UTF-16) offsets onto clusters', () => {
    expect(utf16ToGraphemeIndex(text, 1)).toBe(1);
    expect(utf16ToGraphemeIndex(text, 1 + FAMILY.length)).toBe(2);
    expect(utf16ToGraphemeIndex(`${E_ACUTE}x`, 2)).toBe(1);
  });
});

describe('hasComplexScript', () => {
  it('flags joining scripts and not Latin', () => {
    expect(hasComplexScript('مرحبا')).toBe(true);
    expect(hasComplexScript('नमस्ते')).toBe(true);
    expect(hasComplexScript('Hello, world')).toBe(false);
  });
});
