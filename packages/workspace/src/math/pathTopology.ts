/**
 * Path topology — adding and removing vertices without changing the curve.
 *
 * Pure: every function takes points and returns NEW points. The Direct
 * Selection tool uses these to build the edited outline, and the host binding
 * replays the SAME edit (`PathTopologyEdit`) on every keyframe of an animated
 * path. That replay is the reason the edit is described as (segment, u) or
 * (index) rather than shipped as a finished point list: an animated path is
 * interpolated vertex-by-vertex, so a vertex added to the keyframe at the
 * playhead alone leaves the keyframes with different counts and the
 * interpolator holds instead of morphing.
 *
 * Splitting is linear in the control points, so splitting every keyframe at
 * the same `u` and then interpolating gives exactly the interpolated shape
 * split at `u` — the edit is invisible at every frame, not only at the
 * playhead.
 */

import type { BezierPoint } from './BezierPoint';
import type { Vec2 } from './Vec2';

/** A structural path edit, replayable on any outline with the same vertex count. */
export type PathTopologyEdit =
  | {
      readonly op: 'insert';
      /** Segment from vertex `segment` to the next one (wrapping when closed). */
      readonly segment: number;
      /** Bezier parameter along that segment, strictly inside (0, 1). */
      readonly u: number;
    }
  | { readonly op: 'delete'; readonly index: number }
  /** Several vertices at once (a Delete on a multi-vertex selection). */
  | { readonly op: 'deleteMany'; readonly indices: readonly number[] }
  /**
   * AE's Set First Vertex. A closed outline is ROTATED so `index` leads; an
   * open one can only start at one of its two ends, so the last index reverses
   * it. Either way the drawn curve is unchanged — what moves is where Trim
   * Paths starts and which vertex pairs with which during interpolation.
   */
  | { readonly op: 'firstVertex'; readonly index: number }
  /** AE's Reverse Path Direction: same curve, vertices walked the other way. */
  | { readonly op: 'reverse' }
  /**
   * Continue an open path: the same LOCAL points appended (or prepended) to
   * every state. Unlike a split there is no interpolated position to derive
   * them from, so every keyframe gains the vertices where they were drawn —
   * which is also what AE does.
   */
  | { readonly op: 'extend'; readonly points: readonly BezierPoint[]; readonly atStart: boolean };

/** How many segments an outline of `n` vertices has. */
export function segmentCount(n: number, closed: boolean): number {
  if (n < 2) return 0;
  return closed ? n : n - 1;
}

const mix = (p: Vec2, q: Vec2, u: number): Vec2 => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });

/**
 * Insert a vertex at parameter `u` of `segment` by de Casteljau subdivision.
 * The neighbours' facing handles shorten to match, so the drawn curve is
 * unchanged. The new vertex lands at index `segment + 1` (the end of the array
 * for a closed outline's closing segment). Null when the edit does not apply.
 */
export function splitSegment(
  points: readonly BezierPoint[],
  segment: number,
  u: number,
  closed: boolean,
): BezierPoint[] | null {
  const n = points.length;
  if (!Number.isInteger(segment) || segment < 0 || segment >= segmentCount(n, closed)) return null;
  if (!(u > 0 && u < 1)) return null;
  const ai = segment;
  const bi = (segment + 1) % n;
  const a = points[ai]!;
  const b = points[bi]!;
  const p0 = { x: a.x, y: a.y };
  const p1 = { x: a.outX, y: a.outY };
  const p2 = { x: b.inX, y: b.inY };
  const p3 = { x: b.x, y: b.y };
  const q0 = mix(p0, p1, u);
  const q1 = mix(p1, p2, u);
  const q2 = mix(p2, p3, u);
  const r0 = mix(q0, q1, u);
  const r1 = mix(q1, q2, u);
  const s = mix(r0, r1, u);

  // Spread, not rebuild: host outlines carry extra per-vertex data (a mask
  // vertex's feather override) that must survive the edit.
  const out = points.map((p) => ({ ...p }));
  out[ai] = { ...out[ai]!, outX: q0.x, outY: q0.y };
  out[bi] = { ...out[bi]!, inX: q2.x, inY: q2.y };
  out.splice(segment + 1, 0, { x: s.x, y: s.y, inX: r0.x, inY: r0.y, outX: r1.x, outY: r1.y });
  return out;
}

/** Remove vertex `index`. Null when it does not exist or would leave < 2 vertices. */
export function deleteVertex(points: readonly BezierPoint[], index: number): BezierPoint[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= points.length || points.length <= 2) return null;
  const out = points.map((p) => ({ ...p }));
  out.splice(index, 1);
  return out;
}

/** Remove every listed vertex. Null when any is missing or < 2 would be left. */
export function deleteVertices(points: readonly BezierPoint[], indices: readonly number[]): BezierPoint[] | null {
  const drop = new Set(indices);
  if (drop.size === 0) return null;
  for (const i of drop) if (!Number.isInteger(i) || i < 0 || i >= points.length) return null;
  if (points.length - drop.size < 2) return null;
  return points.filter((_, i) => !drop.has(i)).map((p) => ({ ...p }));
}

/**
 * The same curve walked backwards: order reversed and each vertex's handles
 * swapped, because the segment that LEFT a vertex now ARRIVES at it.
 */
export function reversePath(points: readonly BezierPoint[]): BezierPoint[] {
  return points
    .slice()
    .reverse()
    .map((p) => ({ ...p, inX: p.outX, inY: p.outY, outX: p.inX, outY: p.inY }));
}

/**
 * Make `index` the first vertex (AE Set First Vertex). Closed: a rotation.
 * Open: only an END can lead, so `0` is a no-op copy and the last index
 * reverses the path; anything else is refused (null).
 */
export function setFirstVertex(points: readonly BezierPoint[], index: number, closed: boolean): BezierPoint[] | null {
  const n = points.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) return null;
  if (closed) return [...points.slice(index), ...points.slice(0, index)].map((p) => ({ ...p }));
  if (index === 0) return points.map((p) => ({ ...p }));
  if (index === n - 1) return reversePath(points);
  return null;
}

/** Replay a topology edit. Null when it does not apply to this outline. */
export function applyPathTopology(
  points: readonly BezierPoint[],
  edit: PathTopologyEdit,
  closed: boolean,
): BezierPoint[] | null {
  switch (edit.op) {
    case 'insert':
      return splitSegment(points, edit.segment, edit.u, closed);
    case 'delete':
      return deleteVertex(points, edit.index);
    case 'deleteMany':
      return deleteVertices(points, edit.indices);
    case 'firstVertex':
      return setFirstVertex(points, edit.index, closed);
    case 'reverse':
      return reversePath(points);
    case 'extend': {
      const extra = edit.points.map((p) => ({ ...p }));
      const base = points.map((p) => ({ ...p }));
      return edit.atStart ? [...extra, ...base] : [...base, ...extra];
    }
    default:
      return null;
  }
}

// ── Reshaping (vertex count unchanged) ──────────────────────────────

/** Whether a vertex's two handles are collinear and opposite (a smooth vertex). */
export function isSmoothVertex(p: BezierPoint): boolean {
  if (p.broken) return false;
  const ix = p.inX - p.x;
  const iy = p.inY - p.y;
  const ox = p.outX - p.x;
  const oy = p.outY - p.y;
  const li = Math.hypot(ix, iy);
  const lo = Math.hypot(ox, oy);
  if (li < 1e-9 || lo < 1e-9) return false;
  // Opposite within ~2.5°: cos ≈ -1 and cross ≈ 0.
  return (ix * ox + iy * oy) / (li * lo) < -0.999;
}

/** Turn `p`'s `which` handle to point straight away from the other one, keeping its length. */
function realignOpposite(p: BezierPoint, which: 'in' | 'out'): BezierPoint {
  const lead = which === 'in' ? { x: p.outX - p.x, y: p.outY - p.y } : { x: p.inX - p.x, y: p.inY - p.y };
  const ll = Math.hypot(lead.x, lead.y);
  const own = which === 'in' ? Math.hypot(p.inX - p.x, p.inY - p.y) : Math.hypot(p.outX - p.x, p.outY - p.y);
  if (ll < 1e-9 || own < 1e-9) return p;
  const k = own / ll;
  return which === 'in'
    ? { ...p, inX: p.x - lead.x * k, inY: p.y - lead.y * k }
    : { ...p, outX: p.x - lead.x * k, outY: p.y - lead.y * k };
}

/**
 * Drag a SEGMENT: move the curve point at parameter `u` by `delta`.
 *
 * The standard minimal-change solution. With the end vertices fixed, the curve
 * point is linear in the two inner control points with weights
 * w1 = 3(1−u)²u and w2 = 3(1−u)u², so moving them by `delta·w/(w1²+w2²)` moves
 * B(u) by exactly `delta`, and does it with the smallest total handle motion.
 * `u` is clamped away from the ends, where both weights vanish and the solve
 * would fling the handles to infinity.
 *
 * A neighbour vertex that was SMOOTH before keeps its other handle opposite
 * (its own length kept), so bending a segment does not kink the one beside
 * it — AE's behaviour. A broken or corner neighbour is left alone.
 */
export function bendSegment(
  points: readonly BezierPoint[],
  segment: number,
  u: number,
  delta: Vec2,
  closed: boolean,
): BezierPoint[] | null {
  const n = points.length;
  if (!Number.isInteger(segment) || segment < 0 || segment >= segmentCount(n, closed)) return null;
  const t = Math.min(0.95, Math.max(0.05, u));
  const w1 = 3 * (1 - t) * (1 - t) * t;
  const w2 = 3 * (1 - t) * t * t;
  const k = 1 / (w1 * w1 + w2 * w2);
  const ai = segment;
  const bi = (segment + 1) % n;
  const out = points.map((p) => ({ ...p }));
  const a = out[ai]!;
  const b = out[bi]!;
  const aSmooth = isSmoothVertex(a);
  const bSmooth = isSmoothVertex(b);
  out[ai] = { ...a, outX: a.outX + delta.x * w1 * k, outY: a.outY + delta.y * w1 * k };
  out[bi] = { ...b, inX: b.inX + delta.x * w2 * k, inY: b.inY + delta.y * w2 * k };
  if (aSmooth) out[ai] = realignOpposite(out[ai]!, 'in');
  if (bSmooth) out[bi] = realignOpposite(out[bi]!, 'out');
  return out;
}

/** RotoBezier's default tension — the chord/3 handles of a Catmull-Rom smooth. */
export const ROTO_DEFAULT_TENSION = 1 / 3;

/**
 * RotoBezier: every handle computed from the neighbours instead of stored.
 *
 * Each vertex's handles lie along the chord from its previous to its next
 * vertex (Catmull-Rom's tangent direction), each as long as its own segment
 * times `(1 − tension) / 2`. Tension 1/3 gives the familiar chord/3 smooth,
 * 0 the loosest curve, 1 a corner — AE's "click a RotoBezier vertex: 100% =
 * corner, again: 33% smooth". An open path's two ends have one neighbour and
 * no direction to share, so they stay corners.
 */
export function rotoBezierPoints(points: readonly BezierPoint[], closed: boolean): BezierPoint[] {
  const n = points.length;
  return points.map((p, i) => {
    const prev = i > 0 ? points[i - 1] : closed ? points[n - 1] : undefined;
    const next = i < n - 1 ? points[i + 1] : closed ? points[0] : undefined;
    if (!prev || !next || n < 2) return { ...p, inX: p.x, inY: p.y, outX: p.x, outY: p.y };
    const tension = Math.min(1, Math.max(0, p.tension ?? ROTO_DEFAULT_TENSION));
    const s = (1 - tension) / 2;
    const cx = next.x - prev.x;
    const cy = next.y - prev.y;
    const cl = Math.hypot(cx, cy);
    if (cl < 1e-9) return { ...p, inX: p.x, inY: p.y, outX: p.x, outY: p.y };
    const ux = cx / cl;
    const uy = cy / cl;
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y) * s;
    const outLen = Math.hypot(next.x - p.x, next.y - p.y) * s;
    return { ...p, inX: p.x - ux * inLen, inY: p.y - uy * inLen, outX: p.x + ux * outLen, outY: p.y + uy * outLen };
  });
}

/** An affine map `x' = a·x + c·y + e`, `y' = b·x + d·y + f` (canvas convention). */
interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }

/**
 * Free Transform Points: map the listed vertices — handles included, so the
 * curve around them scales and turns rather than only its anchors moving —
 * through `m`. Vertices not listed are untouched.
 */
export function transformVertices(points: readonly BezierPoint[], indices: Iterable<number>, m: Affine): BezierPoint[] {
  const pick = new Set(indices);
  const ap = (x: number, y: number): [number, number] => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  return points.map((p, i) => {
    if (!pick.has(i)) return { ...p };
    const [x, y] = ap(p.x, p.y);
    const [inX, inY] = ap(p.inX, p.inY);
    const [outX, outY] = ap(p.outX, p.outY);
    return { ...p, x, y, inX, inY, outX, outY };
  });
}

function cubicAt(a: BezierPoint, b: BezierPoint, u: number): Vec2 {
  const v = 1 - u;
  const w0 = v * v * v;
  const w1 = 3 * v * v * u;
  const w2 = 3 * v * u * u;
  const w3 = u * u * u;
  return {
    x: w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x,
    y: w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y,
  };
}

/**
 * The closest point on any segment of an outline to `p`.
 *
 * A coarse scan finds the right neighbourhood (a cubic can double back, so a
 * pure local search from u = 0.5 could settle on the wrong lobe), then a
 * ternary refinement pins `u` well below a pixel. Null for < 2 vertices.
 */
export function nearestSegmentParam(
  points: readonly BezierPoint[],
  closed: boolean,
  p: Vec2,
): { segment: number; u: number; distance: number; point: Vec2 } | null {
  const n = points.length;
  const segs = segmentCount(n, closed);
  if (segs === 0) return null;
  const SAMPLES = 32;
  const dist = (q: Vec2): number => Math.hypot(q.x - p.x, q.y - p.y);
  let best: { segment: number; u: number; distance: number; point: Vec2 } | null = null;
  for (let s = 0; s < segs; s++) {
    const a = points[s]!;
    const b = points[(s + 1) % n]!;
    let bu = 0;
    let bd = Infinity;
    for (let i = 0; i <= SAMPLES; i++) {
      const d = dist(cubicAt(a, b, i / SAMPLES));
      if (d < bd) { bd = d; bu = i / SAMPLES; }
    }
    let lo = Math.max(0, bu - 1 / SAMPLES);
    let hi = Math.min(1, bu + 1 / SAMPLES);
    for (let k = 0; k < 40; k++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (dist(cubicAt(a, b, m1)) < dist(cubicAt(a, b, m2))) hi = m2;
      else lo = m1;
    }
    const u = (lo + hi) / 2;
    const point = cubicAt(a, b, u);
    const d = dist(point);
    if (!best || d < best.distance) best = { segment: s, u, distance: d, point };
  }
  return best;
}
