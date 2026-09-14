/**
 * Anchor-point snapping for the Pan Behind tool (AE: Y).
 *
 * After Effects snaps a dragged anchor to the layer's OWN features first — its
 * corners, edge midpoints and centre — and then to the same snap features a
 * layer drag uses (other layers' edges, anchors, path vertices, guides, grid).
 * Holding Ctrl/Cmd during the drag TOGGLES snapping for that drag.
 *
 * Pure: the tool supplies the layer's box in world space and an optional
 * external snapper; this decides which one wins.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import * as Mat from '../math/Mat2D';
import type { SnapLine, SnapResult } from './SnapEngine';
import { pointLines } from './SnapEngine';

/**
 * The nine box points of a layer — TL, TC, TR, ML, C, MR, BL, BC, BR — in
 * world space: `localBounds` mapped through `worldMatrix`, so a rotated or
 * scaled layer's points sit on its real (oriented) box.
 */
export function layerBoxPoints(localBounds: Rect, worldMatrix: Mat.Mat2D): Vec2[] {
  const xs = [localBounds.x, localBounds.x + localBounds.width / 2, localBounds.x + localBounds.width];
  const ys = [localBounds.y, localBounds.y + localBounds.height / 2, localBounds.y + localBounds.height];
  const out: Vec2[] = [];
  for (const y of ys) for (const x of xs) out.push(Mat.apply(worldMatrix, { x, y }));
  return out;
}

export interface AnchorSnapResult {
  /** Where the anchor goes, in world space. */
  point: Vec2;
  /** What it snapped to (null = free). */
  snappedTo: 'own-box' | 'external' | null;
  /** Indicator lines for the host to draw ([] when free). */
  lines: SnapLine[];
}

/**
 * Resolve a dragged anchor position.
 *
 * @param pointer      the pointer in world space
 * @param ownPoints    the layer's nine box points (see `layerBoxPoints`)
 * @param ownThreshold world-space reach for the layer's own points
 * @param active       whether snapping applies to this drag (snap switch XOR Ctrl)
 * @param external     optional snapper for the other features; called only when
 *                     no own point is in reach
 */
export function resolveAnchorSnap(
  pointer: Vec2,
  ownPoints: readonly Vec2[],
  ownThreshold: number,
  active: boolean,
  external?: (p: Vec2) => SnapResult<Vec2> | null | undefined,
): AnchorSnapResult {
  if (!active) return { point: pointer, snappedTo: null, lines: [] };
  let best: Vec2 | null = null;
  let bestD = ownThreshold;
  for (const p of ownPoints) {
    const d = Math.hypot(p.x - pointer.x, p.y - pointer.y);
    if (d <= bestD) {
      bestD = d;
      best = p;
    }
  }
  if (best) {
    return {
      point: { x: best.x, y: best.y },
      snappedTo: 'own-box',
      lines: pointLines({ x: best.x, y: best.y, source: 'anchor-point' }, ownThreshold / 4),
    };
  }
  const ext = external?.(pointer);
  if (ext && ext.snapped) return { point: ext.value, snappedTo: 'external', lines: [...ext.lines] };
  return { point: pointer, snappedTo: null, lines: [] };
}
