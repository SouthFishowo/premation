/**
 * Pan Behind (Y) anchor snapping: own box points first, external features
 * second, and a Ctrl toggle — plus the tool wiring that uses it.
 */

import { layerBoxPoints, resolveAnchorSnap } from './anchorSnap';
import { PanBehindTool } from '../tools/builtin';
import { SnapEngine } from './SnapEngine';
import { WorkspaceCommandType, type MoveAnchorPayload } from '../commands/WorkspaceCommands';
import type { ToolContext, ToolDragEvent, ToolPointerEvent } from '../tools/Tool';
import { NO_MODIFIERS, type Modifiers } from '../input/events';
import * as Mat from '../math/Mat2D';
import * as R from '../math/Rect';

describe('layerBoxPoints', () => {
  it('returns the nine box points through the world matrix, TL→BR row by row', () => {
    const pts = layerBoxPoints(R.rect(-50, -25, 100, 50), Mat.translation(200, 100));
    expect(pts).toHaveLength(9);
    expect(pts[0]).toEqual({ x: 150, y: 75 }); // TL
    expect(pts[4]).toEqual({ x: 200, y: 100 }); // centre
    expect(pts[8]).toEqual({ x: 250, y: 125 }); // BR
  });

  it('follows rotation — the points sit on the ORIENTED box', () => {
    const pts = layerBoxPoints(R.rect(-10, -10, 20, 20), Mat.rotation(Math.PI / 2));
    // Local TL (-10,-10) rotated a quarter turn is (10,-10).
    expect(pts[0]!.x).toBeCloseTo(10);
    expect(pts[0]!.y).toBeCloseTo(-10);
  });
});

describe('resolveAnchorSnap', () => {
  const own = layerBoxPoints(R.rect(-50, -25, 100, 50), Mat.translation(0, 0));

  it('snaps to the nearest own box point in reach', () => {
    const r = resolveAnchorSnap({ x: 46, y: -22 }, own, 8, true);
    expect(r.snappedTo).toBe('own-box');
    expect(r.point).toEqual({ x: 50, y: -25 });
    expect(r.lines).toHaveLength(2);
  });

  it('asks the external snapper only when no own point is in reach', () => {
    const external = jest.fn(() => ({
      value: { x: 20, y: 0 }, delta: { x: 1, y: 0 }, snapped: true, lines: [], spacing: [],
    }));
    expect(resolveAnchorSnap({ x: 1, y: 1 }, own, 8, true, external).snappedTo).toBe('own-box');
    expect(external).not.toHaveBeenCalled();
    const r = resolveAnchorSnap({ x: 19, y: 0 }, own, 8, true, external);
    expect(external).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ snappedTo: 'external', point: { x: 20, y: 0 } });
  });

  it('inactive (snap off, or Ctrl held with snap on) leaves the pointer free', () => {
    const r = resolveAnchorSnap({ x: 49, y: -24 }, own, 8, false);
    expect(r).toEqual({ point: { x: 49, y: -24 }, snappedTo: null, lines: [] });
  });
});

describe('PanBehindTool snapping', () => {
  function run(mods: Partial<Modifiers>, snapEnabled: boolean): { anchors: MoveAnchorPayload[]; lines: unknown[] } {
    // A 100×50 layer centred at (200,100).
    const node = { id: 'n1', worldMatrix: Mat.translation(200, 100), anchor: { x: 0, y: 0 }, localBounds: R.rect(-50, -25, 100, 50) };
    const snap = new SnapEngine();
    snap.setSettings({ enabled: snapEnabled });
    const anchors: MoveAnchorPayload[] = [];
    let lines: unknown[] = [];
    const ctx = {
      requestRender: () => {},
      selectionIds: () => ['n1'],
      scene: { getNode: () => node },
      selection: { select: () => {}, clickAt: () => {} },
      camera: { screenDistanceToWorld: (px: number) => px },
      hitTester: { hitTest: () => node },
      snap,
      setSnapLines: (l: unknown[]) => { lines = l; },
      execute: (cmd: { type: string; payload: unknown }) => {
        if (cmd.type === WorkspaceCommandType.MoveAnchor) anchors.push(cmd.payload as MoveAnchorPayload);
      },
    } as unknown as ToolContext;
    const t = new PanBehindTool();
    const down: ToolPointerEvent = { screen: { x: 200, y: 100 }, world: { x: 200, y: 100 }, modifiers: NO_MODIFIERS, pointer: {} as ToolPointerEvent['pointer'] };
    t.onPointerDown(down, ctx);
    const modifiers = { ...NO_MODIFIERS, ...mods };
    const drag: ToolDragEvent = {
      startScreen: { x: 200, y: 100 }, currentScreen: { x: 247, y: 77 },
      startWorld: { x: 200, y: 100 }, currentWorld: { x: 247, y: 77 },
      deltaScreen: { x: 0, y: 0 }, totalScreen: { x: 47, y: -23 },
      deltaWorld: { x: 0, y: 0 }, totalWorld: { x: 47, y: -23 },
      modifiers, pointer: {} as ToolDragEvent['pointer'],
    };
    t.onDrag(drag, ctx);
    return { anchors, lines };
  }

  it('drops the anchor on the layer’s top-right corner when snapping is on', () => {
    const { anchors, lines } = run({}, true);
    expect(anchors[0]!.anchor).toEqual({ x: 50, y: -25 });
    expect(lines).toHaveLength(2);
  });

  it('Ctrl suspends it while snapping is on', () => {
    const { anchors } = run({ mod: true, ctrl: true }, true);
    expect(anchors[0]!.anchor.x).toBeCloseTo(47);
    expect(anchors[0]!.anchor.y).toBeCloseTo(-23);
  });

  it('Ctrl turns it on while snapping is off', () => {
    expect(run({}, false).anchors[0]!.anchor.x).toBeCloseTo(47);
    expect(run({ mod: true, ctrl: true }, false).anchors[0]!.anchor).toEqual({ x: 50, y: -25 });
  });
});
