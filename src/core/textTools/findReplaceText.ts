/**
 * Find and Replace in text — the pure part.
 *
 * Matching runs over GRAPHEME clusters (`splitGraphemes`), the index space
 * rich-text runs use, so a match boundary can never split an emoji or a
 * combining accent, and the run-offset shift that follows a replacement is in
 * the same units as the runs it moves.
 *
 * "Match case" off compares clusters case-insensitively; "Whole word" requires
 * the characters either side of a match to be non-word characters (letters,
 * digits, marks and `_` are word characters, in any script).
 */

import { splitGraphemes } from '@core/text/graphemes';
import type { RichRun } from '@core/text/textLayout';
import { shiftRunsForEdits, type GraphemeEdit } from './runOffsets';

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}

export interface TextMatch {
  /** Grapheme index of the first matched character. */
  start: number;
  /** Grapheme index one past the last. */
  end: number;
}

const WORD = /[\p{L}\p{N}\p{M}_]/u;

/** Non-overlapping matches, left to right. Empty `find` matches nothing. */
export function findMatches(text: string, find: string, opts: FindOptions = {}): TextMatch[] {
  if (!find || !text) return [];
  const fold = (s: string): string => (opts.matchCase ? s : s.toLowerCase());
  const hay = splitGraphemes(text).map(fold);
  const needle = splitGraphemes(find).map(fold);
  const n = needle.length;
  const out: TextMatch[] = [];
  let i = 0;
  while (i + n <= hay.length) {
    let hit = true;
    for (let k = 0; k < n; k++) {
      if (hay[i + k] !== needle[k]) { hit = false; break; }
    }
    if (hit && opts.wholeWord) {
      const before = hay[i - 1];
      const after = hay[i + n];
      if ((before !== undefined && WORD.test(before)) || (after !== undefined && WORD.test(after))) hit = false;
    }
    if (hit) {
      out.push({ start: i, end: i + n });
      i += n;
    } else {
      i += 1;
    }
  }
  return out;
}

export interface ReplaceResult {
  text: string;
  /** How many matches were replaced. */
  count: number;
  /** The edits applied, in ORIGINAL grapheme indices — for shifting runs. */
  edits: GraphemeEdit[];
}

/** Replace every match. `count === 0` means `text` is returned unchanged. */
export function replaceAllInString(text: string, find: string, replacement: string, opts: FindOptions = {}): ReplaceResult {
  const matches = findMatches(text, find, opts);
  if (matches.length === 0) return { text, count: 0, edits: [] };
  const g = splitGraphemes(text);
  const insertLength = splitGraphemes(replacement).length;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += g.slice(cursor, m.start).join('') + replacement;
    cursor = m.end;
  }
  out += g.slice(cursor).join('');
  return {
    text: out,
    count: matches.length,
    edits: matches.map((m) => ({ start: m.start, end: m.end, insertLength })),
  };
}

/**
 * Replace in a layer's text AND keep its styled runs on the right characters.
 * A run that covered a replaced word covers the replacement.
 */
export function replaceAllWithRuns(
  text: string,
  runs: ReadonlyArray<RichRun>,
  find: string,
  replacement: string,
  opts: FindOptions = {},
): { text: string; runs: RichRun[]; count: number } {
  const r = replaceAllInString(text, find, replacement, opts);
  if (r.count === 0) return { text, runs: [...runs], count: 0 };
  return {
    text: r.text,
    runs: runs.length > 0 ? shiftRunsForEdits(runs, r.edits, splitGraphemes(r.text).length) : [],
    count: r.count,
  };
}
