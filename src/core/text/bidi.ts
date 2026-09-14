/**
 * The Unicode Bidirectional Algorithm (UAX #9) — resolved embedding levels and
 * visual order for a paragraph / line of text.
 *
 * ## Scope
 *
 * The full algorithm through rule L2, on the Unicode Character Database tables
 * generated into `bidiData.ts` (see `scripts/generate-bidi-data.mjs` for the
 * Unicode version):
 *
 *   • P1–P3: paragraphs split at B; the paragraph level is either given
 *     (AE's Paragraph panel "Right-to-left text direction") or found from the
 *     first strong character, skipping isolates ('auto');
 *   • X1–X10: explicit embeddings, overrides and isolates (LRE/RLE/LRO/RLO/PDF,
 *     LRI/RLI/FSI/PDI) on the directional status stack (max_depth 125, with
 *     the overflow isolate / embedding counters), level runs and isolating run
 *     sequences (BD13) with their sos / eos;
 *   • W1–W7, N0 (paired brackets: BD16 with the 63-entry stack, canonical
 *     equivalents such as U+2329 ≡ U+3008, NSMs following a bracket), N1–N2,
 *     I1–I2;
 *   • L1 (separators, and whitespace / isolate formatting characters before
 *     them or at the end of the line, reset to the paragraph level) and L2.
 *
 * Characters X9 removes (embeddings, overrides, PDF, BN) are NOT dropped from
 * the output: each keeps its logical slot and takes the level of the character
 * before it (the paragraph level at the start), so per-index consumers — text
 * animators, selectors, grapheme indexing — stay aligned. That choice never
 * changes the relative visual order of the other characters.
 *
 * L3 (combining marks) is handled by clustering (`clusterLevels`), L4
 * (mirroring) by the canvas, which mirrors a glyph drawn with
 * `ctx.direction = 'rtl'`.
 *
 * Pure: no canvas, no DOM.
 */

import { BIDI_BRACKETS, BIDI_BRACKET_CANONICAL, BIDI_CLASS_NAMES, BIDI_CLASS_TABLE } from './bidiData';

export type BidiClass =
  | 'L' | 'R' | 'AL' | 'EN' | 'ES' | 'ET' | 'AN' | 'CS' | 'NSM' | 'BN' | 'B' | 'S' | 'WS' | 'ON'
  | 'LRE' | 'LRO' | 'RLE' | 'RLO' | 'PDF' | 'LRI' | 'RLI' | 'FSI' | 'PDI';

/** A paragraph direction: 0 = LTR, 1 = RTL, 'auto' = first strong (P2/P3, LTR if none). */
export type BidiDirection = 0 | 1 | 'auto';

// Numeric class ids — the order of BIDI_CLASS_NAMES.
const L = 0, R = 1, AL = 2, EN = 3, ES = 4, ET = 5, AN = 6, CS = 7, NSM = 8, BN = 9, B = 10, S = 11, WS = 12, ON = 13,
  LRE = 14, LRO = 15, RLE = 16, RLO = 17, PDF = 18, LRI = 19, RLI = 20, FSI = 21, PDI = 22;

const NAMES = BIDI_CLASS_NAMES as ReadonlyArray<BidiClass>;
const ID = new Map<BidiClass, number>(NAMES.map((n, i) => [n, i]));

// ── Tables ──────────────────────────────────────────────────────────────────

let starts: Uint32Array | null = null;
let classIds: Uint8Array | null = null;
const LATIN1 = new Uint8Array(256);

function decodeClasses(): void {
  const s: number[] = [];
  const c: number[] = [];
  let at = 0;
  let digits = '';
  for (let i = 0; i < BIDI_CLASS_TABLE.length; i++) {
    const ch = BIDI_CLASS_TABLE.charCodeAt(i);
    if (ch >= 65 && ch <= 90) {
      at += digits ? parseInt(digits, 36) : 0;
      s.push(at);
      c.push(ch - 65);
      digits = '';
    } else {
      digits += BIDI_CLASS_TABLE[i];
    }
  }
  starts = Uint32Array.from(s);
  classIds = Uint8Array.from(c);
  let k = 0;
  for (let cp = 0; cp < 256; cp++) {
    while (k + 1 < s.length && s[k + 1]! <= cp) k++;
    LATIN1[cp] = c[k]!;
  }
}

function classIdOf(cp: number): number {
  if (!starts) decodeClasses();
  if (cp < 256) return LATIN1[cp]!;
  const st = starts!;
  let lo = 0;
  let hi = st.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (st[mid]! <= cp) lo = mid;
    else hi = mid - 1;
  }
  return classIds![lo]!;
}

let bracketMap: Map<number, { pair: number; open: boolean }> | null = null;
let canonicalMap: Map<number, number> | null = null;

function brackets(): Map<number, { pair: number; open: boolean }> {
  if (!bracketMap) {
    bracketMap = new Map();
    for (const e of BIDI_BRACKETS.split(',')) {
      const [a, b, t] = e.split(':');
      bracketMap.set(parseInt(a!, 16), { pair: parseInt(b!, 16), open: t === 'o' });
    }
    canonicalMap = new Map();
    for (const e of BIDI_BRACKET_CANONICAL.split(',')) {
      if (!e) continue;
      const [a, b] = e.split(':');
      canonicalMap.set(parseInt(a!, 16), parseInt(b!, 16));
    }
  }
  return bracketMap;
}

const canonical = (cp: number): number => canonicalMap?.get(cp) ?? cp;

/** The bidi class of one code point (Unicode Bidi_Class). */
export function bidiClassOf(cp: number): BidiClass {
  return NAMES[classIdOf(cp)]!;
}

/**
 * Bidi_Paired_Bracket / Bidi_Paired_Bracket_Type of one code point, or null
 * when it is not a paired bracket.
 */
export function bidiPairedBracket(cp: number): { pair: number; type: 'open' | 'close' } | null {
  const b = brackets().get(cp);
  return b ? { pair: b.pair, type: b.open ? 'open' : 'close' } : null;
}

/** True when the string contains a strong right-to-left character. */
export function hasStrongRtl(text: string): boolean {
  for (const ch of text) {
    const c = classIdOf(ch.codePointAt(0)!);
    if (c === R || c === AL) return true;
  }
  return false;
}

// ── The algorithm ───────────────────────────────────────────────────────────

const MAX_DEPTH = 125;
const MAX_BRACKET_PAIRS = 63;

const isIsolateInitiator = (c: number): boolean => c === LRI || c === RLI || c === FSI;
const isRemovedByX9 = (c: number): boolean => c === BN || (c >= LRE && c <= PDF);

/** Result of resolving a paragraph (or several, split at B). */
export interface BidiResolution {
  /** One level per input entry. X9-removed entries take the preceding level. */
  levels: number[];
  /** The level of the FIRST paragraph (0 or 1). */
  paragraphLevel: 0 | 1;
}

/**
 * P2/P3: the first strong type in [from, to), skipping isolate initiators up
 * to their matching PDI and stopping at a paragraph separator. -1 when none.
 */
function firstStrong(types: ArrayLike<number>, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = types[i]!;
    if (isIsolateInitiator(c)) depth++;
    else if (c === PDI) {
      if (depth > 0) depth--;
    } else if (c === B) return -1;
    else if (depth === 0 && (c === L || c === R || c === AL)) return c === L ? 0 : 1;
  }
  return -1;
}

/** The P2/P3 paragraph level of a string: 1 when its first strong character is R or AL. */
export function paragraphLevelOf(text: string): 0 | 1 {
  const types = [...text].map((ch) => classIdOf(ch.codePointAt(0)!));
  return firstStrong(types, 0, types.length) === 1 ? 1 : 0;
}

/**
 * Resolve one paragraph [from, to) of `types` in place into `levels`.
 * `cps` (code points) enables N0; without it brackets are not paired.
 */
function resolveParagraph(
  initial: ArrayLike<number>,
  cps: ArrayLike<number> | null,
  from: number,
  to: number,
  direction: BidiDirection,
  levels: number[],
): 0 | 1 {
  const n = to - from;
  const types = new Uint8Array(n); // current (resolved-so-far) types
  const orig = new Uint8Array(n);
  for (let i = 0; i < n; i++) orig[i] = types[i] = initial[from + i]!;
  const lv = new Uint8Array(n);

  // BD9: matching PDI of every isolate initiator.
  const matchingPdi = new Int32Array(n).fill(-1);
  const matchedByInitiator = new Uint8Array(n);
  {
    const open: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = orig[i]!;
      if (isIsolateInitiator(c)) open.push(i);
      else if (c === PDI && open.length > 0) {
        const j = open.pop()!;
        matchingPdi[j] = i;
        matchedByInitiator[i] = 1;
      }
    }
  }

  const paraLevel: 0 | 1 = direction === 'auto' ? (firstStrong(orig, 0, n) === 1 ? 1 : 0) : direction;

  // X1–X8: the directional status stack.
  {
    const stLevel = new Uint8Array(MAX_DEPTH + 2);
    const stOverride = new Uint8Array(MAX_DEPTH + 2); // 0 neutral, 1 → L, 2 → R
    const stIsolate = new Uint8Array(MAX_DEPTH + 2);
    let sp = 0;
    stLevel[0] = paraLevel;
    let overflowIsolates = 0;
    let overflowEmbeddings = 0;
    let validIsolates = 0;
    for (let i = 0; i < n; i++) {
      const c = orig[i]!;
      switch (c) {
        case RLE: case LRE: case RLO: case LRO: {
          const cur = stLevel[sp]!;
          const next = c === RLE || c === RLO ? (cur + 1) | 1 : (cur + 2) & ~1;
          lv[i] = cur;
          if (next <= MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0) {
            sp++;
            stLevel[sp] = next;
            stOverride[sp] = c === RLO ? 2 : c === LRO ? 1 : 0;
            stIsolate[sp] = 0;
          } else if (overflowIsolates === 0) {
            overflowEmbeddings++;
          }
          break;
        }
        case RLI: case LRI: case FSI: {
          const cur = stLevel[sp]!;
          lv[i] = cur;
          if (stOverride[sp]) types[i] = stOverride[sp] === 1 ? L : R;
          let rtl = c === RLI;
          if (c === FSI) {
            const end = matchingPdi[i]! >= 0 ? matchingPdi[i]! : n;
            rtl = firstStrong(orig, i + 1, end) === 1;
          }
          const next = rtl ? (cur + 1) | 1 : (cur + 2) & ~1;
          if (next <= MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0) {
            validIsolates++;
            sp++;
            stLevel[sp] = next;
            stOverride[sp] = 0;
            stIsolate[sp] = 1;
          } else {
            overflowIsolates++;
          }
          break;
        }
        case PDI: {
          if (overflowIsolates > 0) overflowIsolates--;
          else if (validIsolates > 0) {
            overflowEmbeddings = 0;
            while (!stIsolate[sp]) sp--;
            sp--;
            validIsolates--;
          }
          lv[i] = stLevel[sp]!;
          if (stOverride[sp]) types[i] = stOverride[sp] === 1 ? L : R;
          break;
        }
        case PDF: {
          lv[i] = stLevel[sp]!;
          if (overflowIsolates > 0) { /* nothing */ }
          else if (overflowEmbeddings > 0) overflowEmbeddings--;
          else if (!stIsolate[sp] && sp >= 1) sp--;
          break;
        }
        case B:
          lv[i] = paraLevel;
          break;
        case BN:
          lv[i] = stLevel[sp]!;
          break;
        default:
          lv[i] = stLevel[sp]!;
          if (stOverride[sp]) types[i] = stOverride[sp] === 1 ? L : R;
      }
    }
  }

  // X9 + X10: level runs over the remaining characters, then isolating run
  // sequences (BD13). Runs, sequence levels and sos / eos read the EXPLICIT
  // levels (`xl`); I1/I2 of an earlier sequence must not leak into them.
  const xl = lv.slice();
  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (!isRemovedByX9(orig[i]!)) kept.push(i);
  const runs: number[][] = [];
  const runOf = new Int32Array(n).fill(-1);
  for (let k = 0; k < kept.length; k++) {
    const i = kept[k]!;
    if (k === 0 || xl[kept[k - 1]!] !== xl[i]) runs.push([]);
    runs[runs.length - 1]!.push(i);
    runOf[i] = runs.length - 1;
  }
  const bracketTable = cps ? brackets() : null;

  for (const run of runs) {
    const first = run[0]!;
    if (orig[first] === PDI && matchedByInitiator[first]) continue;
    const seq: number[] = run.slice();
    for (;;) {
      const last = seq[seq.length - 1]!;
      if (!isIsolateInitiator(orig[last]!) || matchingPdi[last]! < 0) break;
      const r = runOf[matchingPdi[last]!]!;
      if (r < 0) break;
      for (const i of runs[r]!) seq.push(i);
    }
    resolveSequence(seq);
  }

  function resolveSequence(seq: number[]): void {
    const m = seq.length;
    const level = xl[seq[0]!]!;
    // sos / eos from the neighbouring (non-removed) characters.
    let before = paraLevel as number;
    for (let i = seq[0]! - 1; i >= 0; i--) if (!isRemovedByX9(orig[i]!)) { before = xl[i]!; break; }
    const lastIdx = seq[m - 1]!;
    let after = paraLevel as number;
    if (!isIsolateInitiator(orig[lastIdx]!)) {
      for (let i = lastIdx + 1; i < n; i++) if (!isRemovedByX9(orig[i]!)) { after = xl[i]!; break; }
    }
    const sos = Math.max(before, level) % 2 ? R : L;
    const eos = Math.max(after, level) % 2 ? R : L;
    const t = new Uint8Array(m);
    for (let k = 0; k < m; k++) t[k] = types[seq[k]!]!;

    // W1
    for (let k = 0; k < m; k++) {
      if (t[k] !== NSM) continue;
      if (k === 0) t[k] = sos;
      else {
        const p = t[k - 1]!;
        t[k] = isIsolateInitiator(p) || p === PDI ? ON : p;
      }
    }
    // W2
    {
      let strong = sos;
      for (let k = 0; k < m; k++) {
        const c = t[k]!;
        if (c === L || c === R || c === AL) strong = c;
        else if (c === EN && strong === AL) t[k] = AN;
      }
    }
    // W3
    for (let k = 0; k < m; k++) if (t[k] === AL) t[k] = R;
    // W4
    for (let k = 1; k + 1 < m; k++) {
      const c = t[k]!;
      if (c === ES && t[k - 1] === EN && t[k + 1] === EN) t[k] = EN;
      else if (c === CS) {
        const a = t[k - 1]!;
        if ((a === EN || a === AN) && t[k + 1] === a) t[k] = a;
      }
    }
    // W5
    for (let k = 0; k < m; k++) {
      if (t[k] !== ET) continue;
      let end = k;
      while (end < m && t[end] === ET) end++;
      const touches = (k > 0 && t[k - 1] === EN) || (end < m && t[end] === EN);
      if (touches) for (let j = k; j < end; j++) t[j] = EN;
      k = end - 1;
    }
    // W6
    for (let k = 0; k < m; k++) {
      const c = t[k]!;
      if (c === ES || c === ET || c === CS) t[k] = ON;
    }
    // W7
    {
      let strong = sos;
      for (let k = 0; k < m; k++) {
        const c = t[k]!;
        if (c === L || c === R) strong = c;
        else if (c === EN && strong === L) t[k] = L;
      }
    }

    const e = level % 2 ? R : L;
    const strongDir = (c: number): number => (c === L ? L : c === R || c === EN || c === AN ? R : -1);

    // N0: paired brackets.
    if (bracketTable) {
      const pairs: Array<[number, number]> = [];
      const stackPair: number[] = [];
      const stackPos: number[] = [];
      for (let k = 0; k < m; k++) {
        if (t[k] !== ON) continue;
        const cp = cps![from + seq[k]!]!;
        const br = bracketTable.get(cp);
        if (!br) continue;
        if (br.open) {
          if (stackPair.length === MAX_BRACKET_PAIRS) break;
          stackPair.push(canonical(br.pair));
          stackPos.push(k);
        } else {
          const want = canonical(cp);
          for (let s = stackPair.length - 1; s >= 0; s--) {
            if (stackPair[s] === want) {
              pairs.push([stackPos[s]!, k]);
              stackPair.length = s;
              stackPos.length = s;
              break;
            }
          }
        }
      }
      pairs.sort((a, b) => a[0] - b[0]);
      for (const [open, close] of pairs) {
        let sawE = false;
        let sawOpposite = false;
        for (let k = open + 1; k < close; k++) {
          const d = strongDir(t[k]!);
          if (d === e) { sawE = true; break; }
          if (d >= 0) sawOpposite = true;
        }
        let resolved = -1;
        if (sawE) resolved = e;
        else if (sawOpposite) {
          let ctx = sos;
          for (let k = open - 1; k >= 0; k--) {
            const d = strongDir(t[k]!);
            if (d >= 0) { ctx = d; break; }
          }
          resolved = ctx !== e ? ctx : e;
        }
        if (resolved < 0) continue;
        for (const pos of [open, close]) {
          t[pos] = resolved;
          for (let k = pos + 1; k < m && orig[seq[k]!] === NSM; k++) t[k] = resolved;
        }
      }
    }

    // N1 / N2
    const isNI = (c: number): boolean => c === B || c === S || c === WS || c === ON || c === LRI || c === RLI || c === FSI || c === PDI;
    for (let k = 0; k < m; k++) {
      if (!isNI(t[k]!)) continue;
      let end = k;
      while (end < m && isNI(t[end]!)) end++;
      const lead = k === 0 ? sos : strongDir(t[k - 1]!);
      const trail = end === m ? eos : strongDir(t[end]!);
      const resolved = lead === trail && lead >= 0 ? lead : e;
      for (let j = k; j < end; j++) t[j] = resolved;
      k = end - 1;
    }

    // I1 / I2
    for (let k = 0; k < m; k++) {
      const c = t[k]!;
      const i = seq[k]!;
      if (level % 2 === 0) {
        if (c === R) lv[i] = level + 1;
        else if (c === AN || c === EN) lv[i] = level + 2;
      } else if (c === L || c === EN || c === AN) {
        lv[i] = level + 1;
      }
    }
  }

  // Removed characters: the level of the character before them.
  for (let i = 0; i < n; i++) if (isRemovedByX9(orig[i]!)) lv[i] = i > 0 ? lv[i - 1]! : paraLevel;

  // L1 on the ORIGINAL classes. The paragraph is also the end of a line.
  let trailing = true;
  for (let i = n - 1; i >= 0; i--) {
    const c = orig[i]!;
    if (c === S || c === B) {
      lv[i] = paraLevel;
      trailing = true;
    } else if (trailing && (c === WS || isIsolateInitiator(c) || c === PDI || isRemovedByX9(c))) {
      lv[i] = paraLevel;
    } else {
      trailing = false;
    }
  }

  for (let i = 0; i < n; i++) levels[from + i] = lv[i]!;
  return paraLevel;
}

function resolveIds(ids: ArrayLike<number>, cps: ArrayLike<number> | null, direction: BidiDirection): BidiResolution {
  const n = ids.length;
  const levels = new Array<number>(n);
  let first: 0 | 1 | null = null;
  let start = 0;
  // P1: split into paragraphs; a B belongs to the paragraph it ends.
  for (let i = 0; i <= n; i++) {
    if (i < n && ids[i] !== B) continue;
    const end = Math.min(n, i + 1);
    if (end > start) {
      const p = resolveParagraph(ids, cps, start, end, direction, levels);
      if (first === null) first = p;
    }
    start = end;
  }
  const paragraphLevel: 0 | 1 = first ?? (direction === 'auto' ? 0 : direction);
  return { levels, paragraphLevel };
}

/**
 * Embedding levels, one per entry of `classes`, for text at `paragraphLevel`
 * (0 = LTR, 1 = RTL, 'auto' = P2/P3). Pass the matching `codePoints` to pair
 * brackets (N0); classes alone cannot identify them.
 */
export function resolveLevels(
  input: ReadonlyArray<BidiClass>,
  paragraphLevel: BidiDirection,
  codePoints?: ReadonlyArray<number>,
): number[] {
  const ids = input.map((c) => ID.get(c) ?? ON);
  return resolveIds(ids, codePoints ?? null, paragraphLevel).levels;
}

/** Levels (and the resolved paragraph level) for a sequence of code points. */
export function resolveCodePoints(codePoints: ReadonlyArray<number>, direction: BidiDirection): BidiResolution {
  return resolveIds(codePoints.map(classIdOf), codePoints, direction);
}

/**
 * L2: the visual order of `levels` — `order[v]` is the logical index drawn at
 * visual position `v` (left to right).
 */
export function visualOrder(levels: ReadonlyArray<number>): number[] {
  const order = levels.map((_, i) => i);
  if (levels.length === 0) return order;
  let max = 0;
  let min = Infinity;
  for (const lv of levels) {
    if (lv > max) max = lv;
    if (lv < min) min = lv;
  }
  // "To the lowest odd level on each line, including intermediate levels not
  // actually present in the text."
  const minOdd = min % 2 === 1 ? min : min + 1;
  for (let lv = max; lv >= minOdd; lv--) {
    let i = 0;
    while (i < order.length) {
      if (levels[order[i]!]! < lv) { i++; continue; }
      let j = i;
      while (j < order.length && levels[order[j]!]! >= lv) j++;
      // Reverse [i, j).
      for (let a = i, b = j - 1; a < b; a++, b--) {
        const tmp = order[a]!;
        order[a] = order[b]!;
        order[b] = tmp;
      }
      i = j;
    }
  }
  return order;
}

/**
 * Levels for a sequence of grapheme CLUSTERS: each cluster takes the level of
 * its first code point (a cluster's marks are NSM and resolve with it).
 */
export function clusterLevels(clusters: ReadonlyArray<string>, paragraphLevel: BidiDirection): number[] {
  return clusterBidi(clusters, paragraphLevel).levels;
}

/** `clusterLevels` plus the resolved paragraph level (P2/P3 under 'auto'). */
export function clusterBidi(clusters: ReadonlyArray<string>, direction: BidiDirection): { levels: number[]; paragraphLevel: 0 | 1 } {
  const cps: number[] = [];
  const firstCp: number[] = [];
  for (const cl of clusters) {
    firstCp.push(cps.length);
    for (const ch of cl) cps.push(ch.codePointAt(0)!);
    // An empty cluster holds a slot as a boundary neutral (ZWNBSP, class BN).
    if (cl.length === 0) cps.push(0xfeff);
  }
  const { levels, paragraphLevel: p } = resolveCodePoints(cps, direction);
  return { levels: firstCp.map((k) => levels[k] ?? p), paragraphLevel: p };
}

/**
 * L1 at the end of a LINE: the trailing whitespace, isolate formatting and
 * X9-removed clusters of `clusters` go back to the paragraph level, in place.
 * The paragraph resolution already did this at the paragraph's own end; a
 * paragraph wrapped into several lines needs it at every line end too.
 */
export function resetLineEnd(clusters: ReadonlyArray<string>, levels: number[], paragraphLevel: 0 | 1): void {
  for (let i = Math.min(clusters.length, levels.length) - 1; i >= 0; i--) {
    const cl = clusters[i]!;
    const c = cl.length === 0 ? BN : classIdOf(cl.codePointAt(0)!);
    if (c === WS || isIsolateInitiator(c) || c === PDI || isRemovedByX9(c)) levels[i] = paragraphLevel;
    else break;
  }
}

/** Convenience: the visual string of one line (tests, debugging). */
export function reorderLine(text: string, paragraphLevel: BidiDirection): string {
  const cps = [...text];
  const { levels } = resolveCodePoints(cps.map((c) => c.codePointAt(0)!), paragraphLevel);
  return visualOrder(levels).map((i) => cps[i]!).join('');
}
