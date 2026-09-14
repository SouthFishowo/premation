/**
 * Parenting modifiers, After Effects' way round:
 *   plain  → keep the world pose (no jump)
 *   Shift  → Parent & Link JUMP: the child lands on the parent's anchor
 *   Alt    → legacy "keep values": local values reinterpreted under the parent
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { reparentNode, parentOptionsFor } from './parenting';
import { world2DAt } from './layerSpace';
import { Matrix } from '@motion/scene';
import type { SceneNode } from '@core/types';

function transformNode(id: string, parent: string, x: number, y: number): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: 'shape', x, y, rotation: 0 } }],
  } as unknown as SceneNode;
}

function reset(): void {
  for (const r of [...defaultSceneGraph.getRoots()]) defaultSceneGraph.removeNode(r.id);
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Composition', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', transformNode('P', 'comp_root', 100, 50));
  defaultSceneGraph.addChild('comp_root', transformNode('C', 'comp_root', 200, 80));
  defaultAnimation.removeTrack('C', 'x');
  defaultAnimation.removeTrack('C', 'y');
}

const worldOf = (id: string): { x: number; y: number } => Matrix.transformPoint(world2DAt(id, 0), { x: 0, y: 0 });

describe('parentOptionsFor', () => {
  it('maps Shift to jump, Alt to keep-values, nothing to the default', () => {
    expect(parentOptionsFor(undefined)).toBeUndefined();
    expect(parentOptionsFor({ altKey: false, shiftKey: false })).toBeUndefined();
    expect(parentOptionsFor({ shiftKey: true })).toEqual({ jump: true });
    expect(parentOptionsFor({ altKey: true })).toEqual({ preserveWorld: false });
    // Shift wins when both are held.
    expect(parentOptionsFor({ altKey: true, shiftKey: true })).toEqual({ jump: true });
  });
});

describe('reparentNode — Parent & Link', () => {
  beforeEach(reset);

  it('plain parenting does not move the child', () => {
    expect(reparentNode('C', 'P')).toBe(true);
    expect(worldOf('C').x).toBeCloseTo(200, 4);
    expect(worldOf('C').y).toBeCloseTo(80, 4);
  });

  it('Shift jumps the child onto the parent’s anchor', () => {
    expect(reparentNode('C', 'P', parentOptionsFor({ shiftKey: true }))).toBe(true);
    const c = defaultSceneGraph.getNode('C')!;
    expect(c.parent).toBe('P');
    expect(c.transform.position.x).toBeCloseTo(0, 4);
    expect(c.transform.position.y).toBeCloseTo(0, 4);
    expect(worldOf('C').x).toBeCloseTo(100, 4);
    expect(worldOf('C').y).toBeCloseTo(50, 4);
  });

  it('an animated child keeps its motion, re-based onto the parent', () => {
    defaultAnimation.setKeyframe('C', 'x', 0, 200);
    defaultAnimation.setKeyframe('C', 'x', 1, 400);
    reparentNode('C', 'P', { jump: true });
    const kfs = defaultAnimation.getTrackKeyframes('C', 'x')!;
    expect(kfs.map((k) => k.value)).toEqual([0, 200]);
  });

  it('jumping to None has no anchor to land on — it un-parents in place', () => {
    reparentNode('C', 'P');
    expect(reparentNode('C', null, { jump: true })).toBe(true);
    expect(defaultSceneGraph.getNode('C')!.parent).toBe('comp_root');
    expect(worldOf('C').x).toBeCloseTo(200, 4);
  });
});
