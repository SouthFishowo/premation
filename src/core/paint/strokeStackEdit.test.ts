/**
 * Editing a stroke by INDEX, and removing one without scrambling the keyframes
 * of the strokes above it.
 *
 * Stroke tracks are index-scoped (`stroke.<i>.<param>`), so a removal that only
 * spliced the array would leave stroke 3's animation on `stroke.2.*` — now
 * owned by nothing — and stroke 3 would silently stop animating.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getNodeStrokes, removeNodeStrokeAt, setNodeStrokes, updateNodeStrokeAt, defaultStroke } from './stroke';
import type { SceneNode } from '@core/types';

const ID = 'stroke_stack_edit';

beforeEach(() => {
  defaultAnimation.clear();
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode({
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${ID}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 100, height: 80 } }],
  } as unknown as SceneNode);
  setNodeStrokes(ID, [
    { ...defaultStroke('#ff0000'), width: 1 },
    { ...defaultStroke('#00ff00'), width: 2 },
    { ...defaultStroke('#0000ff'), width: 3 },
  ]);
});

describe('updateNodeStrokeAt', () => {
  it('patches ONLY the stroke at the index', () => {
    updateNodeStrokeAt(ID, 1, { blendMode: 'screen', dash: [5, 5] });
    const s = getNodeStrokes(ID);
    expect(s.map((x) => x.blendMode)).toEqual([undefined, 'screen', undefined]);
    expect(s[1]!.dash).toEqual([5, 5]);
    expect(s[0]!.dash).toEqual([]);
  });

  it('an index past the stack is a no-op, not an append', () => {
    updateNodeStrokeAt(ID, 7, { width: 99 });
    expect(getNodeStrokes(ID)).toHaveLength(3);
  });
});

describe('removeNodeStrokeAt', () => {
  it('drops the removed stroke’s tracks and moves the ones above it down one index', () => {
    defaultAnimation.setKeyframes(ID, 'stroke.1.width', [{ t: 0, value: 20, easing: 'linear' }, { t: 1, value: 25, easing: 'linear' }]);
    defaultAnimation.setKeyframes(ID, 'stroke.2.width', [{ t: 0, value: 30, easing: 'bezier', bezier: [0.1, 0.2, 0.3, 1] }, { t: 1, value: 35, easing: 'linear' }]);
    defaultAnimation.setKeyframes(ID, 'stroke.2.color_r', [{ t: 0, value: 0.5, easing: 'linear' }]);

    removeNodeStrokeAt(ID, 1);

    expect(getNodeStrokes(ID).map((s) => s.width)).toEqual([1, 3]);
    // Stroke 3 is now index 1 and its keyframes came with it — easing intact.
    const moved = defaultAnimation.tracksFor(ID).find((t) => t.prop === 'stroke.1.width')!;
    expect(moved.keyframes.map((k) => k.value)).toEqual([30, 35]);
    expect(moved.keyframes[0]!.bezier).toEqual([0.1, 0.2, 0.3, 1]);
    expect(defaultAnimation.isAnimated(ID, 'stroke.1.color_r')).toBe(true);
    // Nothing is left on the old index.
    expect(defaultAnimation.isAnimated(ID, 'stroke.2.width')).toBe(false);
    expect(defaultAnimation.isAnimated(ID, 'stroke.2.color_r')).toBe(false);
  });

  it('removing a stroke 2 makes its successor the new stroke 2 on the PRIMARY’s names when it lands on index 0', () => {
    defaultAnimation.setKeyframes(ID, 'strokeWidth', [{ t: 0, value: 11, easing: 'linear' }]);
    defaultAnimation.setKeyframes(ID, 'stroke.1.width', [{ t: 0, value: 22, easing: 'linear' }]);
    removeNodeStrokeAt(ID, 0);
    expect(defaultAnimation.tracksFor(ID).find((t) => t.prop === 'strokeWidth')?.keyframes[0]?.value).toBe(22);
    expect(defaultAnimation.isAnimated(ID, 'stroke.1.width')).toBe(false);
  });
});
