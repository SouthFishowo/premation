/**
 * How each character stands in vertical type: upright, rotated sideways, or
 * TRANSFORMED — a vertical glyph alternate.
 *
 * ## The table
 *
 * Unicode's Vertical_Orientation property (UAX #50), generated into
 * verticalOrientationData.ts by scripts/generate-vertical-orientation.mjs:
 *
 *   U   upright (ideographs, kana, hangul, most full-width forms)
 *   R   rotated 90° clockwise (Latin, digits, most symbols)
 *   Tu  transformed — a vertical alternate; without one, upright
 *       (、。，． small kana, ！？)
 *   Tr  transformed — a vertical alternate; without one, rotated
 *       (「」（）【】 ー ～ ： ；)
 *
 * ## Transformed characters on a canvas
 *
 * The real transform is the font's OpenType `vert` / `vrt2` substitution.
 * Chromium's 2D canvas has no `fontFeatureSettings`, but an alias FontFace
 * with `featureSettings: "'vert' 1"` applies it (fontFaceVariants.ts,
 * {@link verticalAlternatesFamily}), so when that alias is available every
 * Tu/Tr character simply stands upright and is drawn with it. When the font's
 * bytes are known, its GSUB answers per CHARACTER (openTypeGsub.ts): only the
 * characters whose glyph really has a `vert` alternate use the alias, and each
 * of the others takes the fallback below on its own.
 *
 * When it is not (a web font with no local file, a font without a `vert`
 * table, the alias still loading) the fallback, in order:
 *   (a) the Unicode vertical PRESENTATION FORM, where one exists
 *       (U+FE10–FE19, U+FE30–FE4F: 、→︑ 。→︒ 「→﹁ （→︵ …→︙);
 *   (b) Tr characters without one ROTATE (ー ～ 〜), which is what their
 *       vertical forms look like;
 *   (c) the one Tu character left without a form, the full-width full stop,
 *       is NUDGED into the upper right of its em box.
 */

import { VO_RANGE_STARTS, VO_RANGE_VALUES } from './verticalOrientationData';

export type VerticalOrientation = 'U' | 'R' | 'Tu' | 'Tr';

const DECODE: Record<string, VerticalOrientation> = { U: 'U', R: 'R', u: 'Tu', r: 'Tr' };

/** UAX #50 Vertical_Orientation of a code point. */
export function verticalOrientationOf(cp: number): VerticalOrientation {
  if (!(cp >= 0)) return 'R';
  let lo = 0;
  let hi = VO_RANGE_STARTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (VO_RANGE_STARTS[mid]! <= cp) lo = mid;
    else hi = mid - 1;
  }
  return DECODE[VO_RANGE_VALUES[lo] ?? 'R'] ?? 'R';
}

/** Vertical_Orientation of a grapheme cluster (its first code point). */
export function clusterVerticalOrientation(cluster: string): VerticalOrientation {
  const cp = cluster.codePointAt(0);
  return cp === undefined ? 'R' : verticalOrientationOf(cp);
}

/** Horizontal character → its Unicode vertical presentation form. */
export const VERTICAL_PRESENTATION_FORMS: ReadonlyMap<number, number> = new Map([
  [0xff0c, 0xfe10], // ， → ︐
  [0x3001, 0xfe11], // 、 → ︑
  [0x3002, 0xfe12], // 。 → ︒
  [0xff1a, 0xfe13], // ： → ︓
  [0xff1b, 0xfe14], // ； → ︔
  [0xff01, 0xfe15], // ！ → ︕
  [0xff1f, 0xfe16], // ？ → ︖
  [0x3016, 0xfe17], // 〖 → ︗
  [0x3017, 0xfe18], // 〗 → ︘
  [0x2026, 0xfe19], // … → ︙
  [0x2025, 0xfe30], // ‥ → ︰
  [0x2014, 0xfe31], // — → ︱
  [0x2013, 0xfe32], // – → ︲
  [0xff3f, 0xfe33], // ＿ → ︳
  [0xfe4f, 0xfe34], // ﹏ → ︴
  [0xff08, 0xfe35], // （ → ︵
  [0xff09, 0xfe36], // ） → ︶
  [0xff5b, 0xfe37], // ｛ → ︷
  [0xff5d, 0xfe38], // ｝ → ︸
  [0x3014, 0xfe39], // 〔 → ︹
  [0x3015, 0xfe3a], // 〕 → ︺
  [0x3010, 0xfe3b], // 【 → ︻
  [0x3011, 0xfe3c], // 】 → ︼
  [0x300a, 0xfe3d], // 《 → ︽
  [0x300b, 0xfe3e], // 》 → ︾
  [0x3008, 0xfe3f], // 〈 → ︿
  [0x3009, 0xfe40], // 〉 → ﹀
  [0x300c, 0xfe41], // 「 → ﹁
  [0x300d, 0xfe42], // 」 → ﹂
  [0x300e, 0xfe43], // 『 → ﹃
  [0x300f, 0xfe44], // 』 → ﹄
  [0xff3b, 0xfe47], // ［ → ﹇
  [0xff3d, 0xfe48], // ］ → ﹈
]);

/** Comma / full-stop forms the last-resort fallback nudges into the em box's upper right. */
export const CORNER_PUNCTUATION: ReadonlySet<number> = new Set([0x3001, 0x3002, 0xff0c, 0xff0e]);

export interface VerticalForm {
  /** What to draw (a presentation form when the fallback substituted one). */
  drawn: string;
  /** Stands upright, advancing one em; false = rotated 90° clockwise. */
  upright: boolean;
  /** Draw with the `vert` alias face (the font's own vertical alternate). */
  alternate: boolean;
  /** Last-resort nudge into the em box's upper right (see file docblock). */
  corner: boolean;
}

export interface VerticalFormOptions {
  /**
   * The `vert` alias face is available for this glyph's style: for every
   * character (true), or per code point — the font's GSUB says which glyphs
   * have a vertical alternate, and the rest take the fallback below.
   */
  alternates: boolean | ((codePoint: number) => boolean);
  /** Standard Vertical Roman Alignment: R characters stand upright too. */
  romanUpright: boolean;
}

/** How `cluster` is drawn in a vertical column. */
export function resolveVerticalForm(cluster: string, opts: VerticalFormOptions): VerticalForm {
  const plain = (upright: boolean, alternate = false): VerticalForm => ({ drawn: cluster, upright, alternate, corner: false });
  // A Latin space is a sideways space either way; U+3000 is upright (U).
  if (cluster === ' ' || cluster === '\t') return plain(false);
  const cp = cluster.codePointAt(0);
  if (cp === undefined) return plain(false);
  const vo = verticalOrientationOf(cp);
  const alternates = typeof opts.alternates === 'function' ? opts.alternates(cp) : opts.alternates;
  const form = VERTICAL_PRESENTATION_FORMS.get(cp);
  const presentation = (): VerticalForm => ({
    drawn: String.fromCodePoint(form!) + cluster.slice(cp > 0xffff ? 2 : 1),
    upright: true,
    alternate: false,
    corner: false,
  });

  if (vo === 'R') {
    if (!opts.romanUpright) return plain(false);
    // Upright Latin (text-orientation: upright) takes vertical alternates too.
    if (alternates) return plain(true, true);
    return form !== undefined ? presentation() : plain(true);
  }
  if (vo === 'U') return plain(true, alternates);
  if (alternates) return plain(true, true);
  if (form !== undefined) return presentation();
  if (vo === 'Tr') return plain(false);
  // Tu without a presentation form.
  return { drawn: cluster, upright: true, alternate: false, corner: CORNER_PUNCTUATION.has(cp) };
}
