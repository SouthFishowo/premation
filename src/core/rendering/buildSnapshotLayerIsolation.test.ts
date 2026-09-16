/**
 * One node that throws while its layer is built costs that layer — not the frame.
 *
 * `buildSnapshot` had no guard anywhere in its layer walk, so a single corrupt
 * prop (effect params a resolver chokes on, a malformed path, a NaN transform)
 * threw out of the whole build: the viewport blanked and export failed with a
 * stack trace instead of a reason. Now the node is skipped, the rest of the
 * frame is built, and the skip is recorded on the snapshot for the backend to
 * report (preview) and refuse (export).
 *
 * The failure is injected through `readNodeAdjustment`, a reader the layer walk
 * calls once per content layer — standing in for any reader that meets data it
 * cannot handle.
 */

import * as adjustment from '@core/effects/adjustment';
import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

function shapeNode(id: string, x: number): SceneNode {
  return {
    id, name: `Layer ${id}`, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y: 300, rotation: 0, width: 100, height: 100 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ff0000' } },
    ],
  } as unknown as SceneNode;
}

const comp = { width: 800, height: 600, background: '#101014' };

function graphOf(...ids: Array<[string, number]>): SceneGraph {
  const graph = new SceneGraph();
  for (const [id, x] of ids) graph.addNode(shapeNode(id, x));
  return graph;
}

const build = (graph: SceneGraph) =>
  buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp);

describe('buildSnapshot per-layer isolation', () => {
  beforeEach(() => {
    const real = jest.requireActual<typeof adjustment>('@core/effects/adjustment').readNodeAdjustment;
    jest.spyOn(adjustment, 'readNodeAdjustment').mockImplementation((node) => {
      if ((node as SceneNode).id === 'bad') throw new Error('corrupt adjustment data');
      return real(node);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('skips the throwing node, builds the rest, and records why', () => {
    const snap = build(graphOf(['a', 100], ['bad', 400], ['c', 700]));

    const drawn = snap.layers.filter((l) => l.visible !== false).map((l) => l.id);
    expect(drawn).toEqual(expect.arrayContaining(['a', 'c']));
    expect(drawn).not.toContain('bad');
    expect(snap.layerErrors).toEqual([
      expect.objectContaining({
        layerId: 'bad',
        layerName: 'Layer bad',
        stage: 'snapshot',
        message: expect.stringMatching(/corrupt adjustment data/),
      }),
    ]);
  });

  it('keeps the failed node\'s stack slot as an invisible stub (track mattes pair by position)', () => {
    const snap = build(graphOf(['a', 100], ['bad', 400], ['c', 700]));
    const ids = snap.layers.map((l) => l.id);
    expect(ids.indexOf('bad')).toBeGreaterThan(ids.indexOf('a'));
    expect(ids.indexOf('bad')).toBeLessThan(ids.indexOf('c'));
    const stub = snap.layers.find((l) => l.id === 'bad')!;
    expect(stub.visible).toBe(false);
    expect(stub.opacity).toBe(0);
    // Exactly one entry for the node: nothing half-built survived next to the stub.
    expect(ids.filter((id) => id === 'bad' || id.startsWith('bad::'))).toEqual(['bad']);
  });

  it('a healthy build is unchanged and carries no layerErrors key at all', () => {
    const snap = build(graphOf(['a', 100], ['c', 700]));
    expect(snap.layers.map((l) => l.id)).toEqual(['a', 'c']);
    expect('layerErrors' in snap).toBe(false);
  });
});
