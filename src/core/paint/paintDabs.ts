/**
 * The dab model of a paint stroke — pure geometry, no canvas.
 *
 * AE's brush is not a stroked line. It is a sequence of tip impressions
 * ("dabs") placed along the path every `spacing × diameter`, each one an
 * elliptical tip (Angle, Roundness) with a Hardness falloff, laying down `flow`
 * paint that accumulates up to the stroke's Opacity. Pen dynamics vary a dab's
 * size, angle, roundness, opacity and flow by the pressure and tilt recorded at
 * that point. Start and End trim the path by arc length before any dab is
 * placed, which is what Write On animates.
 *
 * Everything here is in the stroke's LOCAL space; the raster maps the result
 * through the stroke transform and the canvas transform.
 */

import type { BrushDynamics, PaintStroke, StrokeTransform } from './paintStrokes';

type Pt = { x: number; y: number };

export interface Dab {
  x: number;
  y: number;
  /** Diameter, local px. */
  size: number;
  /** Degrees. */
  angle: number;
  /** 0..1. */
  roundness: number;
  /** Per-dab paint 0..1 (flow × dynamics opacity/flow). */
  alpha: number;
}

/** Cumulative arc lengths (`s[0] = 0`), memoised on the points array — strokes
 *  are immutable, and a write-on re-trims the same array every frame. */
const arcMemo = new WeakMap<object, Float64Array>();

export function arcLengths(points: ReadonlyArray<Pt>): Float64Array {
  const hit = arcMemo.get(points);
  if (hit) return hit;
  const s = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    s[i] = s[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y);
  }
  arcMemo.set(points, s);
  return s;
}

/** Point (and the fractional sample index, for per-point attributes) at arc
 *  length `d`. */
export function pointAtLength(points: ReadonlyArray<Pt>, s: Float64Array, d: number): { x: number; y: number; u: number } {
  const n = points.length;
  if (n === 1 || d <= 0) return { x: points[0]!.x, y: points[0]!.y, u: 0 };
  const total = s[n - 1]!;
  if (d >= total) return { x: points[n - 1]!.x, y: points[n - 1]!.y, u: n - 1 };
  // Binary search the segment.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const seg = s[hi]! - s[lo]!;
  const f = seg > 0 ? (d - s[lo]!) / seg : 0;
  const a = points[lo]!;
  const b = points[hi]!;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, u: lo + f };
}

/** Linear sample of a per-point attribute at fractional index `u`. */
export function sampleAttr(values: ReadonlyArray<number> | undefined, u: number, fallback: number): number {
  if (!values || values.length === 0) return fallback;
  const i = Math.floor(u);
  const f = u - i;
  const a = values[Math.min(values.length - 1, Math.max(0, i))] ?? fallback;
  const b = values[Math.min(values.length - 1, Math.max(0, i + 1))] ?? fallback;
  return a + (b - a) * f;
}

/**
 * The polyline between Start and End (fractions of the arc length). The full
 * array is returned as-is when nothing is trimmed, so the legacy renderer's
 * memoised signature keeps hitting. Null when the trim leaves nothing.
 */
export function trimPolyline(points: ReadonlyArray<Pt>, start = 0, end = 1): ReadonlyArray<Pt> | null {
  if (points.length === 0) return null;
  const a = Math.max(0, Math.min(1, start));
  const b = Math.max(0, Math.min(1, end));
  if (b < a || (b === a && points.length > 1)) return null;
  if (a <= 0 && b >= 1) return points;
  if (points.length === 1) return points;
  const s = arcLengths(points);
  const total = s[points.length - 1]!;
  const da = a * total;
  const db = b * total;
  const out: Pt[] = [];
  const pa = pointAtLength(points, s, da);
  out.push({ x: pa.x, y: pa.y });
  for (let i = 1; i < points.length - 1; i++) {
    if (s[i]! > da && s[i]! < db) out.push(points[i]!);
  }
  const pb = pointAtLength(points, s, db);
  out.push({ x: pb.x, y: pb.y });
  return out;
}

const DEG = Math.PI / 180;

/** Pen tilt → tip angle (deg) and roundness: the tip leans the way the pen does
 *  and flattens with the lean (upright = round). */
export function tiltToTip(tiltX: number, tiltY: number): { angle: number; roundness: number } {
  const lean = Math.min(90, Math.hypot(tiltX, tiltY));
  return {
    angle: lean > 0.5 ? Math.atan2(tiltY, tiltX) / DEG : 0,
    roundness: Math.max(0.1, 1 - lean / 90),
  };
}

/** One dynamics channel's factor at a point (1 when off / no input). */
function dynFactor(src: BrushDynamics[keyof BrushDynamics] | undefined, pressure: number, tiltRound: number): number {
  if (src === 'pressure') return pressure;
  if (src === 'tilt') return tiltRound;
  return 1;
}

/**
 * Dabs for a stroke: its path trimmed to Start/End, one dab every
 * `max(1 device-ish px, spacing × diameter)` of arc length, the first at the
 * trimmed start and the last at the trimmed end (a stroke ends where it was
 * drawn, not up to one interval short). A single-point stroke is one dab.
 *
 * `minStep` guards against a zero-spacing / sub-pixel brush exploding into
 * millions of dabs; the raster passes the local length of half a device pixel.
 */
export function strokeDabs(stroke: PaintStroke, minStep = 0.25): Dab[] {
  const pts = stroke.points;
  if (pts.length === 0 || stroke.size <= 0) return [];
  const s = arcLengths(pts);
  const total = s[pts.length - 1]!;
  const start = Math.max(0, Math.min(1, stroke.start ?? 0));
  const end = Math.max(0, Math.min(1, stroke.end ?? 1));
  if (end < start || (end === start && pts.length > 1 && total > 0)) return [];
  const d0 = start * total;
  const d1 = end * total;
  const spacing = stroke.spacing ?? 0.25;
  const dyn = stroke.dynamics;
  const minSize = Math.max(0, Math.min(1, dyn?.minSize ?? 0));
  const baseAngle = stroke.angle ?? 0;
  const baseRound = stroke.roundness ?? 1;
  const flow = stroke.flow ?? 1;
  const out: Dab[] = [];

  const dabAt = (d: number): void => {
    const p = pointAtLength(pts, s, d);
    const pressure = Math.max(0, Math.min(1, sampleAttr(stroke.pressure, p.u, 1)));
    const tip = stroke.tiltX || stroke.tiltY
      ? tiltToTip(sampleAttr(stroke.tiltX, p.u, 0), sampleAttr(stroke.tiltY, p.u, 0))
      : { angle: 0, roundness: 1 };
    const sizeF = dyn?.size && dyn.size !== 'off'
      ? minSize + (1 - minSize) * dynFactor(dyn.size, pressure, tip.roundness)
      : 1;
    const angle = dyn?.angle === 'tilt' ? baseAngle + tip.angle : dyn?.angle === 'pressure' ? baseAngle + pressure * 360 : baseAngle;
    const roundness = dyn?.roundness && dyn.roundness !== 'off'
      ? Math.max(0.01, baseRound * dynFactor(dyn.roundness, pressure, tip.roundness))
      : baseRound;
    const alpha = flow * dynFactor(dyn?.opacity, pressure, tip.roundness) * dynFactor(dyn?.flow, pressure, tip.roundness);
    out.push({ x: p.x, y: p.y, size: stroke.size * sizeF, angle, roundness, alpha });
  };

  if (pts.length === 1 || total === 0) {
    dabAt(0);
    return out;
  }
  // Interval from the NOMINAL diameter, as AE does: spacing is a property of
  // the brush, and a pressure-thinned stretch keeps the same rhythm.
  const step = Math.max(minStep, spacing * stroke.size);
  let d = d0;
  // Hard cap: a pathological stroke must degrade, not hang the raster.
  const maxDabs = 200_000;
  while (d < d1 && out.length < maxDabs) {
    dabAt(d);
    d += step;
  }
  dabAt(d1);
  return out;
}

/** True when a transform is present and not the identity. */
export function hasStrokeTransform(t: StrokeTransform | undefined): t is StrokeTransform {
  return !!t && (t.anchorX !== t.x || t.anchorY !== t.y || t.scale !== 100 || t.rotation !== 0);
}

/** The per-stroke transform as a 2D affine [a, b, c, d, e, f]:
 *  p' = R·S·(p − anchor) + position. */
export function strokeTransformMatrix(t: StrokeTransform): [number, number, number, number, number, number] {
  const k = t.scale / 100;
  const r = t.rotation * DEG;
  const cos = Math.cos(r) * k;
  const sin = Math.sin(r) * k;
  return [cos, sin, -sin, cos, t.x - (cos * t.anchorX - sin * t.anchorY), t.y - (sin * t.anchorX + cos * t.anchorY)];
}

/** A stroke transform's uniform scale factor (1 when absent). */
export function strokeTransformScale(t: StrokeTransform | undefined): number {
  return t ? Math.abs(t.scale) / 100 : 1;
}

/** Identity transform anchored at a point — what the timeline writes when the
 *  user first touches a stroke's Transform, so Rotation/Scale pivot there. */
export function identityStrokeTransform(at: Pt): StrokeTransform {
  return { anchorX: at.x, anchorY: at.y, x: at.x, y: at.y, scale: 100, rotation: 0 };
}

/** Does the stroke need the dab renderer (vs the v1 continuous polyline)? */
export function usesDabs(s: Pick<PaintStroke, 'spacing' | 'roundness' | 'flow' | 'dynamics' | 'pressure' | 'tiltX' | 'tiltY'>): boolean {
  if (s.spacing !== undefined) return true;
  if ((s.roundness ?? 1) < 1 || (s.flow ?? 1) < 1) return true;
  const d = s.dynamics;
  const dynOn = !!d && [d.size, d.angle, d.roundness, d.opacity, d.flow].some((v) => v && v !== 'off');
  return dynOn && !!(s.pressure || s.tiltX || s.tiltY);
}
