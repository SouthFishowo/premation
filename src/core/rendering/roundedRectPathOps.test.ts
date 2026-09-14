/**
 * A rounded rect KEEPS its corners under the path-operator chain.
 *
 * The chain converts the layer's primitive to an explicit path, which takes
 * the rasterizer off the rect branch — the only place `cornerRadii` used to
 * be honoured. So adding ANY operator squared a rounded rect's corners as a
 * side effect: the observable is the outline the chain is SEEDED with, and
 * these tests sample it after the fold (`layers[].pathPoints`), exactly as
 * `pathOpCurvature.test.ts` does for drawn curves.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { PathOp } from '@core/scene/pathOps';

const comp = { width: 800, height: 600, background: '#101014' };
const W = 200;
const H = 120;
const R = 30;

function rectNode(id: string, cornerRadius: number): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', shapeType: 'rect',
          x: 400, y: 300, rotation: 0, width: W, height: H, cornerRadius,
        },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#1f4f8f' } },
    ],
  } as unknown as SceneNode;
}

/** A twist with angle 0 deforms nothing but is a LIVE operator, so the layer
 *  takes the chain path — the exact scenario that used to square the corners. */
const inertTwist: PathOp = { id: 't1', type: 'twist', amount: 0, detail: 0 } as PathOp;

function outlineWith(cornerRadius: number, ops: readonly PathOp[]): Array<{ x: number; y: number }> {
  const graph = new SceneGraph();
  graph.addNode(rectNode('r', cornerRadius));
  if (ops.length > 0) graph.setPathOps('r', [...ops]);
  const layer = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp)
    .layers.find((l) => l.id === 'r')!;
  expect(layer.primitive).toBe('path');
  return [...(layer.subpaths?.flatMap((s) => s.points) ?? layer.pathPoints ?? [])];
}

describe('rounded rect under a path operator', () => {
  it('the chain input carries the rounded corners, not four sharp ones', () => {
    const pts = outlineWith(R, [inertTwist]);
    // No point reaches the sharp corner itself…
    for (const p of pts) {
      expect(Math.abs(p.x) > W / 2 - 1e-6 && Math.abs(p.y) > H / 2 - 1e-6).toBe(false);
    }
    // …and the corner region is populated by arc points at radius R from the
    // corner centre (flattened arcs, not a chamfer straight across).
    const c = { x: W / 2 - R, y: H / 2 - R };
    const inCorner = pts.filter((p) => p.x > c.x + 1e-6 && p.y > c.y + 1e-6);
    expect(inCorner.length).toBeGreaterThan(3);
    for (const p of inCorner) {
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(R, 4);
    }
  });

  it('a SHARP rect is unchanged: every chain-input point is on the rect, corners intact', () => {
    // (Twist in the chain densifies the outline — subdivided edges — so the
    // exact count is the density policy's business, not this test's.)
    const pts = outlineWith(0, [inertTwist]);
    for (const p of pts) {
      const onEdge = Math.abs(Math.abs(p.x) - W / 2) < 1e-6 || Math.abs(Math.abs(p.y) - H / 2) < 1e-6;
      expect(onEdge).toBe(true);
    }
    for (const [cx, cy] of [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]]) {
      expect(pts.some((p) => Math.abs(p.x - cx!) < 1e-6 && Math.abs(p.y - cy!) < 1e-6)).toBe(true);
    }
  });

  it('a trim walks the rounded outline (surviving arc points stay on the arcs)', () => {
    const trim: PathOp = {
      id: 'tr', type: 'trim', amount: 0, detail: 0, start: 5, end: 95, offset: 0,
    } as PathOp;
    const pts = outlineWith(R, [trim]);
    expect(pts.length).toBeGreaterThan(8);
    const centres = [
      { x: -(W / 2) + R, y: -(H / 2) + R }, { x: W / 2 - R, y: -(H / 2) + R },
      { x: W / 2 - R, y: H / 2 - R }, { x: -(W / 2) + R, y: H / 2 - R },
    ];
    for (const p of pts) {
      const onEdge =
        (Math.abs(Math.abs(p.x) - W / 2) < 1e-4 && Math.abs(p.y) <= H / 2 - R + 1e-4)
        || (Math.abs(Math.abs(p.y) - H / 2) < 1e-4 && Math.abs(p.x) <= W / 2 - R + 1e-4);
      // Trim cuts land BETWEEN flattened arc samples (on the chord), so the
      // arc tolerance is the chord's sagitta (~chord²/8R ≈ 0.03px), not zero.
      const onArc = centres.some((c) => Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - R) < 0.05);
      expect(onEdge || onArc).toBe(true);
    }
  });

  it('the ellipse chain input is untouched (ring sanity)', () => {
    const graph = new SceneGraph();
    const node = rectNode('e', 0);
    (node.components[0]!.props as Record<string, unknown>).shapeType = 'ellipse';
    graph.addNode(node);
    graph.setPathOps('e', [inertTwist]);
    const layer = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp)
      .layers.find((l) => l.id === 'e')!;
    const pts = [...(layer.pathPoints ?? [])];
    expect(pts.length).toBeGreaterThan(8);
    for (const p of pts) {
      // On the ellipse: (x/a)² + (y/b)² = 1.
      const v = (p.x / (W / 2)) ** 2 + (p.y / (H / 2)) ** 2;
      expect(v).toBeCloseTo(1, 4);
    }
  });
});
