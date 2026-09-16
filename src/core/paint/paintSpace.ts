/**
 * Comp viewer → paint space: where a pointer lands in a layer's own centred
 * pixels, AT THE CURRENT TIME, through everything that places the layer.
 *
 * `compToLayerLocal` (paintCoords) inverts the layer's STATIC x/y/rotation/
 * scale and nothing else. That is right for an unparented, unanimated 2D layer
 * and wrong for every other one: a keyframed layer took the stroke at its rest
 * pose, a parented layer ignored the parent's transform, and a 3D layer was
 * inverted as if it lay flat on the comp — the paint landed somewhere the user
 * did not point, on exactly the layers that move.
 *
 * The transforms come from the resolvers the renderer and the chrome already
 * share, not from a fourth composition kept in step by attention:
 *
 *   · 2D — `world2DAt` (parent chain, animated values, time remap), then the
 *     anchor, which the renderer applies as `−anchor` inside the quad and which
 *     the world affine does not carry.
 *   · 3D — `nodeWorldWithParents3d` (anchor included: its local origin IS the
 *     box centre), and a ray through the VIEW ON SCREEN (`currentViewCamera`,
 *     or the ortho basis for Top/Front/…) intersected with the layer's plane.
 *     An edge-on layer has no intersection, so the caller gets null and says so
 *     rather than painting at the layer origin.
 *
 * Pure pieces (`local2D`, `local3D`, `localBrushSizeVia`, `thinSamples`) are
 * exported for tests; `paintSpaceAt` is the live resolver that gathers inputs.
 */

import { Matrix, Matrix4Math, Project3D, type Matrix2D, type Matrix4, type Vec3 } from '@motion/scene';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { world2DAt } from '@core/scene/layerSpace';
import { nodeWorldWithParents3d } from '@core/scene/liveWorld3d';
import { is3DEnabled } from '@core/scene/threeD';
import { readNodeAnchor } from '@core/scene/anchor';
import { orthoViewOf } from '@core/scene/cameraViewMode';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { currentViewCamera } from '@core/workspace/viewProjection';
import { useGuidesStore } from '@stores/guidesStore';
import { layerScaleOf } from './paintCoords';

type Pt = { x: number; y: number };

/** Comp point → paint-local through a 2D world affine plus anchor; null when
 *  the affine is singular (a layer scaled to zero has no surface to paint). */
export function local2D(world: Matrix2D, anchor: Pt, cp: Pt): Pt | null {
  const det = world.a * world.d - world.b * world.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const q = Matrix.transformPoint(Matrix.invert(world), cp);
  return { x: q.x + anchor.x, y: q.y + anchor.y };
}

/**
 * A world-space ray → paint-local on a 3D layer's plane, or null when the ray
 * misses it (edge-on) or the layer matrix is singular. The 3D model matrix
 * already un-anchors, so its local plane coordinates are the paint's.
 */
export function local3D(world: Matrix4, ray: Project3D.Ray3D): Pt | null {
  const inv = Matrix4Math.invert(world);
  if (!inv) return null;
  const point = Matrix4Math.transformPoint(world, { x: 0, y: 0, z: 0 });
  const zTip = Matrix4Math.transformPoint(world, { x: 0, y: 0, z: 1 });
  const normal: Vec3 = { x: zTip.x - point.x, y: zTip.y - point.y, z: zTip.z - point.z };
  const hit = Project3D.intersectRayPlane(ray, point, normal);
  if (!hit) return null;
  // A hit BEHIND the eye is the plane's mirror image, not what is on screen.
  const along =
    (hit.x - ray.origin.x) * ray.direction.x
    + (hit.y - ray.origin.y) * ray.direction.y
    + (hit.z - ray.origin.z) * ray.direction.z;
  if (along < 0) return null;
  const q = Matrix4Math.transformPoint(inv, hit);
  return Number.isFinite(q.x) && Number.isFinite(q.y) ? { x: q.x, y: q.y } : null;
}

/**
 * A comp-pixel brush diameter in the layer's local units AT `cp`: the local
 * area one comp pixel covers there, square-rooted. Measured through the same
 * mapping the points use, so parent scale, animated scale and 3D foreshortening
 * all count — the stroke commits at the width that was previewed. Null when
 * the mapping has no answer near `cp`.
 */
export function localBrushSizeVia(toLocal: (cp: Pt) => Pt | null, cp: Pt, compSize: number): number | null {
  const o = toLocal(cp);
  const u = toLocal({ x: cp.x + 1, y: cp.y });
  const v = toLocal({ x: cp.x, y: cp.y + 1 });
  if (!o || !u || !v) return null;
  const area = Math.abs((u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x));
  const k = Math.sqrt(area);
  return Number.isFinite(k) && k > 0 ? compSize * k : null;
}

/**
 * Indices of the samples worth keeping: each at least `minDist` from the last
 * kept one (sub-pixel pointer jitter adds nothing to a round-capped polyline),
 * with the final sample always kept so the stroke ends where the pointer did.
 * The Layer panel applies the same 0.5 px rule as it appends (`appendPoint`).
 */
export function thinSamples(points: ReadonlyArray<Pt>, minDist = 0.5): number[] {
  if (points.length === 0) return [];
  const keep = [0];
  let last = points[0]!;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) >= minDist) {
      keep.push(i);
      last = p;
    }
  }
  const end = points.length - 1;
  if (keep[keep.length - 1] !== end) keep.push(end);
  return keep;
}

export interface PaintSpace {
  /** Comp px → the layer's centred paint px; null where the layer has no
   *  surface under the point (edge-on 3D, zero scale). */
  toLocal: (cp: Pt) => Pt | null;
  /** Comp-px brush diameter → local units at `cp`. */
  brushSize: (cp: Pt, compSize: number) => number;
  is3D: boolean;
}

/** The live mapping for one layer at comp time `time`, or null when it is gone. */
export function paintSpaceAt(nodeId: string, time: number, comp: { width: number; height: number }): PaintSpace | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const fallbackScale = layerScaleOf(node);
  const withSize = (toLocal: PaintSpace['toLocal'], is3D: boolean): PaintSpace => ({
    toLocal,
    brushSize: (cp, size) => localBrushSizeVia(toLocal, cp, size) ?? size / fallbackScale,
    is3D,
  });

  if (is3DEnabled(node)) {
    const world = nodeWorldWithParents3d(node, time);
    if (!world) return null;
    const mode = useGuidesStore.getState().camera3dMode;
    const ortho = orthoViewOf(mode);
    const camera = currentViewCamera(comp.width, comp.height, time) ?? Project3D.defaultCamera(comp.width, comp.height);
    return withSize(
      (cp) => local3D(world, Project3D.unprojectScreenRay(cp.x, cp.y, camera, ortho, comp.width, comp.height)),
      true,
    );
  }

  const world = world2DAt(nodeId, time);
  // Animated anchor wins, as in every other transform reader.
  const av = defaultAnimation.evaluateNode(nodeId, getRemappedTime(nodeId, time));
  const rest = readNodeAnchor(node);
  const anchor = { x: av.get('anchorX') ?? rest.x, y: av.get('anchorY') ?? rest.y };
  return withSize((cp) => local2D(world, anchor, cp), false);
}
