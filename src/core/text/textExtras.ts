/**
 * The After Effects paragraph + character options that ride alongside the
 * core text fields: indents, space before/after, justification, faux
 * bold/italic, stroke line join and order, "none" fill/stroke swatches and
 * the kerning mode.
 *
 * They travel from the node to the painter as ONE optional object
 * (`RenderLayer.textExtras` → `TextSpec.textExtras`) rather than a dozen new
 * top-level fields, so the seams between buildSnapshot, the backend and the
 * texture cache key each gained one term instead of twelve. It is emitted only
 * when something in it differs from the default, so a layer that uses none of
 * these keeps a byte-identical cache key and render.
 *
 * This module is pure (no canvas). The paragraph geometry here — where a line
 * starts, how much a justified space grows, how far apart baselines sit — is
 * the ONE copy shared by the whole-string fast path in textPaint and the
 * per-glyph `layoutText`, which is what keeps the two paths on the same pixels.
 */

import type { SceneNode } from '@core/types';
import type { FillPaint, LinearFill, RadialFill } from '@core/paint/fill';
import { paragraphLevelOf } from './bidi';

/** Horizontal render padding each side of a text box, px. `measureText`'s
 *  render box adds it; the painter insets left/right-aligned text by it. */
export const TEXT_PAD_X = 12;

/** AE's "Auto" leading: 120% of the font size. */
export const AUTO_LEADING = 1.2;

/** Faux bold: a fill-coloured stroke of this fraction of the font size is
 *  painted under the fill, thickening the glyph without changing its advance. */
export const FAUX_BOLD_STROKE_RATIO = 1 / 30;

/** Faux italic: a synthetic shear of this many degrees. */
export const FAUX_ITALIC_ANGLE_DEG = 12;
export const FAUX_ITALIC_SKEW = Math.tan((FAUX_ITALIC_ANGLE_DEG * Math.PI) / 180);

export type StrokeLineJoin = 'miter' | 'round' | 'bevel';
export type KerningMode = 'metrics' | 'optical';
/**
 * AE's Fill & Stroke order. The first two are PER CHARACTER (each glyph's
 * stroke and fill are painted together); the last two paint every stroke in
 * the layer first (or last), so neighbouring glyphs' strokes never cover
 * each other's fills (or always do).
 */
export type StrokeOrder =
  | 'fill-over-stroke'
  | 'stroke-over-fill'
  | 'all-fills-over-all-strokes'
  | 'all-strokes-over-all-fills';

export const STROKE_ORDERS: ReadonlyArray<{ value: StrokeOrder; label: string }> = [
  { value: 'fill-over-stroke', label: 'Fill Over Stroke' },
  { value: 'stroke-over-fill', label: 'Stroke Over Fill' },
  { value: 'all-fills-over-all-strokes', label: 'All Fills Over All Strokes' },
  { value: 'all-strokes-over-all-fills', label: 'All Strokes Over All Fills' },
];

export interface TextExtras {
  /** Paragraph indents, px (paragraph/box text). */
  leftIndent?: number;
  rightIndent?: number;
  /** Offset of each paragraph's first line, px. Negative = hanging indent. */
  firstLineIndent?: number;
  /** Vertical gap added before / after each paragraph (hard newline), px. */
  spaceBefore?: number;
  spaceAfter?: number;
  /**
   * Present ONLY for paragraph (box) text: the line numbers of the WRAPPED
   * text that end in a soft wrap rather than a hard newline. Justification
   * stretches those lines; every other line is a paragraph's last line.
   */
  softBreakLines?: number[];
  strokeLineJoin?: StrokeLineJoin;
  strokeOrder?: StrokeOrder;
  fauxBold?: boolean;
  fauxItalic?: boolean;
  /** AE's "none" swatches. */
  noFill?: boolean;
  noStroke?: boolean;
  kerningMode?: KerningMode;
  /**
   * Paragraph box with a FIXED height (AE's box text), px. Lines are placed in
   * the box per `boxVerticalAlign` and a line that does not fully fit is not
   * drawn (overflow). Absent = auto height, the behaviour every document had
   * before box heights existed.
   */
  boxHeight?: number;
  /** Vertical alignment inside a fixed box. Absent = top (AE's default). */
  boxVerticalAlign?: 'center' | 'bottom';
  /** "Fit Text to Box": the render-time type scale (< 1) that makes the text fit. */
  fitScale?: number;
  // ── Text ▸ More Options (textMoreOptions.ts) — absent at their defaults ──
  /** Anchor Point Grouping; absent = character. */
  anchorGrouping?: 'word' | 'line' | 'all';
  /** Grouping Alignment, % of the group box [x, y]; absent = [0, 0]. */
  groupingAlign?: [number, number];
  /** Fill & Stroke "All Characters As One"; absent = per character palette. */
  fillStrokeMode?: 'allAsOne';
  /** Inter-Character Blending mode value; absent = normal. */
  interCharacterBlending?: string;
  /** Standard ligatures OFF (they are on by default, as in AE). */
  ligatures?: false;
  /** OpenType features (Character panel ▸ OpenType), absent at defaults. */
  discretionaryLigatures?: true;
  contextualAlternates?: false;
  stylisticSets?: number[];
  // ── Direction and orientation (AE Paragraph panel / Vertical Type Tool) ──
  /** Paragraph direction: right-to-left, or 'auto' — each paragraph takes the
   *  direction of its first strong character (UAX #9 P2/P3). Absent = LTR. */
  direction?: 'rtl' | 'auto';
  /** Vertical type (columns top→bottom, right→left); absent = horizontal. */
  orientation?: 'vertical';
  /** Standard Vertical Roman Alignment: Latin / digits upright in vertical
   *  type. Absent = rotated sideways (AE's default). Only kept when vertical. */
  verticalRomanAlignment?: true;
  /** Auto tate-chu-yoko: runs of up to this many ASCII digits are set
   *  horizontally in a vertical column. Absent = off. Only kept when vertical. */
  tateChuYokoDigits?: number;
  /**
   * An AUTO-HEIGHT paragraph box's content offset, px (+y down): the box keeps
   * its authored TOP edge while the text grows or shrinks, so the line block
   * (centred on the layer origin by construction) is drawn this far down.
   * Absent = 0 — every box without an authored height, and all point text.
   */
  boxOffsetY?: number;
}

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const JOINS: ReadonlySet<string> = new Set(['miter', 'round', 'bevel']);
const ORDERS: ReadonlySet<string> = new Set(STROKE_ORDERS.map((o) => o.value));

/** The extras written on a node's components (later components win). */
export function readTextExtrasProps(node: SceneNode): TextExtras {
  const out: TextExtras = {};
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    for (const k of ['leftIndent', 'rightIndent', 'firstLineIndent', 'spaceBefore', 'spaceAfter'] as const) {
      const v = finite(p[k]);
      if (v !== undefined) out[k] = v;
    }
    if (typeof p.strokeLineJoin === 'string' && JOINS.has(p.strokeLineJoin)) out.strokeLineJoin = p.strokeLineJoin as StrokeLineJoin;
    if (typeof p.strokeOrder === 'string' && ORDERS.has(p.strokeOrder)) out.strokeOrder = p.strokeOrder as StrokeOrder;
    if (typeof p.fauxBold === 'boolean') out.fauxBold = p.fauxBold;
    if (typeof p.fauxItalic === 'boolean') out.fauxItalic = p.fauxItalic;
    if (typeof p.noFill === 'boolean') out.noFill = p.noFill;
    if (typeof p.noStroke === 'boolean') out.noStroke = p.noStroke;
    if (p.kerningMode === 'metrics' || p.kerningMode === 'optical') out.kerningMode = p.kerningMode;
    const dir = readParagraphDirection(p.direction);
    if (dir) out.direction = dir;
    else if (p.direction === 'ltr') delete out.direction;
    if (p.orientation === 'vertical') out.orientation = 'vertical';
    else if (p.orientation === 'horizontal') delete out.orientation;
    if (typeof p.verticalRomanAlignment === 'boolean') {
      if (p.verticalRomanAlignment) out.verticalRomanAlignment = true;
      else delete out.verticalRomanAlignment;
    }
    if (typeof p.tateChuYokoAuto === 'boolean') {
      if (p.tateChuYokoAuto) out.tateChuYokoDigits = out.tateChuYokoDigits ?? TATE_CHU_YOKO_DEFAULT_DIGITS;
      else delete out.tateChuYokoDigits;
    }
    if (out.tateChuYokoDigits !== undefined && typeof p.tateChuYokoDigits === 'number' && Number.isFinite(p.tateChuYokoDigits)) {
      out.tateChuYokoDigits = Math.max(1, Math.min(4, Math.round(p.tateChuYokoDigits)));
    }
  }
  return out;
}

/** AE's auto tate-chu-yoko default digit count. */
export const TATE_CHU_YOKO_DEFAULT_DIGITS = 2;

/** A text layer's stroke GRADIENT (`strokePaint` on the Text component), or
 *  undefined for a solid stroke — the colour in `stroke` already carries that. */
export function readTextStrokePaint(node: SceneNode): LinearFill | RadialFill | undefined {
  for (const c of node.components) {
    if (c.type !== 'Text') continue;
    const p = (c.props as Record<string, unknown>).strokePaint as FillPaint | undefined;
    if (p && (p.type === 'linear' || p.type === 'radial') && Array.isArray(p.stops) && p.stops.length > 0) return p;
    return undefined;
  }
  return undefined;
}

/** Drop default-valued fields; undefined when nothing is left. */
export function compactTextExtras(x: TextExtras): TextExtras | undefined {
  const out: TextExtras = {};
  if (x.leftIndent) out.leftIndent = x.leftIndent;
  if (x.rightIndent) out.rightIndent = x.rightIndent;
  if (x.firstLineIndent) out.firstLineIndent = x.firstLineIndent;
  if (x.spaceBefore) out.spaceBefore = x.spaceBefore;
  if (x.spaceAfter) out.spaceAfter = x.spaceAfter;
  if (x.softBreakLines) out.softBreakLines = x.softBreakLines;
  if (x.strokeLineJoin && x.strokeLineJoin !== 'round') out.strokeLineJoin = x.strokeLineJoin;
  if (x.strokeOrder) out.strokeOrder = x.strokeOrder;
  if (x.fauxBold) out.fauxBold = true;
  if (x.fauxItalic) out.fauxItalic = true;
  if (x.noFill) out.noFill = true;
  if (x.noStroke) out.noStroke = true;
  if (x.kerningMode === 'optical') out.kerningMode = 'optical';
  if (x.boxHeight && x.boxHeight > 0) out.boxHeight = x.boxHeight;
  if (x.boxHeight && (x.boxVerticalAlign === 'center' || x.boxVerticalAlign === 'bottom')) out.boxVerticalAlign = x.boxVerticalAlign;
  if (x.fitScale !== undefined && x.fitScale > 0 && x.fitScale < 1) out.fitScale = x.fitScale;
  if (x.direction === 'rtl' || x.direction === 'auto') out.direction = x.direction;
  if (x.orientation === 'vertical') {
    out.orientation = 'vertical';
    if (x.verticalRomanAlignment) out.verticalRomanAlignment = true;
    if (x.tateChuYokoDigits && x.tateChuYokoDigits >= 1) out.tateChuYokoDigits = x.tateChuYokoDigits;
  }
  if (x.boxOffsetY && Number.isFinite(x.boxOffsetY) && Math.abs(x.boxOffsetY) > 1e-6) out.boxOffsetY = x.boxOffsetY;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Lines of `wrapped` that end in a SOFT break.
 *
 * `wrapText` replaces the space it breaks at with '\n' one-for-one, so the raw
 * and wrapped strings have the same length and every position where they
 * differ is a soft wrap. CJK text breaks between characters with no space to
 * replace, so there the break is INSERTED and the wrapped string is longer:
 * a '\n' with no '\n' or ' ' under it in the raw string is an inserted soft
 * break. If the wrapped string is shorter (it never should be), every break
 * is treated as hard — the safe reading, which never justifies.
 */
export function softBreakLines(raw: string, wrapped: string): number[] {
  const out: number[] = [];
  if (raw.length > wrapped.length) return out;
  if (raw.length < wrapped.length) {
    let i = 0;
    let ln = 0;
    for (let j = 0; j < wrapped.length; j++) {
      if (wrapped.charCodeAt(j) !== 10) { i++; continue; }
      const r = raw.charCodeAt(i);
      if (r === 10) i++;
      else {
        out.push(ln);
        if (r === 32) i++;
      }
      ln++;
    }
    return out;
  }
  let line = 0;
  for (let i = 0; i < wrapped.length; i++) {
    if (wrapped.charCodeAt(i) !== 10) continue;
    if (raw.charCodeAt(i) !== 10) out.push(line);
    line++;
  }
  return out;
}

/**
 * A node's extras for a frame.
 *
 * `softBreaks` is given for paragraph text: either the soft-wrap line numbers
 * or the unwrapped + wrapped content to derive them from. They are carried
 * only when something reads them — a justify alignment, an indent or
 * paragraph spacing — so a plain paragraph layer keeps its exact cache key.
 */
export function textExtrasForNode(
  node: SceneNode,
  softBreaks?: ReadonlyArray<number> | { raw: string; wrapped: string },
  /** The measured paragraph style, for its fit-to-box scale; and the auto-height
   *  box's top-anchor offset (`measureParagraphBox(...).lineOffsetY`). */
  fit?: { fitScale?: number; boxOffsetY?: number },
): TextExtras | undefined {
  const x = readTextExtrasProps(node);
  if (softBreaks && paragraphNeedsLines(node, x)) {
    x.softBreakLines = 'raw' in softBreaks
      ? softBreakLines(softBreaks.raw, softBreaks.wrapped)
      : [...(softBreaks as ReadonlyArray<number>)];
  }
  const box = readParagraphBox(node);
  if (box && box.fixedHeight) {
    x.boxHeight = box.boxHeight;
    if (box.verticalAlign !== 'top') x.boxVerticalAlign = box.verticalAlign;
    if (box.autoSize === 'fit' && fit?.fitScale !== undefined) x.fitScale = fit.fitScale;
  } else if (box && box.boxHeight > 0 && fit?.boxOffsetY) {
    x.boxOffsetY = fit.boxOffsetY;
  }
  return compactTextExtras(x);
}

function paragraphNeedsLines(node: SceneNode, x: TextExtras): boolean {
  let align = '';
  for (const c of node.components) {
    const a = (c.props as Record<string, unknown>).align;
    if (typeof a === 'string') align = a;
  }
  return (
    align.startsWith('justify') ||
    !!x.leftIndent || !!x.rightIndent || !!x.firstLineIndent || !!x.spaceBefore || !!x.spaceAfter ||
    // Bidi resolves per PARAGRAPH: a soft wrap is not a paragraph boundary.
    x.direction === 'rtl' || x.direction === 'auto'
  );
}

// ── Paragraph direction ─────────────────────────────────────────────

/** The stored direction prop, when it is one of the bidi values ('ltr' = absent). */
export function readParagraphDirection(v: unknown): 'rtl' | 'auto' | undefined {
  return v === 'rtl' || v === 'auto' ? v : undefined;
}

/**
 * The ONE reading of a paragraph's direction. 'rtl' is RTL; 'auto' is the
 * direction of the paragraph's first strong character (UAX #9 P2/P3, LTR when
 * it has none — AE's paragraph direction in RTL-enabled setups); anything else
 * (absent, 'ltr', unknown) is LTR, so every older document reads as it did.
 * `paragraphText` is ONE paragraph (text between hard breaks); for a consumer
 * that needs a single answer for a whole layer, pass the first paragraph
 * ({@link firstParagraphDirection}).
 */
export function resolveParagraphDirection(direction: unknown, paragraphText: string): 'ltr' | 'rtl' {
  if (direction === 'rtl') return 'rtl';
  if (direction === 'auto') return paragraphLevelOf(paragraphText) === 1 ? 'rtl' : 'ltr';
  return 'ltr';
}

/** `resolveParagraphDirection` for the first paragraph of `text`. */
export function firstParagraphDirection(direction: unknown, text: string | undefined): 'ltr' | 'rtl' {
  if (direction !== 'auto') return resolveParagraphDirection(direction, '');
  const t = text ?? '';
  const nl = t.search(/\r\n|\n|\r/);
  return resolveParagraphDirection(direction, nl < 0 ? t : t.slice(0, nl));
}

/** Resolve the Fill & Stroke order, honouring the legacy boolean. */
export function strokeOrderOf(order: StrokeOrder | undefined, strokeOverFill: boolean | undefined): StrokeOrder {
  return order ?? (strokeOverFill ? 'stroke-over-fill' : 'fill-over-stroke');
}

// ── Paragraph geometry (shared by both draw paths) ───────────────────

export type LineAlign = 'left' | 'center' | 'right';

export interface ResolvedAlign {
  /** How a line that is NOT justified sits in its frame. */
  line: LineAlign;
  /** A justify variant — soft-wrapped lines of box text stretch to the frame. */
  justify: boolean;
  /** 'justify-all' — the paragraph's last line stretches too. */
  justifyLast: boolean;
}

/**
 * The Paragraph panel's seven alignments. Legacy 'justify' reads as AE's
 * "Justify Last Left". Unknown values fall back to left, as they always did.
 */
export function resolveAlign(align: string | undefined): ResolvedAlign {
  switch (align) {
    case 'center': return { line: 'center', justify: false, justifyLast: false };
    case 'right': return { line: 'right', justify: false, justifyLast: false };
    case 'justify':
    case 'justify-left': return { line: 'left', justify: true, justifyLast: false };
    case 'justify-center': return { line: 'center', justify: true, justifyLast: false };
    case 'justify-right': return { line: 'right', justify: true, justifyLast: false };
    case 'justify-all': return { line: 'left', justify: true, justifyLast: true };
    default: return { line: 'left', justify: false, justifyLast: false };
  }
}

/** Word spaces a justified line may stretch. */
export function isJustifiableSpace(cluster: string): boolean {
  return cluster === ' ' || cluster === ' ' || cluster === '　';
}

export interface ParagraphFrame {
  /** Full render box width, px. The box is centred on x = 0. */
  boxWidth: number;
  /** Inset from each box edge, px. */
  padX: number;
  /** Paragraph (box) text. Point text has no frame to justify or indent in. */
  boxText: boolean;
  align?: string;
  leftIndent?: number;
  rightIndent?: number;
  firstLineIndent?: number;
  /** 'rtl' mirrors the default alignment and the indents. */
  direction?: 'ltr' | 'rtl';
}

/**
 * How a line sits for `align` under `direction`. Right-to-left paragraphs
 * read the stored alignment from the START edge, as AE does: a layer with no
 * alignment (left) sits on the right, Justify Last Left ends on the right,
 * and so on. Centre is centre either way.
 */
export function resolveAlignForDirection(align: string | undefined, direction: 'ltr' | 'rtl' | undefined): ResolvedAlign {
  const a = resolveAlign(align);
  if (direction !== 'rtl' || a.line === 'center') return a;
  return { ...a, line: a.line === 'left' ? 'right' : 'left' };
}

export interface LineFacts {
  /** Natural width of the line, px. */
  width: number;
  /** Justifiable spaces, EXCLUDING trailing ones. */
  spaces: number;
  /** The line ends a paragraph (hard newline or end of text). */
  hardEnd: boolean;
  /** The line starts a paragraph. */
  paragraphStart: boolean;
}

export interface LinePlacement {
  /** Pen x where the line's first glyph starts (centre-origin). */
  left: number;
  /** The x a `textAlign = lineAlign` draw anchors at. */
  anchor: number;
  lineAlign: LineAlign;
  /** Extra px added after each justifiable (non-trailing) space. */
  spaceExtra: number;
}

/**
 * Where a line starts and how much its spaces stretch.
 *
 * Indents apply to paragraph text only: point text's box is derived from its
 * content, so an indent would push glyphs out of their own texture.
 */
export function placeLine(line: LineFacts, frame: ParagraphFrame): LinePlacement {
  const rtl = frame.direction === 'rtl';
  const a = resolveAlignForDirection(frame.align, frame.direction);
  const halfW = frame.boxWidth / 2;
  // Indents are START / END margins: in a right-to-left paragraph the "left"
  // indent and the first-line indent sit on the right edge.
  const startIndent = frame.boxText
    ? (frame.leftIndent ?? 0) + (line.paragraphStart ? frame.firstLineIndent ?? 0 : 0)
    : 0;
  const endIndent = frame.boxText ? frame.rightIndent ?? 0 : 0;
  const indentL = rtl ? endIndent : startIndent;
  const indentR = rtl ? startIndent : endIndent;
  const L = -halfW + frame.padX + indentL;
  const R = halfW - frame.padX - indentR;

  const stretch =
    frame.boxText && a.justify && (!line.hardEnd || a.justifyLast) && line.spaces > 0 && R - L > line.width;
  if (stretch) {
    return { left: L, anchor: L, lineAlign: 'left', spaceExtra: (R - L - line.width) / line.spaces };
  }
  if (a.line === 'center') {
    const anchor = (L + R) / 2;
    return { left: anchor - line.width / 2, anchor, lineAlign: 'center', spaceExtra: 0 };
  }
  if (a.line === 'right') return { left: R - line.width, anchor: R, lineAlign: 'right', spaceExtra: 0 };
  return { left: L, anchor: L, lineAlign: 'left', spaceExtra: 0 };
}

/**
 * Baseline offsets from the first line, and the first-to-last distance.
 *
 * `baseGap` (leading + legacy paragraphSpacing) separates every line, as it
 * always has. Space before/after is added only across a HARD break — between
 * paragraphs — never at a soft wrap and never above the first paragraph.
 * With both zero this is exactly `i × baseGap`, the arithmetic every text
 * layer used before, to the bit.
 */
export function lineOffsets(
  hardEnds: ReadonlyArray<boolean>,
  baseGap: number,
  spaceBefore = 0,
  spaceAfter = 0,
): { offsets: number[]; total: number } {
  const n = Math.max(1, hardEnds.length);
  const offsets: number[] = new Array(n);
  const para = (spaceBefore || 0) + (spaceAfter || 0);
  let extra = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && para !== 0 && hardEnds[i - 1]) extra += para;
    offsets[i] = i * baseGap + extra;
  }
  return { offsets, total: offsets[n - 1]! };
}

/**
 * Which lines of `lineCount` end a paragraph, given soft-wrap line numbers.
 * Without `soft` (point text) every line does.
 */
export function hardEndsOf(lineCount: number, soft: ReadonlyArray<number> | undefined): boolean[] {
  const set = new Set(soft ?? []);
  return Array.from({ length: lineCount }, (_, i) => i === lineCount - 1 || !set.has(i));
}

// ── Paragraph box (AE box text: height, auto-size, vertical alignment) ──

/**
 * AE's box sizing:
 *   • 'off'    — a fixed box; text past its bottom is clipped (overflow);
 *   • 'height' — the box grows and shrinks vertically with the text (AE 2024's
 *                auto-size text box). Also what a box with no height means, so
 *                every document written before box heights stays unchanged;
 *   • 'fit'    — a fixed box; the type is scaled down uniformly until it fits.
 *                A RENDER-time scale — the authored font size is untouched.
 */
export type BoxAutoSize = 'off' | 'height' | 'fit';
export type BoxVerticalAlign = 'top' | 'center' | 'bottom';

export interface ParagraphBoxProps {
  boxWidth: number;
  /** Authored height, 0 when none. */
  boxHeight: number;
  autoSize: BoxAutoSize;
  verticalAlign: BoxVerticalAlign;
  /** The box height is authored and in force (not auto height). */
  fixedHeight: boolean;
}

/** Smallest box a drag or conversion may produce, px. */
export const MIN_BOX_SIZE = 16;

/** The layer rides a mask path (Path Options ▸ Path is set). */
export function hasTextPath(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
  return !!fx?.textPath && typeof fx.textPath === 'object';
}

/**
 * The paragraph-box props of a text node, or null for point text.
 *
 * Text on a PATH is point text (AE lays path text as one run along the path;
 * a box has nothing to hold), so a layer with a text path reads as having no
 * box — no box height, fit or vertical alignment reaches the painter, no box
 * handles show, and the stored box props come back untouched when the path is
 * removed. (Its authored width still wraps the content, as before.)
 */
export function readParagraphBox(node: SceneNode, override?: Record<string, unknown>): ParagraphBoxProps | null {
  if (hasTextPath(node)) return null;
  let boxWidth = 0;
  let boxHeight = 0;
  let autoSize: BoxAutoSize | undefined;
  let verticalAlign: BoxVerticalAlign = 'top';
  const read = (p: Record<string, unknown>): void => {
    if (typeof p.boxWidth === 'number' && Number.isFinite(p.boxWidth)) boxWidth = p.boxWidth;
    if (typeof p.boxHeight === 'number' && Number.isFinite(p.boxHeight)) boxHeight = p.boxHeight;
    if (p.boxAutoSize === 'off' || p.boxAutoSize === 'height' || p.boxAutoSize === 'fit') autoSize = p.boxAutoSize;
    if (p.boxVerticalAlign === 'top' || p.boxVerticalAlign === 'center' || p.boxVerticalAlign === 'bottom') {
      verticalAlign = p.boxVerticalAlign;
    }
  };
  for (const c of node.components) read(c.props as Record<string, unknown>);
  if (override) read(override);
  if (!(boxWidth > 0)) return null;
  // A height with no mode is a fixed box; no height is auto height, whatever
  // the mode says (there is nothing to clip to or fit into).
  const resolved: BoxAutoSize = boxHeight > 0 ? autoSize ?? 'off' : 'height';
  return {
    boxWidth,
    boxHeight: boxHeight > 0 ? boxHeight : 0,
    autoSize: resolved,
    verticalAlign,
    fixedHeight: resolved !== 'height',
  };
}

export interface BoxLinePlacement {
  /** Offset added to every line's centre-origin baseline. */
  dy: number;
  /** Lines drawn: the first `visible` lines; the rest overflow. */
  visible: number;
  /** Some text does not fit the box. */
  overflow: boolean;
}

/** Slack for float noise when deciding whether a line fits, px. */
const BOX_FIT_EPS = 0.5;

/**
 * Where lines sit in a fixed paragraph box, and which of them fit.
 *
 * `lineYs` are the centre-origin `middle` baselines both draw paths already
 * produce (lines stacked about y = 0). `lineHeightPx` is each line's line box:
 * one leading for every line, or — when character runs give lines their own
 * leading — one per line (`TextLayout.lineLeading` / `paragraphLineMetrics`).
 * A line fits when its whole line box lies inside the box — AE draws no
 * partial line. When the text overflows, vertical alignment yields to TOP so
 * the beginning of the text is what stays visible.
 *
 * The ONE copy used by the painter (what is drawn) and the measurer (the
 * overflow flag the viewport shows), so they cannot disagree.
 */
export function placeLinesInBox(
  lineYs: ReadonlyArray<number>,
  lineHeightPx: number | ReadonlyArray<number>,
  boxHeight: number,
  verticalAlign: BoxVerticalAlign | undefined,
): BoxLinePlacement {
  const n = lineYs.length;
  if (n === 0) return { dy: 0, visible: 0, overflow: false };
  const lh = (i: number): number => (typeof lineHeightPx === 'number' ? lineHeightPx : lineHeightPx[i] ?? lineHeightPx[lineHeightPx.length - 1] ?? 0);
  const half = boxHeight / 2;
  const top = lineYs[0]! - lh(0) / 2;
  const bottom = lineYs[n - 1]! + lh(n - 1) / 2;
  const overflow = bottom - top > boxHeight + BOX_FIT_EPS;
  let dy: number;
  if (overflow || !verticalAlign || verticalAlign === 'top') dy = -half - top;
  else if (verticalAlign === 'center') dy = -(top + bottom) / 2;
  else dy = half - bottom;
  let visible = 0;
  for (let i = 0; i < n; i++) {
    if (lineYs[i]! + dy + lh(i) / 2 <= half + BOX_FIT_EPS) visible = i + 1;
    else break;
  }
  return { dy, visible, overflow };
}

/** The centre-origin baselines `lineOffsets` produces, as `placeLinesInBox` takes them. */
export function centredLineYs(offsets: ReadonlyArray<number>, total: number): number[] {
  return offsets.map((o) => o - total / 2);
}
