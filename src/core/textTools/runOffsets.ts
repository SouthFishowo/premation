/**
 * Rich-text run offsets across a text edit — grapheme indices.
 *
 * Runs index user-perceived characters (`splitGraphemes`, see
 * `src/core/text/graphemes.ts`). When text changes — a find/replace, or a
 * Source Text expression that rewrote the string — every run boundary after
 * the change must move by the edit's length delta, or the styling slides onto
 * the wrong letters.
 *
 * `richText.reindexRuns` answers the same question for ONE edit found by
 * prefix/suffix diffing (typing). A Replace All is MANY known edits, and
 * diffing its before/after strings would collapse them into one span from the
 * first match to the last and wipe every run in between — so edits are passed
 * explicitly here.
 *
 * Boundary rules, chosen so a style that covered a replaced word covers its
 * replacement:
 *   • a boundary at or before an edit's start does not move;
 *   • a boundary at or after an edit's end moves by the edit's delta;
 *   • a START inside the replaced span snaps to the replacement's start,
 *     an END inside it snaps to the replacement's end.
 */

import type { RichRun } from '@core/text/textLayout';

/** Replace graphemes `[start, end)` of the ORIGINAL text with `insertLength` new ones. */
export interface GraphemeEdit {
  start: number;
  end: number;
  insertLength: number;
}

/** Map one boundary. `edits` must be sorted and non-overlapping. */
function mapBoundary(i: number, edits: ReadonlyArray<GraphemeEdit>, isEnd: boolean): number {
  let delta = 0;
  for (const e of edits) {
    if (i <= e.start) return i + delta;
    if (i >= e.end) {
      delta += e.insertLength - (e.end - e.start);
      continue;
    }
    // Inside the replaced span.
    return e.start + delta + (isEnd ? e.insertLength : 0);
  }
  return i + delta;
}

/**
 * Shift runs across `edits` and clamp to `newLength` graphemes. Runs that end
 * up empty are dropped; order is preserved.
 */
export function shiftRunsForEdits(
  runs: ReadonlyArray<RichRun>,
  edits: ReadonlyArray<GraphemeEdit>,
  newLength: number,
): RichRun[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const out: RichRun[] = [];
  for (const r of runs) {
    const start = Math.max(0, Math.min(newLength, mapBoundary(r.start, sorted, false)));
    const end = Math.max(0, Math.min(newLength, mapBoundary(r.end, sorted, true)));
    if (end > start) out.push({ start, end, style: r.style });
  }
  return out;
}

/** The single edit that turns `before` into `after` (common prefix / suffix). */
export function diffEdit(before: ReadonlyArray<string>, after: ReadonlyArray<string>): GraphemeEdit {
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (
    suf < before.length - pre
    && suf < after.length - pre
    && before[before.length - 1 - suf] === after[after.length - 1 - suf]
  ) suf++;
  return { start: pre, end: before.length - suf, insertLength: after.length - pre - suf };
}
