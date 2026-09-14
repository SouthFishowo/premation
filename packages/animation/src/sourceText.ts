/**
 * Source Text in expressions — AE's `text.sourceText` and the AE 25 style API.
 *
 * ## What this module owns
 *
 * Three things, all pure:
 *
 *   1. The DATA the host hands an expression about a text layer
 *      (`SourceTextSample` — the text and its layer-wide style in THIS app's
 *      units), through `ExprContext.sourceTextAt`.
 *   2. The OBJECTS an expression sees: `text.sourceText` (a String object, so
 *      `+`, `.length`, `.split(' ')` and every other string idiom work) carrying
 *      `.style` and `.getStyleAt(i)`, and the chainable style object whose
 *      setters return a NEW style object — nothing is mutated, so an
 *      expression evaluated twice on one frame cannot see its own writes.
 *   3. The RESULT of an expression on the Source Text property,
 *      `SourceTextExpressionResult`: plain data (text + layer-wide overrides +
 *      per-character range overrides) that the renderer merges into its text
 *      spec. See `src/core/textExpr/applySourceTextResult.ts` for that merge.
 *
 * ## Why the result is data, not the style object
 *
 * The style object is closures. The renderer must never hold one — it would
 * pin the expression's scope and could not be diffed, cached or serialised.
 * `coerceSourceTextResult` turns whatever the expression returned into data
 * the moment evaluation ends.
 *
 * ## Units
 *
 * Getters and setters speak AE's units, because that is the vocabulary people
 * paste in from AE expressions:
 *
 *   tracking   1/1000 em        (app: letterSpacing px)
 *   leading    px               (app: lineHeight × fontSize)
 *   fillColor  [r, g, b] 0..1   (app: CSS hex)
 *   horizontalScaling / verticalScaling  1 = 100%   (app: percent)
 *
 * The result stores tracking and leading in those RELATIVE units rather than
 * converting at set time, because `setTracking(50).setFontSize(200)` means
 * "50/1000 of the FINAL size" in AE — converting early would bake the old size.
 *
 * ## Index space
 *
 * Character indices in `setFontSize(v, start, count)` and `getStyleAt(i)` are
 * GRAPHEME indices — the same space rich-text runs use (`graphemes.ts` in the
 * app). The package cannot import the app, so the splitter is injected by the
 * caller where it matters and defaults to `Intl.Segmenter` with a code-point
 * fallback, which agrees with the app's splitter.
 *
 * ## Budget
 *
 * Every setter is O(ranges) and ranges are capped (`MAX_RANGE_OVERRIDES`), and
 * `setText` is capped (`MAX_SOURCE_TEXT_LENGTH`), so a plugin-written
 * expression persisted in a document cannot turn one frame into an unbounded
 * allocation. The interpreter's step budget bounds how many setters can run.
 */

/** The property path Source Text lives on — the same key as its hold data track. */
export const SOURCE_TEXT_PROP = 'text.source';

/** Longest text an expression may produce. A headline, not a novel. */
export const MAX_SOURCE_TEXT_LENGTH = 100_000;

/** Most per-character range overrides one expression may stack. */
export const MAX_RANGE_OVERRIDES = 256;

/** A layer's layer-wide text style, in the APP's units (what the components store). */
export interface SourceTextStyle {
  fontFamily: string;
  fontSize: number;
  /** CSS weight string, '100'..'900'. */
  fontWeight: string;
  /** 'normal' | 'italic'. */
  fontStyle: string;
  /** CSS colour. */
  fill: string;
  /** CSS colour, or undefined for no stroke colour set. */
  stroke?: string;
  strokeWidth: number;
  /** px added after each glyph. */
  letterSpacing: number;
  /** Multiple of font size. */
  lineHeight: number;
  baselineShift: number;
  /** Percent, 100 = normal. */
  horizontalScale: number;
  /** Percent, 100 = normal. */
  verticalScale: number;
  /** 'none' | 'uppercase' | … */
  textTransform: string;
  /** 'normal' | 'small-caps'. */
  fontVariant: string;
  /** 'left' | 'center' | 'right' | 'justify'. */
  align: string;
  /** px between paragraphs. */
  paragraphSpacing: number;
  firstLineIndent: number;
  leftIndent: number;
  rightIndent: number;
  spaceBefore: number;
  /** 'rtl' for a right-to-left paragraph; absent / 'ltr' otherwise. */
  direction?: string;
}

/** The fields a per-character run may carry (mirrors the app's `RUN_STYLE_KEYS`). */
export interface SourceTextRunStyle {
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  letterSpacing?: number;
  fill?: string;
}

/** A stored rich-text run, `[start, end)` in grapheme indices. */
export interface SourceTextRun {
  start: number;
  end: number;
  style: SourceTextRunStyle;
}

/** Everything an expression may read about one text layer at one time. */
export interface SourceTextSample {
  text: string;
  style: SourceTextStyle;
  runs?: ReadonlyArray<SourceTextRun>;
}

/**
 * Layer-wide overrides an expression set. Absent = untouched.
 *
 * `tracking` and `leading` are in AE units on purpose — see the module note.
 */
export interface SourceTextStyleOverrides {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  fill?: string;
  applyFill?: boolean;
  stroke?: string;
  strokeWidth?: number;
  applyStroke?: boolean;
  /** 1/1000 em. */
  tracking?: number;
  /** px. */
  leading?: number;
  baselineShift?: number;
  /** Percent. */
  horizontalScale?: number;
  /** Percent. */
  verticalScale?: number;
  textTransform?: string;
  fontVariant?: string;
  // ── Paragraph (AE 25) ──
  align?: string;
  firstLineIndent?: number;
  leftIndent?: number;
  rightIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  /** 'ltr' | 'rtl'. */
  direction?: string;
  /** AE's leading type, stored verbatim ('roman' | 'eastAsian'). */
  leadingType?: string;
}

/** Keys a RANGE override may carry. */
export type SourceTextRangeKey =
  | 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle' | 'fill' | 'tracking'
  | 'textTransform' | 'stroke' | 'strokeWidth' | 'baselineShift'
  | 'horizontalScale' | 'verticalScale' | 'fontVariant' | 'applyFill' | 'applyStroke';

/** One `setX(value, startIndex, numChars)`. Grapheme indices. */
export interface SourceTextRangeOverride {
  start: number;
  count: number;
  style: Pick<SourceTextStyleOverrides, SourceTextRangeKey>;
}

/** What an expression on Source Text evaluates to, as data. */
export interface SourceTextExpressionResult {
  text: string;
  style: SourceTextStyleOverrides;
  /** In application order — later ranges win where they overlap. */
  ranges: SourceTextRangeOverride[];
}

// ── Colour ────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** CSS colour → AE [r, g, b] 0..1. Unparseable colours read as white. */
export function cssToRgb01(css: string | undefined): [number, number, number] {
  const s = (css ?? '').trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let hex = m[1]!;
    if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((c) => c + c).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [clamp01(Number(m[1]) / 255), clamp01(Number(m[2]) / 255), clamp01(Number(m[3]) / 255)];
  return [1, 1, 1];
}

/** AE [r, g, b] 0..1 (or a CSS string, passed through) → CSS hex. */
export function rgb01ToCss(v: unknown, fn: string): string {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((c) => typeof c === 'number' && Number.isFinite(c))) {
    const hex = (c: number): string => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0');
    return `#${hex(v[0] as number)}${hex(v[1] as number)}${hex(v[2] as number)}`;
  }
  throw new Error(`${fn}() needs a colour, e.g. ${fn}([1, 0, 0]).`);
}

// ── Justification / direction vocabulary ─────────────────────────────

const JUSTIFY_TO_ALIGN: Record<string, string> = {
  alignLeft: 'left', alignCenter: 'center', alignRight: 'right',
  justifyLastLineLeft: 'justify', justifyLastLineCenter: 'justify',
  justifyLastLineRight: 'justify', justifyLastLineFull: 'justify',
  left: 'left', center: 'center', right: 'right', justify: 'justify',
};
const ALIGN_TO_JUSTIFY: Record<string, string> = {
  left: 'alignLeft', center: 'alignCenter', right: 'alignRight', justify: 'justifyLastLineLeft',
};

// ── Grapheme split ────────────────────────────────────────────────────

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
let segmenter: Segmenter | null | undefined;

/** Grapheme split — `Intl.Segmenter`, code points where it is missing. */
export function splitSourceGraphemes(text: string): string[] {
  if (!text) return [];
  if (segmenter === undefined) {
    try {
      const Ctor = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => Segmenter }).Segmenter;
      segmenter = Ctor ? new Ctor('und', { granularity: 'grapheme' }) : null;
    } catch {
      segmenter = null;
    }
  }
  if (!segmenter) return [...text];
  const out: string[] = [];
  for (const s of segmenter.segment(text)) out.push(s.segment);
  return out;
}

// ── Effective style resolution ───────────────────────────────────────

/**
 * The layer-wide style an expression result produces, in APP units.
 *
 * Shared by `getStyleAt`/getters here and by the renderer merge in the app, so
 * "what `style.fontSize` reads" and "what the frame draws" have one author.
 */
export function resolveSourceTextStyle(base: SourceTextStyle, o: SourceTextStyleOverrides): SourceTextStyle {
  const fontSize = o.fontSize ?? base.fontSize;
  const out: SourceTextStyle = {
    ...base,
    fontFamily: o.fontFamily ?? base.fontFamily,
    fontSize,
    fontWeight: o.fontWeight ?? base.fontWeight,
    fontStyle: o.fontStyle ?? base.fontStyle,
    fill: o.fill ?? base.fill,
    stroke: o.stroke ?? base.stroke,
    strokeWidth: o.strokeWidth ?? base.strokeWidth,
    letterSpacing: o.tracking !== undefined ? (o.tracking * fontSize) / 1000 : base.letterSpacing,
    lineHeight: o.leading !== undefined && fontSize > 0 ? o.leading / fontSize : base.lineHeight,
    baselineShift: o.baselineShift ?? base.baselineShift,
    horizontalScale: o.horizontalScale ?? base.horizontalScale,
    verticalScale: o.verticalScale ?? base.verticalScale,
    textTransform: o.textTransform ?? base.textTransform,
    fontVariant: o.fontVariant ?? base.fontVariant,
    align: o.align ?? base.align,
    paragraphSpacing: o.spaceAfter !== undefined || o.spaceBefore !== undefined
      ? (o.spaceAfter ?? base.paragraphSpacing) + (o.spaceBefore ?? 0)
      : base.paragraphSpacing,
    firstLineIndent: o.firstLineIndent ?? base.firstLineIndent,
    leftIndent: o.leftIndent ?? base.leftIndent,
    rightIndent: o.rightIndent ?? base.rightIndent,
    spaceBefore: o.spaceBefore ?? base.spaceBefore,
  };
  if (o.applyFill === false) out.fill = 'transparent';
  if (o.applyStroke === false) out.strokeWidth = 0;
  return out;
}

// ── The expression-facing objects ────────────────────────────────────

interface StyleState {
  base: SourceTextSample;
  text: string;
  style: SourceTextStyleOverrides;
  ranges: SourceTextRangeOverride[];
  /** Set by `getStyleAt` — getters then read this character's style. */
  at?: number;
  /** Whether `setText` was called — a result that never set text keeps the source. */
  textSet: boolean;
  /**
   * Built from ANOTHER layer's Source Text. Returning such a style object is
   * AE's "copy that layer's style" idiom, so its whole style — not just what
   * the chain overrode — travels into the result.
   */
  foreign: boolean;
}

/** A full layer style expressed as overrides (AE units where the result uses them). */
function styleAsOverrides(s: SourceTextStyle): SourceTextStyleOverrides {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    fontStyle: s.fontStyle,
    fill: s.fill,
    ...(s.stroke !== undefined ? { stroke: s.stroke } : {}),
    strokeWidth: s.strokeWidth,
    tracking: s.fontSize > 0 ? (s.letterSpacing * 1000) / s.fontSize : 0,
    leading: s.lineHeight * s.fontSize,
    baselineShift: s.baselineShift,
    horizontalScale: s.horizontalScale,
    verticalScale: s.verticalScale,
    textTransform: s.textTransform,
    fontVariant: s.fontVariant,
    align: s.align,
    spaceAfter: s.paragraphSpacing,
  };
}

/**
 * Objects the evaluator produced, mapped to their state. A WeakMap rather than
 * a marker property: an expression can read and copy any property it can see,
 * so a visible marker could be forged into a result; a WeakMap key cannot.
 */
const STYLE_STATES = new WeakMap<object, StyleState>();

const num = (v: unknown, fn: string): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new Error(`${fn}() needs a number.`);
};
const bool = (v: unknown): boolean => Boolean(v);

/** The run style at grapheme `i` from the layer's STORED runs. */
function storedRunAt(sample: SourceTextSample, i: number): SourceTextRunStyle {
  let out: SourceTextRunStyle = {};
  for (const r of sample.runs ?? []) if (i >= r.start && i < r.end) out = { ...out, ...r.style };
  return out;
}

/** AE-unit value of one getter for a state (layer-wide, or at one character). */
function effectiveStyle(state: StyleState): SourceTextStyle {
  let base = state.base.style;
  let o: SourceTextStyleOverrides = state.style;
  if (state.at !== undefined) {
    const i = state.at;
    const run = storedRunAt(state.base, i);
    base = { ...base, ...run };
    const merged: SourceTextStyleOverrides = { ...o };
    for (const r of state.ranges) {
      if (i >= r.start && i < r.start + r.count) Object.assign(merged, r.style);
    }
    o = merged;
    // A stored run's letterSpacing is px at the RUN's size; keep it unless an
    // expression tracking override replaces it.
  }
  return resolveSourceTextStyle(base, o);
}

function pushRange(state: StyleState, key: SourceTextRangeKey, value: unknown, start: unknown, count: unknown, fn: string): StyleState {
  const s = Math.max(0, Math.floor(num(start, fn)));
  const c = count === undefined
    ? splitSourceGraphemes(state.text).length - s
    : Math.max(0, Math.floor(num(count, fn)));
  if (c <= 0) return state;
  if (state.ranges.length >= MAX_RANGE_OVERRIDES) {
    throw new Error(`Too many per-character style ranges (limit ${MAX_RANGE_OVERRIDES}).`);
  }
  return {
    ...state,
    ranges: [...state.ranges, { start: s, count: c, style: { [key]: value } }],
  };
}

type Setter = (value: unknown, startIndex?: unknown, numChars?: unknown) => object;

/**
 * Build the chainable style object for a state.
 *
 * Each setter returns a NEW style object. With a start index it records a
 * range override; without one it overrides the layer-wide style — AE's two
 * overloads.
 */
function makeStyle(state: StyleState): object {
  const next = (s: StyleState): object => makeStyle({ ...s, at: undefined });
  const eff = (): SourceTextStyle => effectiveStyle(state);

  const setter = (
    fn: string,
    key: SourceTextRangeKey | null,
    wholeKey: keyof SourceTextStyleOverrides,
    convert: (v: unknown) => unknown,
  ): Setter => (value, startIndex, numChars) => {
    const v = convert(value);
    if (startIndex !== undefined && key) return next(pushRange(state, key, v, startIndex, numChars, fn));
    if (startIndex !== undefined && !key) throw new Error(`${fn}() is paragraph-wide and takes no character range.`);
    return next({ ...state, style: { ...state.style, [wholeKey]: v } });
  };

  const style = {
    // ── Getters (AE units) ──
    get font(): string { return eff().fontFamily; },
    get fontSize(): number { return eff().fontSize; },
    get fillColor(): number[] { return cssToRgb01(eff().fill); },
    get strokeColor(): number[] { return cssToRgb01(eff().stroke ?? '#000000'); },
    get strokeWidth(): number { return eff().strokeWidth; },
    get tracking(): number { const e = eff(); return e.fontSize > 0 ? (e.letterSpacing * 1000) / e.fontSize : 0; },
    get leading(): number { const e = eff(); return e.lineHeight * e.fontSize; },
    get isFauxBold(): boolean { return Number(eff().fontWeight) >= 700; },
    get isFauxItalic(): boolean { return eff().fontStyle === 'italic'; },
    get isAllCaps(): boolean { return eff().textTransform === 'uppercase'; },
    get isSmallCaps(): boolean { return eff().fontVariant === 'small-caps'; },
    get applyFill(): boolean { const f = eff().fill; return f !== 'transparent' && f !== 'none'; },
    get applyStroke(): boolean { return eff().strokeWidth > 0; },
    get baselineShift(): number { return eff().baselineShift; },
    get horizontalScaling(): number { return eff().horizontalScale / 100; },
    get verticalScaling(): number { return eff().verticalScale / 100; },
    get justification(): string { return ALIGN_TO_JUSTIFY[eff().align] ?? 'alignLeft'; },
    get firstLineIndent(): number { return eff().firstLineIndent; },
    get leftMargin(): number { return eff().leftIndent; },
    get rightMargin(): number { return eff().rightIndent; },
    get spaceBefore(): number { return eff().spaceBefore; },
    get spaceAfter(): number { return state.style.spaceAfter ?? state.base.style.paragraphSpacing; },
    get direction(): string { return state.style.direction === 'rtl' ? 'dirRightToLeft' : 'dirLeftToRight'; },
    get leadingType(): string { return state.style.leadingType === 'eastAsian' ? 'leadingEastAsian' : 'leadingRoman'; },

    // ── Character setters (range-capable) ──
    setFont: setter('setFont', 'fontFamily', 'fontFamily', (v) => {
      if (typeof v !== 'string' || !v.trim()) throw new Error('setFont() needs a font name, e.g. setFont("Inter").');
      return v.trim();
    }),
    setFontSize: setter('setFontSize', 'fontSize', 'fontSize', (v) => Math.max(0.1, num(v, 'setFontSize'))),
    setFillColor: setter('setFillColor', 'fill', 'fill', (v) => rgb01ToCss(v, 'setFillColor')),
    setStrokeColor: setter('setStrokeColor', 'stroke', 'stroke', (v) => rgb01ToCss(v, 'setStrokeColor')),
    setStrokeWidth: setter('setStrokeWidth', 'strokeWidth', 'strokeWidth', (v) => Math.max(0, num(v, 'setStrokeWidth'))),
    setTracking: setter('setTracking', 'tracking', 'tracking', (v) => num(v, 'setTracking')),
    setLeading: setter('setLeading', null, 'leading', (v) => Math.max(0, num(v, 'setLeading'))),
    setFauxBold: setter('setFauxBold', 'fontWeight', 'fontWeight', (v) => {
      const baseW = Number(state.base.style.fontWeight) || 400;
      return bool(v) ? String(Math.max(700, baseW)) : String(baseW >= 700 ? 400 : baseW);
    }),
    setFauxItalic: setter('setFauxItalic', 'fontStyle', 'fontStyle', (v) => (bool(v) ? 'italic' : 'normal')),
    setAllCaps: setter('setAllCaps', 'textTransform', 'textTransform', (v) => (bool(v) ? 'uppercase' : 'none')),
    setSmallCaps: setter('setSmallCaps', 'fontVariant', 'fontVariant', (v) => (bool(v) ? 'small-caps' : 'normal')),
    setApplyFill: setter('setApplyFill', 'applyFill', 'applyFill', bool),
    setApplyStroke: setter('setApplyStroke', 'applyStroke', 'applyStroke', bool),
    setBaselineShift: setter('setBaselineShift', 'baselineShift', 'baselineShift', (v) => num(v, 'setBaselineShift')),
    setHorizontalScaling: setter('setHorizontalScaling', 'horizontalScale', 'horizontalScale', (v) => num(v, 'setHorizontalScaling') * 100),
    setVerticalScaling: setter('setVerticalScaling', 'verticalScale', 'verticalScale', (v) => num(v, 'setVerticalScaling') * 100),

    // ── Paragraph setters (AE 25) ──
    setJustification: setter('setJustification', null, 'align', (v) => {
      const a = typeof v === 'string' ? JUSTIFY_TO_ALIGN[v] : undefined;
      if (!a) throw new Error('setJustification() takes "alignLeft", "alignCenter", "alignRight" or a "justifyLastLine…" value.');
      return a;
    }),
    setFirstLineIndent: setter('setFirstLineIndent', null, 'firstLineIndent', (v) => num(v, 'setFirstLineIndent')),
    setLeftMargin: setter('setLeftMargin', null, 'leftIndent', (v) => num(v, 'setLeftMargin')),
    setRightMargin: setter('setRightMargin', null, 'rightIndent', (v) => num(v, 'setRightMargin')),
    setSpaceBefore: setter('setSpaceBefore', null, 'spaceBefore', (v) => num(v, 'setSpaceBefore')),
    setSpaceAfter: setter('setSpaceAfter', null, 'spaceAfter', (v) => num(v, 'setSpaceAfter')),
    setDirection: setter('setDirection', null, 'direction', (v) =>
      (v === 'dirRightToLeft' || v === 'rtl' ? 'rtl' : 'ltr')),
    setLeadingType: setter('setLeadingType', null, 'leadingType', (v) =>
      (v === 'leadingEastAsian' || v === 'eastAsian' ? 'eastAsian' : 'roman')),

    /** Replace the text this style will be applied to. */
    setText: (value: unknown): object => {
      const s = typeof value === 'string' ? value : String(value ?? '');
      if (s.length > MAX_SOURCE_TEXT_LENGTH) {
        throw new Error(`setText() text is too long (limit ${MAX_SOURCE_TEXT_LENGTH} characters).`);
      }
      return next({ ...state, text: s, textSet: true });
    },
  };
  STYLE_STATES.set(style, state);
  return style;
}

/**
 * `text.sourceText` for a sample: a String object carrying `.style` and
 * `.getStyleAt(i)`.
 *
 * A String OBJECT rather than a plain object with a `toString`, because every
 * string idiom then works with no forwarding list to keep in step — `.length`,
 * `.split`, `.toUpperCase`, `+ " suffix"`, `== "Hello"` — and the evaluator's
 * member read already refuses `constructor` / `__proto__`, so the prototype is
 * no more reachable through it than through a plain string literal.
 */
export function makeSourceTextValue(sample: SourceTextSample, opts: { foreign?: boolean } = {}): object {
  const state: StyleState = {
    base: sample, text: sample.text, style: {}, ranges: [], textSet: false, foreign: opts.foreign === true,
  };
  // A String OBJECT is the point (see the doc comment above), so both the
  // constructor and the wrapper type are deliberate.
  // eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
  const str = new String(sample.text) as String & Record<string, unknown>;
  Object.defineProperty(str, 'style', { get: () => makeStyle(state), enumerable: true });
  Object.defineProperty(str, 'value', { value: sample.text, enumerable: true });
  Object.defineProperty(str, 'getStyleAt', {
    enumerable: true,
    value: (charIndex: unknown): object => {
      const i = Math.max(0, Math.floor(num(charIndex, 'getStyleAt')));
      return makeStyle({ ...state, at: i });
    },
  });
  STYLE_STATES.set(str, state);
  return str;
}

/**
 * Turn whatever an expression on Source Text returned into data.
 *
 * AE's rules: a string is the text; a number or boolean is shown as text; the
 * sourceText itself is a no-op; a style object applies its overrides to the
 * source text (or to the text given with `setText`). Null/undefined is an
 * error — a blank layer from a typo is worse than a stated error.
 */
export function coerceSourceTextResult(
  out: unknown,
  fallbackText: string,
): { result: SourceTextExpressionResult | null; error: string | null } {
  if (out !== null && typeof out === 'object') {
    // A sourceText value IS text — checked before the style lookup, because the
    // String object is registered there too (it backs `.style`).
    if (out instanceof String) return { result: { text: String(out), style: {}, ranges: [] }, error: null };
    const st = STYLE_STATES.get(out);
    if (st) {
      return {
        result: {
          text: st.textSet ? st.text : fallbackText,
          style: st.foreign ? { ...styleAsOverrides(st.base.style), ...st.style } : { ...st.style },
          ranges: st.ranges.map((r) => ({ ...r, style: { ...r.style } })),
        },
        error: null,
      };
    }
    if (Array.isArray(out)) return { result: { text: out.join(','), style: {}, ranges: [] }, error: null };
    return { result: null, error: 'Source Text expressions must return text (or text.sourceText.style…).' };
  }
  if (typeof out === 'string') {
    if (out.length > MAX_SOURCE_TEXT_LENGTH) return { result: null, error: `Text is too long (limit ${MAX_SOURCE_TEXT_LENGTH} characters).` };
    return { result: { text: out, style: {}, ranges: [] }, error: null };
  }
  if (typeof out === 'number') {
    return Number.isFinite(out)
      ? { result: { text: String(out), style: {}, ranges: [] }, error: null }
      : { result: null, error: 'Expression returned a non-finite number.' };
  }
  if (typeof out === 'boolean') return { result: { text: String(out), style: {}, ranges: [] }, error: null };
  return { result: null, error: 'Source Text expressions must return text (or text.sourceText.style…).' };
}

/**
 * A sample AFTER an expression result — what another layer's
 * `thisComp.layer("Title").text.sourceText` reads (AE returns the
 * post-expression text). Ranges are not folded into runs here: a cross-layer
 * read asks about the layer-wide style and the text.
 */
export function sampleAfterResult(sample: SourceTextSample, result: SourceTextExpressionResult | null): SourceTextSample {
  if (!result) return sample;
  return {
    text: result.text,
    style: resolveSourceTextStyle(sample.style, result.style),
    ...(sample.runs ? { runs: sample.runs } : {}),
  };
}
