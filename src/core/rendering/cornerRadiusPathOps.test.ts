/**
 * A rounded rect KEEPS its rounding through the path-operator chain.
 *
 * The chain's seed for a primitive came from `shapeOutline`, which had no
 * corner-radius parameter — so the seed for a rounded rect was the SHARP rect,
 * and the chain's output (traced verbatim as a path) squared the corners off.
 * A rect at Corners: 40 rendered round, and rendered square the moment any
 * live operator — a partial Trim, a Zig-Zag, a Repeater — was added. AE keeps
 * the rounded geometry through its whole operator stack.
 *
 * The inert-op filters in `resolvePathOps` were built to hide exactly this
 * symptom ("an operator moving nothing must not square off a rounded rect"),
 * so every case here uses a LIVE operator, as `pathOpCurvature.test.ts` does.
 *
 * The observable is the geometry the rasterizer receives —
 * `buildSnapshot(...).layers[]` after the chain — checked two ways, in the
 * style of the curvature suite: every emitted point still sits ON the rounded
 * boundary, and the outline's closest approach to each sharp corner is the
 * arc's true stand-off, r(√2−1).
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { defaultTrimOp, type PathOp } from '@core/scene/pathOps';
import type { RenderLayer } from './RenderBackend';

const COMP = { width: 400, height: 300, background: '#101014' };
const W = 160;
const H = 120;
const R = 40;
/** The rounded outline's closest approach to the sharp corner it replaced. */
const STAND_OFF = R * (Math.SQRT2 - 1); // ≈ 16.57

function rectNode(radiusProps: Record<string, number>): SceneNode {
  return {
    id: 'r', name: 'r', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 200, y: 150 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: 'r_t', type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', shapeType: 'rect',
          x: 200, y: 150, rotation: 0, width: W, height: H,
          ...radiusProps,
        },
      },
      { id: 'r_s', type: 'Style', props: { opacity: 100, fill: '#1f4f8f' } },
    ],
  } as unknown as SceneNode;
}

function layerWithOps(
  ops: readonly PathOp[],
  radiusProps: Record<string, number> = { cornerRadius: R },
  anim = new AnimationEngine(),
  t = 0,
): RenderLayer {
  const graph = new SceneGraph();
  graph.addNode(rectNode(radiusProps));
  if (ops.length > 0) graph.setPathOps('r', [...ops]);
  return buildSnapshot(
    graph, anim, t, undefined, undefined, undefined, undefined, COMP,
  ).layers.find((l) => l.id === 'r')!;
}

function pointsOf(layer: RenderLayer): Array<{ x: number; y: number }> {
  if (layer.subpaths && layer.subpaths.length > 0) {
    return layer.subpaths.flatMap((sp) => [...sp.points]);
  }
  return [...(layer.pathPoints ?? [])];
}

/** Signed distance to the rounded rect the layer authored, centred at 0,0. */
function sdf(p: { x: number; y: number }, r: number): number {
  const qx = Math.abs(p.x) - (W / 2 - r);
  const qy = Math.abs(p.y) - (H / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const minDistTo = (pts: ReadonlyArray<{ x: number; y: number }>, c: { x: number; y: number }): number =>
  Math.min(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));

const CORNERS = [
  { x: -W / 2, y: -H / 2 }, // TL
  { x: W / 2, y: -H / 2 },  // TR
  { x: W / 2, y: H / 2 },   // BR
  { x: -W / 2, y: H / 2 },  // BL
];

// Keeps 0–95%: live (a full-span trim is dropped as inert), and the removed
// tail is the END of the ring — the lower left edge — so all four arcs survive.
const trim = (over: Partial<PathOp> = {}): PathOp =>
  ({ ...defaultTrimOp(), start: 0, end: 95, ...over, type: 'trim' });

describe('a rounded rect through the path-op chain', () => {
  it('POSITIVE CONTROL: without operators the radius reaches the rasterizer as a field', () => {
    const layer = layerWithOps([]);
    expect(layer.primitive).toBe('rect');
    expect(layer.cornerRadius).toBe(R);
  });

  it('a live partial trim emits the ROUNDED outline, not the sharp rect', () => {
    const pts = pointsOf(layerWithOps([trim()]));
    expect(pts.length).toBeGreaterThan(8);
    // Every corner is stood off by ≈ the radius — a sharp seed would put a
    // vertex AT the corner (distance ~0) and this is what the bug rendered.
    for (const c of CORNERS) {
      const d = minDistTo(pts, c);
      expect(d).toBeGreaterThan(STAND_OFF - 1.5);
      expect(d).toBeLessThan(STAND_OFF + 1.5);
    }
  });

  it('every emitted point sits ON the rounded boundary, not merely off the corner', () => {
    // "Off the corner" alone would also pass for a wrong-but-shrunken rect.
    const pts = pointsOf(layerWithOps([trim()]));
    const worst = Math.max(...pts.map((p) => Math.abs(sdf(p, R))));
    expect(worst).toBeLessThan(0.5);
  });

  it('the trim still CUT something — this is the live chain, not a bypass', () => {
    const layer = layerWithOps([trim()]);
    expect(layer.primitive).toBe('path');
    expect(layer.subpaths?.some((sp) => sp.open)).toBe(true);
  });

  it('the baked radii are cleared from the layer — geometry now, not dead fields', () => {
    const layer = layerWithOps([trim()]);
    expect(layer.cornerRadius).toBe(0);
    expect(layer.cornerRadii).toBeUndefined();
    expect(layer.cornerRadiusScale).toBeUndefined();
  });

  it('per-corner radii survive: only the corner that asked is rounded', () => {
    const pts = pointsOf(layerWithOps([trim()], { cornerRadiusTL: R }));
    const dTL = minDistTo(pts, CORNERS[0]!);
    expect(dTL).toBeGreaterThan(STAND_OFF - 1.5);
    expect(dTL).toBeLessThan(STAND_OFF + 1.5);
    // TR stays the sharp vertex it authored.
    expect(minDistTo(pts, CORNERS[1]!)).toBeLessThan(0.75);
  });

  it('an ANIMATED radius reaches the seed (F35 composed with the chain)', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe('r', 'cornerRadius', 0, 20, 'linear');
    anim.setKeyframe('r', 'cornerRadius', 2, 52, 'linear');
    // Halfway: 36. The stored static radius (R) is outside the ramp on purpose.
    const pts = pointsOf(layerWithOps([trim()], { cornerRadius: R }, anim, 1));
    const expected = 36 * (Math.SQRT2 - 1);
    for (const c of CORNERS) {
      const d = minDistTo(pts, c);
      expect(d).toBeGreaterThan(expected - 1.5);
      expect(d).toBeLessThan(expected + 1.5);
    }
  });
});
