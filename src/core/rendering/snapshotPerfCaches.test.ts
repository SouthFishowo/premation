/**
 * The cross-frame caches buildSnapshot leans on for big comps must be
 * invisible: a cached build equals an uncached one, and every edit that could
 * change the output reaches it.
 *
 *   • the static sealed-precomp cache (staticPrecompCache.ts) — a comp whose
 *     content cannot change with time reuses its nested pass;
 *   • the epoch-stable component memos (`readBase`, `materialOf`) — reads
 *     cached on a live view's render array, invalidated by any scene mutation.
 */

import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { COMP_REF_PROP } from '@core/scene/compInstance';
import { buildSnapshot, type SnapshotComp } from './buildSnapshot';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import {
  setStaticPrecompCacheEnabled,
  staticPrecompCacheStats,
  resetStaticPrecompCacheStats,
} from './staticPrecompCache';
import type { RenderLayer, RenderSnapshot } from './RenderBackend';

type Comp = { id: string; type: string; props: Record<string, unknown> };

function node(id: string, kind: string, props: Record<string, unknown> = {}, extra: Comp[] = []): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, ...props } },
      ...(kind === 'group' || kind === 'comp' ? [] : [{ id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#3366ff' } }]),
      ...extra,
    ],
  } as unknown as SceneNode;
}

/** A host comp placing `count` sealed instances of one inner comp of `inner` shapes. */
function precompScene(count = 3, inner = 4): { graph: SceneGraph; anim: AnimationEngine; comp: SnapshotComp } {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  graph.addNode(node('innerC', 'group'));
  for (let i = 0; i < inner; i++) {
    graph.addChild('innerC', node(`in${i}`, i % 2 ? 'text' : 'shape', { x: 20 + i * 30, y: 40, width: 24, height: 24 },
      i % 2 ? [{ id: `in${i}_x`, type: 'Text', props: { content: `T${i}`, fontSize: 18 } }] : []));
  }
  graph.addNode(node('host', 'group'));
  for (let k = 0; k < count; k++) {
    graph.addChild('host', node(`inst${k}`, 'comp', { x: 100 + k * 160, y: 120 }, [
      { id: `inst${k}_fx`, type: 'fx', props: { precomp: true, [COMP_REF_PROP]: 'innerC' } },
    ]));
  }
  const comp: SnapshotComp = {
    width: 640, height: 360, background: '#000', rootId: 'host',
    compSizeOf: (id) => (id === 'innerC' ? { width: 150, height: 100 } : undefined),
  };
  return { graph, anim, comp };
}

/** Strip `sourceTime` — the one field a reused static nested pass may carry from
 *  its build frame (see staticPrecompCache.ts: no pixel path reads it for the
 *  kinds the cache admits). */
function withoutSourceTime(layers: ReadonlyArray<RenderLayer>): unknown[] {
  return layers.map((l) => {
    const { sourceTime: _s, precompLayers, ...rest } = l;
    void _s;
    return precompLayers ? { ...rest, precompLayers: withoutSourceTime(precompLayers) } : rest;
  });
}

function build(s: ReturnType<typeof precompScene>, t: number): RenderSnapshot {
  return buildSnapshot(s.graph, s.anim, t, undefined, undefined, undefined, undefined, s.comp);
}

afterEach(() => setStaticPrecompCacheEnabled(true));

describe('static sealed-precomp cache', () => {
  it('reuses a static nested pass across frames, identical to the uncached build', () => {
    const s = precompScene();
    setStaticPrecompCacheEnabled(false);
    const uncached = [0, 0.5, 1.25].map((t) => build(s, t));
    setStaticPrecompCacheEnabled(true);
    resetStaticPrecompCacheStats();
    const cached = [0, 0.5, 1.25].map((t) => build(s, t));

    // 3 instances × 3 frames of ONE comp: the first placement builds, the
    // other eight are served.
    expect(staticPrecompCacheStats().stores).toBe(1);
    expect(staticPrecompCacheStats().hits).toBe(8);
    for (let i = 0; i < 3; i++) {
      expect(withoutSourceTime(cached[i]!.layers)).toEqual(withoutSourceTime(uncached[i]!.layers));
      // The renderer scene is exactly equal — sourceTime never reaches it.
      expect(snapshotToFrameScene(cached[i]!)).toEqual(snapshotToFrameScene(uncached[i]!));
    }
    // Each placement still gets its OWN ids (the cache holds unprefixed layers).
    const ids = cached[1]!.layers.flatMap((l) => (l.precompLayers ?? []).map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never reuses an animated comp, and matches the uncached build', () => {
    const s = precompScene(2);
    s.anim.setKeyframes('in0', 'x', [
      { t: 0, value: 0, easing: 'linear' },
      { t: 2, value: 100, easing: 'linear' },
    ] as never);
    setStaticPrecompCacheEnabled(false);
    const uncached = build(s, 0.75);
    setStaticPrecompCacheEnabled(true);
    resetStaticPrecompCacheStats();
    build(s, 0.25);
    const cached = build(s, 0.75);
    expect(staticPrecompCacheStats().hits).toBe(0);
    expect(cached.layers).toEqual(uncached.layers);
  });

  it('a keyframe added after caching invalidates (the engine has no revision to key on)', () => {
    const s = precompScene(1);
    build(s, 0);
    const before = build(s, 0.5).layers[0]!.precompLayers![0]!.x;
    s.anim.setKeyframes('in0', 'x', [
      { t: 0, value: 0, easing: 'linear' },
      { t: 1, value: 300, easing: 'linear' },
    ] as never);
    const after = build(s, 0.5).layers[0]!.precompLayers![0]!.x;
    expect(after).not.toBe(before);
    expect(after).toBeCloseTo(150, 5);
  });

  it('an edit inside the comp reaches the next frame', () => {
    const s = precompScene(2);
    build(s, 0);
    build(s, 0.1);
    const fillBefore = build(s, 0.2).layers[0]!.precompLayers![0]!.fill;
    expect(s.graph.writeProp('in0', 'in0_s', 'fill', '#00ff00')).toBe(true);
    const snap = build(s, 0.3);
    expect(fillBefore).toBe('#3366ff');
    expect(snap.layers[0]!.precompLayers![0]!.fill).toBe('#00ff00');
    expect(snap.layers[1]!.precompLayers![0]!.fill).toBe('#00ff00');
  });

  it('an effect on an inner layer makes the comp time-dependent (not cached)', () => {
    const s = precompScene(1);
    s.graph.setEffects('in0', [{ id: 'fx1', type: 'blur', params: { amount: 2 } }]);
    resetStaticPrecompCacheStats();
    build(s, 0);
    build(s, 0.5);
    expect(staticPrecompCacheStats().hits).toBe(0);
    expect(staticPrecompCacheStats().stores).toBe(0);
  });

  it('a retimed or time-remapped container always rebuilds', () => {
    const s = precompScene(1);
    s.anim.setKeyframes('inst0', 'timeSpeed', [
      { t: 0, value: 50, easing: 'hold' },
    ] as never);
    resetStaticPrecompCacheStats();
    build(s, 0);
    build(s, 0.5);
    expect(staticPrecompCacheStats().hits).toBe(0);

    const r = precompScene(1);
    r.graph.setLayerTime('inst0', { reverse: true });
    resetStaticPrecompCacheStats();
    build(r, 0);
    build(r, 0.5);
    expect(staticPrecompCacheStats().hits).toBe(0);
  });

  it('hiding an inner layer reaches the next frame', () => {
    const s = precompScene(1);
    build(s, 0);
    const hidden = s.graph.getNode('in0')!;
    (hidden as { visible: boolean }).visible = false;
    const snap = build(s, 0.4);
    expect(snap.layers[0]!.precompLayers![0]!.visible).toBe(false);
  });
});

describe('epoch-stable component memos', () => {
  it('a prop edit between frames reaches readBase / material readers', () => {
    const graph = new SceneGraph();
    const anim = new AnimationEngine();
    graph.addNode(node('root', 'group'));
    graph.addChild('root', node('a', 'shape', { x: 10, y: 20, width: 50, height: 50 }));
    const comp: SnapshotComp = { width: 200, height: 200, background: '#000', rootId: 'root' };
    const first = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(first.x).toBe(10);
    expect(first.opacity).toBe(1);
    graph.writeProp('a', 'a_t', 'x', 77);
    graph.writeProp('a', 'a_s', 'opacity', 40);
    const second = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(second.x).toBe(77);
    expect(second.opacity).toBeCloseTo(0.4, 10);
    // A material switch lives in the same Transform props.
    graph.writeProp('a', 'a_t', 'castsShadows', false);
    const third = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp);
    expect(third.layers[0]!.x).toBe(77);
  });

  it('an animated material prop bypasses the memo', () => {
    const graph = new SceneGraph();
    const anim = new AnimationEngine();
    graph.addNode(node('root', 'group'));
    graph.addChild('root', node('a', 'shape', { width: 50, height: 50, is3D: true }));
    const comp: SnapshotComp = { width: 200, height: 200, background: '#000', rootId: 'root' };
    buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp);
    anim.setKeyframes('a', 'castsShadows', [{ t: 0, value: 0, easing: 'hold' }] as never);
    const snap = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp);
    // castsShadows animated off → no cast-shadow flag on the 3D layer.
    expect(snap.layers[0]!.castsShadow3d).toBeUndefined();
  });
});
