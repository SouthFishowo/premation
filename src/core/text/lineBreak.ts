/**
 * Where a line (or a vertical column) may break — word boundaries for
 * spaced scripts, any character boundary for CJK, and basic JIS X 4051
 * kinsoku shori (line-start / line-end prohibition).
 *
 * ## Break opportunities
 *
 * Between two units `a | b`:
 *   • never before whitespace (a trailing space hangs past the line end);
 *   • never where kinsoku forbids it — `b` may not START a line (closing
 *     brackets, 、。 small kana, ー …) or `a` may not END one (opening
 *     brackets, currency prefixes);
 *   • always after whitespace;
 *   • always next to an ideographic character (Vertical_Orientation other
 *     than R: ideographs, kana, hangul, full-width forms — UAX #14's ID
 *     class, near enough);
 *   • between two spaced-script characters only at an `Intl.Segmenter`
 *     word boundary where both sides are words (scripts written without
 *     spaces, e.g. Thai) or after a hyphen. Without Intl.Segmenter: spaces
 *     and hyphens only.
 *
 * ## Greedy wrap
 *
 * {@link wrapUnits} fills a line until the next unit would pass the limit,
 * then breaks at the LAST opportunity on the line. A word that alone is
 * longer than the line is broken at the character that overflows — still
 * pushed back a character where that character may not start a line
 * (oidashi). Pure: lengths are the caller's.
 */

import { clusterVerticalOrientation } from './verticalForms';
import { splitGraphemes } from './graphemes';

const cps = (s: string): number[] => [...s].map((c) => c.codePointAt(0)!);

/** JIS X 4051 characters that may not START a line (行頭禁則). */
export const KINSOKU_NO_LINE_START: ReadonlySet<number> = new Set(cps(
  // Closing brackets and quotes
  ')]}’”»〉》」』】〕〗〙〛）］｝｠｣〞〟' +
  // Hyphens, dividing punctuation, middle dots, full stops, commas
  '‐゠–〜～!?！？‼⁇⁈⁉・：；･:;。．｡.、，､,' +
  // Iteration marks, prolonged sound mark, voicing marks
  'ヽヾゝゞ々〻ーｰ゛゜' +
  // Small kana
  'ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿｧｨｩｪｫｬｭｮｯ' +
  // Postfixed abbreviations
  '%％‰℃°′″',
));

/** JIS X 4051 characters that may not END a line (行末禁則). */
export const KINSOKU_NO_LINE_END: ReadonlySet<number> = new Set(cps(
  '([{‘“«〈《「『【〔〖〘〚（［｛｟｢〝' +
  '$＄￥¥＃£￡€',
));

/** Whitespace that hangs at a break. (U+3000 is a CJK character, not this.) */
export function isBreakSpace(unit: string): boolean {
  return unit === ' ' || unit === '\t';
}

/** Breaks freely on either side — Vertical_Orientation U / Tu / Tr. */
export function isIdeographicUnit(unit: string): boolean {
  return unit !== '' && !isBreakSpace(unit) && clusterVerticalOrientation(unit) !== 'R';
}

const HYPHENS: ReadonlySet<number> = new Set([0x2d, 0x2010]);

type WordSegment = { segment: string; index: number; isWordLike?: boolean };
type WordSegmenter = { segment(input: string): Iterable<WordSegment> };
let wordSegmenter: WordSegmenter | null | undefined;

function getWordSegmenter(): WordSegmenter | null {
  if (wordSegmenter !== undefined) return wordSegmenter;
  try {
    const Ctor = (Intl as unknown as { Segmenter?: new (l: string | undefined, o: { granularity: string }) => WordSegmenter }).Segmenter;
    wordSegmenter = Ctor ? new Ctor(undefined, { granularity: 'word' }) : null;
  } catch {
    wordSegmenter = null;
  }
  return wordSegmenter;
}

/** Test hook: run without Intl.Segmenter (the spaces-only fallback). */
export function setWordSegmenterForTest(disabled: boolean): void {
  wordSegmenter = disabled ? null : undefined;
}

/** Kinsoku alone: may a line start at unit `i` (i ≥ 1)? */
export function kinsokuAllows(units: ReadonlyArray<string>, i: number): boolean {
  const a = units[i - 1];
  const b = units[i];
  if (a === undefined || b === undefined) return false;
  const first = b.codePointAt(0);
  const lastChars = [...a];
  const last = lastChars[lastChars.length - 1]?.codePointAt(0);
  if (first !== undefined && KINSOKU_NO_LINE_START.has(first)) return false;
  if (last !== undefined && KINSOKU_NO_LINE_END.has(last)) return false;
  return true;
}

/**
 * `out[i]` — a line may start at unit `i` (see the file docblock). `out[0]`
 * is false. Units are grapheme clusters, or a caller's unbreakable groups.
 */
export function breakOpportunities(units: ReadonlyArray<string>): boolean[] {
  const n = units.length;
  const out = new Array<boolean>(n).fill(false);
  if (n < 2) return out;

  // Word-segment starts where BOTH neighbouring segments are word-like.
  let wordJoins: Set<number> | null = null;
  const seg = getWordSegmenter();
  if (seg) {
    const text = units.join('');
    const starts = new Map<number, number>();
    let off = 0;
    units.forEach((u, i) => { starts.set(off, i); off += u.length; });
    wordJoins = new Set();
    let prevWordLike = false;
    for (const s of seg.segment(text)) {
      const wordLike = s.isWordLike === true;
      const at = starts.get(s.index);
      if (at !== undefined && at > 0 && wordLike && prevWordLike) wordJoins.add(at);
      prevWordLike = wordLike;
    }
  }

  for (let i = 1; i < n; i++) {
    const a = units[i - 1]!;
    const b = units[i]!;
    if (isBreakSpace(b)) continue;
    if (!kinsokuAllows(units, i)) continue;
    if (isBreakSpace(a)) { out[i] = true; continue; }
    if (isIdeographicUnit(a) || isIdeographicUnit(b)) { out[i] = true; continue; }
    const aLast = a.codePointAt(a.length - 1);
    if (aLast !== undefined && HYPHENS.has(aLast)) { out[i] = true; continue; }
    if (wordJoins?.has(i)) out[i] = true;
  }
  return out;
}

/** Slack for float noise when deciding whether a unit still fits, px. */
const FIT_EPS = 0.5;

/**
 * Greedy wrap. Returns the unit indices that START a new line (ascending,
 * never 0). `lengths[i]` is unit i's advance along the line; `limit` may vary
 * by line number (a first-line indent).
 */
export function wrapUnits(
  units: ReadonlyArray<string>,
  lengths: ReadonlyArray<number>,
  limit: number | ((line: number) => number),
  opportunities: ReadonlyArray<boolean> = breakOpportunities(units),
): number[] {
  const starts: number[] = [];
  const limitOf = typeof limit === 'number' ? () => limit : limit;
  if (!(limitOf(0) > 0)) return starts;
  let start = 0;
  let len = 0;
  for (let i = 0; i < units.length; i++) {
    const w = lengths[i] ?? 0;
    if (i > start && !isBreakSpace(units[i]!) && len + w > limitOf(starts.length) + FIT_EPS) {
      let b = i;
      while (b > start && !opportunities[b]) b--;
      if (b === start) {
        // One word longer than the line: break at the overflowing character,
        // pushed back while kinsoku forbids a line to start there.
        b = i;
        while (b - 1 > start && !kinsokuAllows(units, b)) b--;
        if (!kinsokuAllows(units, b)) b = i;
      }
      starts.push(b);
      start = b;
      len = 0;
      for (let k = b; k < i; k++) len += lengths[k] ?? 0;
    }
    len += w;
  }
  return starts;
}

// ── Inserted soft breaks (horizontal CJK paragraphs) ───────────────────

/**
 * Wrap one paragraph's clusters into a string with '\n' soft breaks: a break
 * after a space REPLACES that space (lengths stay aligned, as `wrapText` has
 * always done); a break between CJK characters has no space to replace and
 * INSERTS one.
 */
export function joinWrapped(clusters: ReadonlyArray<string>, starts: ReadonlyArray<number>): string {
  let out = '';
  let s = 0;
  for (let i = 0; i < clusters.length; i++) {
    if (starts[s] === i) {
      s++;
      if (out.endsWith(' ')) out = `${out.slice(0, -1)}\n`;
      else out += '\n';
    }
    out += clusters[i]!;
  }
  return out;
}

/**
 * Grapheme indices (in `wrapped`) of the '\n's that `wrapText` INSERTED —
 * those with neither a newline nor a replaced space under them in `raw`.
 * Empty for every wrap that only replaced spaces.
 */
export function insertedBreakIndices(rawClusters: ReadonlyArray<string>, wrappedClusters: ReadonlyArray<string>): number[] {
  const out: number[] = [];
  if (wrappedClusters.length <= rawClusters.length) return out;
  let i = 0;
  for (let j = 0; j < wrappedClusters.length; j++) {
    const w = wrappedClusters[j]!;
    const r = rawClusters[i];
    if (w === r || (w === '\n' && r === ' ')) i++;
    else if (w === '\n') out.push(j);
    else i++;
  }
  return out;
}

/**
 * Map a layer's logical (raw-text) indices onto its WRAPPED text: runs shift
 * past every inserted soft break and animator output gains a `blank` entry at
 * each one. The stored string never changes — the wrap exists only in the text
 * handed to the painter, and this is the one seam between the two index spaces
 * (buildSnapshot calls it for the static text and for a Source Text
 * expression's text alike). Returns the inputs untouched when nothing was inserted.
 */
export function alignIndicesToWrap<R extends { start: number; end: number }, G>(
  raw: string,
  wrapped: string,
  runs: ReadonlyArray<R> | undefined,
  glyphs: ReadonlyArray<G> | undefined,
  blank: () => G,
): { runs: ReadonlyArray<R> | undefined; glyphs: ReadonlyArray<G> | undefined } {
  if (!(runs || glyphs) || wrapped.length <= raw.length) return { runs, glyphs };
  const inserted = insertedBreakIndices(splitGraphemes(raw), splitGraphemes(wrapped));
  if (inserted.length === 0) return { runs, glyphs };
  let out: G[] | undefined;
  if (glyphs) {
    out = [...glyphs];
    for (const j of inserted) out.splice(j, 0, blank());
  }
  return { runs: runs ? shiftSpansForInsertedBreaks(runs, inserted) : undefined, glyphs: out };
}

/** Shift raw-indexed `[start, end)` spans past the inserted breaks. */
export function shiftSpansForInsertedBreaks<T extends { start: number; end: number }>(
  spans: ReadonlyArray<T>,
  inserted: ReadonlyArray<number>,
): T[] {
  if (inserted.length === 0) return spans.slice();
  // Raw index each break was inserted before.
  const rawPos = inserted.map((j, m) => j - m);
  const before = (k: number, inclusive: boolean): number => {
    let c = 0;
    for (const p of rawPos) if (inclusive ? p <= k : p < k) c++;
    return c;
  };
  return spans.map((s) => ({ ...s, start: s.start + before(s.start, true), end: s.end + before(s.end, false) }));
}
