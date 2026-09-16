/**
 * layerPaint — pointer-sample helpers for the Layer panel's paint brush. Pure,
 * so the pointer plumbing stays thin and this is testable without a canvas.
 *
 * The Layer panel shows the layer UNTRANSFORMED, so its points are already in
 * the layer's own space (centred, as `PaintStroke` stores them) and the brush
 * size is layer pixels as-is — AE's Layer-panel painting. The stroke itself is
 * built by `core/paint/paintCommit`, the same commit the comp viewer uses.
 */

type Pt = { x: number; y: number };

/** Add a point unless it is sub-pixel jitter from the last one. */
export function appendPoint(points: ReadonlyArray<Pt>, p: Pt, minDist = 0.5): Pt[] {
  const last = points[points.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDist) return [...points];
  return [...points, p];
}
