/**
 * Shared text layout — the single source of truth for where every glyph sits.
 *
 * Both backends used to lay text out for themselves: `Canvas2DBackend`'s text
 * case and `AppTextureProvider.rasterizeText` were parallel copies of the same
 * line-split / align / lineHeight arithmetic, kept in agreement by convention
 * and one test comment. That was survivable while a layer had exactly one font,
 * but per-character runs multiply every decision by the number of runs, and two
 * copies of that is two chances to disagree. So the arithmetic lives here once
 * and both backends ask this module where the glyphs go.
 *
 * The module is pure: it never touches a canvas. Measurement is injected as a
 * `MeasureGlyph` callback, so layout is unit-testable with a fake metric (and
 * jsdom, which has no real text metrics, can still exercise every branch).
 *
 * Coordinate space matches `Canvas2DBackend`: the layer box is centred on
 * (0, 0), +x right, +y down, and `y` is a `textBaseline: 'middle'` baseline.
 * `rasterizeText` draws in top-left box space and offsets by half the box.
 *
 * Characters are GRAPHEME CLUSTERS (`splitGraphemes`), not code points — see
 * graphemes.ts. Paragraph geometry (alignment, justification, indents, space
 * before/after) comes from textExtras.ts, which the whole-string fast path in
 * textPaint also uses; `planWholeStringLines` below is that fast path's plan,
 * kept here so a unit test can hold the two paths to identical x positions.
 */

import type { GlyphTransform } from './textAnimators';
import { splitGraphemes, isLineBreak } from './graphemes';
import { clusterBidi, clusterLevels, hasStrongRtl, resetLineEnd, visualOrder } from './bidi';
import { isIdeographicUnit } from './lineBreak';
import {
  AUTO_LEADING,
  hardEndsOf,
  isJustifiableSpace,
  lineOffsets,
  placeLine,
  type KerningMode,
  type LineAlign,
  resolveParagraphDirection,
  type ParagraphFrame,
} from './textExtras';

/** Everything that can vary per character. */
export interface TextStyle {
  fontSize: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  /** Extra advance after each glyph, px. */
  letterSpacing?: number;
  /** Glyph colour. Layer-wide `fill` is the default; a run may override it. */
  fill?: string;
  /**
   * Manual kerning AFTER this character, in 1/1000 em — AE's kerning field.
   * Applied between this glyph and the next one on the same line, so a value
   * on the last character of a line changes nothing.
   */
  kerning?: number;
  /** Synthetic bold: a fill-coloured stroke under the fill (no advance change). */
  fauxBold?: boolean;
  /** Synthetic italic: a shear, independent of the font's own italic. */
  fauxItalic?: boolean;
  // ── Per-range character styles (AE Character panel on a selection) ──
  /** Stroke colour / width for these characters (overrides the layer's). */
  strokeColor?: string;
  strokeWidth?: number;
  /** Leading, multiple of font size. AE takes the LARGEST leading on a line. */
  lineHeight?: number;
  /** Percent, 100 = unscaled. Horizontal scale widens the advance too. */
  horizontalScale?: number;
  verticalScale?: number;
  /** Px, positive raises. */
  baselineShift?: number;
  /** Tsume, 0–100 %: removes that share of the glyph's side bearings. */
  tsume?: number;
  allCaps?: boolean;
  smallCaps?: boolean;
  /** 'super' | 'sub'. */
  verticalAlign?: string;
  /** Tate-chu-yoko: set these characters horizontally within one em of a
   *  vertical column (verticalLayout.ts). Ignored in horizontal type. */
  tateChuYoko?: boolean;
  /** Variable-font axis OFFSETS from a text animator's Font Axis properties.
   *  Internal: set from the glyph transform during layout, never stored in a run. */
  axisOffsets?: Record<string, number>;
}

/**
 * A styled span over `splitGraphemes(text)`, half-open `[start, end)`.
 *
 * Indices are GRAPHEME indices — the same index space `unitPositions` in
 * textSelectors.ts uses, so a run and an animator selector agree about what
 * character 5 is. (Documents written before graphemes stored code-point
 * offsets; `richText.readRuns` converts them.)
 */
export interface RichRun {
  start: number;
  end: number;
  style: Partial<TextStyle>;
}

/** Layer-wide paragraph settings — these cannot vary per character. */
export interface ParagraphStyle {
  /** 'left' | 'center' | 'right' | 'justify' | 'justify-left' |
   *  'justify-center' | 'justify-right' | 'justify-all'. */
  align?: string;
  /** Multiple of font size between baselines. Undefined = Auto (120%). */
  lineHeight?: number;
  /** Extra px between lines (legacy: every line break). */
  paragraphSpacing?: number;
  /** Paragraph indents, px — paragraph (box) text only. */
  leftIndent?: number;
  rightIndent?: number;
  firstLineIndent?: number;
  /** Px added between paragraphs (hard newlines). */
  spaceBefore?: number;
  spaceAfter?: number;
}

/** A glyph, resolved and placed. */
export interface PlacedGlyph {
  char: string;
  /** Index into `splitGraphemes(text)`. */
  index: number;
  /** Glyph centre X (the pen is advanced to the centre, matching the
   *  `textAlign: 'center'` draw the backends already do per glyph). */
  x: number;
  /** Baseline Y for `textBaseline: 'middle'`. */
  y: number;
  /** Width consumed, including letter spacing, kerning, animator tracking and
   *  any justification stretch. */
  advance: number;
  /**
   * The glyph's own advance width, without kerning or letter-spacing.
   *
   * `x - inkWidth / 2` is the PEN position — where the browser's own
   * `fillText` would start this glyph. Drawing from the pen with
   * `textAlign: 'left'` reproduces the browser's side bearings exactly;
   * drawing centred on the advance box does not, and the difference is a
   * per-glyph offset that shows up as edge shimmer when a partially-animated
   * string mixes the two draw paths.
   */
  inkWidth: number;
  /** Fully resolved style — base merged with whichever run covers `index`. */
  style: TextStyle;
  /** 0-based line this glyph landed on. */
  line: number;
  /** The animator transform for this glyph, when the layer has animators. */
  transform?: GlyphTransform;
  /** Baseline rotation in radians, set when the glyph rides a path. Absent for
   *  ordinary text — the backend only rotates when it is told to. */
  angle?: number;
  /** What is DRAWN, when it differs from `char` (Character Offset / Value,
   *  per-range All Caps). Absent means `char`. */
  drawn?: string;
  /** Bidi embedding level — set only in a right-to-left paragraph, where the
   *  glyphs of each line are emitted in VISUAL order (left to right) and
   *  `index` stays the logical position animators select by. */
  level?: number;
}

export interface LineBox {
  /** Sum of the line's advances (after any justification stretch). */
  width: number;
  /** Baseline Y. */
  y: number;
  /** Where the line's left edge sits, after `align`. Text on a path measures
   *  each glyph's offset from here to turn it into an arc length. */
  left: number;
  /** Px each justifiable space was stretched by (0 unless justified). */
  spaceExtra?: number;
  /** The line's PARAGRAPH direction — set only on lines whose glyphs carry
   *  bidi levels (right-to-left or 'auto' layouts). */
  direction?: 'ltr' | 'rtl';
}

export interface TextLayout {
  glyphs: PlacedGlyph[];
  lines: LineBox[];
  /** Widest line. */
  width: number;
  /** First to last baseline, plus one line's leading. */
  height: number;
  /** Vertical box text only: columns drawn — the rest overflow the box width. */
  visibleLines?: number;
  /** Each line's own leading, px — set only when a run carries its own
   *  leading (otherwise every line box is `height − (last y − first y)`). */
  lineLeading?: number[];
}

/** Measures one glyph under a fully-resolved style. Injected so this module
 *  stays pure — the backends pass a canvas-backed (and cached) implementation. */
export type MeasureGlyph = (char: string, style: TextStyle) => number;

/**
 * Measures a whole STRING under one style — the kerning-aware path.
 *
 * ## Why this exists
 *
 * Summing per-glyph widths silently discards kerning, because kerning is a
 * property of a PAIR and there is no pair in a one-character measurement. On
 * `JOIN THE REVOLUTION` at 129px the per-glyph sum came to 1684px against a
 * true width of 1676px — 8px of drift, accumulating left to right.
 *
 * That is not a cosmetic 0.5% error. The rasterizer has two paths: static text
 * draws as one `fillText` per line (kerned, 1676px) and text with any animator
 * draws per glyph (unkerned, 1684px). Anything that composites both — a cached
 * texture crossfading into a freshly drawn one — superimposes the same string at
 * two spacings, and the result is a picket fence of 1px vertical bars densest
 * where the drift has accumulated most. Rendered and measured: 71 ink runs
 * against 17 for a single clean draw.
 *
 * Measuring cumulative prefixes and taking differences recovers the exact
 * advances, kerning included, and makes the two paths agree to the pixel.
 */
export type MeasureRun = (text: string, style: TextStyle) => number;

/** Ink side bearings of one glyph, px: `left` from the pen to the ink, `right`
 *  from the ink to the advance end. Used by per-range tsume. */
export type MeasureBearings = (char: string, style: TextStyle) => { left: number; right: number };

/**
 * Optical kerning for one adjacent pair: px added to the LEFT glyph's advance,
 * measured from the two glyphs' ink profiles (opticalKerning.ts). The caller
 * measures advances with the font's own kerning OFF.
 */
export type OpticalKern = (left: string, leftStyle: TextStyle, right: string, rightStyle: TextStyle) => number;

export interface LayoutOptions {
  /** Per-character style overrides. Later runs win where they overlap. */
  runs?: ReadonlyArray<RichRun>;
  /** Animator output, one entry per character of `text`. Contributes
   *  `tracking` to the advance; the rest is applied by the backend at paint. */
  transforms?: ReadonlyArray<GlyphTransform>;
  /** Layer box width — the frame `align` anchors against. */
  boxWidth: number;
  /**
   * Kerning-aware measurement. Strongly preferred — see `MeasureRun`.
   *
   * Optional so backends without real text metrics (jsdom in the unit tests,
   * the headless rasterizers) keep working on the per-glyph fallback. They lose
   * kerning, which for a metric-free fake measurer is meaningless anyway.
   */
  measureRun?: MeasureRun;
  /** Inset from each box edge, px (the render padding). Default 0. */
  padX?: number;
  /**
   * Present only for paragraph (box) text: wrapped line numbers ending in a
   * soft wrap. Justification and indents need it; point text omits it.
   */
  softBreakLines?: ReadonlyArray<number>;
  /** 'optical' adds `opticalKern` between every adjacent inked pair (the
   *  caller measures with font kerning off); manual kerning adds on top. */
  kerningMode?: KerningMode;
  opticalKern?: OpticalKern;
  measureBearings?: MeasureBearings;
  /**
   * 'rtl': AE's right-to-left paragraph direction; 'auto': each paragraph takes
   * its first strong character's direction (P2/P3). Levels are resolved per
   * PARAGRAPH (text between hard breaks — `softBreakLines` says which line
   * ends are soft), then each wrapped line gets L1 and is reordered (L2) and
   * its glyphs are emitted in visual order; the default alignment and the
   * indents mirror in a right-to-left paragraph (textExtras.placeLine).
   */
  direction?: 'rtl' | 'auto';
}

/** One wrapped line's bidi: its paragraph's direction and its glyph levels
 *  (null for an 'auto' line that is purely left-to-right). */
export interface LineBidi {
  direction: 'ltr' | 'rtl';
  levels: number[] | null;
}

/**
 * UAX #9 over WRAPPED lines: levels are resolved once per paragraph over the
 * logical cluster sequence (a paragraph ends at a hard end), then each line
 * takes its slice and gets L1 (trailing whitespace to the paragraph level).
 *
 * A soft wrap stands in the paragraph for what the wrap removed: a space
 * (`wrapText` replaces the space it breaks at), except between CJK units,
 * where the break was INSERTED and stands for nothing.
 */
export function paragraphBidiLines(
  lines: ReadonlyArray<ReadonlyArray<string>>,
  hardEnds: ReadonlyArray<boolean>,
  direction: 'rtl' | 'auto',
): LineBidi[] {
  const out: LineBidi[] = [];
  let start = 0;
  for (let li = 0; li < lines.length; li++) {
    if (!hardEnds[li] && li < lines.length - 1) continue;
    const seq: string[] = [];
    const from: number[] = [];
    for (let k = start; k <= li; k++) {
      if (k > start) {
        const prev = lines[k - 1]!;
        const a = prev[prev.length - 1];
        const b = lines[k]![0];
        const inserted = a !== undefined && b !== undefined && (isIdeographicUnit(a) || isIdeographicUnit(b));
        if (!inserted) seq.push(' ');
      }
      from.push(seq.length);
      for (const c of lines[k]!) seq.push(c);
    }
    const { levels, paragraphLevel } = clusterBidi(seq, direction === 'rtl' ? 1 : 'auto');
    for (let k = start; k <= li; k++) {
      const line = lines[k]!;
      const at = from[k - start]!;
      const lv = levels.slice(at, at + line.length);
      resetLineEnd(line, lv, paragraphLevel);
      const plain = direction === 'auto' && paragraphLevel === 0 && lv.every((l) => l === 0);
      out.push({ direction: paragraphLevel === 1 ? 'rtl' : 'ltr', levels: plain ? null : lv });
    }
    start = li + 1;
  }
  return out;
}

/** Grapheme clusters of each line of `text` (line breaks are not clusters of any line). */
function graphemeLines(text: string): string[][] {
  const lines: string[][] = [[]];
  for (const c of splitGraphemes(text)) {
    if (isLineBreak(c)) lines.push([]);
    else lines[lines.length - 1]!.push(c);
  }
  return lines;
}

/**
 * Whether resolving bidi per PARAGRAPH puts any glyph of wrapped `text` at a
 * different level than resolving each line alone — what a canvas does with a
 * line drawn whole. Only then must a right-to-left / 'auto' paragraph leave the
 * whole-line fast path; everywhere else the two agree and nothing changes.
 */
export function softWrapChangesBidi(
  text: string,
  softBreakLines: ReadonlyArray<number> | undefined,
  direction: 'rtl' | 'auto',
): boolean {
  if (!softBreakLines || softBreakLines.length === 0 || !hasStrongRtl(text)) return false;
  const lines = graphemeLines(text);
  const para = paragraphBidiLines(lines, hardEndsOf(lines.length, softBreakLines), direction);
  return para.some((p, i) => {
    const line = lines[i]!;
    if (line.length === 0) return false;
    const own = clusterLevels(line, p.direction === 'rtl' ? 1 : 0);
    return own.some((l, j) => l !== (p.levels ? p.levels[j] : 0));
  });
}

/**
 * Merge the base style with every run covering `index`.
 *
 * Runs are applied in array order, so a later run wins an overlap. Callers that
 * care about determinism should normalize first (`normalizeRuns`), which makes
 * runs disjoint and ordered — but layout must not *depend* on that, because a
 * document written by an older build may carry overlapping runs.
 */
export function resolveGlyphStyle(
  base: TextStyle,
  runs: ReadonlyArray<RichRun> | undefined,
  index: number,
): TextStyle {
  if (!runs || runs.length === 0) return base;
  let style = base;
  for (const run of runs) {
    if (index >= run.start && index < run.end) {
      style = { ...style, ...run.style };
    }
  }
  return style;
}

/** The fields that change how a string MEASURES. Two glyphs with the same key
 *  can be kerned against each other; a key change is a font boundary. */
function metricKey(s: TextStyle): string {
  return `${s.fontStyle ?? ''}|${s.fontWeight ?? ''}|${s.fontSize}|${s.fontFamily ?? ''}|${s.letterSpacing ?? 0}`
    + `|${s.smallCaps ? 'sc' : ''}|${s.horizontalScale ?? ''}|${s.verticalAlign ?? ''}|${s.tsume ?? ''}`
    + `|${s.axisOffsets ? JSON.stringify(s.axisOffsets) : ''}`;
}

/** Superscript/subscript: must equal `SUPER_SUB_SCALE` / `SUPER_SHIFT` /
 *  `SUB_SHIFT` in measureText.ts (a test holds them together; importing would
 *  cycle through the measurement module). */
const RANGE_SUPER_SUB_SCALE = 0.65;
const RANGE_SUPER_SHIFT = 0.35;
const RANGE_SUB_SHIFT = 0.15;

/**
 * A glyph's PER-RANGE scale and baseline offset: horizontal / vertical scale,
 * baseline shift and super/subscript from its run style. The layer-wide values
 * are one box transform in the painter; these apply to the characters of a
 * selection only. `dy` is canvas-down px.
 */
export function glyphStyleScale(s: TextStyle): { sx: number; sy: number; dy: number } {
  const va = s.verticalAlign === 'super' || s.verticalAlign === 'sub' ? RANGE_SUPER_SUB_SCALE : 1;
  const sx = ((typeof s.horizontalScale === 'number' && s.horizontalScale > 0 ? s.horizontalScale : 100) / 100) * va;
  const sy = ((typeof s.verticalScale === 'number' && s.verticalScale > 0 ? s.verticalScale : 100) / 100) * va;
  let dy = typeof s.baselineShift === 'number' && Number.isFinite(s.baselineShift) && s.baselineShift !== 0 ? -s.baselineShift : 0;
  if (s.verticalAlign === 'super') dy -= s.fontSize * RANGE_SUPER_SHIFT;
  else if (s.verticalAlign === 'sub') dy += s.fontSize * RANGE_SUB_SHIFT;
  return { sx, sy, dy };
}

/**
 * Place every glyph of `text`.
 *
 * Newlines break lines and are not emitted as glyphs. Whitespace IS emitted —
 * it advances the pen, and the backend skips painting it. Empty lines still
 * occupy their leading.
 */
export function layoutText(
  text: string,
  base: TextStyle & ParagraphStyle,
  measure: MeasureGlyph,
  opts: LayoutOptions,
): TextLayout {
  const chars = splitGraphemes(text);
  // The style a glyph measures and draws under: its run, plus any Font Axis
  // offsets its animator applies (which change the advance, so they are part
  // of the measuring style, not a paint-time afterthought).
  const styleAt = (i: number): TextStyle => {
    const s = resolveGlyphStyle(base, opts.runs, i);
    const ax = opts.transforms?.[i]?.axes;
    return ax && Object.keys(ax).length > 0 ? { ...s, axisOffsets: ax } : s;
  };
  // What is drawn: Character Offset / Value substitution, then per-range caps.
  const drawnAt = (i: number): string => {
    const d = opts.transforms?.[i]?.displayChar ?? chars[i]!;
    return opts.runs && resolveGlyphStyle(base, opts.runs, i).allCaps ? d.toUpperCase() : d;
  };
  // Per-range leading is honoured only when a run actually sets one — so a
  // layer without it keeps the uniform-gap arithmetic to the bit.
  const perRangeLeading = !!opts.runs?.some((r) => r.style.lineHeight !== undefined);

  /**
   * Kerned advance for each glyph, or null when the caller gave us no run
   * measurer (headless backends with no real metrics, and the unit tests).
   *
   * Computed per maximal same-METRICS span: kerning only applies between
   * glyphs that share a font, and a prefix measured across a style boundary
   * would be measured under the wrong font from the boundary onward. (The span
   * test used to compare freshly-spread style OBJECTS, which are never equal,
   * so every styled glyph was measured alone and lost its kerning.)
   */
  const kernedAdvances = ((): (number | null)[] | null => {
    const run = opts.measureRun;
    if (!run) return null;
    const out: (number | null)[] = new Array(chars.length).fill(null);
    let spanStart = 0;
    const flush = (end: number): void => {
      if (end <= spanStart) return;
      const style = styleAt(spanStart);
      let prev = 0;
      let drawnSoFar = '';
      for (let i = spanStart; i < end; i++) {
        // A substituted glyph (Character Offset) changes the string being
        // measured, so build the prefix from what will actually be DRAWN.
        drawnSoFar += drawnAt(i);
        const w = run(drawnSoFar, style);
        out[i] = w - prev;
        prev = w;
      }
    };
    let spanKey = chars.length > 0 ? metricKey(styleAt(0)) : '';
    for (let i = 0; i <= chars.length; i++) {
      const atEnd = i === chars.length;
      // A newline is a hard break for kerning as well as for layout.
      const broken = atEnd || isLineBreak(chars[i]!);
      const key = !atEnd && !broken ? metricKey(styleAt(i)) : spanKey;
      const styleChanged = !atEnd && !broken && i > spanStart && key !== spanKey;
      if (broken || styleChanged) {
        flush(i);
        spanStart = broken && !atEnd ? i + 1 : i;
        if (!atEnd && spanStart < chars.length) spanKey = metricKey(styleAt(spanStart));
      }
    }
    return out;
  })();

  // Pass 1 — measure and group into lines. Advances are resolved per glyph
  // under that glyph's own style: a run that changes the font changes the
  // width, so measuring the whole string under one font (as drawGlyphs did)
  // would misplace everything after the first run boundary.
  interface Pending {
    char: string;
    drawn: string;
    index: number;
    advance: number;
    /**
     * The glyph's own width, ignoring kerning.
     *
     * Kerning belongs BETWEEN two glyphs, but a prefix-difference measurement
     * necessarily attributes each pair's tuck to the SECOND glyph — so 'V' in
     * 'AV' comes back 8px narrower than it draws. Centring it in that shrunken
     * box shifts it 4px left of where the browser puts it, which is a residual
     * mismatch that survives even after the total widths agree.
     *
     * So the pen steps by `advance` (kerned, and therefore correct cumulatively)
     * while each glyph is centred on `inkWidth` (its own box). Both properties
     * hold at once, which is what makes the two draw paths land on the same
     * pixels rather than merely end at the same place.
     */
    inkWidth: number;
    style: TextStyle;
    transform?: GlyphTransform;
    /** Px the glyph sits right of its pen (Tracking Type before, tsume). */
    shiftX: number;
    /** Px the glyph sits below its line's baseline (per-range baseline shift, super/sub). */
    shiftY: number;
  }
  const lines: Pending[][] = [[]];

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (isLineBreak(char)) {
      lines.push([]);
      continue;
    }
    const style = styleAt(i);
    const transform = opts.transforms?.[i];
    // Character Offset can substitute a wider glyph ('l' → 'W'); measuring the
    // original would leave the line short by the difference and the rest of it
    // creeping left as the offset animates.
    const drawn = drawnAt(i);
    // The kerned advance already includes this glyph's letter-spacing, because
    // the run measurement is taken with the style's spacing applied. The
    // per-glyph fallback has to add it back by hand.
    const kerned = kernedAdvances?.[i];
    let advance =
      kerned !== null && kerned !== undefined
        ? kerned + (transform?.tracking ?? 0)
        : measure(drawn, style) + (style.letterSpacing ?? 0) + (transform?.tracking ?? 0);
    let inkWidth = measure(drawn, style);
    let shiftX = transform?.trackingBefore ?? 0;
    // Per-range horizontal scale / super-subscript narrow or widen the glyph
    // and its own advance (not the animator's tracking, which is in px).
    const gs = glyphStyleScale(style);
    if (gs.sx !== 1) {
      const trk = transform?.tracking ?? 0;
      advance = (advance - trk) * gs.sx + trk;
      inkWidth *= gs.sx;
    }
    // Tsume removes a share of the glyph's side bearings: the ink moves left by
    // the left share and the pen after it comes in by both.
    if (style.tsume && opts.measureBearings) {
      const b = opts.measureBearings(drawn, style);
      const t = Math.max(0, Math.min(100, style.tsume)) / 100;
      const l = Math.max(0, b.left) * t * gs.sx;
      const r = Math.max(0, b.right) * t * gs.sx;
      shiftX -= l;
      advance -= l + r;
    }
    lines[lines.length - 1]!.push({ char, drawn, index: i, advance, inkWidth, style, transform, shiftX, shiftY: gs.dy });
  }

  // Pass 1b — pair adjustments. Manual kerning (per character, 1/1000 em) and
  // optical kerning both sit BETWEEN two glyphs on the same line.
  const optical = opts.kerningMode === 'optical' && opts.opticalKern ? opts.opticalKern : null;
  for (const line of lines) {
    for (let j = 0; j < line.length - 1; j++) {
      const g = line[j]!;
      const next = line[j + 1]!;
      const manual = g.style.kerning;
      if (manual) g.advance += (manual / 1000) * g.style.fontSize;
      if (optical && g.drawn.trim() !== '' && next.drawn.trim() !== '') {
        // Per-range horizontal scale narrows the pair's space with the glyph.
        g.advance += optical(g.drawn, g.style, next.drawn, next.style) * glyphStyleScale(g.style).sx;
      }
    }
  }

  // Pass 2 — place. Lines are stacked about the vertical centre so a layer with
  // one line renders exactly where the single-line fast path puts it.
  const hardEnds = hardEndsOf(lines.length, opts.softBreakLines);
  const stack = stackLines(lines, base, opts.softBreakLines, perRangeLeading);
  const { offsets, total: totalHeight, lineHeightPx } = stack;
  const startY = -totalHeight / 2;
  const frame: ParagraphFrame = {
    boxWidth: opts.boxWidth,
    padX: opts.padX ?? 0,
    boxText: opts.softBreakLines !== undefined,
    align: base.align,
    leftIndent: base.leftIndent,
    rightIndent: base.rightIndent,
    firstLineIndent: base.firstLineIndent,
  };
  const frameRtl: ParagraphFrame = { ...frame, direction: 'rtl' };
  // Bidi per paragraph, reordered per line (paragraphBidiLines).
  const lineBidi = opts.direction === 'rtl' || opts.direction === 'auto'
    ? paragraphBidiLines(lines.map((l) => l.map((g) => g.char)), hardEnds, opts.direction)
    : null;

  const glyphs: PlacedGlyph[] = [];
  const boxes: LineBox[] = [];
  let widest = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const lineWidth = line.reduce((sum, g) => sum + g.advance, 0);
    const lastInk = lastNonSpace(line.map((g) => g.char));
    const spaces = line.reduce((n, g, j) => n + (j < lastInk && isJustifiableSpace(g.char) ? 1 : 0), 0);
    const y = startY + offsets[li]!;
    // Line Anchor: the line is placed as if its animator tracking were absent,
    // and the tracking then grows about that fraction of it (0 = from the left
    // edge, 0.5 = both ways, 1 = leftwards). Only when an animator sets it.
    const anchored = line.find((g) => g.transform?.lineAnchor !== undefined);
    const trackExtra = anchored ? line.reduce((s, g) => s + (g.transform?.tracking ?? 0), 0) : 0;
    const bidi = lineBidi?.[li];
    const placed = placeLine(
      { width: anchored ? lineWidth - trackExtra : lineWidth, spaces, hardEnd: hardEnds[li]!, paragraphStart: li === 0 || hardEnds[li - 1]! },
      bidi?.direction === 'rtl' ? frameRtl : frame,
    );
    let pen = anchored ? placed.left - trackExtra * anchored.transform!.lineAnchor! : placed.left;
    const lineLeft = pen;
    // Bidi: walk the line in VISUAL order. Advances, kerning and the
    // justification test all stay logical (`j`), so the line's width — and so
    // its alignment — is exactly what it was.
    const levels = bidi?.levels ?? null;
    const order = levels ? visualOrder(levels) : null;

    for (let k = 0; k < line.length; k++) {
      const j = order ? order[k]! : k;
      const g = line[j]!;
      const stretch = placed.spaceExtra > 0 && j < lastInk && isJustifiableSpace(g.char) ? placed.spaceExtra : 0;
      glyphs.push({
        char: g.char,
        index: g.index,
        // Centred on the glyph's OWN box, not on its kerned advance — see
        // `inkWidth`. The pen still steps by the kerned advance below.
        x: g.shiftX ? pen + g.shiftX + g.inkWidth / 2 : pen + g.inkWidth / 2,
        y: g.shiftY ? y + g.shiftY : y,
        advance: g.advance + stretch,
        inkWidth: g.inkWidth,
        style: g.style,
        line: li,
        transform: g.transform,
        ...(g.drawn !== g.char ? { drawn: g.drawn } : {}),
        ...(levels ? { level: levels[j]! } : {}),
      });
      pen += g.advance + stretch;
    }
    const consumed = pen - lineLeft;
    widest = Math.max(widest, consumed);
    boxes.push({
      width: consumed, y, left: lineLeft,
      ...(placed.spaceExtra > 0 ? { spaceExtra: placed.spaceExtra } : {}),
      ...(levels && bidi ? { direction: bidi.direction } : {}),
    });
  }

  return {
    glyphs, lines: boxes, width: widest, height: totalHeight + lineHeightPx,
    ...(stack.lineLeading ? { lineLeading: stack.lineLeading } : {}),
  };
}

/**
 * How a stack of lines is spaced — the ONE copy of the vertical arithmetic
 * `layoutText` places lines with, shared with the measurer (paragraph box
 * overflow) so a run that raises the font size or the leading moves both.
 *
 *   • `lineHeightPx`: the tallest leading of any glyph (a run may raise the font
 *     size; the tallest glyph sets the leading, so a mixed-size line does not
 *     overlap its neighbour) — the uniform gap, and the block's last line box;
 *   • `lineLeading`: only when a run sets its OWN leading — each line's largest
 *     (AE), an empty line keeping the layer's.
 */
export function stackLines(
  lines: ReadonlyArray<ReadonlyArray<{ style: TextStyle }>>,
  base: { fontSize: number } & ParagraphStyle,
  softBreakLines: ReadonlyArray<number> | undefined,
  perRangeLeading: boolean,
): { offsets: number[]; total: number; lineHeightPx: number; lineLeading?: number[] } {
  const lineHeightMul = base.lineHeight ?? AUTO_LEADING;
  const paragraphSpacing = base.paragraphSpacing ?? 0;
  const baseLeading = (base.fontSize || 0) * lineHeightMul;
  let lineHeightPx = baseLeading;
  for (const line of lines) {
    for (const g of line) {
      lineHeightPx = Math.max(lineHeightPx, g.style.fontSize * (perRangeLeading ? g.style.lineHeight ?? lineHeightMul : lineHeightMul));
    }
  }
  const hardEnds = hardEndsOf(lines.length, softBreakLines);
  if (!perRangeLeading) {
    return { ...lineOffsets(hardEnds, lineHeightPx + paragraphSpacing, base.spaceBefore, base.spaceAfter), lineHeightPx };
  }
  const { offsets, total } = rangedLineOffsets(lines, hardEnds, baseLeading, paragraphSpacing, base.spaceBefore, base.spaceAfter, lineHeightMul);
  const lineLeading = lines.map((line) => (line.length === 0
    ? baseLeading
    : line.reduce((m, g) => Math.max(m, g.style.fontSize * (g.style.lineHeight ?? lineHeightMul)), 0)));
  return { offsets, total, lineHeightPx, lineLeading };
}

/**
 * The line stack of `text` under `base` + `runs` without measuring a glyph —
 * what the paragraph-box measurer needs to agree with the painter about where
 * lines sit and which of them fit. `ys` are centre-origin baselines.
 */
export function paragraphLineMetrics(
  text: string,
  base: { fontSize: number } & ParagraphStyle & Partial<TextStyle>,
  runs: ReadonlyArray<RichRun> | undefined,
  softBreakLines: ReadonlyArray<number> | undefined,
): { ys: number[]; leading: number[]; lineHeightPx: number; blockHeight: number } {
  const chars = splitGraphemes(text);
  const lines: Array<Array<{ style: TextStyle }>> = [[]];
  for (let i = 0; i < chars.length; i++) {
    if (isLineBreak(chars[i]!)) {
      lines.push([]);
      continue;
    }
    lines[lines.length - 1]!.push({ style: resolveGlyphStyle(base, runs, i) });
  }
  const perRangeLeading = !!runs?.some((r) => r.style.lineHeight !== undefined);
  const s = stackLines(lines, base, softBreakLines, perRangeLeading);
  return {
    ys: s.offsets.map((o) => o - s.total / 2),
    leading: s.lineLeading ?? s.offsets.map(() => s.lineHeightPx),
    lineHeightPx: s.lineHeightPx,
    blockHeight: s.total + s.lineHeightPx,
  };
}

/** Index of the last cluster that is not a justifiable space (-1 if none). */
function lastNonSpace(clusters: ReadonlyArray<string>): number {
  for (let i = clusters.length - 1; i >= 0; i--) if (!isJustifiableSpace(clusters[i]!)) return i;
  return -1;
}

/**
 * Baseline offsets when a RUN sets its own leading. AE gives each line the
 * largest leading of any character on it, and that leading is the distance
 * from the previous baseline to this one. An empty line keeps the layer's.
 * With every line at the same leading this is exactly `lineOffsets`.
 */
function rangedLineOffsets(
  lines: ReadonlyArray<ReadonlyArray<{ style: TextStyle }>>,
  hardEnds: ReadonlyArray<boolean>,
  baseLeadingPx: number,
  paragraphSpacing: number,
  spaceBefore: number | undefined,
  spaceAfter: number | undefined,
  lineHeightMul: number,
): { offsets: number[]; total: number } {
  const n = Math.max(1, lines.length);
  const offsets: number[] = new Array(n).fill(0);
  const para = (spaceBefore || 0) + (spaceAfter || 0);
  for (let i = 1; i < n; i++) {
    const line = lines[i] ?? [];
    const leading = line.length === 0
      ? baseLeadingPx
      : line.reduce((m, g) => Math.max(m, g.style.fontSize * (g.style.lineHeight ?? lineHeightMul)), 0);
    offsets[i] = offsets[i - 1]! + leading + paragraphSpacing + (para !== 0 && hardEnds[i - 1] ? para : 0);
  }
  return { offsets, total: offsets[n - 1]! };
}

// ── The whole-string fast path's plan ────────────────────────────────

export interface WholeLineSegment {
  text: string;
  /** Centre-origin x to draw at with `textAlign = align`. */
  x: number;
  align: LineAlign;
  /** Centre-origin pen x where this segment's first glyph starts. */
  left: number;
}

export interface WholeLinePlan {
  /** Centre-origin baseline. */
  y: number;
  /** Pen x of the line's first glyph. */
  left: number;
  /** The line's natural width. */
  width: number;
  segments: WholeLineSegment[];
  /** 'auto' layouts only: this line's paragraph is right-to-left, so the
   *  canvas must draw it under `direction = 'rtl'`. */
  direction?: 'rtl';
}

/**
 * How the fast path draws static, single-style text: one `fillText` per line,
 * or — for a justified line — one per word, each placed where the stretched
 * spaces put it.
 *
 * `measureLine` measures a string under the layer style WITH letter spacing
 * (exactly what `ctx.measureText` reports after `ctx.letterSpacing` is set),
 * which is also what `layoutText`'s kerned prefix measurement sums to — so a
 * word's x here equals its first glyph's pen there. `textPaint.test.ts` holds
 * the two to that.
 *
 * Non-justified lines keep the `textAlign` anchor draw they always had, so
 * every existing layer paints byte-identically.
 */
export function planWholeStringLines(
  text: string,
  base: { fontSize: number } & ParagraphStyle,
  measureLine: (s: string) => number,
  opts: { boxWidth: number; padX?: number; softBreakLines?: ReadonlyArray<number>; direction?: 'rtl' | 'auto' },
): WholeLinePlan[] {
  const raw = text.split(/\r\n|\n/);
  const hardEnds = hardEndsOf(raw.length, opts.softBreakLines);
  // 'auto': each PARAGRAPH (lines up to a hard end) takes its first strong
  // character's direction; the canvas then draws each of its lines under it.
  const rtlLine: boolean[] = raw.map(() => opts.direction === 'rtl');
  if (opts.direction === 'auto') {
    let start = 0;
    for (let li = 0; li < raw.length; li++) {
      if (!hardEnds[li] && li < raw.length - 1) continue;
      const rtl = resolveParagraphDirection('auto', raw.slice(start, li + 1).join(' ')) === 'rtl';
      for (let k = start; k <= li; k++) rtlLine[k] = rtl;
      start = li + 1;
    }
  }
  const lineHeightPx = (base.lineHeight ?? AUTO_LEADING) * base.fontSize;
  const { offsets, total } = lineOffsets(
    hardEnds,
    lineHeightPx + (base.paragraphSpacing ?? 0),
    base.spaceBefore,
    base.spaceAfter,
  );
  const frame: ParagraphFrame = {
    boxWidth: opts.boxWidth,
    padX: opts.padX ?? 0,
    boxText: opts.softBreakLines !== undefined,
    align: base.align,
    leftIndent: base.leftIndent,
    rightIndent: base.rightIndent,
    firstLineIndent: base.firstLineIndent,
  };
  // A right-to-left line drawn whole is reordered by the canvas itself
  // (`ctx.direction = 'rtl'`); only its placement mirrors here. Justified
  // RTL lines take the per-glyph path (textPaint), which reorders by word.
  const frameRtl: ParagraphFrame = { ...frame, direction: 'rtl' };

  return raw.map((line, li): WholeLinePlan => {
    const plan = planLine(line, li, rtlLine[li] ? frameRtl : frame);
    return opts.direction === 'auto' && rtlLine[li] ? { ...plan, direction: 'rtl' } : plan;
  });

  function planLine(line: string, li: number, frame: ParagraphFrame): WholeLinePlan {
    const y = -total / 2 + offsets[li]!;
    const clusters = splitGraphemes(line);
    const lastInk = lastNonSpace(clusters);
    let spaces = 0;
    for (let j = 0; j < lastInk; j++) if (isJustifiableSpace(clusters[j]!)) spaces++;
    const width = line ? measureLine(line) : 0;
    const placed = placeLine(
      { width, spaces, hardEnd: hardEnds[li]!, paragraphStart: li === 0 || hardEnds[li - 1]! },
      frame,
    );
    if (placed.spaceExtra <= 0) {
      return {
        y,
        left: placed.left,
        width,
        segments: line ? [{ text: line, x: placed.anchor, align: placed.lineAlign, left: placed.left }] : [],
      };
    }
    // Justified: one draw per word. A word's pen is the measured prefix before
    // it plus the stretch of every space already passed.
    const segments: WholeLineSegment[] = [];
    let utf16 = 0;
    let passed = 0;
    let wordStart = -1;
    let wordText = '';
    const flush = (): void => {
      if (wordStart < 0) return;
      const left = placed.left + (wordStart > 0 ? measureLine(line.slice(0, wordStart)) : 0) + passed * placed.spaceExtra;
      segments.push({ text: wordText, x: left, align: 'left', left });
      wordStart = -1;
      wordText = '';
    };
    for (let j = 0; j < clusters.length; j++) {
      const c = clusters[j]!;
      if (isJustifiableSpace(c)) {
        flush();
        if (j < lastInk) passed++;
      } else {
        if (wordStart < 0) wordStart = utf16;
        wordText += c;
      }
      utf16 += c.length;
    }
    flush();
    return { y, left: placed.left, width, segments };
  }
}
