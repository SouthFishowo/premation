/**
 * Direct Selection over geometry AND mask outlines.
 *
 * Two bugs this pins down:
 *  1. Masks were invisible to the tool — it only ever read `node.pathPoints` —
 *     so a mask's shape was frozen the moment it was drawn, and mask path
 *     animation (which morphs exactly these points) could never be authored.
 *  2. Handle ids encoded the node id and were parsed back with `split('_')`,
 *     so ANY id containing an underscore ("comp_root", "tab_a1") resolved to
 *     the wrong node. The tool now keeps a handle→ref map instead.
 */

import { DirectSelectionTool } from '../tools/builtin';
import { commands, WorkspaceCommandType } from '../commands/WorkspaceCommands';
import type { ToolContext, ToolPointerEvent, ToolDragEvent } from '../tools/Tool';
import type { WorkspaceCommand, WorkspaceNode } from '../ports';
import { corner } from '../math/BezierPoint';

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** A square outline centred on the origin. */
const square = (h: number) => [corner(-h, -h), corner(h, -h), corner(h, h), corner(-h, h)];

function node(over: Partial<WorkspaceNode> = {}): WorkspaceNode {
  return {
    id: 'comp_root_layer' as WorkspaceNode['id'], // underscores on purpose
    parentId: null,
    worldBounds: { x: -50, y: -50, width: 100, height: 100 },
    worldMatrix: IDENTITY,
    localBounds: { x: -50, y: -50, width: 100, height: 100 },
    visible: true,
    locked: false,
    zIndex: 0,
    ...over,
  } as WorkspaceNode;
}

function makeCtx(n: WorkspaceNode): { ctx: ToolContext; executed: WorkspaceCommand[] } {
  const executed: WorkspaceCommand[] = [];
  const ctx = {
    camera: { screenDistanceToWorld: (px: number) => px },
    scene: { getNode: (id: string) => (id === n.id ? n : undefined), getNodes: () => [n], onChanged: () => () => {} },
    selection: { clickAt: () => {} },
    selectionIds: () => [n.id],
    execute: (c: WorkspaceCommand) => executed.push(c),
    requestRender: () => {},
  } as unknown as ToolContext;
  return { ctx, executed };
}

const down = (x: number, y: number, mods: Partial<{ alt: boolean; shift: boolean; ctrl: boolean; mod: boolean }> = {}): ToolPointerEvent =>
  ({ world: { x, y }, modifiers: { alt: false, shift: false, ctrl: false, meta: false, mod: false, ...mods } }) as unknown as ToolPointerEvent;

const drag = (x: number, y: number, mods: Partial<{ alt: boolean }> = {}): ToolDragEvent =>
  ({ currentWorld: { x, y }, modifiers: { alt: false, shift: false, ctrl: false, meta: false, mod: false, ...mods } }) as unknown as ToolDragEvent;

describe('DirectSelectionTool — geometry', () => {
  it('moves a vertex on a node whose id contains underscores', () => {
    const n = node({ pathPoints: square(40) });
    const { ctx, executed } = makeCtx(n);
    const tool = new DirectSelectionTool();

    tool.onPointerDown(down(-40, -40), ctx);
    tool.onDrag(drag(-10, -20), ctx);

    // The regression: `split('_')` on "comp_root_layer" yielded node "root".
    expect(executed).toHaveLength(1);
    expect(executed[0]!.type).toBe(WorkspaceCommandType.UpdateNodePath);
    const p = (executed[0]!.payload as { id: string; points: ReturnType<typeof square> });
    expect(p.id).toBe('comp_root_layer');
    expect(p.points[0]).toMatchObject({ x: -10, y: -20 });
  });
});

describe('DirectSelectionTool — masks', () => {
  const masked = () =>
    node({ maskPaths: [{ id: 'mask_1', points: square(30) }] });

  it('exposes handles for a mask outline', () => {
    const { ctx } = makeCtx(masked());
    // Was zero: the tool bailed on `if (!node?.pathPoints) continue`.
    expect(new DirectSelectionTool().getHandles(ctx).length).toBe(4);
  });

  it('reshapes the mask, not the layer geometry', () => {
    const { ctx, executed } = makeCtx(masked());
    const tool = new DirectSelectionTool();

    tool.onPointerDown(down(-30, -30), ctx);
    tool.onDrag(drag(-5, -5), ctx);

    expect(executed).toHaveLength(1);
    expect(executed[0]!.type).toBe(WorkspaceCommandType.UpdateMaskPath);
    const p = executed[0]!.payload as { id: string; maskId: string; points: ReturnType<typeof square> };
    expect(p).toMatchObject({ id: 'comp_root_layer', maskId: 'mask_1' });
    expect(p.points[0]).toMatchObject({ x: -5, y: -5 });
    // The other vertices are untouched.
    expect(p.points[1]).toMatchObject({ x: 30, y: -30 });
  });

  it('drags a vertex handle-and-all so tangents follow', () => {
    const pts = square(30).map((p) => ({ ...p, inX: p.x - 5, outX: p.x + 5 }));
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: pts }] }));
    const tool = new DirectSelectionTool();

    tool.onPointerDown(down(-30, -30), ctx);
    tool.onDrag(drag(-20, -30), ctx);

    const p = executed[0]!.payload as { points: typeof pts };
    expect(p.points[0]!.x).toBe(-20);
    expect(p.points[0]!.inX).toBe(-25); // moved with the point
    expect(p.points[0]!.outX).toBe(-15);
  });

  it('deletes a mask vertex with Alt+click (on release — a drag converts instead)', () => {
    const { ctx, executed } = makeCtx(masked());
    const tool = new DirectSelectionTool();
    tool.onPointerDown(down(-30, -30, { alt: true }), ctx);
    expect(executed).toHaveLength(0);
    tool.onClick!(down(-30, -30, { alt: true }), ctx);

    expect(executed[0]!.type).toBe(WorkspaceCommandType.UpdateMaskPath);
    const p = executed[0]!.payload as { points: unknown[]; topology?: unknown };
    expect(p.points).toHaveLength(3);
    // Topology travels with the edit so an animated mask loses the vertex in
    // every keyframe, not just the one at the playhead.
    expect(p.topology).toEqual({ op: 'delete', index: 0 });
  });

  it('refuses to delete below a drawable outline', () => {
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: [corner(0, 0), corner(10, 10)] }] }));
    const tool = new DirectSelectionTool();
    tool.onPointerDown(down(0, 0, { alt: true }), ctx);
    tool.onClick!(down(0, 0, { alt: true }), ctx);
    expect(executed).toHaveLength(0);
  });

  it('handles geometry and masks on the same layer without confusing them', () => {
    const { ctx, executed } = makeCtx(
      node({ pathPoints: square(40), maskPaths: [{ id: 'm', points: square(30) }] }),
    );
    const tool = new DirectSelectionTool();
    expect(tool.getHandles(ctx).length).toBe(8);

    // Grab the mask corner (30,30), not the geometry corner (40,40).
    tool.onPointerDown(down(30, 30), ctx);
    tool.onDrag(drag(25, 25), ctx);
    expect(executed[0]!.type).toBe(WorkspaceCommandType.UpdateMaskPath);

    // Now the geometry corner.
    tool.onPointerDown(down(40, 40), ctx);
    tool.onDrag(drag(45, 45), ctx);
    expect(executed[1]!.type).toBe(WorkspaceCommandType.UpdateNodePath);
  });

  it('reveals tangents only for the active vertex of the active outline', () => {
    const { ctx } = makeCtx(masked());
    const tool = new DirectSelectionTool();
    expect(tool.getHandles(ctx).filter((h) => h.kind !== 'point')).toHaveLength(0);

    tool.onPointerDown(down(-30, -30), ctx);
    const handles = tool.getHandles(ctx);
    expect(handles.filter((h) => h.kind === 'tangent-in')).toHaveLength(1);
    expect(handles.filter((h) => h.kind === 'tangent-out')).toHaveLength(1);
  });
});

type Pts = Array<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }>;
const lastPoints = (executed: WorkspaceCommand[]): Pts => (executed[executed.length - 1]!.payload as { points: Pts }).points;

describe('DirectSelectionTool — handles on corners (Convert Vertex)', () => {
  it('Alt-drag on a CORNER pulls out fresh symmetric handles', () => {
    // The bug: corner tangents coincide with the vertex, and the first-hit scan
    // always found the vertex first — a corner could never get handles.
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: square(30) }] }));
    const tool = new DirectSelectionTool();
    tool.onPointerDown(down(-30, -30, { alt: true }), ctx);
    tool.onDrag(drag(-10, -30, { alt: true }), ctx);

    expect(lastPoints(executed)[0]).toMatchObject({ x: -30, y: -30, outX: -10, outY: -30, inX: -50, inY: -30 });
    tool.onPointerUp!(down(-10, -30), ctx);
    // A drag is not a click: nothing was deleted.
    expect(lastPoints(executed)).toHaveLength(4);
  });

  it('Ctrl+Alt-click toggles corner → smooth → corner', () => {
    let n = node({ maskPaths: [{ id: 'm', points: square(30) }] });
    const run = (): Pts => {
      const { ctx, executed } = makeCtx(n);
      const tool = new DirectSelectionTool();
      tool.onPointerDown(down(-30, -30, { alt: true, ctrl: true, mod: true }), ctx);
      tool.onClick!(down(-30, -30, { alt: true, ctrl: true, mod: true }), ctx);
      return lastPoints(executed);
    };
    const smooth = run();
    expect(smooth).toHaveLength(4); // toggled, not deleted
    const v = smooth[0]!;
    // Along the chord from its neighbours (-30,30) → (30,-30), a third of 60 each way.
    expect(v.outX - v.x).toBeCloseTo(20 / Math.SQRT2);
    expect(v.outY - v.y).toBeCloseTo(-(20 / Math.SQRT2));
    expect(v.inX - v.x).toBeCloseTo(-(20 / Math.SQRT2));

    n = node({ maskPaths: [{ id: 'm', points: smooth }] });
    expect(run()[0]).toMatchObject(corner(-30, -30));
  });

  it('grabs a pulled-out tangent over its vertex when the tangent is nearer', () => {
    const pts = [{ x: 0, y: 0, inX: -6, inY: 0, outX: 6, outY: 0 }, corner(100, 0), corner(50, 80)];
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: pts }] }));
    const tool = new DirectSelectionTool();
    tool.onPointerDown(down(0, 0), ctx); // activate → tangents shown
    tool.onPointerDown(down(5, 0), ctx); // vertex 5 away, out-tangent 1 away
    tool.onDrag(drag(6, 20), ctx);
    const v = lastPoints(executed)[0]!;
    expect(v).toMatchObject({ x: 0, y: 0, outX: 6, outY: 20 }); // the handle moved, not the vertex
  });

  it('dragging one handle of a smooth vertex keeps the OTHER handle\'s length', () => {
    const pts = [{ x: 0, y: 0, inX: -10, inY: 0, outX: 30, outY: 0 }, corner(100, 0), corner(50, 80)];
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: pts }] }));
    const tool = new DirectSelectionTool();
    tool.onPointerDown(down(0, 0), ctx);
    tool.onPointerDown(down(30, 0), ctx);
    tool.onDrag(drag(0, 30), ctx);
    const v = lastPoints(executed)[0]!;
    expect(v.outX).toBeCloseTo(0);
    expect(v.outY).toBeCloseTo(30);
    // Direction mirrored, length kept at 10 (was reset to 30).
    expect(v.inX).toBeCloseTo(0);
    expect(v.inY).toBeCloseTo(-10);
  });
});

describe('DirectSelectionTool — Shift-click adds a vertex ON the outline', () => {
  it('splits the segment under the click, preserving the curve, with a replayable topology', () => {
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: square(30) }] }));
    new DirectSelectionTool().onPointerDown(down(0, -31, { shift: true }), ctx);
    const payload = executed[0]!.payload as { points: Pts; topology: { op: string; segment: number; u: number } };
    expect(payload.points).toHaveLength(5);
    expect(payload.points[1]!.x).toBeCloseTo(0);
    expect(payload.points[1]!.y).toBeCloseTo(-30);
    expect(payload.topology).toMatchObject({ op: 'insert', segment: 0 });
    expect(payload.topology.u).toBeCloseTo(0.5, 3);
  });

  it('closes the loop: a click on the closing segment inserts at the end', () => {
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: square(30) }] }));
    new DirectSelectionTool().onPointerDown(down(-30, 0, { shift: true }), ctx);
    const pts = lastPoints(executed);
    expect(pts).toHaveLength(5);
    expect(pts[4]!.x).toBeCloseTo(-30);
    expect(pts[4]!.y).toBeCloseTo(0);
  });

  it('does NOT append a vertex far from the outline — it is an ordinary Shift-click', () => {
    const { ctx, executed } = makeCtx(node({ maskPaths: [{ id: 'm', points: square(30) }] }));
    let clicked = 0;
    (ctx.selection as unknown as { clickAt: () => void }).clickAt = () => { clicked += 1; };
    const tool = new DirectSelectionTool();
    tool.onPointerDown(down(0, 0, { shift: true }), ctx);
    // With an editable outline selected, empty-space presses resolve on
    // release: a drag marquees vertices, a click is the layer click.
    tool.onClick!(down(0, 0, { shift: true }), ctx);
    expect(executed).toHaveLength(0);
    expect(clicked).toBe(1);
  });

  it('an OPEN geometry path has no closing segment to split', () => {
    const { ctx, executed } = makeCtx(node({ pathPoints: square(30), pathClosed: false }));
    new DirectSelectionTool().onPointerDown(down(-30, 0, { shift: true }), ctx);
    expect(executed).toHaveLength(0);
  });
});

describe('commands.updateMaskPath', () => {
  it('carries the layer, the mask and the points', () => {
    const c = commands.updateMaskPath('n1' as never, 'm1', square(1));
    expect(c.type).toBe(WorkspaceCommandType.UpdateMaskPath);
    expect(c.payload).toMatchObject({ id: 'n1', maskId: 'm1' });
  });
});
