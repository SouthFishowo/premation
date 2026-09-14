/**
 * SnapEngine — resolves a moving point or rectangle onto nearby "snap targets"
 * (grid lines, guides, and other objects' edges/centers/corners) within a
 * pixel-space threshold. Returns the corrected position plus the snap lines to
 * highlight. Pure and stateless per call; the Workspace assembles targets and
 * feeds them in.
 *
 * Everything is computed in **world units**; the caller converts the screen-px
 * threshold to world units at the current zoom so the "magnet" feels constant.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import * as R from '../math/Rect';
import * as Mat from '../math/Mat2D';
import {
  spacingCandidates,
  equalSizeCandidates,
  type SpacingCandidate,
  type SizeCandidate,
} from './smartGuides';

export interface SnapSettings {
  enabled: boolean;
  toGrid: boolean;
  toGuides: boolean;
  toObjects: boolean;
  /** Also match centers & edges (not just points). */
  toEdges: boolean;
  toCenters: boolean;
  /**
   * Figma-style smart guides: equal-spacing snapping plus the measurement
   * chrome the host draws from it (distance badges, hatch bars, equal-size
   * highlights). Alignment snapping is unaffected either way — turning this off
   * takes away the measuring, not the magnet.
   */
  smartGuides: boolean;
  /**
   * AE snap FEATURES beyond box edges, each gated additionally by `toObjects`.
   * Optional so a settings literal written before they existed still type-
   * checks; absent reads as ON.
   *
   *  • toAnchors      — other layers' anchor points
   *  • toMaskVertices — vertices of other layers' masks and shape paths
   *  • to3D           — 3D layers' projected anchor + corners (in the active
   *                     view, i.e. screen space — see `featurePoints`)
   */
  toAnchors?: boolean;
  toMaskVertices?: boolean;
  to3D?: boolean;
  /** Snap threshold in screen pixels. */
  thresholdPx: number;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  enabled: true,
  toGrid: true,
  toGuides: true,
  toObjects: true,
  toEdges: true,
  toCenters: true,
  smartGuides: true,
  toAnchors: true,
  toMaskVertices: true,
  to3D: true,
  /*
   * The magnet's reach, in SCREEN px.
   *
   * Every px of this is paid twice on a drag: once as a band the pointer
   * crosses with the layer standing still, and once as the teleport that ends
   * it. At 6 that was a 12px dead zone and two ~6px lurches per target — read
   * by users as the drag "jumping". 3 keeps the assist (a deliberate approach
   * still lands on the edge) and halves both costs; Ctrl/Cmd during the drag
   * suspends it entirely — see SelectTool.onDrag.
   */
  thresholdPx: 3,
};

export type SnapSource =
  | 'grid'
  | 'guide'
  | 'object-edge'
  | 'object-center'
  | 'object-corner'
  | 'anchor-point'
  | 'mask-vertex'
  | 'projected-3d';

/**
 * A 2-D snap FEATURE — a point both axes lock to at once (AE snaps to anchor
 * points and path vertices as points, not as alignment lines). Checked before
 * the 1-D line targets: a point in reach is the stronger, more specific magnet.
 */
export interface SnapPointTarget {
  x: number;
  y: number;
  source: SnapSource;
}

/** The subset of a workspace node the feature extractor reads. */
export interface SnapFeatureNode {
  readonly worldMatrix: Mat.Mat2D;
  readonly anchor?: Vec2;
  readonly is3D?: boolean;
  readonly worldCorners?: readonly Vec2[];
  readonly pathPoints?: readonly Vec2[];
  readonly maskPaths?: ReadonlyArray<{ readonly points: readonly Vec2[] }>;
}

/** A 1-D line the geometry can snap to, in world coordinates. */
export interface SnapTarget {
  axis: 'x' | 'y';
  /** World coordinate along the perpendicular axis. */
  position: number;
  source: SnapSource;
  /** Optional extent for drawing an alignment line (world coords). */
  extentFrom?: number;
  extentTo?: number;
}

export interface SnapLine {
  axis: 'x' | 'y';
  position: number;
  from: number;
  to: number;
  source: SnapSource;
}

export interface SnapResult<T> {
  /** The snapped geometry (same shape that was passed in). */
  value: T;
  /** World-space delta applied to reach the snap. */
  delta: Vec2;
  /** Whether any axis snapped. */
  snapped: boolean;
  lines: SnapLine[];
  /**
   * Equal-spacing snaps that were APPLIED (at most one per axis), for the host
   * to draw as hatch bars. Empty unless the caller passed neighbour rects and
   * `smartGuides` is on. Alignment always wins an axis: a box that lines up
   * with an edge must not be nudged off it to even out a gap.
   */
  spacing: readonly SpacingCandidate[];
}

interface AxisMatch {
  target: SnapTarget;
  /** The moving coordinate that matched (for delta computation). */
  movingCoord: number;
  distance: number;
}

export class SnapEngine {
  private settings: SnapSettings = { ...DEFAULT_SNAP_SETTINGS };

  getSettings(): SnapSettings {
    return { ...this.settings };
  }

  setSettings(patch: Partial<SnapSettings>): void {
    this.settings = { ...this.settings, ...patch };
  }

  /** Grid targets covering a world region, at the given spacing. */
  static gridTargets(region: Rect, spacing: number): SnapTarget[] {
    if (spacing <= 0) return [];
    const targets: SnapTarget[] = [];
    const startX = Math.floor(region.x / spacing) * spacing;
    const endX = region.x + region.width;
    for (let x = startX; x <= endX; x += spacing) {
      targets.push({ axis: 'x', position: x, source: 'grid' });
    }
    const startY = Math.floor(region.y / spacing) * spacing;
    const endY = region.y + region.height;
    for (let y = startY; y <= endY; y += spacing) {
      targets.push({ axis: 'y', position: y, source: 'grid' });
    }
    return targets;
  }

  /** Edge/center/corner targets derived from a set of object world bounds. */
  static objectTargets(bounds: readonly Rect[]): SnapTarget[] {
    const targets: SnapTarget[] = [];
    for (const b of bounds) {
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const yFrom = b.y;
      const yTo = b.y + b.height;
      const xFrom = b.x;
      const xTo = b.x + b.width;
      // Vertical lines (x positions): left, center, right.
      targets.push({ axis: 'x', position: b.x, source: 'object-edge', extentFrom: yFrom, extentTo: yTo });
      targets.push({ axis: 'x', position: xTo, source: 'object-edge', extentFrom: yFrom, extentTo: yTo });
      targets.push({ axis: 'x', position: cx, source: 'object-center', extentFrom: yFrom, extentTo: yTo });
      // Horizontal lines (y positions): top, middle, bottom.
      targets.push({ axis: 'y', position: b.y, source: 'object-edge', extentFrom: xFrom, extentTo: xTo });
      targets.push({ axis: 'y', position: yTo, source: 'object-edge', extentFrom: xFrom, extentTo: xTo });
      targets.push({ axis: 'y', position: cy, source: 'object-center', extentFrom: xFrom, extentTo: xTo });
    }
    return targets;
  }

  /**
   * Point features of a set of nodes, in world (= active-view screen-projected)
   * space:
   *
   *  • 2D layer — its anchor (`anchor-point`), plus every vertex of its shape
   *    path and masks (`mask-vertex`), all mapped through `worldMatrix`.
   *  • 3D layer — its anchor and its four `worldCorners` as `projected-3d`.
   *    The host has already projected those through the active view, so
   *    snapping against them is snapping in SCREEN space in that view: exact at
   *    the corners, and at the anchor wherever the projection's affine
   *    approximation holds (it is exact for a centred anchor). Mask vertices of
   *    a 3D layer are mapped through the same affine and share that caveat.
   */
  static featurePoints(nodes: readonly SnapFeatureNode[]): SnapPointTarget[] {
    const out: SnapPointTarget[] = [];
    for (const n of nodes) {
      const m = n.worldMatrix;
      const anchor = Mat.apply(m, n.anchor ?? { x: 0, y: 0 });
      out.push({ x: anchor.x, y: anchor.y, source: n.is3D ? 'projected-3d' : 'anchor-point' });
      if (n.is3D && n.worldCorners) {
        for (const c of n.worldCorners) out.push({ x: c.x, y: c.y, source: 'projected-3d' });
      }
      const vertex = (p: Vec2): void => {
        const w = Mat.apply(m, p);
        out.push({ x: w.x, y: w.y, source: 'mask-vertex' });
      };
      for (const p of n.pathPoints ?? []) vertex(p);
      for (const mask of n.maskPaths ?? []) for (const p of mask.points) vertex(p);
    }
    return out;
  }

  /**
   * Snap a single world point.
   *
   * `force` ignores the master `enabled` switch (the per-source switches still
   * apply) — the Pan Behind tool's Ctrl gesture TOGGLES snapping, so with
   * snapping off Ctrl has to be able to turn it on for one drag.
   */
  snapPoint(
    point: Vec2,
    targets: readonly SnapTarget[],
    thresholdWorld: number,
    points?: readonly SnapPointTarget[],
    opts?: { force?: boolean },
  ): SnapResult<Vec2> {
    if (!this.settings.enabled && !opts?.force) {
      return { value: point, delta: { x: 0, y: 0 }, snapped: false, lines: [], spacing: [] };
    }
    const pointMatch = points && points.length ? this.bestPoint([point], points, thresholdWorld) : null;
    if (pointMatch) {
      const dx = pointMatch.target.x - pointMatch.moving.x;
      const dy = pointMatch.target.y - pointMatch.moving.y;
      return {
        value: { x: point.x + dx, y: point.y + dy },
        delta: { x: dx, y: dy },
        snapped: true,
        lines: pointLines(pointMatch.target, thresholdWorld),
        spacing: [],
      };
    }
    const xMatch = this.bestMatch([point.x], targets, 'x', thresholdWorld);
    const yMatch = this.bestMatch([point.y], targets, 'y', thresholdWorld);
    const dx = xMatch ? xMatch.target.position - xMatch.movingCoord : 0;
    const dy = yMatch ? yMatch.target.position - yMatch.movingCoord : 0;
    return this.buildResult({ x: point.x + dx, y: point.y + dy }, { x: dx, y: dy }, xMatch, yMatch, point);
  }

  /**
   * Snap a moving world rect. Considers its left/center/right (x) and
   * top/middle/bottom (y) against the targets, choosing the closest per axis.
   */
  snapRect(
    rect: Rect,
    targets: readonly SnapTarget[],
    thresholdWorld: number,
    /**
     * The other objects' world bounds, for equal-SPACING snapping. Optional:
     * callers that only want alignment (the behaviour that shipped) pass
     * nothing and get byte-identical results.
     */
    others?: readonly Rect[],
    /**
     * Point features (anchors, path vertices, projected 3D points). The rect's
     * corners, centre and edge midpoints are matched against them first; a
     * point in reach claims BOTH axes and alignment/spacing are skipped.
     */
    points?: readonly SnapPointTarget[],
  ): SnapResult<Rect> {
    if (!this.settings.enabled) {
      return { value: rect, delta: { x: 0, y: 0 }, snapped: false, lines: [], spacing: [] };
    }
    if (points && points.length) {
      const moving = rectKeyPoints(rect, this.settings.toEdges, this.settings.toCenters);
      const pm = this.bestPoint(moving, points, thresholdWorld);
      if (pm) {
        const d = { x: pm.target.x - pm.moving.x, y: pm.target.y - pm.moving.y };
        return {
          value: R.translate(rect, d),
          delta: d,
          snapped: true,
          lines: pointLines(pm.target, thresholdWorld),
          spacing: [],
        };
      }
    }
    const xCoords: number[] = [rect.x];
    const yCoords: number[] = [rect.y];
    if (this.settings.toEdges) {
      xCoords.push(rect.x + rect.width);
      yCoords.push(rect.y + rect.height);
    }
    if (this.settings.toCenters) {
      xCoords.push(rect.x + rect.width / 2);
      yCoords.push(rect.y + rect.height / 2);
    }
    const xMatch = this.bestMatch(xCoords, targets, 'x', thresholdWorld);
    const yMatch = this.bestMatch(yCoords, targets, 'y', thresholdWorld);
    let dx = xMatch ? xMatch.target.position - xMatch.movingCoord : 0;
    let dy = yMatch ? yMatch.target.position - yMatch.movingCoord : 0;
    /*
     * Equal spacing, on the axes alignment did not claim.
     *
     * An axis that already snapped to an edge/center/guide is LEFT ALONE: two
     * magnets pulling the same axis in different directions is a fight the user
     * feels as jitter, and alignment is the stronger promise of the two (it is
     * what the pink line is already claiming on screen).
     */
    const spacing: SpacingCandidate[] = [];
    if (this.settings.smartGuides && this.settings.toObjects && others && others.length) {
      const free = R.translate(rect, { x: dx, y: dy });
      for (const c of spacingCandidates(free, others, thresholdWorld)) {
        if (c.axis === 'x' && !xMatch && !spacing.some((s) => s.axis === 'x')) {
          dx += c.delta;
          spacing.push(c);
        } else if (c.axis === 'y' && !yMatch && !spacing.some((s) => s.axis === 'y')) {
          dy += c.delta;
          spacing.push(c);
        }
      }
    }
    const snappedRect = R.translate(rect, { x: dx, y: dy });
    const result = this.buildResult(snappedRect, { x: dx, y: dy }, xMatch, yMatch, R.center(rect));
    return { ...result, snapped: result.snapped || spacing.length > 0, spacing };
  }

  /**
   * Equal-SIZE matches for a rect that is being RESIZED — the size half of
   * smart guides, and the half a move gesture can only light up.
   *
   * A resize is not a translation, so this cannot ride along in `snapRect`:
   * the caller owns the fixed point (the opposite edge, the anchor, or the
   * centre under Alt) and is the only thing that can grow the box while
   * keeping it. So the engine answers the measuring question — "which
   * neighbour is this box nearly as wide/tall as, and by how much" — and the
   * tool applies it.
   *
   * At most one per axis, nearest first: two competing sizes on one axis
   * cannot both be applied. Gated on the same settings as the rest of smart
   * guides, so turning them off (or object snapping off, or snapping off)
   * takes this with them.
   */
  sizeMatches(
    rect: Rect,
    others: readonly Rect[],
    thresholdWorld: number,
  ): SizeCandidate[] {
    const s = this.settings;
    if (!s.enabled || !s.smartGuides || !s.toObjects) return [];
    const out: SizeCandidate[] = [];
    const seen = new Set<'x' | 'y'>();
    for (const c of equalSizeCandidates(rect, others, thresholdWorld)) {
      if (seen.has(c.axis)) continue;
      seen.add(c.axis);
      out.push(c);
    }
    return out;
  }

  /** Whether a snap source is switched on (for hosts that match features themselves). */
  sourceAllowed(source: SnapSource): boolean {
    return this.allowed(source);
  }

  private allowed(source: SnapSource): boolean {
    const s = this.settings;
    if (source === 'grid') return s.toGrid;
    if (source === 'guide') return s.toGuides;
    if (source === 'anchor-point') return s.toObjects && s.toAnchors !== false;
    if (source === 'mask-vertex') return s.toObjects && s.toMaskVertices !== false;
    if (source === 'projected-3d') return s.toObjects && s.to3D !== false;
    return s.toObjects;
  }

  /** Nearest (Euclidean) allowed point feature to any moving point, in reach. */
  private bestPoint(
    moving: readonly Vec2[],
    points: readonly SnapPointTarget[],
    threshold: number,
  ): { target: SnapPointTarget; moving: Vec2; distance: number } | null {
    let best: { target: SnapPointTarget; moving: Vec2; distance: number } | null = null;
    for (const target of points) {
      if (!this.allowed(target.source)) continue;
      for (const mp of moving) {
        const distance = Math.hypot(target.x - mp.x, target.y - mp.y);
        if (distance <= threshold && (best === null || distance < best.distance)) {
          best = { target, moving: mp, distance };
        }
      }
    }
    return best;
  }

  private bestMatch(
    movingCoords: number[],
    targets: readonly SnapTarget[],
    axis: 'x' | 'y',
    threshold: number,
  ): AxisMatch | null {
    let best: AxisMatch | null = null;
    for (const target of targets) {
      if (target.axis !== axis || !this.allowed(target.source)) continue;
      for (const mc of movingCoords) {
        const distance = Math.abs(target.position - mc);
        if (distance <= threshold && (best === null || distance < best.distance)) {
          best = { target, movingCoord: mc, distance };
        }
      }
    }
    return best;
  }

  private buildResult<T>(
    value: T,
    delta: Vec2,
    xMatch: AxisMatch | null,
    yMatch: AxisMatch | null,
    anchor: Vec2,
  ): SnapResult<T> {
    const lines: SnapLine[] = [];
    if (xMatch) lines.push(this.matchToLine(xMatch, anchor));
    if (yMatch) lines.push(this.matchToLine(yMatch, anchor));
    return { value, delta, snapped: xMatch !== null || yMatch !== null, lines, spacing: [] };
  }

  private matchToLine(match: AxisMatch, anchor: Vec2): SnapLine {
    const t = match.target;
    // Draw along the target's extent if known, else a short mark around anchor.
    const perp = t.axis === 'x' ? anchor.y : anchor.x;
    const from = t.extentFrom ?? perp - 40;
    const to = t.extentTo ?? perp + 40;
    return { axis: t.axis, position: t.position, from, to, source: t.source };
  }
}

/**
 * The points of a moving rect that can land on a point feature: its corners
 * always, edge midpoints with `toEdges`, the centre with `toCenters`.
 */
function rectKeyPoints(rect: Rect, edges: boolean, centers: boolean): Vec2[] {
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const pts: Vec2[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  if (edges) pts.push({ x: cx, y: y0 }, { x: x1, y: cy }, { x: cx, y: y1 }, { x: x0, y: cy });
  if (centers) pts.push({ x: cx, y: cy });
  return pts;
}

/**
 * The indicator for a POINT snap: a short cross through the feature, drawn by
 * the host exactly like alignment lines (same `SnapLine` shape, same colour).
 * Its arm length follows the threshold so it reads the same at every zoom.
 */
export function pointLines(p: SnapPointTarget, thresholdWorld: number): SnapLine[] {
  const arm = Math.max(thresholdWorld * 4, 1e-6);
  return [
    { axis: 'x', position: p.x, from: p.y - arm, to: p.y + arm, source: p.source },
    { axis: 'y', position: p.y, from: p.x - arm, to: p.x + arm, source: p.source },
  ];
}
