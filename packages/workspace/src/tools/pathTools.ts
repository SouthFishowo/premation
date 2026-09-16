/**
 * AE's Pen flyout vertex tools and the Mask Feather tool.
 *
 *   AddVertexTool     — click a segment of a selected path: a vertex, curve unchanged
 *   DeleteVertexTool  — click a vertex: gone, in every keyframe
 *   ConvertVertexTool — click a vertex: smooth ⇄ corner; drag: redraw its handles;
 *                       drag a handle: that handle alone (the pair breaks)
 *   MaskFeatherTool   — click a mask path: a feather point; drag: its width;
 *                       Alt-click: remove it
 *
 * The Pen reaches the first three on its own (over a segment / a vertex), so
 * these exist for what AE has them for: a tool that does ONE thing no matter
 * where the pointer lands, and a flyout entry to find it by.
 *
 * All four act only on the selected layers' outlines. A press that finds no
 * outline is an ordinary layer click, so picking a layer to edit never needs a
 * trip back to the Selection tool.
 */

import type { Vec2 } from '../math/Vec2';
import type { BezierPoint } from '../math/BezierPoint';
import * as Mat from '../math/Mat2D';
import type { OverlayHandle } from '../ports';
import type { CursorType } from '../cursor/CursorManager';
import { deleteVertex } from '../math/pathTopology';
import type { Tool, ToolContext, ToolDragEvent, ToolPointerEvent, ToolHud } from './Tool';
import {
  PATH_PICK_RADIUS,
  beginVertexGesture,
  commitOutline,
  convertClick,
  convertDrag,
  finishPoints,
  hasHandles,
  insertVertex,
  moveGestureVertex,
  outlineKey,
  pickSegment,
  pickVertex,
  placeHandle,
  selectedOutlines,
  vertexNormal,
  withBroken,
  type Outline,
  type OutlineId,
  type VertexGesture,
} from './pathEdit';

/** The vertices of every selected outline, first vertex flagged. */
function vertexHandles(ctx: ToolContext, outlines: readonly Outline[] = selectedOutlines(ctx)): OverlayHandle[] {
  const out: OverlayHandle[] = [];
  for (const o of outlines) {
    o.points.forEach((p, i) => {
      out.push({
        id: `pv:${outlineKey(o)}:${i}`,
        position: Mat.apply(o.matrix, { x: p.x, y: p.y }),
        kind: 'point',
        ...(i === 0 && o.points.length > 1 ? { first: true } : {}),
      });
    });
  }
  return out;
}

/** A press that is not on an outline: the ordinary layer click. */
function layerClick(e: ToolPointerEvent, ctx: ToolContext): void {
  ctx.selection.clickAt(e.world, e.modifiers);
  ctx.requestRender();
}

// ── Add Vertex ──────────────────────────────────────────────────────
export class AddVertexTool implements Tool {
  readonly id = 'add-vertex';
  readonly label = 'Add Vertex';
  readonly cursor: CursorType = 'pen-add';

  private gesture: VertexGesture | null = null;

  getHandles(ctx: ToolContext): readonly OverlayHandle[] {
    return vertexHandles(ctx);
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    this.gesture = null;
    const hit = pickSegment(ctx, e.world, selectedOutlines(ctx));
    const done = hit ? insertVertex(ctx, hit) : null;
    if (!hit || !done) {
      layerClick(e, ctx);
      return;
    }
    // AE: the press that adds the vertex can drag it straight away.
    this.gesture = beginVertexGesture({ ...hit.outline, points: done.points }, done.index, e.world);
    ctx.requestRender();
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    const g = this.gesture;
    if (!g) return;
    g.moved = true;
    commitOutline(ctx, g.id, moveGestureVertex(g, e.currentWorld));
    ctx.requestRender();
  }

  onPointerUp(_e: ToolPointerEvent, _ctx: ToolContext): void {
    this.gesture = null;
  }
}

// ── Delete Vertex ───────────────────────────────────────────────────
export class DeleteVertexTool implements Tool {
  readonly id = 'delete-vertex';
  readonly label = 'Delete Vertex';
  readonly cursor: CursorType = 'pen-remove';

  getHandles(ctx: ToolContext): readonly OverlayHandle[] {
    return vertexHandles(ctx);
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const hit = pickVertex(ctx, e.world, selectedOutlines(ctx));
    if (!hit) {
      layerClick(e, ctx);
      return;
    }
    // Refuses below two vertices — nothing drawable would be left.
    const next = deleteVertex(hit.outline.points, hit.index);
    if (next) commitOutline(ctx, hit.outline, finishPoints(next, hit.outline), { op: 'delete', index: hit.index });
    ctx.requestRender();
  }
}

// ── Convert Vertex ──────────────────────────────────────────────────
export class ConvertVertexTool implements Tool {
  readonly id = 'convert-vertex';
  readonly label = 'Convert Vertex';
  readonly cursor: CursorType = 'pen-convert';

  private gesture: VertexGesture | null = null;
  /** A press on one of a vertex's handles: the drag moves it alone. */
  private handleDrag: { id: OutlineId; index: number; which: 'in' | 'out'; matrix: Mat.Mat2D; points: BezierPoint[] } | null = null;
  private hud: ToolHud | null = null;

  getHud(_ctx: ToolContext): ToolHud | null {
    return this.hud;
  }

  /** Vertices, plus the handles of every vertex that has any (RotoBezier outlines have none to drag). */
  getHandles(ctx: ToolContext): readonly OverlayHandle[] {
    const outlines = selectedOutlines(ctx);
    const out = vertexHandles(ctx, outlines);
    for (const o of outlines) {
      if (o.rotoBezier) continue;
      o.points.forEach((p, i) => {
        if (!hasHandles(p)) return;
        const origin = Mat.apply(o.matrix, { x: p.x, y: p.y });
        out.push(
          { id: `pin:${outlineKey(o)}:${i}`, position: Mat.apply(o.matrix, { x: p.inX, y: p.inY }), kind: 'tangent-in', origin },
          { id: `pout:${outlineKey(o)}:${i}`, position: Mat.apply(o.matrix, { x: p.outX, y: p.outY }), kind: 'tangent-out', origin },
        );
      });
    }
    return out;
  }

  /** The nearest pulled-out handle within reach, if any. */
  private pickHandle(ctx: ToolContext, world: Vec2): ConvertVertexTool['handleDrag'] {
    const radius = ctx.camera.screenDistanceToWorld(PATH_PICK_RADIUS);
    let best: ConvertVertexTool['handleDrag'] = null;
    let bestD = radius;
    for (const o of selectedOutlines(ctx)) {
      if (o.rotoBezier) continue;
      o.points.forEach((p, index) => {
        for (const which of ['in', 'out'] as const) {
          const hx = which === 'in' ? p.inX : p.outX;
          const hy = which === 'in' ? p.inY : p.outY;
          if (hx === p.x && hy === p.y) continue; // retracted: the vertex is the thing there
          const w = Mat.apply(o.matrix, { x: hx, y: hy });
          const d = Math.hypot(w.x - world.x, w.y - world.y);
          if (d < bestD) {
            bestD = d;
            best = { id: { nodeId: o.nodeId, maskId: o.maskId }, index, which, matrix: o.matrix, points: o.points.map((q) => ({ ...q })) };
          }
        }
      });
    }
    return best;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    this.gesture = null;
    this.handleDrag = null;
    this.hud = null;
    const handle = this.pickHandle(ctx, e.world);
    const vertex = pickVertex(ctx, e.world, selectedOutlines(ctx));
    // A handle wins only when it is nearer than the vertex it hangs from.
    if (handle && (!vertex || vertex.distance > ctx.camera.screenDistanceToWorld(1))) {
      this.handleDrag = handle;
      return;
    }
    if (vertex) {
      this.gesture = beginVertexGesture(vertex.outline, vertex.index, e.world);
      return;
    }
    layerClick(e, ctx);
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    const h = this.handleDrag;
    if (h) {
      // AE: dragging a direction line with Convert Vertex breaks the pair.
      const local = Mat.apply(Mat.invert(h.matrix), e.currentWorld);
      const points = h.points.map((p) => ({ ...p }));
      points[h.index] = withBroken(placeHandle(points[h.index]!, h.which, local, 'broken'), true);
      commitOutline(ctx, h.id, points);
      ctx.requestRender();
      return;
    }
    const g = this.gesture;
    if (!g) return;
    g.moved = true;
    const res = convertDrag(g, e.currentWorld);
    this.hud = res.hud;
    commitOutline(ctx, g.id, res.points);
    ctx.requestRender();
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext): void {
    const g = this.gesture;
    this.gesture = null;
    this.handleDrag = null;
    if (g && !g.moved) {
      const res = convertClick(g);
      this.hud = res.hud;
      commitOutline(ctx, g.id, res.points);
    } else if (g) {
      this.hud = null;
    }
    ctx.requestRender();
  }
}

// ── Mask Feather ────────────────────────────────────────────────────

/**
 * AE's Mask Feather tool, on this editor's variable-feather model.
 *
 * AE places feather points anywhere along a segment; the renderer here stores
 * variable feather PER VERTEX (`MaskPoint.feather`, interpolated along the
 * outline by `maskFeather.ts`). So a click on a segment first adds a vertex
 * there — de Casteljau, the curve does not move — and that vertex carries the
 * feather point. A click on an existing vertex makes it a feather point in
 * place. Dragging sets the width (a DIAMETER, as the mask's own Feather is),
 * measured along the outline's outward normal; Alt-click removes the point.
 */
export class MaskFeatherTool implements Tool {
  readonly id = 'mask-feather';
  readonly label = 'Mask Feather';
  readonly cursor: CursorType = 'feather';

  private drag: { id: OutlineId; index: number; points: BezierPoint[]; matrix: Mat.Mat2D; normal: Vec2 } | null = null;
  private hud: ToolHud | null = null;

  private maskOutlines(ctx: ToolContext): Outline[] {
    return selectedOutlines(ctx).filter((o) => o.maskId !== null);
  }

  getHud(_ctx: ToolContext): ToolHud | null {
    return this.hud;
  }

  getHandles(ctx: ToolContext): readonly OverlayHandle[] {
    const outlines = this.maskOutlines(ctx);
    const out = vertexHandles(ctx, outlines);
    for (const o of outlines) {
      o.points.forEach((p, i) => {
        const feather = (p as BezierPoint & { feather?: number }).feather;
        if (typeof feather !== 'number') return;
        const n = vertexNormal(o.points, i, o.closed);
        const origin = Mat.apply(o.matrix, { x: p.x, y: p.y });
        const tip = Mat.apply(o.matrix, { x: p.x + (n.x * feather) / 2, y: p.y + (n.y * feather) / 2 });
        out.push({ id: `mf:${outlineKey(o)}:${i}`, position: tip, kind: 'feather', origin });
      });
    }
    return out;
  }

  /** A feather grip (or a vertex) under the pointer. */
  private pickPoint(ctx: ToolContext, world: Vec2): { outline: Outline; index: number } | null {
    const radius = ctx.camera.screenDistanceToWorld(PATH_PICK_RADIUS);
    for (const o of this.maskOutlines(ctx)) {
      for (let i = 0; i < o.points.length; i++) {
        const p = o.points[i]! as BezierPoint & { feather?: number };
        if (typeof p.feather !== 'number') continue;
        const n = vertexNormal(o.points, i, o.closed);
        const tip = Mat.apply(o.matrix, { x: p.x + (n.x * p.feather) / 2, y: p.y + (n.y * p.feather) / 2 });
        if (Math.hypot(tip.x - world.x, tip.y - world.y) <= radius) return { outline: o, index: i };
      }
    }
    const v = pickVertex(ctx, world, this.maskOutlines(ctx));
    return v ? { outline: v.outline, index: v.index } : null;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    this.drag = null;
    this.hud = null;
    const hit = this.pickPoint(ctx, e.world);
    if (hit) {
      const p = hit.outline.points[hit.index] as BezierPoint & { feather?: number };
      if (e.modifiers.alt) {
        if (typeof p.feather === 'number') {
          const points = hit.outline.points.map((q, i) => {
            if (i !== hit.index) return { ...q };
            const { feather: _drop, ...rest } = q as BezierPoint & { feather?: number };
            return rest;
          });
          commitOutline(ctx, hit.outline, points);
        }
        ctx.requestRender();
        return;
      }
      this.beginDrag(hit.outline, hit.index, hit.outline.points.map((q) => ({ ...q })));
      return;
    }
    const seg = pickSegment(ctx, e.world, this.maskOutlines(ctx));
    const done = seg ? insertVertex(ctx, seg) : null;
    if (!seg || !done) {
      layerClick(e, ctx);
      return;
    }
    // The new vertex starts as a zero-width feather point (AE's new point is
    // hard until dragged). Written as a plain reshape at the playhead — the
    // topology already went into every keyframe.
    const points = done.points.map((q, i) => (i === done.index ? { ...q, feather: 0 } : { ...q }));
    commitOutline(ctx, seg.outline, points);
    this.beginDrag({ ...seg.outline, points }, done.index, points);
    ctx.requestRender();
  }

  private beginDrag(outline: Outline, index: number, points: BezierPoint[]): void {
    this.drag = {
      id: { nodeId: outline.nodeId, maskId: outline.maskId },
      index,
      points,
      matrix: outline.matrix,
      normal: vertexNormal(points, index, outline.closed),
    };
  }

  onDrag(e: ToolDragEvent, ctx: ToolContext): void {
    const d = this.drag;
    if (!d) return;
    const local = Mat.apply(Mat.invert(d.matrix), e.currentWorld);
    const v = d.points[d.index]!;
    // Distance from the vertex along its normal, both sides: the renderer's
    // feather is symmetric about the edge, so inward and outward drags both
    // widen it.
    const along = Math.abs((local.x - v.x) * d.normal.x + (local.y - v.y) * d.normal.y);
    const width = Math.round(along * 2 * 10) / 10;
    const points = d.points.map((q, i) => (i === d.index ? { ...q, feather: width } : { ...q }));
    commitOutline(ctx, d.id, points);
    this.hud = { anchorWorld: e.currentWorld, lines: [`Feather: ${width} px`] };
    ctx.requestRender();
  }

  onPointerUp(_e: ToolPointerEvent, _ctx: ToolContext): void {
    this.drag = null;
    this.hud = null;
  }
}
