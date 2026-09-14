/**
 * Flip, Reset Transform and the numpad nudges — the pure rules, then each one
 * against the live scene graph and animation engine, keyframed case included.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import {
  negateKeyframes,
  flipLayer,
  resetTransformWrites,
  resetLayerTransform,
  numpadStep,
  nudgedScale,
  nudgeRotation,
  nudgeScale,
  propertyResetValue,
  canResetProperties,
  resetProperties,
} from './layerTransformOps';

function bootCommandSystem(): void {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) as never }));
}

const ID = 'lto_layer';
const PROPS = ['scaleX', 'scaleY', 'scale', 'rotation', 'x', 'y', 'anchorX', 'anchorY', 'opacity'];

function addLayer(props: Record<string, unknown>): void {
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  if (!defaultSceneGraph.getNode('comp_root')) {
    defaultSceneGraph.addNode({
      id: 'comp_root', name: 'Composition', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
    } as unknown as SceneNode);
  }
  defaultSceneGraph.addChild('comp_root', {
    id: ID, name: ID, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${ID}_t`, type: 'Transform', props: { __kind: 'shape', ...props } },
      { id: `${ID}_s`, type: 'Style', props: { opacity: 40 } },
    ],
  } as unknown as SceneNode);
  for (const p of PROPS) defaultAnimation.removeTrack(ID, p);
}

const prop = (name: string): unknown =>
  defaultSceneGraph.getNode(ID)!.components.find((c) => (c.props as Record<string, unknown>)[name] !== undefined)?.props[name];

beforeEach(bootCommandSystem);

describe('pure rules', () => {
  it('negateKeyframes flips values and spatial tangents, keeps timing', () => {
    const out = negateKeyframes([{ t: 0, value: 1, so: 0.2 }, { t: 1, value: 2, si: -0.5, easing: 'easeIn' }]);
    expect(out).toEqual([{ t: 0, value: -1, so: -0.2 }, { t: 1, value: -2, si: 0.5, easing: 'easeIn' }]);
  });

  it('numpad steps 1, Shift 10, signed', () => {
    expect(numpadStep(1, false)).toBe(1);
    expect(numpadStep(-1, true)).toBe(-10);
  });

  it('scale nudges grow the magnitude, keep a flip, never cross zero', () => {
    expect(nudgedScale(1, 10)).toBeCloseTo(1.1);
    expect(nudgedScale(-1, 10)).toBeCloseTo(-1.1);
    expect(nudgedScale(0.05, -10)).toBe(0);
  });

  it('reset defaults: comp centre, 100 %, anchor at content centre; 3D and camera variants', () => {
    const w = resetTransformWrites({ kind: 'shape', is3D: false, hasOpacity: true, centre: { x: 960, y: 540 } });
    const map = Object.fromEntries(w.map((x) => [x.prop, x.value]));
    expect(map).toEqual({ anchorX: 0, anchorY: 0, x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0, opacity: 100 });
    const threeD = resetTransformWrites({ kind: 'shape', is3D: true, hasOpacity: false, centre: { x: 0, y: 0 } }).map((x) => x.prop);
    expect(threeD).toEqual(expect.arrayContaining(['z', 'anchorZ', 'scaleZ', 'rotationX', 'rotationY', 'orientationZ']));
    expect(threeD).not.toContain('opacity');
    const cam = resetTransformWrites({ kind: 'camera', is3D: true, hasOpacity: false, centre: { x: 0, y: 0 } }).map((x) => x.prop);
    expect(cam).toEqual(['orientationX', 'orientationY', 'orientationZ']);
  });
});

describe('against the scene', () => {
  it('flip negates a static scale on one axis only', () => {
    addLayer({ scaleX: 0.5, scaleY: 2 });
    expect(flipLayer(ID, 'horizontal')).toBe(true);
    expect(prop('scaleX')).toBe(-0.5);
    expect(prop('scaleY')).toBe(2);
  });

  it('flip on KEYFRAMED scale negates every keyframe on the axis', () => {
    addLayer({ scaleX: 1, scaleY: 1 });
    defaultAnimation.setKeyframe(ID, 'scaleY', 0, 1);
    defaultAnimation.setKeyframe(ID, 'scaleY', 2, 3);
    flipLayer(ID, 'vertical');
    expect(defaultAnimation.getTrackKeyframes(ID, 'scaleY')!.map((k) => k.value)).toEqual([-1, -3]);
    expect(defaultAnimation.getTrackKeyframes(ID, 'scaleX')).toBeNull();
  });

  it('flip on a layer animated through the uniform `scale` shorthand gets a negated per-axis copy', () => {
    addLayer({});
    defaultAnimation.setKeyframe(ID, 'scale', 0, 1);
    defaultAnimation.setKeyframe(ID, 'scale', 1, 2);
    flipLayer(ID, 'horizontal');
    expect(defaultAnimation.getTrackKeyframes(ID, 'scaleX')!.map((k) => k.value)).toEqual([-1, -2]);
    // The other axis still follows `scale`.
    expect(defaultAnimation.getTrackKeyframes(ID, 'scale')!.map((k) => k.value)).toEqual([1, 2]);
  });

  it('numpad rotate sets a static value when Rotation is not animated', () => {
    addLayer({ rotation: 10 });
    nudgeRotation([ID], 1);
    expect(prop('rotation')).toBe(11);
    expect(defaultAnimation.isAnimated(ID, 'rotation')).toBe(false);
  });

  it('numpad rotate KEYFRAMES an animated Rotation at the playhead, from the value on screen', () => {
    addLayer({ rotation: 0 });
    defaultAnimation.setKeyframe(ID, 'rotation', 0, 30);
    defaultAnimation.setKeyframe(ID, 'rotation', 4, 90);
    nudgeRotation([ID], -10);
    // Playhead at 0: the animated 30°, not the base 0°, is what gets nudged.
    const kfs = defaultAnimation.getTrackKeyframes(ID, 'rotation')!;
    expect(kfs.find((k) => k.t === 0)?.value).toBe(20);
    expect(kfs.find((k) => k.t === 4)?.value).toBe(90);
  });

  it('numpad scale changes both axes by percentage points', () => {
    addLayer({ scaleX: 1, scaleY: -1 });
    nudgeScale([ID], 10);
    expect(prop('scaleX')).toBeCloseTo(1.1);
    expect(prop('scaleY')).toBeCloseTo(-1.1);
  });

  it('reset removes transform keyframes and writes the defaults', () => {
    addLayer({ x: 5, y: 6, scaleX: 3, scaleY: 3, rotation: 45, anchorX: 12, anchorY: -4 });
    defaultAnimation.setKeyframe(ID, 'x', 0, 100);
    defaultAnimation.setKeyframe(ID, 'x', 1, 200);
    defaultAnimation.setKeyframe(ID, 'opacity', 0, 10);
    expect(resetLayerTransform(ID, { width: 1000, height: 600 })).toBe(true);
    expect(defaultAnimation.isAnimated(ID, 'x')).toBe(false);
    expect(defaultAnimation.isAnimated(ID, 'opacity')).toBe(false);
    expect(prop('x')).toBe(500);
    expect(prop('y')).toBe(300);
    expect(prop('scaleX')).toBe(1);
    expect(prop('rotation')).toBe(0);
    expect(prop('anchorX')).toBe(0);
    // Opacity is written where it lives (the Style component).
    expect(defaultSceneGraph.getNode(ID)!.components.find((c) => c.type === 'Style')!.props.opacity).toBe(100);
  });
});

describe('reset ONE property (timeline row right-click)', () => {
  it('the value: the Transform default first, then the registry number, else nothing', () => {
    expect(propertyResetValue('x', [{ prop: 'x', value: 500 }], 0)).toBe(500);
    expect(propertyResetValue('strokeWidth', [], 4)).toBe(4);
    expect(propertyResetValue('maskShape', [], null)).toBeUndefined();
  });

  it('clears only that property’s keyframes and writes its default', () => {
    addLayer({ x: 5, y: 6, rotation: 45, scaleX: 3 });
    defaultAnimation.setKeyframe(ID, 'rotation', 0, 10);
    defaultAnimation.setKeyframe(ID, 'rotation', 1, 90);
    defaultAnimation.setKeyframe(ID, 'x', 0, 100);
    expect(canResetProperties(ID, ['rotation'])).toBe(true);
    expect(resetProperties(ID, ['rotation'], { width: 1000, height: 600 }, 'Reset Rotation')).toBe(true);
    expect(defaultAnimation.isAnimated(ID, 'rotation')).toBe(false);
    expect(prop('rotation')).toBe(0);
    // Untouched neighbours.
    expect(defaultAnimation.isAnimated(ID, 'x')).toBe(true);
    expect(prop('scaleX')).toBe(3);
  });

  it('a Position row resets x and y to the comp centre; Opacity to 100 on its Style', () => {
    addLayer({ x: 5, y: 6 });
    resetProperties(ID, ['x', 'y'], { width: 1000, height: 600 });
    expect(prop('x')).toBe(500);
    expect(prop('y')).toBe(300);
    resetProperties(ID, ['opacity'], { width: 1000, height: 600 });
    expect(defaultSceneGraph.getNode(ID)!.components.find((c) => c.type === 'Style')!.props.opacity).toBe(100);
  });

  it('a locked layer offers no reset', () => {
    addLayer({ rotation: 45 });
    defaultSceneGraph.getNode(ID)!.locked = true;
    expect(canResetProperties(ID, ['rotation'])).toBe(false);
    expect(resetProperties(ID, ['rotation'], { width: 10, height: 10 })).toBe(false);
    defaultSceneGraph.getNode(ID)!.locked = false;
  });
});
