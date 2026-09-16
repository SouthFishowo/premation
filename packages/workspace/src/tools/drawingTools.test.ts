/**
 * Drawing tools — verify each new tool commits a createNode command with the
 * right kind + geometry, and that the pen commits (rather than discards) on
 * deactivate so switching tools mid-draw keeps the path.
 */

import { PencilTool, LineTool, PolygonTool, StarTool, CurvatureTool, PenTool, MaskPenTool } from './builtin';
import { WorkspaceCommandType, type CreateNodePayload } from '../commands/WorkspaceCommands';
import type { ToolContext, ToolDragEvent, ToolPointerEvent, ToolKeyEvent } from './Tool';
import { NO_MODIFIERS } from '../input/events';

function makeCtx() {
  const commands: Array<{ kind: string; points?: unknown[] }> = [];
  const ctx = {
    requestRender: () => {},
    selectionIds: () => [] as string[],
    execute: (cmd: { type: string; payload: CreateNodePayload }) => {
      if (cmd.type === WorkspaceCommandType.CreateNode) {
        commands.push({ kind: cmd.payload.kind, points: cmd.payload.points });
      }
    },
  } as unknown as ToolContext;
  return { ctx, commands };
}

const drag = (sx: number, sy: number, cx: number, cy: number): ToolDragEvent => ({
  startScreen: { x: sx, y: sy }, currentScreen: { x: cx, y: cy },
  startWorld: { x: sx, y: sy }, currentWorld: { x: cx, y: cy },
  deltaScreen: { x: 0, y: 0 }, totalScreen: { x: cx - sx, y: cy - sy },
  deltaWorld: { x: 0, y: 0 }, totalWorld: { x: cx - sx, y: cy - sy },
  modifiers: NO_MODIFIERS, pointer: {} as ToolDragEvent['pointer'],
});

const click = (x: number, y: number): ToolPointerEvent => ({
  screen: { x, y }, world: { x, y }, modifiers: NO_MODIFIERS, pointer: {} as ToolPointerEvent['pointer'],
});

describe('drawing tools commit the right nodes', () => {
  it('LineTool creates a 2-point Line', () => {
    const { ctx, commands } = makeCtx();
    const t = new LineTool();
    t.onDragStart(drag(0, 0, 0, 0), ctx);
    t.onDrag(drag(0, 0, 100, 60), ctx);
    t.onDragEnd(drag(0, 0, 100, 60), ctx);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe('Line');
    expect(commands[0]!.points).toHaveLength(2);
  });

  it('PencilTool creates a Pencil path from a freehand drag', () => {
    const { ctx, commands } = makeCtx();
    const t = new PencilTool();
    t.onDragStart(drag(0, 0, 0, 0), ctx);
    for (let i = 1; i <= 20; i++) t.onDrag(drag(0, 0, i * 5, Math.sin(i) * 30), ctx);
    t.onDragEnd(drag(0, 0, 100, 0), ctx);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe('Pencil');
    expect((commands[0]!.points as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('PolygonTool creates a 6-point Polygon', () => {
    const { ctx, commands } = makeCtx();
    const t = new PolygonTool();
    t.onDrag(drag(0, 0, 100, 100), ctx);
    t.onDragEnd(drag(0, 0, 100, 100), ctx);
    expect(commands[0]!.kind).toBe('Polygon');
    expect(commands[0]!.points).toHaveLength(6);
  });

  it('StarTool creates a 10-point Star', () => {
    const { ctx, commands } = makeCtx();
    const t = new StarTool();
    t.onDrag(drag(0, 0, 100, 100), ctx);
    t.onDragEnd(drag(0, 0, 100, 100), ctx);
    expect(commands[0]!.kind).toBe('Star');
    expect(commands[0]!.points).toHaveLength(10);
  });

  it('CurvatureTool smooths clicked points into a Path with bezier handles', () => {
    const { ctx, commands } = makeCtx();
    const t = new CurvatureTool();
    t.onClick(click(0, 0), ctx);
    t.onClick(click(50, 40), ctx);
    t.onClick(click(100, 0), ctx);
    t.onKeyDown({ key: 'Enter' } as ToolKeyEvent, ctx);
    expect(commands[0]!.kind).toBe('Path');
    const pts = commands[0]!.points as Array<{ x: number; outX: number }>;
    // Middle anchor should carry a non-trivial out-tangent (curve, not corner).
    expect(pts[1]!.outX).not.toBe(pts[1]!.x);
  });

  it('PenTool commits (does not discard) the in-progress path on deactivate', () => {
    const { ctx, commands } = makeCtx();
    const t = new PenTool();
    t.onPointerDown(click(0, 0), ctx);
    t.onPointerUp(click(0, 0), ctx);
    t.onPointerDown(click(80, 40), ctx);
    t.onPointerUp(click(80, 40), ctx);
    // Switching tools mid-draw triggers deactivate — the path must be kept.
    t.deactivate(ctx);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe('Path');
  });
});

/**
 * The reported bug, pinned down.
 *
 * "I draw with another pen, then draw with the Pen, then pick another tool, and
 * the stroke I already had is deleted." It was: `finish` passed the single
 * selected node as `maskTargetId`, so the path became an `add` MASK on that
 * layer — clipping the layer to the new outline — instead of becoming a layer
 * of its own. Both halves of the drawing vanish that way.
 *
 * The condition was met permanently rather than occasionally, because
 * `createNode` selects whatever it just created. So after drawing ANYTHING the
 * pen was in mask mode, with no way to see that and no way to turn it off.
 *
 * A selection is the trigger, which is why nothing above catches it: every test
 * there uses a context whose selection is empty. These use a populated one.
 */
function makeCtxWithSelection(ids: string[]) {
  const commands: Array<{ kind: string; maskTargetId?: string }> = [];
  const ctx = {
    requestRender: () => {},
    selectionIds: () => ids,
    execute: (cmd: { type: string; payload: CreateNodePayload }) => {
      if (cmd.type === WorkspaceCommandType.CreateNode) {
        commands.push({ kind: cmd.payload.kind, maskTargetId: cmd.payload.maskTargetId });
      }
    },
  } as unknown as ToolContext;
  return { ctx, commands };
}

const drawTwoPoints = (t: PenTool, ctx: ToolContext): void => {
  t.onPointerDown(click(0, 0), ctx);
  t.onPointerUp(click(0, 0), ctx);
  t.onPointerDown(click(80, 40), ctx);
  t.onPointerUp(click(80, 40), ctx);
  t.deactivate(ctx);
};

describe('the Pen draws a layer, not a mask', () => {
  it('does NOT mask the selected layer', () => {
    const { ctx, commands } = makeCtxWithSelection(['layer_the_user_just_drew']);
    drawTwoPoints(new PenTool(), ctx);

    expect(commands).toHaveLength(1);
    // The whole bug in one assertion: a mask target here meant the previous
    // stroke was clipped away and this path never became a layer.
    expect(commands[0]!.maskTargetId).toBeUndefined();
    expect(commands[0]!.kind).toBe('Path');
  });

  it('MaskPenTool still masks — the capability moved, it was not removed', () => {
    const { ctx, commands } = makeCtxWithSelection(['layer_a']);
    drawTwoPoints(new MaskPenTool(), ctx);

    expect(commands).toHaveLength(1);
    expect(commands[0]!.maskTargetId).toBe('layer_a');
  });

  it('MaskPenTool with nothing selected falls back to a path layer', () => {
    const { ctx, commands } = makeCtxWithSelection([]);
    drawTwoPoints(new MaskPenTool(), ctx);

    // A mask needs a layer to belong to. Refusing the stroke would throw away
    // what the user just drew, so it lands as a layer instead.
    expect(commands).toHaveLength(1);
    expect(commands[0]!.maskTargetId).toBeUndefined();
    expect(commands[0]!.kind).toBe('Path');
  });

  it('MaskPenTool does not guess which layer to mask from a multi-selection', () => {
    const { ctx, commands } = makeCtxWithSelection(['layer_a', 'layer_b']);
    drawTwoPoints(new MaskPenTool(), ctx);

    expect(commands[0]!.maskTargetId).toBeUndefined();
  });
});

/**
 * Closing, and the AE modifiers while drawing.
 *
 * The Pen could not close a SHAPE at all — clicking the first vertex closed
 * only in mask mode, and every path was created open — and the mask pen's
 * close radius was 10 WORLD px, which is a pinhole zoomed out and a trap
 * zoomed in. `zoom` below is world px per screen px.
 */
function makePenCtx(zoom = 1, selection: string[] = []) {
  const created: Array<{ points: Array<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }>; closed?: boolean; maskTargetId?: string }> = [];
  const ctx = {
    camera: { screenDistanceToWorld: (px: number) => px * zoom },
    requestRender: () => {},
    selectionIds: () => selection,
    execute: (cmd: { type: string; payload: CreateNodePayload }) => {
      if (cmd.type === WorkspaceCommandType.CreateNode) {
        created.push({
          points: cmd.payload.points as never,
          closed: cmd.payload.closed,
          maskTargetId: cmd.payload.maskTargetId,
        });
      }
    },
  } as unknown as ToolContext;
  return { ctx, created };
}

const at = (x: number, y: number, mods: Partial<typeof NO_MODIFIERS> = {}): ToolPointerEvent => ({
  screen: { x, y }, world: { x, y }, modifiers: { ...NO_MODIFIERS, ...mods }, pointer: {} as ToolPointerEvent['pointer'],
});

const pull = (x: number, y: number, mods: Partial<typeof NO_MODIFIERS> = {}): ToolDragEvent => ({
  ...drag(0, 0, x, y),
  modifiers: { ...NO_MODIFIERS, ...mods },
});

const place = (t: PenTool, ctx: ToolContext, x: number, y: number, mods: Partial<typeof NO_MODIFIERS> = {}): void => {
  t.onPointerDown(at(x, y, mods), ctx);
  t.onPointerUp(at(x, y, mods), ctx);
};

const triangle = (t: PenTool, ctx: ToolContext): void => {
  place(t, ctx, 0, 0);
  place(t, ctx, 100, 0);
  place(t, ctx, 50, 80);
};

describe('Pen closing', () => {
  it('clicking the first vertex closes a Pen SHAPE, and says so', () => {
    const { ctx, created } = makePenCtx();
    const t = new PenTool();
    triangle(t, ctx);
    place(t, ctx, 4, 3); // 5 screen px from the first vertex
    expect(created).toHaveLength(1);
    expect(created[0]!.closed).toBe(true);
    expect(created[0]!.points).toHaveLength(3);
  });

  it('Mask Pen closes the same way', () => {
    const { ctx, created } = makePenCtx(1, ['layer_a']);
    const t = new MaskPenTool();
    triangle(t, ctx);
    place(t, ctx, 2, 2);
    expect(created).toHaveLength(1);
    expect(created[0]!.maskTargetId).toBe('layer_a');
  });

  it('the close radius is SCREEN px: zoomed in, a nearby click adds a vertex', () => {
    // 2× zoom → 9 screen px is 4.5 world px. The old 10 world px closed here.
    const { ctx, created } = makePenCtx(0.5);
    const t = new MaskPenTool();
    triangle(t, ctx);
    place(t, ctx, 6, 0);
    expect(created).toHaveLength(0);
    expect(t.pendingPoints).toHaveLength(4);
  });

  it('…and zoomed out, a click that looks close on screen closes', () => {
    const { ctx, created } = makePenCtx(4);
    const t = new PenTool();
    triangle(t, ctx);
    place(t, ctx, 30, 0); // 7.5 screen px
    expect(created[0]!.closed).toBe(true);
  });

  it('a drag on the closing click shapes the first vertex\'s handles', () => {
    const { ctx, created } = makePenCtx();
    const t = new PenTool();
    triangle(t, ctx);
    t.onPointerDown(at(0, 0), ctx);
    t.onDrag(pull(0, -30), ctx);
    expect(created).toHaveLength(0); // closes on release, not press
    t.onPointerUp(at(0, -30), ctx);
    expect(created[0]!.closed).toBe(true);
    const first = created[0]!.points[0]!;
    expect(first.outY - first.y).toBeCloseTo(-30);
    expect(first.inY - first.y).toBeCloseTo(30);
  });

  it('double-clicking the LAST vertex closes; double-clicking empty space finishes open', () => {
    const closeRun = makePenCtx();
    const a = new PenTool();
    triangle(a, closeRun.ctx);
    place(a, closeRun.ctx, 50, 80);
    place(a, closeRun.ctx, 50, 80);
    a.onDoubleClick(at(50, 80), closeRun.ctx);
    expect(closeRun.created[0]).toMatchObject({ closed: true });
    expect(closeRun.created[0]!.points).toHaveLength(3);

    const openRun = makePenCtx();
    const b = new PenTool();
    place(b, openRun.ctx, 0, 0);
    place(b, openRun.ctx, 100, 0);
    place(b, openRun.ctx, 300, 300);
    place(b, openRun.ctx, 300, 300);
    b.onDoubleClick(at(300, 300), openRun.ctx);
    expect(openRun.created[0]!.closed).toBeFalsy();
    expect(openRun.created[0]!.points).toHaveLength(3);
  });

  it('Enter still finishes an OPEN path', () => {
    const { ctx, created } = makePenCtx();
    const t = new PenTool();
    triangle(t, ctx);
    t.onKeyDown({ key: 'Enter' } as ToolKeyEvent, ctx);
    expect(created[0]!.closed).toBeFalsy();
  });
});

describe('Pen modifiers while drawing', () => {
  it('Shift-click constrains the new segment to 15° steps, keeping its length', () => {
    const { ctx } = makePenCtx();
    const t = new PenTool();
    place(t, ctx, 0, 0);
    place(t, ctx, 100, 10, { shift: true }); // 5.7° → 0°
    const p = t.pendingPoints[1]!;
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeCloseTo(Math.hypot(100, 10));
  });

  it('Shift-drag constrains the handle to 15° steps', () => {
    const { ctx } = makePenCtx();
    const t = new PenTool();
    t.onPointerDown(at(0, 0), ctx);
    t.onDrag(pull(50, 48, { shift: true }), ctx); // 43.8° → 45°
    const p = t.pendingPoints[0]!;
    expect(p.outX).toBeCloseTo(p.outY);
  });

  it('Alt-drag moves only the outgoing handle', () => {
    const { ctx } = makePenCtx();
    const t = new PenTool();
    place(t, ctx, 0, 0);
    t.onPointerDown(at(100, 0), ctx);
    t.onDrag(pull(100, 50, { alt: true }), ctx);
    const p = t.pendingPoints[1]!;
    expect(p).toMatchObject({ outX: 100, outY: 50, inX: 100, inY: 0 });
  });

  it('a plain drag still pulls symmetric handles', () => {
    const { ctx } = makePenCtx();
    const t = new PenTool();
    t.onPointerDown(at(100, 0), ctx);
    t.onDrag(pull(100, 50), ctx);
    expect(t.pendingPoints[0]).toMatchObject({ outX: 100, outY: 50, inX: 100, inY: -50 });
  });

  it('Backspace takes back the last vertex and claims the key', () => {
    const { ctx, created } = makePenCtx();
    const t = new PenTool();
    triangle(t, ctx);
    expect(t.onKeyDown({ key: 'Backspace' } as ToolKeyEvent, ctx)).toBe(true);
    expect(t.pendingPoints).toHaveLength(2);
    expect(t.onKeyDown({ key: 'Delete' } as ToolKeyEvent, ctx)).toBe(true);
    expect(t.pendingPoints).toHaveLength(1);
    expect(created).toHaveLength(0);
  });

  it('Curvature Pen: Backspace takes back the last point too', () => {
    const { ctx } = makePenCtx();
    const t = new CurvatureTool();
    t.onClick(at(0, 0), ctx);
    t.onClick(at(50, 0), ctx);
    expect(t.onKeyDown({ key: 'Backspace' } as ToolKeyEvent, ctx)).toBe(true);
    // Preview includes no mouse, so one committed point remains.
    expect(t.pendingPoints).toHaveLength(1);
  });
});
