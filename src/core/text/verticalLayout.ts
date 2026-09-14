/**
 * Vertical type (AE's Vertical Type Tool) — where every glyph of a vertical
 * text layer sits.
 *
 * ## The model
 *
 *   • Characters stack TOP → BOTTOM in a column; columns flow RIGHT → LEFT
 *     (the CJK convention and AE's default). A hard return starts a column;
 *     paragraph (box) text also breaks a column where it would pass the box
 *     height.
 *   • Orientation per character comes from Unicode's Vertical_Orientation
 *     table (verticalForms.ts): U stands UPRIGHT and advances one em, R is
 *     ROTATED 90° clockwise and advances by its horizontal width — unless
 *     Standard Vertical Roman Alignment stands it upright too — and Tu / Tr
 *     take the font's VERTICAL ALTERNATES (`vert`, through an alias face)
 *     when the painter has them, or a presentation-form / rotate / nudge
 *     fallback when it does not.
 *   • TATE-CHU-YOKO: a range styled `tateChuYoko`, or (auto) a run of up to N
 *     ASCII digits, is set HORIZONTALLY inside one em of the column, centred,
 *     squeezed to the column width when wider.
 *   • Box columns break at word boundaries for rotated Latin and between any
 *     two CJK characters, with kinsoku shori (lineBreak.ts).
 *   • Tracking (letter spacing, animator tracking, manual kerning) acts ALONG
 *     the column; leading is the distance between column centres.
 *   • Paragraph alignment maps to the column axis: left = top, center =
 *     centre, right = bottom. The justify variants stretch soft-broken box
 *     columns to the box height — between characters in CJK columns, at word
 *     spaces in Latin ones — and place the last column by their last-line
 *     alignment (Justify All stretches it too), as textExtras.placeLine does
 *     for horizontal lines.
 *
 * Pure (measurement injected), in the same centre-origin, +y-down space as
 * `layoutText`: `y` is a glyph's centre along its column and `x` the column
 * centre, both relative to the box centre.
 */

import type { GlyphTransform } from './textAnimators';
import { splitGraphemes, isLineBreak } from './graphemes';
import { AUTO_LEADING, hardEndsOf, lineOffsets, resolveAlign } from './textExtras';
import {
  glyphStyleScale,
  resolveGlyphStyle,
  type LineBox,
  type MeasureGlyph,
  type MeasureRun,
  type OpticalKern,
  type ParagraphStyle,
  type PlacedGlyph,
  type RichRun,
  type TextLayout,
  type TextStyle,
} from './textLayout';
import { clusterVerticalOrientation, resolveVerticalForm, type VerticalForm } from './verticalForms';
import { isBreakSpace, isIdeographicUnit, wrapUnits } from './lineBreak';

/** Rotation of a sideways glyph, radians (90° clockwise). */
export const SIDEWAYS_ANGLE = Math.PI / 2;

/**
 * True when the cluster stands upright by DEFAULT — UAX #50 U or Tu, i.e.
 * its orientation without vertical alternates. (Tr characters such as 「 and
 * ー fall back to rotated.)
 */
export function isUprightInVertical(cluster: string): boolean {
  if (cluster === ' ' || cluster === '\t') return false;
  const vo = clusterVerticalOrientation(cluster);
  return vo === 'U' || vo === 'Tu';
}

const isAsciiDigit = (c: string): boolean => c.length === 1 && c >= '0' && c <= '9';

/** Auto tate-chu-yoko: maximal runs of ASCII digits no longer than `maxDigits`, as [start, end). */
export function autoTateChuYokoRuns(chars: ReadonlyArray<string>, maxDigits: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!(maxDigits >= 1)) return out;
  let i = 0;
  while (i < chars.length) {
    if (!isAsciiDigit(chars[i]!)) { i++; continue; }
    let j = i + 1;
    while (j < chars.length && isAsciiDigit(chars[j]!)) j++;
    if (j - i <= maxDigits) out.push([i, j]);
    i = j;
  }
  return out;
}

export interface VerticalLayoutOptions {
  runs?: ReadonlyArray<RichRun>;
  transforms?: ReadonlyArray<GlyphTransform>;
  /** Render box width (padding included). */
  boxWidth: number;
  padX?: number;
  /**
   * Column length of a paragraph box, px. Present = box text: columns break
   * where they would pass it, the block starts at the box's top-right, and
   * columns past the box's left edge overflow (`visibleLines`).
   */
  columnLimit?: number;
  /** Kerning-aware run measurement, for rotated (sideways) runs. */
  measureRun?: MeasureRun;
  /** Standard Vertical Roman Alignment: Latin / digits upright too. */
  romanUpright?: boolean;
  /**
   * Whether the font's vertical alternates (`vert` alias face) can be drawn for
   * a style — for all its characters, or per code point (fontFaceVariants'
   * `VerticalAlternates.has`, read from the font's GSUB).
   */
  alternates?: (style: TextStyle) => boolean | ((codePoint: number) => boolean);
  /** Auto tate-chu-yoko: runs of up to this many ASCII digits. Absent / 0 = off. */
  tateChuYokoDigits?: number;
  /**
   * Optical kerning (kerningMode 'optical', opticalKerning.ts), between two
   * units of one column: a pair of SIDEWAYS glyphs takes the horizontal pair
   * adjustment along its run (those glyphs are laid on their side), a pair of
   * UPRIGHT glyphs the vertical one. Tate-chu-yoko units are never kerned;
   * manual kerning adds on top.
   */
  opticalKern?: OpticalKern;
  opticalKernVertical?: VerticalOpticalKern;
}

/** Px to add to the UPPER upright glyph's advance; `alternate` says which of the
 *  two draw with the font's vertical alternates. */
export type VerticalOpticalKern = (
  upper: string, upperStyle: TextStyle,
  lower: string, lowerStyle: TextStyle,
  alternate: { upper: boolean; lower: boolean },
) => number;

/** A vertical glyph — a PlacedGlyph plus how the painter must draw it. */
export interface VerticalGlyph extends PlacedGlyph {
  /** Draw with the font's vertical alternates (the `vert` alias face). */
  vertAlternate?: true;
  /** Tate-chu-yoko member: its run's first grapheme index, and the horizontal
   *  squeeze (≤ 1) that fits the run into one em. */
  tcy?: { start: number; scale: number };
}

function metricKey(s: TextStyle): string {
  return `${s.fontStyle ?? ''}|${s.fontWeight ?? ''}|${s.fontSize}|${s.fontFamily ?? ''}|${s.letterSpacing ?? 0}`
    + `|${s.smallCaps ? 'sc' : ''}|${s.horizontalScale ?? ''}|${s.verticalAlign ?? ''}`
    + `|${s.axisOffsets ? JSON.stringify(s.axisOffsets) : ''}`;
}

interface Member {
  char: string;
  drawn: string;
  index: number;
  style: TextStyle;
  transform?: GlyphTransform;
  form: VerticalForm;
  inkWidth: number;
}

/** One unbreakable step along a column: a glyph, or a tate-chu-yoko run. */
interface Unit {
  members: Member[];
  /** Logical text, for break opportunities. */
  text: string;
  advance: number;
  tcy?: { width: number; scale: number; em: number };
  space: boolean;
  ideographic: boolean;
}

/** Lay `text` out in vertical columns. */
export function layoutVerticalText(
  text: string,
  base: TextStyle & ParagraphStyle,
  measure: MeasureGlyph,
  opts: VerticalLayoutOptions,
): TextLayout {
  const chars = splitGraphemes(text);
  const n = chars.length;
  const styleAt = (i: number): TextStyle => {
    const s = resolveGlyphStyle(base, opts.runs, i);
    const ax = opts.transforms?.[i]?.axes;
    return ax && Object.keys(ax).length > 0 ? { ...s, axisOffsets: ax } : s;
  };
  const drawnAt = (i: number): string => {
    const d = opts.transforms?.[i]?.displayChar ?? chars[i]!;
    return opts.runs && resolveGlyphStyle(base, opts.runs, i).allCaps ? d.toUpperCase() : d;
  };
  const altCache = new Map<string, boolean | ((codePoint: number) => boolean)>();
  const alternatesFor = (s: TextStyle): boolean | ((codePoint: number) => boolean) => {
    if (!opts.alternates) return false;
    const key = metricKey(s);
    let hit = altCache.get(key);
    if (hit === undefined) {
      hit = opts.alternates(s);
      altCache.set(key, hit);
    }
    return hit;
  };
  const romanUpright = !!opts.romanUpright;
  const forms: Array<VerticalForm | null> = chars.map((c, i) =>
    isLineBreak(c) ? null : resolveVerticalForm(drawnAt(i), { alternates: alternatesFor(styleAt(i)), romanUpright }));

  // Tate-chu-yoko runs: per-range first, then auto digit runs that do not
  // overlap one. `tcyEnd[i]` > i marks a run starting at i.
  const tcyEnd = new Array<number>(n).fill(-1);
  const inTcy = new Array<boolean>(n).fill(false);
  const markTcy = (a: number, b: number): void => {
    if (!(b > a)) return;
    for (let k = a; k < b; k++) if (inTcy[k]) return;
    tcyEnd[a] = b;
    for (let k = a; k < b; k++) inTcy[k] = true;
  };
  if (opts.runs?.some((r) => r.style.tateChuYoko)) {
    let i = 0;
    while (i < n) {
      if (isLineBreak(chars[i]!) || !styleAt(i).tateChuYoko) { i++; continue; }
      let j = i + 1;
      while (j < n && !isLineBreak(chars[j]!) && styleAt(j).tateChuYoko) j++;
      markTcy(i, j);
      i = j;
    }
  }
  if (opts.tateChuYokoDigits) for (const [a, b] of autoTateChuYokoRuns(chars, opts.tateChuYokoDigits)) markTcy(a, b);

  const sideways = (i: number): boolean => !isLineBreak(chars[i]!) && !inTcy[i] && !forms[i]!.upright;

  // Kerned advances for maximal same-metric runs of SIDEWAYS glyphs — they are
  // drawn as one rotated string, so they must be spaced the way that draws.
  const kerned: (number | null)[] = new Array(n).fill(null);
  if (opts.measureRun) {
    let i = 0;
    while (i < n) {
      if (!sideways(i)) { i++; continue; }
      const key = metricKey(styleAt(i));
      let end = i + 1;
      while (end < n && sideways(end) && metricKey(styleAt(end)) === key) end++;
      const style = styleAt(i);
      let prev = 0;
      let soFar = '';
      for (let k = i; k < end; k++) {
        soFar += forms[k]!.drawn;
        const w = opts.measureRun(soFar, style);
        kerned[k] = w - prev;
        prev = w;
      }
      i = end;
    }
  }

  const mul = base.lineHeight ?? AUTO_LEADING;
  let leading = (base.fontSize || 0) * mul;

  // Pass 1 — units, per paragraph.
  const paragraphs: Unit[][] = [[]];
  for (let i = 0; i < n; i++) {
    const char = chars[i]!;
    if (isLineBreak(char)) {
      paragraphs.push([]);
      continue;
    }
    const para = paragraphs[paragraphs.length - 1]!;
    const style = styleAt(i);
    const gs = glyphStyleScale(style);
    const ls = style.letterSpacing ?? 0;
    const em = style.fontSize * gs.sy;
    leading = Math.max(leading, style.fontSize * mul);

    if (tcyEnd[i]! > i) {
      const end = tcyEnd[i]!;
      const members: Member[] = [];
      let width = 0;
      let tracking = 0;
      let logical = '';
      for (let k = i; k < end; k++) {
        const s = styleAt(k);
        const d = drawnAt(k);
        const w = measure(d, s) * glyphStyleScale(s).sx;
        members.push({ char: chars[k]!, drawn: d, index: k, style: s, transform: opts.transforms?.[k], form: forms[k]!, inkWidth: w });
        width += w;
        tracking += opts.transforms?.[k]?.tracking ?? 0;
        logical += chars[k]!;
        leading = Math.max(leading, s.fontSize * mul);
      }
      const scale = width > style.fontSize && width > 0 ? style.fontSize / width : 1;
      para.push({
        members,
        text: logical,
        advance: em + ls + tracking,
        tcy: { width, scale, em },
        space: false,
        ideographic: isIdeographicUnit(logical),
      });
      i = end - 1;
      continue;
    }

    const form = forms[i]!;
    const transform = opts.transforms?.[i];
    const own = measure(form.drawn, style) * gs.sx;
    let advance = form.upright
      ? em + ls
      : (kerned[i] ?? measure(form.drawn, style) + ls) * gs.sx;
    advance += transform?.tracking ?? 0;
    para.push({
      members: [{ char, drawn: form.drawn, index: i, style, transform, form, inkWidth: form.upright ? em : own }],
      text: char,
      advance,
      space: isBreakSpace(form.drawn),
      ideographic: isIdeographicUnit(char),
    });
  }

  // Pass 2 — columns. Box text wraps each paragraph by the column length.
  const limit = opts.columnLimit !== undefined && opts.columnLimit > 0 ? opts.columnLimit : undefined;
  const columns: Unit[][] = [];
  const softEnd: boolean[] = [];
  for (const para of paragraphs) {
    const breaks = limit !== undefined && para.length > 1
      ? wrapUnits(para.map((u) => u.text), para.map((u) => u.advance), limit)
      : [];
    let from = 0;
    for (const b of breaks) {
      columns.push(para.slice(from, b));
      softEnd.push(true);
      from = b;
    }
    columns.push(para.slice(from));
    softEnd.push(false);
  }

  // Optical kerning sits between two units of the same column too: sideways
  // pairs (rotated Latin) along their run, upright pairs down the column.
  if (opts.opticalKern || opts.opticalKernVertical) {
    for (const col of columns) {
      for (let j = 0; j < col.length - 1; j++) {
        const u = col[j]!;
        const v = col[j + 1]!;
        if (u.tcy || v.tcy) continue;
        const a = u.members[0]!;
        const b = v.members[0]!;
        if (a.drawn.trim() === '' || b.drawn.trim() === '') continue;
        if (!a.form.upright && !b.form.upright) {
          if (opts.opticalKern) u.advance += opts.opticalKern(a.drawn, a.style, b.drawn, b.style) * glyphStyleScale(a.style).sx;
        } else if (a.form.upright && b.form.upright && opts.opticalKernVertical) {
          u.advance += opts.opticalKernVertical(a.drawn, a.style, b.drawn, b.style, { upper: !!a.form.alternate, lower: !!b.form.alternate })
            * glyphStyleScale(a.style).sy;
        }
      }
    }
  }

  // Manual kerning sits between two units of the same column.
  for (const col of columns) {
    for (let j = 0; j < col.length - 1; j++) {
      const last = col[j]!.members[col[j]!.members.length - 1]!;
      const k = last.style.kerning;
      if (k) col[j]!.advance += (k / 1000) * last.style.fontSize;
    }
  }
  const lens = columns.map((col) => col.reduce((s, u) => s + u.advance, 0));

  const hardEnds = hardEndsOf(columns.length, softEnd.flatMap((s, i) => (s ? [i] : [])));
  const { offsets, total } = lineOffsets(hardEnds, leading + (base.paragraphSpacing ?? 0), base.spaceBefore, base.spaceAfter);
  const padX = opts.padX ?? 0;
  const firstX = limit !== undefined ? opts.boxWidth / 2 - padX - leading / 2 : total / 2;
  const maxLen = lens.reduce((m, l) => Math.max(m, l), 0);
  const span = limit ?? maxLen;
  const ra = resolveAlign(base.align);

  const glyphs: VerticalGlyph[] = [];
  const lines: LineBox[] = [];
  let visible = columns.length;
  if (limit !== undefined) {
    const leftEdge = -opts.boxWidth / 2 + padX;
    visible = 0;
    for (let c = 0; c < columns.length; c++) {
      if (firstX - offsets[c]! - leading / 2 >= leftEdge - 0.5) visible = c + 1;
      else break;
    }
  }

  for (let c = 0; c < columns.length; c++) {
    const col = columns[c]!;
    let lastInk = col.length - 1;
    while (lastInk >= 0 && col[lastInk]!.space) lastInk--;
    // A soft-broken column's trailing spaces hang past its end.
    let len = lens[c]!;
    if (softEnd[c]) for (let j = lastInk + 1; j < col.length; j++) len -= col[j]!.advance;

    // Justification: soft-broken box columns (and, for Justify All, every
    // column) stretch to the column length — between CJK characters, or at
    // the word spaces of a Latin column.
    const stretchAfter = new Set<number>();
    let extra = 0;
    if (limit !== undefined && ra.justify && (softEnd[c] || ra.justifyLast) && limit > len + 1e-9) {
      const cjk = col.some((u) => u.ideographic);
      // Around CJK units and at word spaces — never between the letters of a
      // sideways Latin word, which is drawn as one string (textPaint.groupVertical).
      for (let j = 0; j < lastInk; j++) {
        const u = col[j]!;
        if (u.space || (cjk && (u.ideographic || col[j + 1]!.ideographic))) stretchAfter.add(j);
      }
      if (stretchAfter.size > 0) extra = (limit - len) / stretchAfter.size;
    }
    const stretched = extra > 0;
    const colLen = stretched ? limit! : len;

    const x = firstX - offsets[c]!;
    const top = stretched || ra.line === 'left' ? -span / 2 : ra.line === 'center' ? -colLen / 2 : span / 2 - colLen;
    let pen = top;
    for (let j = 0; j < col.length; j++) {
      const u = col[j]!;
      const ex = stretchAfter.has(j) ? extra : 0;
      if (u.tcy) {
        const first = u.members[0]!;
        const gs = glyphStyleScale(first.style);
        const cy = pen + (first.transform?.trackingBefore ?? 0) + u.tcy.em / 2;
        let cum = 0;
        u.members.forEach((m, k) => {
          glyphs.push({
            char: m.char,
            index: m.index,
            x: x - gs.dy + (cum + m.inkWidth / 2 - u.tcy!.width / 2) * u.tcy!.scale,
            y: cy,
            advance: k === 0 ? u.advance + ex : 0,
            inkWidth: m.inkWidth * u.tcy!.scale,
            style: m.style,
            line: c,
            transform: m.transform,
            ...(m.drawn !== m.char ? { drawn: m.drawn } : {}),
            tcy: { start: first.index, scale: u.tcy!.scale },
          });
          cum += m.inkWidth;
        });
      } else {
        const g = u.members[0]!;
        const gs = glyphStyleScale(g.style);
        const upright = g.form.upright;
        const body = upright ? g.style.fontSize * gs.sy : g.inkWidth;
        const corner = g.form.corner ? g.style.fontSize : 0;
        glyphs.push({
          char: g.char,
          index: g.index,
          // A baseline shift raises a sideways glyph toward the column's right.
          x: x - gs.dy + corner * 0.5,
          y: pen + (g.transform?.trackingBefore ?? 0) + body / 2 - corner * 0.5,
          advance: u.advance + ex,
          inkWidth: g.inkWidth,
          style: g.style,
          line: c,
          transform: g.transform,
          ...(upright ? {} : { angle: SIDEWAYS_ANGLE }),
          ...(g.drawn !== g.char ? { drawn: g.drawn } : {}),
          ...(g.form.alternate ? { vertAlternate: true as const } : {}),
        });
      }
      pen += u.advance + ex;
    }
    lines.push({ width: colLen, y: top, left: x, ...(stretched ? { spaceExtra: extra } : {}) });
  }

  return {
    glyphs,
    lines,
    width: total + leading,
    height: maxLen,
    ...(limit !== undefined ? { visibleLines: visible } : {}),
  };
}
