/**
 * Every stroke of a stack animates — `buildSnapshot(...).layers[].strokes`.
 *
 * `strokeTracks.test.ts` pins the fold; this pins the CROSSING: that the
 * snapshot hands the fold every stored stroke with its stored index, so a track
 * on stroke 2 reaches stroke 2's pixels. The inline fold this replaced bound
 * every track to strokes[0]: strokes 2+ were frozen at their stored values.
 *
 * Three strokes with different stored widths and colours, so "stroke 2 read its
 * own track" cannot pass by reading the primary's.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const comp = { width: 400, height: 300, background: '#101014' };

const base = { enabled: true, opacity: 1, align: 'center', dash: [] as number[], cap: 'butt', join: 'miter' };
const STACK = [
  { ...base, color: '#ff0000', width: 4 },
  { ...base, color: '#00ff00', width: 9, dash: [12, 6] },
  { ...base, color: '#0000ff', width: 15 },
];

function scene(stack = STACK): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  graph.addNode({
    id: 's', name: 's', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 200, y: 150 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 's_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 200, y: 150, width: 160, height: 120 } },
    ],
  } as unknown as SceneNode);
  graph.setStroke('s', stack[0] as never);
  graph.setStrokes('s', stack as never);
  return { graph, anim: new AnimationEngine() };
}

const layerAt = (graph: SceneGraph, anim: AnimationEngine, t: number) =>
  buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp).layers.find((l) => l.id === 's')!;

describe('strokes 2+ are no longer frozen', () => {
  it('POSITIVE CONTROL: with no tracks the stack is the stored stack', () => {
    const { graph, anim } = scene();
    expect(layerAt(graph, anim, 0).strokes?.map((s) => [s.width, s.color])).toEqual([[4, '#ff0000'], [9, '#00ff00'], [15, '#0000ff']]);
  });

  it('a width ramp on stroke 2 moves stroke 2, and only stroke 2', () => {
    const { graph, anim } = scene();
    anim.setKeyframe('s', 'stroke.1.width', 0, 2, 'linear');
    anim.setKeyframe('s', 'stroke.1.width', 2, 42, 'linear');
    const strokes = layerAt(graph, anim, 1).strokes!;
    expect(strokes.map((s) => s.width)).toEqual([4, 22, 15]);
  });

  it('opacity, colour and a dash slot reach stroke 3 and stroke 2', () => {
    const { graph, anim } = scene();
    anim.setKeyframe('s', 'stroke.2.opacity', 0, 0.4, 'linear');
    for (const [ch, v] of [['_r', 1], ['_g', 1], ['_b', 0], ['_a', 1]] as const) anim.setKeyframe('s', `stroke.2.color${ch}`, 0, v, 'linear');
    anim.setKeyframe('s', 'stroke.1.gap1', 0, 30, 'linear');
    const strokes = layerAt(graph, anim, 0).strokes!;
    expect(strokes[2]!.opacity).toBeCloseTo(0.4, 9);
    expect(strokes[2]!.color.toLowerCase().startsWith('#ffff00')).toBe(true);
    expect(strokes[1]!.dash).toEqual([12, 30]);
    // The primary is untouched by any of them.
    expect(strokes[0]).toMatchObject({ width: 4, color: '#ff0000', opacity: 1 });
  });

  it('the primary’s original flat names still drive strokes[0] AND the `stroke` mirror', () => {
    const { graph, anim } = scene();
    anim.setKeyframe('s', 'strokeWidth', 0, 12, 'linear');
    const layer = layerAt(graph, anim, 0);
    expect(layer.stroke?.width).toBe(12);
    expect(layer.strokes?.[0]?.width).toBe(12);
    expect(layer.strokes?.[1]?.width).toBe(9);
  });

  it('a disabled stroke 2 keeps stroke 3 on stroke 3’s own tracks', () => {
    const { graph, anim } = scene([STACK[0]!, { ...STACK[1]!, enabled: false }, STACK[2]!]);
    anim.setKeyframe('s', 'stroke.1.width', 0, 50, 'linear');
    anim.setKeyframe('s', 'stroke.2.width', 0, 7, 'linear');
    expect(layerAt(graph, anim, 0).strokes?.map((s) => s.width)).toEqual([4, 7]);
  });
});
