/**
 * The compact UBA against UAX #9's own worked examples (with Hebrew letters
 * standing in for the spec's upper-case "right-to-left" letters) and mixed
 * Arabic / Latin / number strings.
 */

import {
  bidiClassOf,
  bidiPairedBracket,
  clusterLevels,
  hasStrongRtl,
  paragraphLevelOf,
  reorderLine,
  resolveCodePoints,
  resolveLevels,
  visualOrder,
} from './bidi';

// Hebrew letters used as the spec's CAPITALS.
const CAR = 'אבג';
const RAC = 'גבא';
const MEANS = 'דהוזח';
const SNAEM = 'חזוהד';

const levelsOf = (s: string, p: 0 | 1): number[] => resolveLevels([...s].map((c) => bidiClassOf(c.codePointAt(0)!)), p);

describe('bidi classes', () => {
  it('classifies strong, weak and neutral characters', () => {
    expect(bidiClassOf('a'.codePointAt(0)!)).toBe('L');
    expect(bidiClassOf('א'.codePointAt(0)!)).toBe('R');
    expect(bidiClassOf('ب'.codePointAt(0)!)).toBe('AL');
    expect(bidiClassOf('5'.codePointAt(0)!)).toBe('EN');
    expect(bidiClassOf('٥'.codePointAt(0)!)).toBe('AN');
    expect(bidiClassOf(' '.codePointAt(0)!)).toBe('WS');
    expect(bidiClassOf(','.codePointAt(0)!)).toBe('CS');
    expect(bidiClassOf('$'.codePointAt(0)!)).toBe('ET');
    expect(bidiClassOf('+'.codePointAt(0)!)).toBe('ES');
    expect(bidiClassOf('!'.codePointAt(0)!)).toBe('ON');
    expect(bidiClassOf(0x064e)).toBe('NSM');
    expect(bidiClassOf('中'.codePointAt(0)!)).toBe('L');
    expect(hasStrongRtl('abc مرحبا')).toBe(true);
    expect(hasStrongRtl('abc 123')).toBe(false);
  });
});

describe('UAX #9 examples', () => {
  it('"car means CAR." in an LTR paragraph', () => {
    const s = `car means ${CAR}.`;
    expect(levelsOf(s, 0)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0]);
    expect(reorderLine(s, 0)).toBe(`car means ${RAC}.`);
  });

  it('"car MEANS CAR." in an RTL paragraph', () => {
    const s = `car ${MEANS} ${CAR}.`;
    expect(levelsOf(s, 1)).toEqual([2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(reorderLine(s, 1)).toBe(`.${RAC} ${SNAEM} car`);
  });

  it('"he said “car MEANS CAR.”" style: an RTL run inside LTR keeps its words in RTL order', () => {
    const s = `he said ${MEANS} ${CAR} ok`;
    expect(reorderLine(s, 0)).toBe(`he said ${RAC} ${SNAEM} ok`);
  });
});

describe('numbers', () => {
  it('European digits after Hebrew stay left-to-right inside the RTL run', () => {
    expect(reorderLine(`${CAR} 123`, 1)).toBe(`123 ${RAC}`);
    expect(levelsOf(`${CAR} 123`, 1)).toEqual([1, 1, 1, 1, 2, 2, 2]);
  });

  it('LTR paragraph: "abc CAR 123 def" → "abc 123 RAC def"', () => {
    const s = `abc ${CAR} 123 def`;
    expect(levelsOf(s, 0)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 0, 0, 0, 0]);
    expect(reorderLine(s, 0)).toBe(`abc 123 ${RAC} def`);
  });

  it('W2: European digits after Arabic letters become Arabic numbers (still LTR inside)', () => {
    // "عدد 12" in an RTL paragraph: the digits read left-to-right at level 2.
    const s = 'عدد 12';
    expect(levelsOf(s, 1)).toEqual([1, 1, 1, 1, 2, 2]);
    expect(reorderLine(s, 1)).toBe('12 ددع');
  });

  it('W4/W5: separators and terminators join the number', () => {
    expect(levelsOf(`${CAR} 1,000$`, 1)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(reorderLine(`${CAR} 1+2`, 1)).toBe(`1+2 ${RAC}`);
  });

  it('Arabic-Indic digits are AN and stay in order', () => {
    expect(reorderLine('رقم ١٢٣', 1)).toBe('١٢٣ مقر');
  });
});

describe('mixed Arabic + Latin', () => {
  it('Latin inside an RTL paragraph keeps its own order and sits where it was typed', () => {
    const s = 'مرحبا Hello عالم';
    expect(reorderLine(s, 1)).toBe('ملاع Hello ابحرم');
  });

  it('L1: trailing whitespace takes the paragraph level', () => {
    expect(levelsOf('abc  ', 1)).toEqual([2, 2, 2, 1, 1]);
    // In RTL the trailing space therefore lands at the visual LEFT end.
    expect(reorderLine('abc ', 1)).toBe(' abc');
  });

  it('marks travel with their base cluster', () => {
    const clusters = ['بَ', 'ت', ' ', 'x'];
    expect(clusterLevels(clusters, 1)).toEqual([1, 1, 1, 2]);
  });
});

describe('full UBA: explicit formatting, brackets, auto direction', () => {
  const cpsOf = (s: string): number[] => [...s].map((c) => c.codePointAt(0)!);

  it('classifies explicit formatting characters from the UCD table', () => {
    expect(bidiClassOf(0x202b)).toBe('RLE');
    expect(bidiClassOf(0x202e)).toBe('RLO');
    expect(bidiClassOf(0x2067)).toBe('RLI');
    expect(bidiClassOf(0x2068)).toBe('FSI');
    expect(bidiClassOf(0x2069)).toBe('PDI');
    expect(bidiPairedBracket(0x28)).toEqual({ pair: 0x29, type: 'open' });
    expect(bidiPairedBracket(0x61)).toBeNull();
  });

  it('N0: brackets around RTL text in an LTR paragraph take the RTL context', () => {
    // UAX #9 example: "AB(CD[&ef]!)gh" in an RTL paragraph.
    const s = `${CAR.slice(0, 2)}(${MEANS.slice(0, 2)}[&ef]!)gh`;
    expect(resolveCodePoints(cpsOf(s), 1).levels).toEqual([1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 1, 1, 2, 2]);
  });

  it('RLO overrides Latin letters to right-to-left; PDF closes it', () => {
    // RLO (removed) stays at level 0; PDF takes the level before it (1) and
    // reverses with the overridden run.
    expect(reorderLine('a‮bcd‬e', 0)).toBe('a‮‬dcbe');
  });

  it('an RLI isolate does not affect its surroundings', () => {
    const { levels } = resolveCodePoints(cpsOf(`a ⁧${CAR}⁩ 1`), 0);
    expect(levels).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0]);
  });

  it("'auto' uses the first strong character, skipping isolates", () => {
    expect(paragraphLevelOf(`123 ${CAR} abc`)).toBe(1);
    expect(paragraphLevelOf(`⁦${CAR}⁩ abc`)).toBe(0);
    expect(resolveCodePoints(cpsOf(`${CAR} abc`), 'auto').paragraphLevel).toBe(1);
    expect(clusterLevels([...'abc'], 'auto')).toEqual([0, 0, 0]);
  });

  it('characters removed by X9 keep their logical slot at the preceding level', () => {
    const levels = resolveCodePoints(cpsOf(`${CAR}‍b`), 0).levels;
    expect(levels).toHaveLength(5);
    expect(levels[3]).toBe(levels[2]);
    expect(visualOrder(levels)).toHaveLength(5);
  });
});

describe('visualOrder', () => {
  it('reverses from the highest level down to the lowest odd level', () => {
    expect(visualOrder([0, 0, 1, 1, 2, 2, 1, 0])).toEqual([0, 1, 6, 4, 5, 3, 2, 7]);
    expect(visualOrder([])).toEqual([]);
    // Levels not present count: reversed at 2, then again at 1 — logical order.
    expect(visualOrder([0, 0, 2, 2])).toEqual([0, 1, 2, 3]);
    expect(visualOrder([1, 2, 2])).toEqual([1, 2, 0]);
  });
});
