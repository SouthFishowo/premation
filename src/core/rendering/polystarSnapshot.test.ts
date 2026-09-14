/**
 * Parametric Polystar reaches the renderer — and stays parametric.
 *
 * The observable is the OUTLINE the rasterizer receives: `buildSnapshot`
 * recomputes it from the live parameter set every frame, before the
 * path-operator chain seeds. So this samples exactly that crossing —
 * `layers[].pathPoints` / `subpaths` — for the three claims that matter:
 * the parameters render, they ANIMATE (keyframed points/radius change the
 * outline), and a chain operator applies ON TOP of the live outline rather
 * than on some baked copy.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { POLYSTAR_FX_PROP, polystarPropPath, type Polystar } from '@core/scene/polystar';
import type { RenderLayer } from '@core/rendering/RenderBackend';

const comp = { width: 800, height: 600, background: '#101014' };

function starNode(id: string, cfg: Partial<Polystar> = {}): SceneNode {
  const polystar: Polystar = {
    starType: 'star', points: 5, rotation: 0,
    outerRadius: 100, innerRadius: 50, outerRoundness: 0, innerRoundness: 0,
    ...cfg,
  };
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', shapeType: 'polystar',
          x: 400, y: 300, rotation: 0, width: 200, height: 200,
        },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
      { id: `${id}_fx`, type: 'fx', props: { [POLYSTAR_FX_PROP]: polystar } },
    ],
  } as unknown as SceneNode;
}

function layerAt(
  graph: SceneGraph,
  anim: AnimationEngine,
  t: number,
  id = 'star',
): RenderLayer {
  const layer = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp)
    .layers.find((l) => l.id === id);
  expect(layer).toBeDefined();
  return layer!;
}

function outlineOf(layer: RenderLayer): Array<{ x: number; y: number }> {
  return [...(layer.subpaths?.flatMap((s) => s.points) ?? layer.pathPoints ?? [])];
}

describe('a parametric polystar renders from its parameters', () => {
  it('emits a path outline with 2·points vertices on the two radii', () => {
    const graph = new SceneGraph();
    graph.addNode(starNode('star'));
    const layer = layerAt(graph, new AnimationEngine(), 0);
    expect(layer.primitive).toBe('path');
    const pts = outlineOf(layer);
    expect(pts.length).toBe(10);
    pts.forEach((p, i) => {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(i % 2 === 0 ? 100 : 50, 4);
    });
    // The layer box follows the radius, so the raster cannot clip the shape.
    expect(layer.width).toBe(200);
    expect(layer.height).toBe(200);
  });

  it('roundness reaches the rasterizer as real bezier handles', () => {
    const graph = new SceneGraph();
    graph.addNode(starNode('star', { outerRoundness: 80 }));
    const pts = layerAt(graph, new AnimationEngine(), 0).pathPoints ?? [];
    const outer = pts[0] as { x: number; outX?: number; outY?: number; y: number };
    expect(outer.outX).toBeDefined();
    expect(Math.hypot((outer.outX ?? 0) - outer.x, (outer.outY ?? 0) - outer.y)).toBeGreaterThan(1);
  });
});

describe('polystar parameters ANIMATE', () => {
  it('keyframed points 5 → 7 changes the vertex count across the ramp', () => {
    const graph = new SceneGraph();
    graph.addNode(starNode('star'));
    const anim = new AnimationEngine();
    anim.setKeyframe('star', polystarPropPath('points'), 0, 5, 'linear');
    anim.setKeyframe('star', polystarPropPath('points'), 2, 7, 'linear');
    expect(outlineOf(layerAt(graph, anim, 0)).length).toBe(10);
    expect(outlineOf(layerAt(graph, anim, 2)).length).toBe(14);
  });

  it('a keyframed outer radius moves the spikes AND grows the layer box', () => {
    const graph = new SceneGraph();
    graph.addNode(starNode('star'));
    const anim = new AnimationEngine();
    anim.setKeyframe('star', polystarPropPath('outerRadius'), 0, 100, 'linear');
    anim.setKeyframe('star', polystarPropPath('outerRadius'), 2, 180, 'linear');
    const mid = layerAt(graph, anim, 1);
    const spikes = outlineOf(mid).filter((_, i) => i % 2 === 0);
    for (const p of spikes) expect(Math.hypot(p.x, p.y)).toBeCloseTo(140, 4);
    expect(mid.width).toBeCloseTo(280, 4);
  });
});

describe('the path-op chain applies ON TOP of the live parametric outline', () => {
  it('a trim cuts the star, and every surviving point still sits on it', () => {
    const graph = new SceneGraph();
    graph.addNode(starNode('star'));
    graph.setPathOps('star', [
      { id: 'tr', type: 'trim', amount: 0, detail: 0, start: 0, end: 50, offset: 0 },
    ]);
    const layer = layerAt(graph, new AnimationEngine(), 0);
    const pts = outlineOf(layer);
    expect(pts.length).toBeGreaterThan(2);
    for (const p of pts) {
      const r = Math.hypot(p.x, p.y);
      expect(r).toBeGreaterThan(50 - 1e-3);
      expect(r).toBeLessThan(100 + 1e-3);
    }
  });

  it('…and the trimmed outline still follows a KEYFRAMED radius (recomputed per frame)', () => {
    const graph = new SceneGraph();
    graph.addNode(starNode('star'));
    graph.setPathOps('star', [
      { id: 'tr', type: 'trim', amount: 0, detail: 0, start: 0, end: 50, offset: 0 },
    ]);
    const anim = new AnimationEngine();
    anim.setKeyframe('star', polystarPropPath('outerRadius'), 0, 100, 'linear');
    anim.setKeyframe('star', polystarPropPath('outerRadius'), 2, 160, 'linear');
    const maxAt = (t: number): number =>
      Math.max(...outlineOf(layerAt(graph, anim, t)).map((p) => Math.hypot(p.x, p.y)));
    expect(maxAt(0)).toBeCloseTo(100, 3);
    expect(maxAt(2)).toBeCloseTo(160, 3);
  });
});

describe('old baked polygons are untouched', () => {
  it('a shape with Geometry points and no fx.polystar keeps its stored outline', () => {
    const baked: SceneNode = {
      id: 'old', name: 'old', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        {
          id: 'old_t', type: 'Transform',
          props: { [SCENE_KIND_PROP]: 'shape', shapeType: 'path', x: 400, y: 300, rotation: 0, width: 40, height: 40 },
        },
        {
          id: 'old_g', type: 'Geometry',
          props: {
            points: [
              { x: 0, y: -20, inX: 0, inY: -20, outX: 0, outY: -20 },
              { x: 20, y: 20, inX: 20, inY: 20, outX: 20, outY: 20 },
              { x: -20, y: 20, inX: -20, inY: 20, outX: -20, outY: 20 },
            ],
          },
        },
        { id: 'old_s', type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
      ],
    } as unknown as SceneNode;
    const graph = new SceneGraph();
    graph.addNode(baked);
    const layer = layerAt(graph, new AnimationEngine(), 0, 'old');
    expect(layer.pathPoints?.length).toBe(3);
    expect(layer.pathPoints?.[0]).toMatchObject({ x: 0, y: -20 });
  });
});
