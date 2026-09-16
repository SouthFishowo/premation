import { buildPropertyMenu } from './propertyMenu';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { onExpressionEditorRequest } from '@core/animation/expressionCommands';
import type { SceneNode } from '@core/types';

const NODE = 'n1';

// Every mutating entry routes through `runAnimEdit`, which records onto the
// command system so the action is undoable — boot a minimal one.
const dummyServices = {
  undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
  selection: { get: () => [], set: () => {}, clear: () => {} },
  panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
  workspace: { setActive: () => {}, getActive: () => '' },
  get: () => undefined,
} as never;

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: dummyServices, getState: () => ({}) }));
});

function labels(items: ReturnType<typeof buildPropertyMenu>): string[] {
  return items.filter((i) => !i.separator).map((i) => String(i.label));
}

beforeEach(() => {
  defaultAnimation.clear();
});

describe('buildPropertyMenu — entries reflect state', () => {
  it('offers only "Enable Animation" and a reset on an un-animated property', () => {
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'x', layerT: 0, value: 100, setValue: () => {} });
    expect(labels(items)).toEqual(['Enable Animation', 'Reset Position X']);
  });

  it('omits the reset when the caller cannot write a plain value', () => {
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'x', layerT: 0, value: 100 });
    expect(labels(items)).toEqual(['Enable Animation']);
  });

  it('omits the reset for a property with no meaningful default', () => {
    // Width is non-resettable in the registry — "reset" would mean 0.
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'width', layerT: 0, value: 80, setValue: () => {} });
    expect(labels(items)).not.toContain('Reset Width');
  });

  it('offers Add Keyframe (not Remove) when animated but off a keyframe', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 100);
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'x', layerT: 5, value: 100, setValue: () => {} });
    expect(labels(items)).toContain('Add Keyframe');
    expect(labels(items)).not.toContain('Remove Keyframe');
    // No easing submenu off a keyframe — there is nothing to ease.
    expect(labels(items)).not.toContain('Keyframe Interpolation');
  });

  it('offers Remove Keyframe and the easing submenu when ON a keyframe', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 2, 100);
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'x', layerT: 2, value: 100, setValue: () => {} });
    expect(labels(items)).toContain('Remove Keyframe');
    expect(labels(items)).toContain('Keyframe Interpolation');
    expect(labels(items)).toContain('Remove Animation');
  });

  it('lists the AE easing presets, Hold last', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 100);
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'x', layerT: 0, value: 100 });
    const sub = items.find((i) => i.id === 'kf-easing')!;
    expect(sub.children!.map((c) => String(c.label))).toEqual([
      'Linear', 'Easy Ease', 'Easy Ease In', 'Easy Ease Out', 'Toggle Hold',
    ]);
  });
});

describe('buildPropertyMenu — actions', () => {
  it('Enable Animation writes a keyframe at the playhead holding the value', () => {
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'opacity', layerT: 1.5, value: 42 });
    items.find((i) => i.id === 'animate')!.onSelect!();
    expect(defaultAnimation.isAnimated(NODE, 'opacity')).toBe(true);
    expect(defaultAnimation.sample(NODE, 'opacity', 1.5)).toBe(42);
  });

  it('Add Keyframe holds the CURRENT value — anchoring without changing it', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 100);
    defaultAnimation.setKeyframe(NODE, 'x', 4, 300);
    const at2 = defaultAnimation.sample(NODE, 'x', 2)!;
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'x', layerT: 2, value: at2 });
    items.find((i) => i.id === 'kf-toggle')!.onSelect!();
    // The curve through t=2 is unchanged.
    expect(defaultAnimation.sample(NODE, 'x', 2)).toBeCloseTo(at2, 6);
    expect(defaultAnimation.getTrackKeyframes(NODE, 'x')).toHaveLength(3);
  });

  it('Remove Animation drops the whole track', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 100);
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'x', layerT: 0, value: 100 });
    items.find((i) => i.id === 'remove-anim')!.onSelect!();
    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(false);
  });

  it('Reset on an ANIMATED property writes a keyframe, not a static value', () => {
    // A plain write would be invisible — the track overrides it on the next frame.
    defaultAnimation.setKeyframe(NODE, 'rotation', 0, 90);
    let staticWrites = 0;
    const items = buildPropertyMenu({
      nodeId: NODE, prop: 'rotation', layerT: 0, value: 90, setValue: () => { staticWrites++; },
    });
    items.find((i) => i.id === 'reset')!.onSelect!();
    expect(staticWrites).toBe(0);
    expect(defaultAnimation.sample(NODE, 'rotation', 0)).toBe(0);
  });

  it('Reset on an un-animated property writes the plain value', () => {
    let written: number | null = null;
    const items = buildPropertyMenu({
      nodeId: NODE, prop: 'rotation', layerT: 0, value: 90, setValue: (v) => { written = v; },
    });
    items.find((i) => i.id === 'reset')!.onSelect!();
    expect(written).toBe(0);
    expect(defaultAnimation.isAnimated(NODE, 'rotation')).toBe(false);
  });

  it('keeps a bare id (no scene node) free of the expression entries', () => {
    const items = buildPropertyMenu({ nodeId: NODE, prop: 'x', layerT: 0, value: 1 });
    expect(items.some((i) => i.id === 'expr-add' || i.id === 'expr-edit')).toBe(false);
  });

  it('names entries from the registry, so an effect param reads properly', () => {
    const items = buildPropertyMenu({
      nodeId: NODE, prop: 'effect.fx_3.radius', layerT: 0, value: 16, setValue: () => {},
    });
    // Not "Reset effect.fx_3.radius".
    expect(labels(items).some((l) => /Radius/.test(l) && !/fx_3/.test(l))).toBe(true);
  });
});

/**
 * The expression entries — the way a compact inspector field (whose `=` is
 * hover-only, or absent on a two-field row) reaches its expression.
 */
describe('buildPropertyMenu — expression entries', () => {
  const REAL = 'menu_expr_a';
  const OTHER = 'menu_expr_b';

  const add = (id: string): void => {
    defaultSceneGraph.addNode({
      id, name: id, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0 } }],
    } as unknown as SceneNode);
  };

  beforeEach(() => {
    for (const id of [REAL, OTHER]) {
      if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode(id);
      add(id);
    }
  });

  it('offers Add Expression when the property has none', () => {
    const items = buildPropertyMenu({ nodeId: REAL, prop: 'x', layerT: 0, value: 0 });
    expect(labels(items)).toContain('Add Expression');
    expect(labels(items)).not.toContain('Edit Expression');
  });

  it('Add attaches `value` to every selected layer in one go', () => {
    const items = buildPropertyMenu({ nodeId: REAL, prop: 'x', layerT: 0, value: 0, nodeIds: [REAL, OTHER] });
    items.find((i) => i.id === 'expr-add')!.onSelect!();
    expect(defaultAnimation.hasExpression(REAL, 'x')).toBe(true);
    expect(defaultAnimation.hasExpression(OTHER, 'x')).toBe(true);
  });

  it('offers Edit + Remove (and no Add) once there is one; Edit asks that row to open its editor', () => {
    defaultAnimation.setExpression(REAL, 'x', 'value');
    const items = buildPropertyMenu({ nodeId: REAL, prop: 'x', layerT: 0, value: 0 });
    expect(labels(items)).toEqual(expect.arrayContaining(['Edit Expression', 'Remove Expression']));
    expect(labels(items)).not.toContain('Add Expression');

    const heard: Array<{ nodeId: string; prop: string }> = [];
    const off = onExpressionEditorRequest((ref) => heard.push(ref));
    items.find((i) => i.id === 'expr-edit')!.onSelect!();
    off();
    expect(heard).toEqual([{ nodeId: REAL, prop: 'x' }]);
  });

  it('Remove drops the expression', () => {
    defaultAnimation.setExpression(REAL, 'x', 'value');
    const items = buildPropertyMenu({ nodeId: REAL, prop: 'x', layerT: 0, value: 0 });
    items.find((i) => i.id === 'expr-remove')!.onSelect!();
    expect(defaultAnimation.hasExpression(REAL, 'x')).toBe(false);
  });
});
