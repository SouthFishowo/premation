/**
 * Vertical type depth: tate-chu-yoko, word wrap + kinsoku in box columns,
 * column justification and vertical alternates. A fixed metric — the em for
 * upright characters, 10 px for everything else — keeps positions exact.
 */

import type { TextStyle } from './textLayout';
import { autoTateChuYokoRuns, isUprightInVertical, layoutVerticalText, SIDEWAYS_ANGLE, type VerticalGlyph } from './verticalLayout';

const measure = (char: string, style: TextStyle): number => (isUprightInVertical(char) ? style.fontSize : 10);
const base = { fontSize: 20 };
const glyphs = (l: { glyphs: unknown[] }): VerticalGlyph[] => l.glyphs as VerticalGlyph[];

describe('tate-chu-yoko', () => {
  it('finds auto runs of up to N ASCII digits only', () => {
    expect(autoTateChuYokoRuns([...'第12回123'], 2)).toEqual([[1, 3]]);
    expect(autoTateChuYokoRuns([...'1a23'], 2)).toEqual([[0, 1], [2, 4]]);
    expect(autoTateChuYokoRuns([...'12'], 0)).toEqual([]);
  });

  it('sets an auto digit run horizontally, centred in one em of the column', () => {
    const laid = layoutVerticalText('第12回', base, measure, { boxWidth: 100, tateChuYokoDigits: 2 });
    const gl = glyphs(laid);
    expect(gl.map((x) => [x.char, x.x, x.y, x.angle])).toEqual([
      ['第', 0, -20, undefined],
      ['1', -5, 0, undefined],
      ['2', 5, 0, undefined],
      ['回', 0, 20, undefined],
    ]);
    expect(gl[1]!.tcy).toEqual({ start: 1, scale: 1 });
    expect(gl.map((x) => x.advance)).toEqual([20, 20, 0, 20]);
    expect(laid.height).toBe(60);
  });

  it('leaves a longer digit run rotated', () => {
    const laid = layoutVerticalText('123', base, measure, { boxWidth: 100, tateChuYokoDigits: 2 });
    expect(glyphs(laid).every((x) => x.angle === SIDEWAYS_ANGLE && !x.tcy)).toBe(true);
  });

  it('squeezes a per-range run wider than the column to one em', () => {
    const laid = layoutVerticalText('123', base, measure, {
      boxWidth: 100,
      runs: [{ start: 0, end: 3, style: { tateChuYoko: true } }],
    });
    const gl = glyphs(laid);
    const k = 20 / 30;
    expect(gl.map((x) => x.tcy?.scale)).toEqual([k, k, k]);
    [-10 * k, 0, 10 * k].forEach((v, i) => expect(gl[i]!.x).toBeCloseTo(v, 9));
    expect(gl[0]!.inkWidth).toBeCloseTo(10 * k, 9);
    expect(laid.height).toBe(20);
  });

  it('a tate-chu-yoko run is one unbreakable unit', () => {
    const laid = layoutVerticalText('日12', base, measure, { boxWidth: 200, padX: 0, columnLimit: 30, tateChuYokoDigits: 2 });
    expect(laid.glyphs.map((x) => x.line)).toEqual([0, 1, 1]);
  });
});

describe('box columns: word wrap and kinsoku', () => {
  const box = (text: string, limit: number, extra: object = {}) =>
    layoutVerticalText(text, { ...base, ...extra }, measure, { boxWidth: 400, padX: 0, columnLimit: limit });

  it('wraps rotated Latin at the word, not the character', () => {
    expect(box('ab cde', 45).glyphs.map((x) => x.line)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('breaks a word only when it alone exceeds the column', () => {
    expect(box('abcdef', 35).glyphs.map((x) => x.line)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('never starts a column with 。 — the character before it moves too', () => {
    const laid = box('日本。', 40);
    expect(laid.glyphs.map((x) => x.line)).toEqual([0, 1, 1]);
    expect(glyphs(laid)[2]!.drawn).toBe('︒');
  });

  it('never ends a column with 「', () => {
    expect(box('日「本語', 40).glyphs.map((x) => x.line)).toEqual([0, 1, 1, 2]);
  });
});

describe('column justification', () => {
  const box = (text: string, limit: number, align: string) =>
    layoutVerticalText(text, { ...base, align }, measure, { boxWidth: 400, padX: 0, columnLimit: limit });

  it('stretches a soft-broken CJK column between its characters', () => {
    const laid = box('日本語漢', 70, 'justify-left');
    expect(laid.glyphs.map((x) => x.y)).toEqual([-25, 0, 25, -25]);
    expect(laid.lines[0]).toMatchObject({ width: 70, spaceExtra: 5 });
    expect(laid.lines[1]!.spaceExtra).toBeUndefined();
  });

  it('places the last column by the last-line alignment', () => {
    expect(box('日本語漢', 70, 'justify-center').glyphs[3]!.y).toBe(0);
    expect(box('日本語漢', 70, 'justify-right').glyphs[3]!.y).toBe(25);
  });

  it('Justify All stretches the last column too', () => {
    const laid = box('日本語漢字', 70, 'justify-all');
    // Column 1 = 漢字 (40 px) stretched to 70: one gap of 30.
    expect(laid.glyphs.slice(3).map((x) => x.y)).toEqual([-25, 25]);
  });

  it('stretches word spaces in a Latin column', () => {
    const laid = box('ab cd ef', 65, 'justify-left');
    expect(laid.glyphs.slice(0, 5).map((x) => x.y)).toEqual([-27.5, -17.5, -7.5, 17.5, 27.5]);
    expect(laid.lines[0]).toMatchObject({ width: 65, spaceExtra: 15 });
  });

  it('point text is never justified', () => {
    const laid = layoutVerticalText('日本\n語', { ...base, align: 'justify-all' }, measure, { boxWidth: 100 });
    expect(laid.lines.every((l) => l.spaceExtra === undefined)).toBe(true);
  });
});

describe('vertical alternates', () => {
  it('with a vert face: 「 stays 「, upright, flagged for the alternate face', () => {
    const laid = layoutVerticalText('「日', base, measure, { boxWidth: 100, alternates: () => true });
    const gl = glyphs(laid);
    expect(gl[0]!).toMatchObject({ char: '「', vertAlternate: true });
    expect(gl[0]!.drawn).toBeUndefined();
    expect(gl[0]!.angle).toBeUndefined();
    expect(gl[0]!.advance).toBe(20);
  });

  it('a per-code-point answer turns only the characters the font has alternates for', () => {
    const laid = layoutVerticalText('「」', base, measure, { boxWidth: 100, alternates: () => (cp) => cp === 0x300c });
    const gl = glyphs(laid);
    expect(gl[0]!).toMatchObject({ char: '「', vertAlternate: true });
    expect(gl[1]!.vertAlternate).toBeUndefined();
    expect(gl[1]!.drawn).toBe('﹂');
  });

  it('asks per style, so a run in another font can fall back', () => {
    const laid = layoutVerticalText('「「', base, measure, {
      boxWidth: 100,
      runs: [{ start: 1, end: 2, style: { fontFamily: 'Web' } }],
      alternates: (s) => s.fontFamily !== 'Web',
    });
    const gl = glyphs(laid);
    expect(gl[0]!.vertAlternate).toBe(true);
    expect(gl[1]!.drawn).toBe('﹁');
  });

  it('without one: the presentation form, the rotated long vowel, the nudged full stop', () => {
    const gl = glyphs(layoutVerticalText('「ー．', base, measure, { boxWidth: 100 }));
    expect(gl[0]!.drawn).toBe('﹁');
    expect(gl[1]!.angle).toBe(SIDEWAYS_ANGLE);
    // ．: 10 px rotated ー before it; nudged half an em right and up.
    expect(gl[2]!.x).toBe(10);
    expect(gl[2]!.vertAlternate).toBeUndefined();
  });
});
