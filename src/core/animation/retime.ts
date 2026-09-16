/**
 * Retime — the two ways to say which source frame a layer shows, as Twixtor
 * and After Effects' Timewarp both offer them:
 *
 *   - SPEED %      — "play at 100% here, 20% there". A keyframeable rate.
 *   - FRAME NUMBER — "show source frame 142 here". The classic Time Remap.
 *
 * Plus NORMAL, which is neither. The mode is not stored anywhere: it is read
 * off the tracks, so undo, autosave, copy/paste and the timeline cannot
 * disagree with it. A `timeSpeed` track means Speed; a `timeRemap` (or legacy
 * `precompTime`) track without one means Frame Number.
 *
 * ── Why Speed is its own track and not generated remap keyframes ──────────
 * Speed is a RATE; the renderer needs a POSITION, which is its integral (see
 * `speedRamp.ts`). The obvious build writes the integral out as remap
 * keyframes. That gives the document two representations of one decision, and
 * the moment anyone touches the derived one — the graph editor, a paste, an AI
 * tool — they silently disagree. So the speed keys ARE the document and the
 * integral is evaluated here, on demand, exactly, and cached per curve.
 *
 * ── Which axis the speed keys live on ───────────────────────────────────
 * The layer's ordinary keyframe axis (the clip map: `sourceIn + frame − start`),
 * NOT the chain axis `timeRemap` uses. That is what makes a speed curve move
 * with its clip when the bar is dragged, and keeps the diamonds, the graph
 * editor and the inspector on the conversion every other property already
 * uses. The integral starts at the bar's IN-POINT, where the bar's own
 * `sourceIn` frame shows — so the first frame of a clip never jumps when its
 * speed changes, which is what anyone trimming a clip expects of it.
 *
 * ── The one number every consumer needs ─────────────────────────────────
 * `retimedChainTime` answers "what chain-axis time would the old remap track
 * have held here", so every existing consumer (renderer `sourceTime`, frame
 * blending, audio varispeed, nested precomp folds) keeps its single code path
 * and simply asks this instead of sampling `timeRemap` itself.
 */

import type { AnimationEngine, Keyframe } from '@motion/animation';

export const SPEED_PROP = 'timeSpeed';
export const REMAP_PROP = 'timeRemap';
export const LEGACY_REMAP_PROP = 'precompTime';

/** Every track that retimes a layer's source. */
export const RETIME_PROPS: ReadonlySet<string> = new Set([SPEED_PROP, REMAP_PROP, LEGACY_REMAP_PROP]);

export type RetimeMode = 'normal' | 'speed' | 'frames';

/** The slice of the engine this module reads. */
export type RetimeEngine = Pick<AnimationEngine, 'isAnimated' | 'sample' | 'tracksFor'>;

/** Speeds a person can type. Negative plays backwards; 0 holds. */
export const MIN_SPEED_PERCENT = -1000;
export const MAX_SPEED_PERCENT = 1000;

export function clampSpeedPercent(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.max(MIN_SPEED_PERCENT, Math.min(MAX_SPEED_PERCENT, v));
}

export function readRetimeMode(anim: RetimeEngine, nodeId: string): RetimeMode {
  if (anim.isAnimated(nodeId, SPEED_PROP)) return 'speed';
  if (anim.isAnimated(nodeId, REMAP_PROP) || anim.isAnimated(nodeId, LEGACY_REMAP_PROP)) return 'frames';
  return 'normal';
}

export function hasRetime(anim: RetimeEngine, nodeId: string): boolean {
  return readRetimeMode(anim, nodeId) !== 'normal';
}

// ── The bar a time belongs to ──────────────────────────────────────────────

/** What the retime needs to know about the clip bar governing a moment. */
export interface RetimeClip {
  /** Clip-axis time minus comp time, seconds: (sourceIn − start) / fps. */
  offsetSec: number;
  /** Comp time of the bar's in-point, seconds. */
  inSec: number;
}

/** The minimum of a timeline `Layer` this module reads (frames, end exclusive). */
export interface RetimeBar {
  start: number;
  end: number;
  clip: { sourceIn: number };
}

/**
 * The bar live at `frame`, else the NEAREST one.
 *
 * Nearest, not "none": a remap value is allowed to leave the bar's comp range
 * (200% near the out-point reads past it, slow motion near a trimmed in-point
 * reads before it) and still means a position in THIS clip's source. Falling
 * through to raw comp time there showed an unrelated frame.
 */
export function pickRetimeBar<B extends RetimeBar>(bars: ReadonlyArray<B>, frame: number): B | null {
  let best: B | null = null;
  let bestDist = Infinity;
  for (const b of bars) {
    if (frame >= b.start && frame < b.end) return b;
    const dist = frame < b.start ? b.start - frame : frame - (b.end - 1);
    if (dist < bestDist) { bestDist = dist; best = b; }
  }
  return best;
}

export function retimeClipOf(bar: RetimeBar | null, fps: number): RetimeClip | null {
  if (!bar || !(fps > 0)) return null;
  return { offsetSec: (bar.clip.sourceIn - bar.start) / fps, inSec: bar.start / fps };
}

// ── The speed integral ─────────────────────────────────────────────────────

/** Panels per eased segment. The curve is smooth, so this is far below a frame of error. */
const EASED_PANELS = 64;

interface Segment {
  t0: number;
  t1: number;
  /** Speed multipliers (percent / 100) at the ends. */
  v0: number;
  v1: number;
  kind: 'hold' | 'linear' | 'sampled';
  /** Cumulative integral at each panel edge — sampled segments only. */
  cum?: Float64Array;
  /** Speed at each panel edge — sampled segments only. */
  vals?: Float64Array;
}

interface SpeedTable {
  sig: string;
  first: { t: number; v: number };
  last: { t: number; v: number };
  segments: Segment[];
  /** Integral from the first key to the start of each segment. */
  startCum: number[];
}

/**
 * Keyed by the track's keyframes ARRAY, not the engine: `buildSnapshot` wraps
 * the engine in a fresh object per frame, and the array it hands through is the
 * engine's own. The signature still guards against in-place edits of the keys.
 */
const tables = new WeakMap<ReadonlyArray<Keyframe>, SpeedTable>();

function signatureOf(keys: ReadonlyArray<Keyframe>): string {
  let s = '';
  for (const k of keys) {
    s += `${k.t},${k.value},${k.easing ?? ''},${k.bezier ? k.bezier.join(' ') : ''},${k.si ?? ''},${k.so ?? ''};`;
  }
  return s;
}

function speedKeys(anim: RetimeEngine, nodeId: string): ReadonlyArray<Keyframe> {
  const track = anim.tracksFor(nodeId).find((tr) => tr.prop === SPEED_PROP);
  return track?.keyframes ?? [];
}

function buildTable(anim: RetimeEngine, nodeId: string, keys: ReadonlyArray<Keyframe>, sig: string): SpeedTable {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const segments: Segment[] = [];
  const startCum: number[] = [];
  let cum = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const len = b.t - a.t;
    if (!(len > 0)) continue;
    const v0 = a.value / 100;
    const v1 = b.value / 100;
    startCum.push(cum);
    if (a.easing === 'step' || a.easing === 'hold') {
      segments.push({ t0: a.t, t1: b.t, v0, v1, kind: 'hold' });
      cum += v0 * len;
    } else if (a.easing === 'linear' && a.so === undefined && b.si === undefined) {
      segments.push({ t0: a.t, t1: b.t, v0, v1, kind: 'linear' });
      cum += ((v0 + v1) / 2) * len;
    } else {
      // Anything shaped (ease presets, bezier handles, spatial tangents,
      // expressions): integrate the curve the engine actually evaluates, so
      // what you see in the graph is what plays.
      const vals = new Float64Array(EASED_PANELS + 1);
      const c = new Float64Array(EASED_PANELS + 1);
      for (let j = 0; j <= EASED_PANELS; j++) {
        const t = a.t + (len * j) / EASED_PANELS;
        vals[j] = (j === 0 ? a.value : j === EASED_PANELS ? b.value : anim.sample(nodeId, SPEED_PROP, t) ?? a.value) / 100;
      }
      const h = len / EASED_PANELS;
      for (let j = 1; j <= EASED_PANELS; j++) c[j] = c[j - 1]! + ((vals[j - 1]! + vals[j]!) / 2) * h;
      segments.push({ t0: a.t, t1: b.t, v0, v1, kind: 'sampled', cum: c, vals });
      cum += c[EASED_PANELS]!;
    }
  }
  const f = sorted[0]!;
  const l = sorted[sorted.length - 1]!;
  return { sig, first: { t: f.t, v: f.value / 100 }, last: { t: l.t, v: l.value / 100 }, segments, startCum };
}

function tableFor(anim: RetimeEngine, nodeId: string): SpeedTable | null {
  const keys = speedKeys(anim, nodeId);
  if (keys.length === 0) return null;
  const sig = signatureOf(keys);
  const hit = tables.get(keys);
  if (hit && hit.sig === sig) return hit;
  const table = buildTable(anim, nodeId, keys, sig);
  tables.set(keys, table);
  return table;
}

/** ∫ speed from the first key to `x` (negative before it). Speed is held flat outside the keys. */
function cumulativeAt(table: SpeedTable, x: number): number {
  if (x <= table.first.t) return (x - table.first.t) * table.first.v;
  const segs = table.segments;
  if (segs.length === 0 || x >= table.last.t) {
    const total = segs.length === 0 ? 0 : table.startCum[segs.length - 1]! + segmentIntegral(segs[segs.length - 1]!, segs[segs.length - 1]!.t1);
    return total + (x - table.last.t) * table.last.v;
  }
  // Few keys in practice; a linear scan beats a binary search's overhead.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (x <= s.t1) return table.startCum[i]! + segmentIntegral(s, Math.max(s.t0, x));
  }
  return 0;
}

function segmentIntegral(s: Segment, x: number): number {
  const d = x - s.t0;
  if (d <= 0) return 0;
  const len = s.t1 - s.t0;
  if (s.kind === 'hold') return s.v0 * d;
  if (s.kind === 'linear') return s.v0 * d + ((s.v1 - s.v0) * d * d) / (2 * len);
  const h = len / EASED_PANELS;
  const j = Math.min(EASED_PANELS - 1, Math.floor(d / h));
  const into = d - j * h;
  const va = s.vals![j]!;
  const vb = s.vals![j + 1]!;
  return s.cum![j]! + va * into + ((vb - va) * into * into) / (2 * h);
}

/** Speed multiplier (1 = 100%) at clip-axis time `u`. 1 with no speed track. */
export function speedAt(anim: RetimeEngine, nodeId: string, u: number): number {
  if (!anim.isAnimated(nodeId, SPEED_PROP)) return 1;
  const v = anim.sample(nodeId, SPEED_PROP, u);
  return v === undefined ? 1 : v / 100;
}

/** Source seconds advanced between clip-axis times `a` and `b` at the layer's speed curve. */
export function speedAdvance(anim: RetimeEngine, nodeId: string, a: number, b: number): number {
  const table = tableFor(anim, nodeId);
  if (!table) return b - a;
  return cumulativeAt(table, b) - cumulativeAt(table, a);
}

/**
 * The chain-axis time a layer's source is retimed to at comp time `t`, or
 * undefined when the layer is not retimed.
 *
 * Speed mode: the source position is the in-point's source time plus the
 * integral of speed since the in-point, both on the clip axis; subtracting the
 * clip offset hands back a value the unchanged clip map turns into exactly
 * that source position.
 */
export function retimedChainTime(
  anim: RetimeEngine,
  nodeId: string,
  t: number,
  clip: RetimeClip | null,
): number | undefined {
  if (anim.isAnimated(nodeId, SPEED_PROP)) {
    const off = clip?.offsetSec ?? 0;
    const uIn = clip ? clip.inSec + off : 0;
    const source = uIn + speedAdvance(anim, nodeId, uIn, t + off);
    return source - off;
  }
  if (anim.isAnimated(nodeId, REMAP_PROP)) return anim.sample(nodeId, REMAP_PROP, t);
  if (anim.isAnimated(nodeId, LEGACY_REMAP_PROP)) return anim.sample(nodeId, LEGACY_REMAP_PROP, t);
  return undefined;
}
