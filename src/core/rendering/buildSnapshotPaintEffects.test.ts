/**
 * Integration: the paint effects' per-frame hand-offs in `buildSnapshot`.
 *
 * The kernels are pure functions of their params, so everything that makes
 * them follow the scene — every mask at this frame, Scribble's wiggle state,
 * Write-on's recorded dab history — has to be resolved INTO those params here.
 * Each block below would pass every kernel test and still render a frozen or
 * empty effect if this hand-off broke, which is why it is pinned on its own.
 */

import { buildSnapshot } from './buildSnapshot';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { Effect } from '@core/effects/effects';
import { rectangleMask, type MaskPath } from '@core/effects/mask';

const COMP = { width: 400, height: 300, background: '#000' };

function shape(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 200, y: 150 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 200, y: 150, width: 200, height: 100 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

const masks = (): MaskPath[] => [
  { ...rectangleMask(100, 50), id: 'a', mode: 'add' },
  { ...rectangleMask(40, 20), id: 'b', mode: 'subtract', inverted: true, closed: false },
];

function effectAt(anim: AnimationEngine, t: number, type: string): Effect {
  const layer = buildSnapshot(defaultSceneGraph, anim, t, undefined, undefined, undefined, undefined, COMP).layers
    .find((l) => l.id === 's1')!;
  return (layer.effects ?? []).find((e) => e.type === type)!;
}

describe('buildSnapshot — paint effect hand-offs', () => {
  beforeEach(() => {
    defaultSceneGraph.clear();
    defaultSceneGraph.addNode(shape('s1'));
    defaultSceneGraph.setMask('s1', { paths: masks() });
  });
  afterEach(() => defaultSceneGraph.clear());

  it('Stroke receives EVERY mask in order with closed / mode / inverted, and the picked index', () => {
    defaultSceneGraph.setEffects('s1', [{ id: 'p1', type: 'path-stroke', params: { pathMaskId: 'b' } } as Effect]);
    const p = effectAt(new AnimationEngine(), 0, 'path-stroke').params!;
    // Two 4-corner rectangles → 65 points each; b open → 3 cubics × 16 + 1 = 49.
    expect(p.maskPathsMeta).toEqual([65, 1, 1, 0, 49, 0, 2, 1]);
    expect((p.maskPathsXY as number[]).length).toBe((65 + 49) * 2);
    expect(p.pathMaskIndex).toBe(1);
  });

  it('an unset Path resolves index −1 and the kernel falls back to the first mask', () => {
    defaultSceneGraph.setEffects('s1', [{ id: 'p1', type: 'path-stroke', params: { pathMaskId: '' } } as Effect]);
    expect(effectAt(new AnimationEngine(), 0, 'path-stroke').params!.pathMaskIndex).toBe(-1);
  });

  it('Scribble’s wiggle state is quantised from the layer clock', () => {
    defaultSceneGraph.setEffects('s1', [{ id: 'sc', type: 'scribble', params: { wiggleType: 1, wigglesPerSecond: 2 } } as Effect]);
    const anim = new AnimationEngine();
    expect(effectAt(anim, 1.3, 'scribble').params!.wiggleState).toBe(2);
    expect(effectAt(anim, 1.45, 'scribble').params!.wiggleState).toBe(2); // same jump → same params → cache hit
    expect(effectAt(anim, 1.6, 'scribble').params!.wiggleState).toBe(3);
  });

  it('Write-on (brush) receives its dab history sampled from the position track', () => {
    defaultSceneGraph.setEffects('s1', [{ id: 'w1', type: 'write-on', params: { writeOnMode: 0, brushSpacing: 0.25 } } as Effect]);
    const anim = new AnimationEngine();
    anim.setKeyframe('s1', 'effect.w1.brushPositionX', 0, -10);
    anim.setKeyframe('s1', 'effect.w1.brushPositionX', 1, 10);
    const p = effectAt(anim, 1, 'write-on').params!;
    const xs = (p.brushTrailXY as number[]).filter((_, i) => i % 2 === 0).map((v) => Math.round(v));
    expect(xs).toEqual([-10, -5, 0, 5, 10]);
    expect(p.brushTrailFilled).toBe(0);
  });

  it('a classic Write-on and a single-path Vegas resolve nothing new — stored documents render as before', () => {
    defaultSceneGraph.setEffects('s1', [
      { id: 'w1', type: 'write-on', params: { completion: 50 } } as Effect,
      { id: 'v1', type: 'vegas', params: { segments: 4 } } as Effect,
    ]);
    const anim = new AnimationEngine();
    // The stack arrives default-filled from the node read; what matters is that
    // the new hand-offs stay at their empty defaults and the old values survive.
    const w = effectAt(anim, 0.5, 'write-on').params!;
    expect(w.completion).toBe(50);
    expect(w.writeOnMode).toBe(1);
    expect(w.brushTrailXY ?? []).toEqual([]);
    const v = effectAt(anim, 0.5, 'vegas').params!;
    expect(v.segments).toBe(4);
    expect(v.segmentDistribution ?? 1).toBe(1);
    expect(v.maskPathsMeta ?? []).toEqual([]);
  });

  it('Vegas ▸ All Masks does receive the packed masks', () => {
    defaultSceneGraph.setEffects('s1', [{ id: 'v1', type: 'vegas', params: { allMasks: true } } as Effect]);
    expect(effectAt(new AnimationEngine(), 0, 'vegas').params!.maskPathsMeta).toHaveLength(8);
  });
});
