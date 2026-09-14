/**
 * Grapheme clusters — the ONE per-character index space for text.
 *
 * ## Why
 *
 * Text used to be split by code point (`[...text]`). That is correct for a
 * surrogate pair ('𝐀') but wrong for anything a reader sees as one character
 * and Unicode spells as several code points:
 *
 *   • emoji ZWJ sequences     '👨‍👩‍👧' = 5 code points
 *   • skin-tone modifiers     '👍🏽'   = 2
 *   • flags                   '🇰🇷'   = 2
 *   • combining marks         'é' written as 'e' + U+0301 = 2
 *
 * The moment a layer had animators, styled runs or a text path, every one of
 * those was drawn as separate pieces (a family emoji fell apart into three
 * people and two invisible joiners, an accent floated off its letter), and a
 * selector's "character 5" disagreed with what the user counted.
 *
 * Every per-character consumer — runs, selectors, animators, layout,
 * per-character 3D and the on-canvas editor's selection mapping — splits with
 * `splitGraphemes`, so they agree about what character N is.
 *
 * ## Migration
 *
 * Documents written before this change store rich-text run offsets in
 * CODE-POINT indices. `richText.readRuns` converts them at read time with
 * `codePointToGraphemeIndex` (see there). For the overwhelming majority of text
 * — anything without multi-code-point clusters — the two index spaces are
 * identical and the conversion is the identity.
 */

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };

let segmenter: Segmenter | null | undefined;

function getSegmenter(): Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    const Ctor = (Intl as unknown as { Segmenter?: new (locale: string, opts: { granularity: string }) => Segmenter })
      .Segmenter;
    segmenter = Ctor ? new Ctor('und', { granularity: 'grapheme' }) : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

/** Test seam: force the code-point fallback (or restore the real segmenter). */
export function setGraphemeSegmenterForTest(mode: 'fallback' | 'auto'): void {
  segmenter = mode === 'fallback' ? null : undefined;
  cache.clear();
}

// A small memo: layout, animators and selectors all split the same string
// several times per frame.
const cache = new Map<string, string[]>();
const MAX_CACHE = 256;

/**
 * Split `text` into user-perceived characters.
 *
 * Uses `Intl.Segmenter` (grapheme granularity). Runtimes without it fall back
 * to code points, which is exactly the previous behaviour. A newline is always
 * its own cluster — "\r\n" is kept as ONE cluster by the segmenter, which is
 * correct, and layout treats any cluster containing '\n' as a line break.
 *
 * The returned array is shared — callers must not mutate it.
 */
export function splitGraphemes(text: string): readonly string[] {
  if (!text) return EMPTY;
  const hit = cache.get(text);
  if (hit) return hit;
  const seg = getSegmenter();
  let out: string[];
  if (seg) {
    out = [];
    for (const s of seg.segment(text)) out.push(s.segment);
  } else {
    out = [...text];
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(text, out);
  return out;
}

const EMPTY: readonly string[] = Object.freeze([]) as readonly string[];

/** Number of grapheme clusters in `text`. */
export function graphemeCount(text: string): number {
  return splitGraphemes(text).length;
}

/** True when every grapheme is a single code point — the index spaces agree. */
export function graphemesAreCodePoints(text: string): boolean {
  return splitGraphemes(text).length === [...text].length;
}

/**
 * Convert a code-point offset into a grapheme offset.
 *
 * An offset that falls INSIDE a cluster rounds UP to the end of that cluster
 * for an end offset and DOWN to its start for a start offset — pass
 * `roundUp` accordingly, so a run that covered part of an emoji keeps covering
 * the whole of it rather than none of it.
 */
export function codePointToGraphemeIndex(text: string, cp: number, roundUp = false): number {
  if (cp <= 0) return 0;
  const gs = splitGraphemes(text);
  let acc = 0;
  for (let i = 0; i < gs.length; i++) {
    const len = [...gs[i]!].length;
    if (cp === acc) return i;
    if (cp < acc + len) return roundUp ? i + 1 : i;
    acc += len;
  }
  return gs.length;
}

/** Convert a grapheme offset into a code-point offset. */
export function graphemeToCodePointIndex(text: string, g: number): number {
  const gs = splitGraphemes(text);
  let acc = 0;
  for (let i = 0; i < Math.min(g, gs.length); i++) acc += [...gs[i]!].length;
  return acc;
}

/** Convert a UTF-16 offset (DOM selection, `string.slice`) into a grapheme offset. */
export function utf16ToGraphemeIndex(text: string, utf16: number): number {
  if (utf16 <= 0) return 0;
  const gs = splitGraphemes(text);
  let acc = 0;
  for (let i = 0; i < gs.length; i++) {
    if (utf16 <= acc) return i;
    acc += gs[i]!.length;
    // A caret can never legally sit inside a cluster; if the DOM reports one,
    // treat it as after the cluster.
    if (utf16 < acc) return i + 1;
  }
  return gs.length;
}

/** True for a cluster that breaks a line. */
export function isLineBreak(cluster: string): boolean {
  return cluster === '\n' || cluster === '\r\n' || cluster === '\r';
}

/**
 * Scripts whose glyphs change shape with their neighbours (cursive joining)
 * or are reordered/stacked by the shaper. Drawing these one cluster at a time
 * breaks them, so the painter keeps runs of them whole wherever it can.
 */
const COMPLEX_SCRIPT =
  // Escaped, not literal: the last range ends on U+FEFF, which lint (rightly)
  // flags as invisible whitespace when written raw.
  /[\u0590-\u08ff\u0900-\u0dff\u0e00-\u0eff\u0f00-\u0fff\u1000-\u109f\u1780-\u17ff\u1800-\u18af\ua840-\ua87f\ufb1d-\ufdff\ufe70-\ufeff]|\uD802[\uDEC0-\uDEFF]|\uD83A[\uDD00-\uDD5F]/;

export function hasComplexScript(text: string): boolean {
  return COMPLEX_SCRIPT.test(text);
}
