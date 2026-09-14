/**
 * Glyph outlines → mask paths. The pure half of Create Masks from Text.
 *
 * Kept apart from `masksFromText.ts` (which touches the scene graph, the font
 * loader and the canvas) so the geometry — the part with real rules — is
 * testable with plain numbers.
 *
 * ## Holes
 *
 * A glyph like O or A is an outer contour plus a counter. A mask stack has no
 * winding rule; it has combine MODES applied top to bottom. So nesting depth is
 * computed by containment (a contour inside an odd number of others is a hole)
 * and the masks are ORDERED by depth — every outer first as Add, then every
 * counter as Subtract, then any island inside a counter (®) as Add again. That
 * sequence reproduces even-odd fill for glyphs that do not overlap each other,
 * which is every glyph layout the text engine produces.
 *
 * Winding direction is not used: TrueType and CFF disagree on it, and traced
 * contours have whatever direction the tracer gave them.
 */

import type { MaskMode, MaskPath, MaskPoint } from '@core/effects/mask';

export interface OutlinePoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export interface OutlineContour {
  points: ReadonlyArray<OutlinePoint>;
}

/** Map a point from the text layer's space into the mask layer's space. */
export type PointMap = (x: number, y: number) => readonly [number, number];

const STEPS = 8;

/** A closed contour flattened to a polygon (cubic segments sampled). */
export function flattenContour(points: ReadonlyArray<OutlinePoint>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const straight = a.outX === a.x && a.outY === a.y && b.inX === b.x && b.inY === b.y;
    if (straight) {
      out.push([a.x, a.y]);
      continue;
    }
    for (let s = 0; s < STEPS; s++) {
      const t = s / STEPS;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      out.push([
        w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x,
        w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y,
      ]);
    }
  }
  return out;
}

/** Even-odd ray cast. */
export function polygonContains(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Absolute area of a polygon (shoelace). */
export function polygonArea(poly: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j]![0] + poly[i]![0]) * (poly[j]![1] - poly[i]![1]);
  }
  return Math.abs(a / 2);
}

/**
 * How many OTHER contours contain contour `i`. Tested at the centroid of the
 * contour's own polygon when that lies inside it (a counter's centroid is
 * inside the counter), else at its first vertex — a vertex sits ON its own
 * outline, but not on anybody else's.
 */
function nestingDepths(polys: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): number[] {
  return polys.map((poly, i) => {
    let px = poly[0]?.[0] ?? 0;
    let py = poly[0]?.[1] ?? 0;
    if (poly.length > 0) {
      const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      if (polygonContains(poly, cx, cy)) { px = cx; py = cy; }
    }
    let depth = 0;
    polys.forEach((other, j) => {
      if (j !== i && polygonArea(other) > polygonArea(poly) && polygonContains(other, px, py)) depth += 1;
    });
    return depth;
  });
}

/**
 * One mask per contour, mapped through `map`, ordered and moded by nesting.
 * Degenerate contours (fewer than 3 anchors, or zero area) are skipped.
 */
export function glyphContoursToMaskPaths(
  contours: ReadonlyArray<OutlineContour>,
  map: PointMap,
  makeId: (index: number) => string,
): MaskPath[] {
  const mapped = contours
    .filter((c) => c.points.length >= 3)
    .map((c) => c.points.map((p): MaskPoint => {
      const [x, y] = map(p.x, p.y);
      const [inX, inY] = map(p.inX, p.inY);
      const [outX, outY] = map(p.outX, p.outY);
      return { x, y, inX, inY, outX, outY };
    }))
    .map((points) => ({ points, poly: flattenContour(points) }))
    .filter((c) => polygonArea(c.poly) > 1e-6);

  const depths = nestingDepths(mapped.map((c) => c.poly));
  const order = mapped.map((_, i) => i).sort((a, b) => depths[a]! - depths[b]! || a - b);

  return order.map((i, n): MaskPath => {
    const mode: MaskMode = depths[i]! % 2 === 1 ? 'subtract' : 'add';
    return {
      id: makeId(n),
      name: `${mode === 'subtract' ? 'Counter' : 'Glyph'} ${n + 1}`,
      mode,
      closed: true,
      points: mapped[i]!.points,
      feather: 0,
      opacity: 1,
      expansion: 0,
      inverted: false,
    };
  });
}
