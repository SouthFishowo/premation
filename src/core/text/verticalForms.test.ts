/**
 * Unicode Vertical_Orientation lookups and how each character is drawn in a
 * vertical column — with the font's own `vert` alternates, and without.
 */

import { VERTICAL_ORIENTATION_UNICODE_VERSION, VO_RANGE_STARTS, VO_RANGE_VALUES } from './verticalOrientationData';
import { clusterVerticalOrientation, resolveVerticalForm, verticalOrientationOf } from './verticalForms';

const fallback = { alternates: false, romanUpright: false };
const withVert = { alternates: true, romanUpright: false };

describe('verticalOrientationData', () => {
  it('is a well-formed range table with a version header', () => {
    expect(VERTICAL_ORIENTATION_UNICODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(VO_RANGE_STARTS[0]).toBe(0);
    expect(VO_RANGE_VALUES).toHaveLength(VO_RANGE_STARTS.length);
    expect(VO_RANGE_VALUES).toMatch(/^[URur]+$/);
    for (let i = 1; i < VO_RANGE_STARTS.length; i++) {
      expect(VO_RANGE_STARTS[i]!).toBeGreaterThan(VO_RANGE_STARTS[i - 1]!);
      expect(VO_RANGE_VALUES[i]).not.toBe(VO_RANGE_VALUES[i - 1]);
    }
  });
});

describe('verticalOrientationOf', () => {
  it.each([
    [0x41, 'R'], // A
    [0x31, 'R'], // 1
    [0x20, 'R'], // space
    [0x2026, 'R'], // …
    [0x6f22, 'U'], // 漢
    [0x304b, 'U'], // か
    [0xd55c, 'U'], // 한
    [0x3000, 'U'], // ideographic space
    [0xff21, 'U'], // Ａ
    [0x3001, 'Tu'], // 、
    [0x3002, 'Tu'], // 。
    [0x3041, 'Tu'], // ぁ
    [0xff01, 'Tu'], // ！
    [0x300c, 'Tr'], // 「
    [0x30fc, 'Tr'], // ー
    [0xff08, 'Tr'], // （
    [0xff5e, 'Tr'], // ～
    [0x20000, 'U'], // CJK Extension B
    [0x10fffd, 'U'], // plane 16 PUA (header default)
    [0xe0001, 'R'],
  ] as const)('U+%s is %s', (cp, vo) => {
    expect(verticalOrientationOf(cp)).toBe(vo);
  });

  it('reads a cluster by its first code point', () => {
    expect(clusterVerticalOrientation('\u{20B9F}')).toBe('U');
    expect(clusterVerticalOrientation('')).toBe('R');
  });
});

describe('resolveVerticalForm — with the font’s vert alternates', () => {
  it('stands every transformed character upright and draws it with the vert face', () => {
    for (const c of ['「', '」', '、', '。', 'ー', '（', '～']) {
      expect(resolveVerticalForm(c, withVert)).toEqual({ drawn: c, upright: true, alternate: true, corner: false });
    }
  });

  it('ideographs also take the vert face (a no-op substitution); Latin stays rotated', () => {
    expect(resolveVerticalForm('漢', withVert)).toMatchObject({ upright: true, alternate: true });
    expect(resolveVerticalForm('A', withVert)).toMatchObject({ upright: false, alternate: false });
  });

  it('Standard Vertical Roman Alignment stands Latin upright with alternates too', () => {
    expect(resolveVerticalForm('A', { alternates: true, romanUpright: true })).toMatchObject({ upright: true, alternate: true });
  });
});

describe('resolveVerticalForm — per-character alternates (the font’s GSUB)', () => {
  // A font whose vert turns 、 and 「 but not ー or ．
  const gsub = { alternates: (cp: number) => cp === 0x3001 || cp === 0x300c, romanUpright: false };

  it('characters with an alternate use the vert face', () => {
    expect(resolveVerticalForm('、', gsub)).toEqual({ drawn: '、', upright: true, alternate: true, corner: false });
    expect(resolveVerticalForm('「', gsub)).toMatchObject({ drawn: '「', alternate: true });
  });

  it('characters without one take the Unicode fallback, one by one', () => {
    expect(resolveVerticalForm('」', gsub)).toEqual({ drawn: '﹂', upright: true, alternate: false, corner: false });
    expect(resolveVerticalForm('ー', gsub)).toEqual({ drawn: 'ー', upright: false, alternate: false, corner: false });
    expect(resolveVerticalForm('．', gsub)).toMatchObject({ corner: true, alternate: false });
    expect(resolveVerticalForm('漢', gsub)).toMatchObject({ upright: true, alternate: false });
  });
});

describe('resolveVerticalForm — the fallback', () => {
  it('(a) substitutes Unicode vertical presentation forms', () => {
    expect(resolveVerticalForm('、', fallback)).toEqual({ drawn: '︑', upright: true, alternate: false, corner: false });
    expect(resolveVerticalForm('。', fallback).drawn).toBe('︒');
    expect(resolveVerticalForm('「', fallback).drawn).toBe('﹁');
    expect(resolveVerticalForm('」', fallback).drawn).toBe('﹂');
    expect(resolveVerticalForm('（', fallback).drawn).toBe('︵');
    expect(resolveVerticalForm('）', fallback).drawn).toBe('︶');
    expect(resolveVerticalForm('【', fallback).drawn).toBe('︻');
    expect(resolveVerticalForm('！', fallback).drawn).toBe('︕');
  });

  it('(b) rotates transformed-rotated characters without a form', () => {
    expect(resolveVerticalForm('ー', fallback)).toEqual({ drawn: 'ー', upright: false, alternate: false, corner: false });
    expect(resolveVerticalForm('～', fallback).upright).toBe(false);
    expect(resolveVerticalForm('〜', fallback).upright).toBe(false);
  });

  it('(c) nudges the full-width full stop, which has no form', () => {
    expect(resolveVerticalForm('．', fallback)).toEqual({ drawn: '．', upright: true, alternate: false, corner: true });
  });

  it('keeps upright characters and rotates Latin', () => {
    expect(resolveVerticalForm('漢', fallback)).toEqual({ drawn: '漢', upright: true, alternate: false, corner: false });
    expect(resolveVerticalForm('a', fallback).upright).toBe(false);
    expect(resolveVerticalForm(' ', fallback).upright).toBe(false);
    // Rotated, an ellipsis already reads as a vertical one.
    expect(resolveVerticalForm('…', fallback)).toMatchObject({ drawn: '…', upright: false });
  });

  it('upright Latin punctuation takes its presentation form', () => {
    expect(resolveVerticalForm('…', { alternates: false, romanUpright: true })).toMatchObject({ drawn: '︙', upright: true });
    expect(resolveVerticalForm('A', { alternates: false, romanUpright: true })).toMatchObject({ drawn: 'A', upright: true });
  });
});
