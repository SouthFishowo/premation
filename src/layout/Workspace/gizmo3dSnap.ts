/**
 * Snapping for 3D gizmo TRANSLATE drags — the pure half.
 *
 * The workspace's snap features (other layers' anchors, mask/shape vertices and
 * 3D layers' projected anchor + corners) live in SCREEN space of the active
 * view: comp px, already projected. The gizmo moves a 3D point along an axis or
 * in a plane. So the snap is solved in two steps:
 *
 *  1. On screen: where may the dragged anchor's projection land?
 *     • plane drag — anywhere, so the nearest feature within the threshold;
 *     • axis drag  — only on the projected axis LINE, so a feature within the
 *       threshold of that line (and of the current point along it) lands the
 *       anchor at the feature's foot on the line.
 *  2. Back in 3D: cast the view ray through that screen point and intersect it
 *     with the axis (closest point) or the plane. The ray passes through the
 *     line's projection, so the solved position projects exactly onto it —
 *     under perspective as well as ortho.
 *
 * Ctrl/Cmd toggles snapping for the drag, exactly as the 2D tools do.
 */

import { Project3D, type Vec3 } from '@motion/scene';
import type { SnapPointTarget } from '@motion/workspace';

export interface ScreenPt {
  x: number;
  y: number;
}

export interface ScreenSnap {
  /** Where the dragged projection lands. */
  point: ScreenPt;
  /** The feature it snapped to (for the indicator). */
  target: SnapPointTarget;
}

export interface SnapView {
  camera: Project3D.Camera3D;
  orthoView: Project3D.OrthoView | null;
  width: number;
  height: number;
}

/** Snapping on for this move: the switch, inverted while Ctrl/Cmd is held. */
export function snapActive(enabled: boolean, modHeld: boolean): boolean {
  return enabled !== modHeld;
}

/** Nearest feature within `threshold` of a free screen point. */
export function snapScreenPointFree(
  p: ScreenPt,
  targets: ReadonlyArray<SnapPointTarget>,
  threshold: number,
): ScreenSnap | null {
  let best: ScreenSnap | null = null;
  let bestD = Infinity;
  for (const t of targets) {
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d <= threshold && d < bestD) {
      bestD = d;
      best = { point: { x: t.x, y: t.y }, target: t };
    }
  }
  return best;
}

/**
 * Snap a point constrained to the screen line `origin + s·dir`. A feature
 * counts when its perpendicular distance to the line AND the distance along
 * the line from `p` to its foot are both within `threshold`; the result is the
 * foot (the only reachable point nearest the feature).
 */
export function snapScreenPointOnLine(
  p: ScreenPt,
  origin: ScreenPt,
  dir: ScreenPt,
  targets: ReadonlyArray<SnapPointTarget>,
  threshold: number,
): ScreenSnap | null {
  const len = Math.hypot(dir.x, dir.y);
  if (!(len > 1e-9)) return null;
  const ux = dir.x / len;
  const uy = dir.y / len;
  let best: ScreenSnap | null = null;
  let bestScore = Infinity;
  for (const t of targets) {
    const s = (t.x - origin.x) * ux + (t.y - origin.y) * uy;
    const fx = origin.x + ux * s;
    const fy = origin.y + uy * s;
    const perp = Math.hypot(t.x - fx, t.y - fy);
    const along = Math.hypot(fx - p.x, fy - p.y);
    if (perp > threshold || along > threshold) continue;
    const score = Math.hypot(perp, along);
    if (score < bestScore) {
      bestScore = score;
      best = { point: { x: fx, y: fy }, target: t };
    }
  }
  return best;
}

export function projectForView(p: Vec3, v: SnapView): ScreenPt {
  const q = v.orthoView ? Project3D.projectOrtho(p, v.orthoView, v.width, v.height) : Project3D.projectPoint(p, v.camera);
  return { x: q.x, y: q.y };
}

function rayAt(s: ScreenPt, v: SnapView): Project3D.Ray3D {
  return Project3D.unprojectScreenRay(s.x, s.y, v.camera, v.orthoView, v.width, v.height);
}

/** The point on the 3D axis whose projection is `screen` (which lies on the axis' projection). */
export function solveAxisMoveToScreen(screen: ScreenPt, origin: Vec3, axisDir: Vec3, v: SnapView): Vec3 {
  const { tAxis } = Project3D.closestPointRayAxis(rayAt(screen, v), origin, axisDir);
  return { x: origin.x + axisDir.x * tAxis, y: origin.y + axisDir.y * tAxis, z: origin.z + axisDir.z * tAxis };
}

/** The point on the 3D plane whose projection is `screen`; null when the plane is edge-on. */
export function solvePlaneMoveToScreen(screen: ScreenPt, origin: Vec3, normal: Vec3, v: SnapView): Vec3 | null {
  return Project3D.intersectRayPlane(rayAt(screen, v), origin, normal);
}

/**
 * The whole constrained snap for one translate move. `moved` is the position
 * the unsnapped drag solved; `dir` is the axis direction (axis drags) or the
 * plane normal (plane drags). Null = nothing in reach — keep `moved`.
 */
export function snapGizmoTranslate(args: {
  kind: 'axis' | 'plane';
  start: Vec3;
  moved: Vec3;
  dir: Vec3;
  view: SnapView;
  points: ReadonlyArray<SnapPointTarget>;
  threshold: number;
}): { pos: Vec3; target: SnapPointTarget } | null {
  const { kind, start, moved, dir, view, points, threshold } = args;
  if (points.length === 0) return null;
  const p = projectForView(moved, view);
  if (kind === 'plane') {
    const hit = snapScreenPointFree(p, points, threshold);
    if (!hit) return null;
    const pos = solvePlaneMoveToScreen(hit.point, start, dir, view);
    return pos ? { pos, target: hit.target } : null;
  }
  const o = projectForView(start, view);
  const far = projectForView({ x: start.x + dir.x * 100, y: start.y + dir.y * 100, z: start.z + dir.z * 100 }, view);
  const hit = snapScreenPointOnLine(p, o, { x: far.x - o.x, y: far.y - o.y }, points, threshold);
  if (!hit) return null;
  return { pos: solveAxisMoveToScreen(hit.point, start, dir, view), target: hit.target };
}
