/**
 * The command layer's decisions, against the real animation engine.
 *
 * `retime.test.ts` proves the speed integral is exact. What is tested here is
 * what the command does with it: that ramps COMPOSE (a second ramp starts from
 * the speed the first one left behind, rather than snapping back to 100%),
 * that the footage continues from the frame on screen instead of jumping, and
 * that it refuses layers where a retime would be silently inert.
 *
 * Ramps write Speed % points. A layer already keyed in Frame Number keeps
 * ramping its remap curve — that path is pinned at the bottom.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { buildSpeedRampCommands, rampTargets } from './speedRampCommands';
import { SPEED_PROP, readRetimeMode, retimedChainTime } from './retime';

/** `runAnimEdit` records an undo entry, so the command system has to exist. */
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

const PRECOMP = 'pre_1';
const SOLID = 'solid_1';
const VIDEO = 'video_1';

/**
 * A layer, optionally flagged as a precomp.
 *
 * The flag lives on an `fx` component as `precomp: true` — a `__kind` of
 * 'group' is NOT enough, which is what `isPrecomp` actually reads and what a
 * first version of this fixture got wrong.
 */
function addNode(id: string, kind: string, precomp = false): void {
  defaultSceneGraph.addChild('comp_root', {
    id,
    name: id,
    parent: 'comp_root',
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { __kind: kind } },
      ...(precomp ? [{ id: `${id}_fx`, type: 'fx', props: { precomp: true } }] : []),
    ],
  } as never);
}

const command = (suffix: string) =>
  buildSpeedRampCommands().find((c) => String(c.id) === `time.speedRamp.${suffix}`)!;

/** Source position the renderer resolves for the precomp (no bar: identity clip map). */
function sourceAt(t: number): number {
  return retimedChainTime(defaultAnimation, PRECOMP, t, null) ?? t;
}

/** Speed the layer plays at, as the slope of its source position. */
function speedAt(t: number): number {
  const dt = 1 / 240;
  return (sourceAt(t + dt) - sourceAt(t)) / dt;
}

function setPlayhead(t: number): void {
  const project = useProjectStore.getState();
  const tabId = project.activeTabId;
  if (tabId) useProjectStore.setState({ tabs: { ...project.tabs, [tabId]: { ...project.tabs[tabId]!, time: t } } });
}

beforeEach(() => {
  bootCommandSystem();
  for (const id of [PRECOMP, SOLID, VIDEO]) {
    if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode?.(id);
  }
  addNode(PRECOMP, 'group', true);
  addNode(SOLID, 'solid');
  addNode(VIDEO, 'video');
  defaultAnimation.setKeyframes(PRECOMP, 'timeRemap', []);
  defaultAnimation.setKeyframes(PRECOMP, SPEED_PROP, []);
  useCompositionStore.setState({ durationSeconds: 10 } as never);
  useSelectionStore.setState({ ids: [PRECOMP] });
  setPlayhead(0);
});

describe('rampTargets', () => {
  it('accepts a pre-composed layer', () => {
    expect(rampTargets()).toEqual([PRECOMP]);
  });

  it('accepts a video layer — the main thing anyone ramps', () => {
    // The regression. Ramps were restricted to precomps on the belief that a
    // footage layer had no self-remap hook; the general layer path samples
    // the retime for every node, and `speedRampRender.test.ts` shows a video
    // layer's `sourceTime` following the curve.
    useSelectionStore.setState({ ids: [VIDEO] });
    expect(rampTargets()).toEqual([VIDEO]);
    expect(command('quarter').enabled!()).toBe(true);
  });

  it('refuses a shape, where a retime really would be inert', () => {
    // A retime feeds `sourceTime` and nothing else — it does not move the
    // layer's own transform keyframes. A solid has no source to retime, so
    // nothing would read the value.
    useSelectionStore.setState({ ids: [SOLID] });
    expect(rampTargets()).toEqual([]);
    expect(command('quarter').enabled!()).toBe(false);
  });

  it('ignores ids whose node has gone', () => {
    useSelectionStore.setState({ ids: [PRECOMP, 'deleted_layer'] });
    expect(rampTargets()).toEqual([PRECOMP]);
  });
});

describe('speed ramp commands', () => {
  it('writes Speed % points, not a remap curve', () => {
    command('quarter').execute({} as never);
    expect(readRetimeMode(defaultAnimation, PRECOMP)).toBe('speed');
    expect(defaultAnimation.isAnimated(PRECOMP, 'timeRemap')).toBe(false);
  });

  it('eases from full speed to a quarter and holds it', () => {
    command('quarter').execute({} as never);

    expect(speedAt(0)).toBeCloseTo(1, 1);
    // Past the transition it must be AT the target, not still on its way.
    expect(speedAt(1.5)).toBeCloseTo(0.25, 2);
    expect(speedAt(5)).toBeCloseTo(0.25, 2);
  });

  it('composes: a second ramp starts from the speed the first left', () => {
    // The property that makes ramps usable in sequence — otherwise ramping
    // back up would start with a jump from 25% to 100%.
    command('quarter').execute({} as never);
    setPlayhead(4);
    command('normal').execute({} as never);

    expect(speedAt(4)).toBeCloseTo(0.25, 2);
    expect(speedAt(6)).toBeCloseTo(1, 1);
  });

  it('continues from the frame on screen rather than jumping', () => {
    setPlayhead(3);
    const before = sourceAt(3);
    command('half').execute({} as never);
    expect(sourceAt(3)).toBeCloseTo(before, 5);
  });

  it('never runs the footage backwards through a deceleration', () => {
    command('quarter').execute({} as never);
    let prev = -Infinity;
    for (let t = 0; t <= 6; t += 0.02) {
      const v = sourceAt(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = v;
    }
  });

  it('holds the frame when ramped to a freeze', () => {
    command('freeze').execute({} as never);
    expect(sourceAt(8)).toBeCloseTo(sourceAt(2), 4);
  });

  it('speeds up as well as down', () => {
    command('double').execute({} as never);
    expect(speedAt(2)).toBeCloseTo(2, 1);
  });

  it('leaves the curve before the playhead alone', () => {
    command('quarter').execute({} as never);
    const early = sourceAt(0.25);
    setPlayhead(5);
    command('normal').execute({} as never);
    expect(sourceAt(0.25)).toBeCloseTo(early, 5);
  });

  it('does nothing when there is no room left for a ramp', () => {
    setPlayhead(9.9);
    command('quarter').execute({} as never);
    expect(readRetimeMode(defaultAnimation, PRECOMP)).toBe('normal');
  });

  it('keeps ramping the remap curve of a layer already in Frame Number mode', () => {
    defaultAnimation.setKeyframe(PRECOMP, 'timeRemap', 0, 0, 'linear');
    defaultAnimation.setKeyframe(PRECOMP, 'timeRemap', 10, 10, 'linear');
    command('quarter').execute({} as never);
    expect(readRetimeMode(defaultAnimation, PRECOMP)).toBe('frames');
    expect(speedAt(5)).toBeCloseTo(0.25, 2);
  });
});
