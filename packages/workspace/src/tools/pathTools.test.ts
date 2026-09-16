/**
 * AE-parity path editing: the vertex tools, the Pen's auto-behaviours and
 * path continuation, multi-vertex Direct Selection, Free Transform Points,
 * broken handles, snapping and the Mask Feather tool.
 *
 * Driven the way `direct-select-mask.test.ts` drives the engine: a hand-built
 * context over one in-memory node whose outlines UPDATE when a command is
 * executed, so a multi-tick gesture sees its own writes like the real binding.
 */

import { AddVertexTool, ConvertVertexTool, DeleteVertexTool, MaskFeatherTool } from './pathTools';
import { DirectSelectionTool, PenTool } from './builtin';
import { WorkspaceCommandType, type UpdateMaskPathPayload, type UpdateNodePathPayload } from '../commands/WorkspaceCommands';
import type { ToolContext, ToolDragEvent, ToolKeyEvent, ToolPointerEvent } from './Tool';
import type { WorkspaceCommand, WorkspaceNode } from '../ports';
import type { BezierPoint } from '../math/BezierPoint';
import { corner } from '../math/BezierPoint';
import { NO_MODIFIERS, type Modifiers } from '../input/events';

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const square = (h: number): BezierPoint[] => [corner(-h, -h), corner(h, -h), corner(h, h), corner(-h, h)];

interface Harness {
  ctx: ToolContext;
  executed: WorkspaceCommand[];
  node: () => WorkspaceNode;
  clicks: number;
}

/** One layer, selected, whose geometry/masks are rewritten by the commands the tools submit. */
function harness(init: Partial<WorkspaceNode>, opts: { snap?: boolean } = {}): Harness {
  let n: WorkspaceNode = {
    id: 'layer', parentId: null,
    worldBounds: { x: -50, y: -50, width: 100, height: 100 },
    localBounds: { x: -50, y: -50, width: 100, height: 100 },
    worldMatrix: IDENTITY, visible: true, locked: false, zIndex: 0,
    ...init,
  } as WorkspaceNode;
  const executed: WorkspaceCommand[] = [];
  const h: Harness = {
    executed,
    node: () => n,
    clicks: 0,
    ctx: undefined as unknown as ToolContext,
  };
  h.ctx = {
    camera: { screenDistanceToWorld: (px: number) => px },
    scene: { getNode: (id: string) => (id === n.id ? n : undefined), getNodes: () => [n], onChanged: () => () => {} },
    selection: { clickAt: () => { h.clicks += 1; return null; } },
    selectionIds: () => [n.id],
    snap: { getSettings: () => ({ enabled: opts.snap === true, thresholdPx: 3 }) },
    setSnapLines: () => {},
    requestRender: () => {},
    execute: (c: WorkspaceCommand) => {
      executed.push(c);
      if (c.type === WorkspaceCommandType.UpdateNodePath) {
        const p = c.payload as UpdateNodePathPayload;
        n = { ...n, pathPoints: p.points, ...(p.closed !== undefined ? { pathClosed: p.closed } : {}) };
      } else if (c.type === WorkspaceCommandType.UpdateMaskPath) {
        const p = c.payload as UpdateMaskPathPayload;
        n = { ...n, maskPaths: (n.maskPaths ?? []).map((m) => (m.id === p.maskId ? { ...m, points: p.points } : m)) };
      }
    },
  } as unknown as ToolContext;
  return h;
}

const mods = (m: Partial<Modifiers> = {}): Modifiers => ({ ...NO_MODIFIERS, ...m });
const at = (x: number, y: number, m: Partial<Modifiers> = {}): ToolPointerEvent =>
  ({ screen: { x, y }, world: { x, y }, modifiers: mods(m), pointer: {} }) as unknown as ToolPointerEvent;
const drag = (sx: number, sy: number, x: number, y: number, m: Partial<Modifiers> = {}): ToolDragEvent =>
  ({
    startScreen: { x: sx, y: sy }, currentScreen: { x, y }, startWorld: { x: sx, y: sy }, currentWorld: { x, y },
    deltaScreen: { x: 0, y: 0 }, totalScreen: { x: x - sx, y: y - sy }, deltaWorld: { x: 0, y: 0 }, totalWorld: { x: x - sx, y: y - sy },
    modifiers: mods(m), pointer: {},
  }) as unknown as ToolDragEvent;
const key = (k: string, m: Partial<Modifiers> = {}): ToolKeyEvent => ({ key: k, code: k === ' ' ? 'Space' : k, modifiers: mods(m) }) as unknown as ToolKeyEvent;

const lastPayload = (h: Harness): UpdateNodePathPayload => h.executed[h.executed.length - 1]!.payload as UpdateNodePathPayload;

// ── Direct Selection: multi-vertex ──────────────────────────────────

describe('Direct Selection — vertex selection and multi-vertex edits', () => {
  it('marquee-selects vertices, then one drag moves all of them', () => {
    const h = harness({ pathPoints: square(40) });
    const t = new DirectSelectionTool();
    t.onPointerDown(at(-60, -60), h.ctx);
    t.onDragStart(drag(-60, -60, 60, -20), h.ctx);
    t.onDrag(drag(-60, -60, 60, -20), h.ctx);
    t.onDragEnd(drag(-60, -60, 60, -20), h.ctx);
    const selected = t.getHandles(h.ctx).filter((x) => x.kind === 'point' && x.selected);
    expect(selected).toHaveLength(2); // the two top vertices
    expect(h.clicks).toBe(0); // a marquee is not a layer click

    t.onPointerDown(at(40, -40), h.ctx);
    t.onDrag(drag(40, -40, 50, -30), h.ctx);
    const pts = lastPayload(h).points;
    expect(pts[0]).toMatchObject({ x: -30, y: -30 });
    expect(pts[1]).toMatchObject({ x: 50, y: -30 });
    expect(pts[2]).toMatchObject({ x: 40, y: 40 }); // unselected, untouched
  });

  it('Shift-click adds and removes vertices from the selection', () => {
    const h = harness({ pathPoints: square(40) });
    const t = new DirectSelectionTool();
    t.onPointerDown(at(-40, -40), h.ctx);
    t.onPointerDown(at(40, 40, { shift: true }), h.ctx);
    expect(t.selectedIndices({ nodeId: 'layer', maskId: null })).toEqual([0, 2]);
    t.onPointerDown(at(-40, -40, { shift: true }), h.ctx);
    expect(t.selectedIndices({ nodeId: 'layer', maskId: null })).toEqual([2]);
  });

  it('Delete removes every selected vertex as one replayable edit, and claims the key', () => {
    const h = harness({ pathPoints: [...square(40), corner(0, 60)] });
    const t = new DirectSelectionTool();
    expect(t.claimedKeys()).toEqual([]);
    t.onPointerDown(at(-40, -40), h.ctx);
    t.onPointerDown(at(40, 40, { shift: true }), h.ctx);
    expect(t.claimedKeys()).toEqual(expect.arrayContaining(['delete', 'backspace', 'shift+arrowleft', 'ctrl+t']));
    expect(t.onKeyDown(key('Delete'), h.ctx)).toBe(true);
    const p = lastPayload(h);
    expect(p.points).toHaveLength(3);
    expect(p.topology).toEqual({ op: 'deleteMany', indices: [0, 2] });
    expect(t.claimedKeys()).toEqual([]);
  });

  it('arrow keys nudge the selected vertices, Shift by 10', () => {
    const h = harness({ maskPaths: [{ id: 'm', points: square(30) }] });
    const t = new DirectSelectionTool();
    t.onPointerDown(at(30, 30), h.ctx);
    t.onKeyDown(key('ArrowRight'), h.ctx);
    expect((h.executed[0]!.payload as UpdateMaskPathPayload).points[2]).toMatchObject({ x: 31, y: 30 });
    t.onKeyDown(key('ArrowUp', { shift: true }), h.ctx);
    expect((h.executed[1]!.payload as UpdateMaskPathPayload).points[2]).toMatchObject({ x: 31, y: 20 });
  });

  it('dragging a SEGMENT bends it through the pointer, leaving the vertices where they are', () => {
    const h = harness({ pathPoints: [corner(0, 0), corner(100, 0), corner(100, 100)], pathClosed: false });
    const t = new DirectSelectionTool();
    t.onPointerDown(at(50, 0), h.ctx);
    t.onDrag(drag(50, 0, 50, 30), h.ctx);
    const [a, b] = lastPayload(h).points;
    expect(a).toMatchObject({ x: 0, y: 0 });
    expect(b).toMatchObject({ x: 100, y: 0 });
    // B(0.5) = (P0 + 3P1 + 3P2 + P3)/8 must now sit at y = 30.
    expect((a!.y + 3 * a!.outY + 3 * b!.inY + b!.y) / 8).toBeCloseTo(30, 6);
  });

  it('an Alt-dragged handle stays broken on a later PLAIN drag', () => {
    const smooth: BezierPoint = { x: 0, y: 0, inX: -20, inY: 0, outX: 20, outY: 0 };
    const h = harness({ pathPoints: [smooth, corner(100, 0), corner(50, 80)] });
    const t = new DirectSelectionTool();
    t.onPointerDown(at(0, 0), h.ctx);
    t.onPointerDown(at(20, 0, { alt: true }), h.ctx);
    t.onDrag(drag(20, 0, 20, 20, { alt: true }), h.ctx);
    let v = lastPayload(h).points[0]!;
    expect(v).toMatchObject({ outX: 20, outY: 20, inX: -20, inY: 0, broken: true });

    t.onPointerUp(at(20, 20), h.ctx);
    t.onPointerDown(at(20, 20), h.ctx); // no Alt this time
    t.onDrag(drag(20, 20, 0, 30), h.ctx);
    v = lastPayload(h).points[0]!;
    expect(v).toMatchObject({ outX: 0, outY: 30, inX: -20, inY: 0, broken: true });
  });

  it('a dragged vertex snaps to another vertex of its own path', () => {
    const h = harness({ pathPoints: [corner(0, 0), corner(100, 0), corner(100, 100)] }, { snap: true });
    const t = new DirectSelectionTool();
    t.onPointerDown(at(100, 100), h.ctx);
    t.onDrag(drag(100, 100, 5, 4), h.ctx); // 6.4 px from vertex 0
    expect(lastPayload(h).points[2]).toMatchObject({ x: 0, y: 0 });
  });
});

describe('Free Transform Points', () => {
  it('Ctrl+T opens a box around the selected vertices; a corner drag scales about the opposite corner', () => {
    const h = harness({ pathPoints: [corner(0, 0), corner(100, 0), corner(100, 50), corner(0, 50)] });
    const t = new DirectSelectionTool();
    t.onPointerDown(at(-10, -10), h.ctx);
    t.onDragStart(drag(-10, -10, 200, 200), h.ctx);
    t.onDragEnd(drag(-10, -10, 200, 200), h.ctx);
    expect(t.onKeyDown(key('t', { ctrl: true, mod: true }), h.ctx)).toBe(true);
    const box = t.getTransformBox(h.ctx)!;
    expect(box.corners[2]).toMatchObject({ x: 100, y: 50 });

    t.onPointerDown(at(100, 50), h.ctx); // the SE grip
    t.onDrag(drag(100, 50, 200, 100), h.ctx);
    const pts = lastPayload(h).points;
    expect(pts[0]).toMatchObject({ x: 0, y: 0 });
    expect(pts[2]!.x).toBeCloseTo(200);
    expect(pts[2]!.y).toBeCloseTo(100);
    t.onDragEnd(drag(100, 50, 200, 100), h.ctx);
    expect(t.getTransformBox(h.ctx)!.corners[2].x).toBeCloseTo(200);

    expect(t.claimedKeys()).toContain('enter');
    expect(t.onKeyDown(key('Enter'), h.ctx)).toBe(true);
    expect(t.getTransformBox(h.ctx)).toBeNull();
  });

  it('double-clicking the path transforms the whole outline; a drag inside rotates about the anchor from outside', () => {
    const h = harness({ maskPaths: [{ id: 'm', points: square(50) }] });
    const t = new DirectSelectionTool();
    t.onDoubleClick(at(0, -50), h.ctx);
    expect(t.getTransformBox(h.ctx)).not.toBeNull();
    // Just outside the NE corner: the rotate zone. Sweep 90° about the centre.
    t.onPointerDown(at(60, -60), h.ctx);
    t.onDrag(drag(60, -60, 60, 60), h.ctx);
    const pts = (h.executed[h.executed.length - 1]!.payload as UpdateMaskPathPayload).points;
    expect(pts[0]!.x).toBeCloseTo(50);
    expect(pts[0]!.y).toBeCloseTo(-50);
    expect(pts[1]!.x).toBeCloseTo(50);
    expect(pts[1]!.y).toBeCloseTo(50);
  });
});

// ── Vertex tools ────────────────────────────────────────────────────

describe('Add / Delete / Convert Vertex tools', () => {
  it('Add Vertex splits the segment under the click and drags the new vertex', () => {
    const h = harness({ pathPoints: square(40) });
    const t = new AddVertexTool();
    t.onPointerDown(at(0, -40), h.ctx);
    const first = h.executed[0]!.payload as UpdateNodePathPayload;
    expect(first.points).toHaveLength(5);
    expect(first.topology).toMatchObject({ op: 'insert', segment: 0 });
    t.onDrag(drag(0, -40, 0, -60), h.ctx);
    const moved = lastPayload(h).points[1]!;
    expect(moved.x).toBeCloseTo(0, 5);
    expect(moved.y).toBeCloseTo(-60, 5);
  });

  it('Add Vertex off the path is a plain layer click', () => {
    const h = harness({ pathPoints: square(40) });
    new AddVertexTool().onPointerDown(at(0, 0), h.ctx);
    expect(h.executed).toHaveLength(0);
    expect(h.clicks).toBe(1);
  });

  it('Delete Vertex removes the clicked vertex', () => {
    const h = harness({ maskPaths: [{ id: 'm', points: square(30) }] });
    new DeleteVertexTool().onPointerDown(at(30, -30), h.ctx);
    const p = h.executed[0]!.payload as UpdateMaskPathPayload;
    expect(p.points).toHaveLength(3);
    expect(p.topology).toEqual({ op: 'delete', index: 1 });
  });

  it('Convert Vertex: click toggles corner ⇄ smooth, drag redraws symmetric handles, a handle drag breaks the pair', () => {
    const h = harness({ pathPoints: square(30) });
    const t = new ConvertVertexTool();
    t.onPointerDown(at(-30, -30), h.ctx);
    t.onPointerUp(at(-30, -30), h.ctx);
    expect(hasHandlesOn(lastPayload(h).points[0]!)).toBe(true);

    t.onPointerDown(at(30, 30), h.ctx);
    t.onDrag(drag(30, 30, 30, 50), h.ctx);
    t.onPointerUp(at(30, 50), h.ctx);
    const v = lastPayload(h).points[2]!;
    expect(v).toMatchObject({ outX: 30, outY: 50, inX: 30, inY: 10 });
    expect(v.broken).toBeUndefined();

    t.onPointerDown(at(30, 50), h.ctx); // its out handle
    t.onDrag(drag(30, 50, 50, 50), h.ctx);
    expect(lastPayload(h).points[2]).toMatchObject({ outX: 50, outY: 50, inX: 30, inY: 10, broken: true });
  });

  it('Convert Vertex on a RotoBezier path edits tension and reports it', () => {
    const h = harness({ pathPoints: square(30), pathRotoBezier: true });
    const t = new ConvertVertexTool();
    t.onPointerDown(at(-30, -30), h.ctx);
    t.onPointerUp(at(-30, -30), h.ctx);
    expect(lastPayload(h).points[0]!.tension).toBe(1);
    expect(t.getHud(h.ctx)!.lines[0]).toBe('Tension: 100%');
  });
});

const hasHandlesOn = (p: BezierPoint): boolean => p.inX !== p.x || p.outX !== p.x || p.inY !== p.y || p.outY !== p.y;

// ── Pen auto-behaviours and continuation ────────────────────────────

describe('Pen on an existing path', () => {
  it('over a segment it adds a vertex; over a vertex a click converts it', () => {
    const h = harness({ pathPoints: square(40) });
    const t = new PenTool();
    t.onPointerDown(at(40, 0), h.ctx);
    t.onPointerUp(at(40, 0), h.ctx);
    expect((h.executed[0]!.payload as UpdateNodePathPayload).topology).toMatchObject({ op: 'insert', segment: 1 });
    expect(t.pendingPoints).toHaveLength(0); // no draft was started

    t.onPointerDown(at(-40, 40), h.ctx);
    t.onPointerUp(at(-40, 40), h.ctx);
    expect(hasHandlesOn(lastPayload(h).points[4]!)).toBe(true);
  });

  it('clicking the END vertex of an open path continues it; the new run is appended', () => {
    const h = harness({ pathPoints: [corner(0, 0), corner(100, 0)], pathClosed: false });
    const t = new PenTool();
    t.onPointerDown(at(100, 0), h.ctx);
    t.onPointerUp(at(100, 0), h.ctx);
    expect(t.pendingPoints).toHaveLength(2);
    t.onPointerDown(at(100, 100), h.ctx);
    t.onPointerUp(at(100, 100), h.ctx);
    t.onKeyDown(key('Enter'), h.ctx);
    const p = lastPayload(h);
    expect(p.points.map((q) => [q.x, q.y])).toEqual([[0, 0], [100, 0], [100, 100]]);
    expect(p.topology).toMatchObject({ op: 'extend', atStart: false });
    expect(h.executed.some((c) => c.type === WorkspaceCommandType.CreateNode)).toBe(false);
  });

  it('continuing from the FIRST vertex prepends, in path order', () => {
    const h = harness({ pathPoints: [corner(0, 0), corner(100, 0)], pathClosed: false });
    const t = new PenTool();
    t.onPointerDown(at(0, 0, { ctrl: true, mod: true }), h.ctx);
    t.onPointerUp(at(0, 0), h.ctx);
    t.onPointerDown(at(-50, 50), h.ctx);
    t.onPointerUp(at(-50, 50), h.ctx);
    t.onPointerDown(at(-100, 0), h.ctx);
    t.onPointerUp(at(-100, 0), h.ctx);
    t.deactivate(h.ctx);
    const p = lastPayload(h);
    expect(p.points.map((q) => [q.x, q.y])).toEqual([[-100, 0], [-50, 50], [0, 0], [100, 0]]);
    expect(p.topology).toMatchObject({ op: 'extend', atStart: true });
    expect((p.topology as { points: BezierPoint[] }).points.map((q) => q.x)).toEqual([-100, -50]);
  });

  it('continuing and clicking the other end closes the path', () => {
    const h = harness({ pathPoints: [corner(0, 0), corner(100, 0), corner(100, 100)], pathClosed: false });
    const t = new PenTool();
    t.onPointerDown(at(100, 100), h.ctx);
    t.onPointerUp(at(100, 100), h.ctx);
    t.onPointerDown(at(0, 0), h.ctx);
    t.onPointerUp(at(0, 0), h.ctx);
    const p = lastPayload(h);
    expect(p.closed).toBe(true);
    expect(p.points).toHaveLength(3);
  });

  it('Space while dragging a new vertex repositions it instead of pulling handles', () => {
    const h = harness({});
    const t = new PenTool();
    t.onPointerDown(at(0, 0), h.ctx);
    t.onDrag(drag(0, 0, 10, 0), h.ctx); // pulls a handle
    expect(t.onKeyDown(key(' '), h.ctx)).toBe(true);
    t.onDrag(drag(0, 0, 30, 20), h.ctx); // moves by (20, 20)
    t.onKeyUp!(key(' '), h.ctx);
    expect(t.pendingPoints[0]).toMatchObject({ x: 20, y: 20, outX: 30, outY: 20, inX: 10, inY: 20 });
  });

  it('Alt-drag while drawing marks the vertex broken', () => {
    const h = harness({});
    const t = new PenTool();
    t.onPointerDown(at(0, 0), h.ctx);
    t.onDrag(drag(0, 0, 0, 40, { alt: true }), h.ctx);
    expect(t.pendingPoints[0]!.broken).toBe(true);
  });

  it('Ctrl-drag is a temporary Direct Selection: it moves a vertex, no draft', () => {
    const h = harness({ pathPoints: square(40) });
    const t = new PenTool();
    t.onPointerDown(at(-40, -40, { ctrl: true, mod: true }), h.ctx);
    t.onDrag(drag(-40, -40, -20, -20, { ctrl: true, mod: true }), h.ctx);
    t.onPointerUp(at(-20, -20), h.ctx);
    expect(lastPayload(h).points[0]).toMatchObject({ x: -20, y: -20 });
    expect(t.pendingPoints).toHaveLength(0);
  });
});

// ── Mask Feather ────────────────────────────────────────────────────

describe('Mask Feather tool', () => {
  it('a click on the mask adds a feather point, a drag sets its width, Alt-click removes it', () => {
    const h = harness({ maskPaths: [{ id: 'm', points: square(50) }] });
    const t = new MaskFeatherTool();
    t.onPointerDown(at(0, -50), h.ctx);
    const inserted = h.executed[0]!.payload as UpdateMaskPathPayload;
    expect(inserted.topology).toMatchObject({ op: 'insert', segment: 0 });
    t.onDrag(drag(0, -50, 0, -60), h.ctx); // 10 px outward → 20 px diameter
    const pts = (h.executed[h.executed.length - 1]!.payload as UpdateMaskPathPayload).points as Array<BezierPoint & { feather?: number }>;
    expect(pts[1]!.feather).toBeCloseTo(20);
    expect(t.getHandles(h.ctx).filter((x) => x.kind === 'feather')).toHaveLength(1);
    t.onPointerUp(at(0, -60), h.ctx);

    t.onPointerDown(at(0, -60, { alt: true }), h.ctx); // on the grip
    const cleared = (h.executed[h.executed.length - 1]!.payload as UpdateMaskPathPayload).points as Array<BezierPoint & { feather?: number }>;
    expect(cleared[1]!.feather).toBeUndefined();
  });

  it('ignores the layer geometry — feather belongs to masks', () => {
    const h = harness({ pathPoints: square(50) });
    new MaskFeatherTool().onPointerDown(at(0, -50), h.ctx);
    expect(h.executed).toHaveLength(0);
  });
});
