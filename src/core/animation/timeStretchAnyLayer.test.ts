/**
 * Time Stretch on a layer with NO source — a solid here — which After Effects
 * stretches by scaling the bar and the keyframes about the Hold in Place frame.
 * Clip bars are frames (end exclusive); keyframe times are read back on the
 * comp axis through `keyframeToCompTime`, the map the timeline draws with.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { getNodeLayerTime, readNodeLayerTime } from '@core/scene/layerTime';
import { readNodeMaskAnim } from '@core/effects/mask';
import { captureDocument, restoreDocument } from '@core/api/cloudDocument';
import { compToKeyframeTime, getTimelineController, keyframeToCompTime } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';
import {
  applyTimeStretch,
  bakeStretchGeometry,
  clampSignedStretch,
  retimeKeys,
  stretchValueOf,
} from './layerTimeCommands';

const ROOT = 'comp_root';
const ID = 'ts_solid';

let fps = 30;

function setup(startSec: number, durationSec: number, layerKind = 'solid'): void {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: ROOT, name: 'Composition 1', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild(ROOT, {
    id: ID, name: ID, parent: ROOT, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${ID}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: layerKind, x: 0, y: 0, width: 50, height: 50 } },
    ],
  } as unknown as SceneNode);
  const c = getTimelineController();
  c.reset();
  c.syncFromScene(ROOT);
  fps = c.timeline.getFrameRate().fps;
  const bar = c.getLayersForNode(ID)[0]!;
  bar.clip.start = Math.round(startSec * fps);
  bar.clip.duration = Math.round(durationSec * fps);
  bar.clip.sourceIn = 0;
  c.invalidateLayerIndex();
  // Position keyframes at 0 s and 1 s of the layer.
  defaultAnimation.setTrackKeyframes(ID, 'x', [
    { t: 0, value: 0, easing: 'easeIn' },
    { t: 1, value: 100 },
  ]);
}

const bar = (): { start: number; duration: number } => {
  const l = getTimelineController().getLayersForNode(ID)[0]!;
  return { start: l.clip.start, duration: l.clip.duration };
};
const keyTimes = (): number[] => (defaultAnimation.getTrackKeyframes(ID, 'x') ?? []).map((k) => k.t);
const keyCompTimes = (): number[] =>
  (defaultAnimation.getTrackKeyframes(ID, 'x') ?? []).map((k) => keyframeToCompTime(ID, k.t, 'x'));

describe('Time Stretch on a solid', () => {
  it('200 % from the in-point doubles the bar and moves the 1 s key to 2 s — keys, holds and masks alike', async () => {
    setup(0, 2);
    defaultAnimation.setDataKeyframe(ID, 'text.source', 'text', 1, 'B');
    defaultAnimation.setExpression(ID, 'y', 'value + 1');
    defaultSceneGraph.setMaskAnim(ID, [{ t: 1, mask: { paths: [] } }]);

    await applyTimeStretch([ID], 200, 'in', 0);

    expect(bar()).toEqual({ start: 0, duration: 4 * fps });
    expect(keyTimes()).toEqual([0, 2]);
    expect(keyCompTimes()[1]).toBeCloseTo(2, 5);
    expect(defaultAnimation.getDataTrack(ID, 'text.source')?.keyframes.map((k) => k.t)).toEqual([2]);
    expect(readNodeMaskAnim(defaultSceneGraph.getNode(ID)!).map((k) => k.t)).toEqual([2]);
    // Expressions are not keyframes; the layer stores no playback rate.
    expect(defaultAnimation.getExpressionSrc(ID, 'y')).toBe('value + 1');
    expect(getNodeLayerTime(ID).stretch).toBe(100);
  });

  it('Hold in Place at the out-point keeps the bar end; the in-point and keys move earlier', async () => {
    setup(2, 2); // bar 2 s → 4 s; keys draw at 2 s and 3 s
    expect(keyCompTimes().map((t) => Math.round(t * 1000) / 1000)).toEqual([2, 3]);

    await applyTimeStretch([ID], 200, 'out', 0);

    expect(bar()).toEqual({ start: 0, duration: 4 * fps });
    const comp = keyCompTimes();
    expect(comp[0]).toBeCloseTo(0, 5);
    expect(comp[1]).toBeCloseTo(2, 5);
  });

  it('−100 % keeps the bar and reverses the keys within it, easing handed to the new owner', async () => {
    setup(0, 2);
    await applyTimeStretch([ID], -100, 'in', 0);

    expect(bar()).toEqual({ start: 0, duration: 2 * fps });
    const kfs = defaultAnimation.getTrackKeyframes(ID, 'x')!;
    expect(kfs.map((k) => [k.t, k.value])).toEqual([[1, 100], [2, 0]]);
    // The 0→1 s segment was eased-in from the 0 s key; reversed, that segment
    // now starts at the 100 key and eases OUT.
    expect(kfs[0]!.easing).toBe('easeOut');
  });

  it('is ONE undo step: undo restores bar and keys, redo reapplies both', async () => {
    setup(0, 2);
    const history = getCommandSystem().getHistory();
    const entries = history.getEntries().length;

    await applyTimeStretch([ID], 200, 'in', 0);
    expect(history.getEntries().length).toBe(entries + 1);

    history.undo();
    expect(bar()).toEqual({ start: 0, duration: 2 * fps });
    expect(keyTimes()).toEqual([0, 1]);

    history.redo();
    expect(bar()).toEqual({ start: 0, duration: 4 * fps });
    expect(keyTimes()).toEqual([0, 2]);
  });
});

describe('markers and the stored stretch value', () => {
  const addMarker = (atSec: number, spanSec: number): void => {
    const c = getTimelineController();
    const bar = c.getLayersForNode(ID)[0]!;
    c.timeline.addMarker({
      frame: Math.round(atSec * fps), duration: Math.round(spanSec * fps), scope: 'layer', ownerId: bar.id, name: 'm',
    });
  };
  const markers = (): number[][] =>
    getTimelineController().getLayerMarkers(ID).map((m) => [Math.round(m.time * 1000) / 1000, Math.round(m.duration * 1000) / 1000]);

  it('layer markers move and scale about the hold frame; a sign change mirrors them in the bar; one undo', async () => {
    setup(0, 2);
    addMarker(0.5, 0.5);
    await applyTimeStretch([ID], 200, 'in', 0);
    expect(markers()).toEqual([[1, 1]]);

    // 200 → −200 is a factor of −1: the 1–2 s span mirrors in the 4 s bar to 2–3 s.
    await applyTimeStretch([ID], -200, 'in', 0);
    expect(markers()).toEqual([[2, 1]]);
    expect(stretchValueOf(ID)).toBe(-200);

    getCommandSystem().getHistory().undo();
    expect(markers()).toEqual([[1, 1]]);
    expect(stretchValueOf(ID)).toBe(200);
  });

  it('footage markers move with a stretched bar too', async () => {
    setup(0, 2, 'video');
    addMarker(0.5, 0.5);
    await applyTimeStretch([ID], 200, 'in', 0);
    expect(markers()).toEqual([[1, 1]]);
    expect(stretchValueOf(ID)).toBe(200);
  });

  it('the value is absolute — 200 % then 100 % puts everything back — and the renderer does not scale again', async () => {
    setup(0, 2);
    await applyTimeStretch([ID], 200, 'in', 0);
    expect(stretchValueOf(ID)).toBe(200);
    // Bookkeeping only: the render-time stretch (fx.time) stays identity…
    expect(readNodeLayerTime(defaultSceneGraph.getNode(ID)!)).toBeUndefined();
    // …so the axis the renderer samples keys on maps comp 2 s to key time 2 s:
    // the 100 key lands at 2 s — stretched ONCE (not at 4 s, not back at 1 s).
    expect(compToKeyframeTime(ID, 2, 'x')).toBeCloseTo(2, 5);
    expect(defaultAnimation.sample(ID, 'x', compToKeyframeTime(ID, 2, 'x'))).toBeCloseTo(100);
    expect(defaultAnimation.sample(ID, 'x', compToKeyframeTime(ID, 1, 'x'))).toBeLessThan(100);

    await applyTimeStretch([ID], 100, 'in', 0);
    expect(keyTimes()).toEqual([0, 1]);
    expect(bar()).toEqual({ start: 0, duration: 2 * fps });
    expect(stretchValueOf(ID)).toBe(100);
  });

  it('survives save/load without re-applying the stretch', async () => {
    setup(0, 2);
    await applyTimeStretch([ID], 200, 'in', 0);
    const saved = structuredClone(captureDocument());
    await applyTimeStretch([ID], 100, 'in', 0);

    restoreDocument(saved);
    expect(stretchValueOf(ID)).toBe(200);
    expect(keyTimes()).toEqual([0, 2]);
    expect(bar()).toEqual({ start: 0, duration: 4 * fps });
  });
});

describe('the bake maths', () => {
  it('a split layer keeps every bar showing the same key at the same frame', () => {
    // Two bars of one layer, the second continuing the first's keyframe time.
    const plan = bakeStretchGeometry(
      [{ start: 0, duration: 30, sourceIn: 0 }, { start: 40, duration: 30, sourceIn: 40 }],
      2, 0, 30,
    )!;
    expect(plan.bars).toEqual([{ start: 0, duration: 60, sourceIn: 0 }, { start: 80, duration: 60, sourceIn: 80 }]);
    expect(plan).toMatchObject({ keyScale: 2, keyOffset: 0 });
  });

  it('reversing mirrors bezier handles in time and swaps spatial tangents', () => {
    const out = retimeKeys(
      [
        { t: 0, value: 0, easing: 'bezier' as const, bezier: [0.2, 0.1, 0.6, 0.9] as [number, number, number, number], so: 5 },
        { t: 1, value: 1, si: 3 },
      ],
      -1,
      1,
    );
    expect(out.map((k) => k.t)).toEqual([0, 1]);
    expect(out[0]).toMatchObject({ value: 1, so: 3, easing: 'bezier' });
    expect(out[0]!.bezier![0]).toBeCloseTo(0.4);
    expect(out[0]!.bezier![1]).toBeCloseTo(0.1);
    expect(out[0]!.bezier![2]).toBeCloseTo(0.8);
    expect(out[0]!.bezier![3]).toBeCloseTo(0.9);
    expect(out[1]).toMatchObject({ value: 0, si: 5 });
  });

  it('a signed factor clamps its magnitude and keeps its sign', () => {
    expect(clampSignedStretch(-5000)).toBe(-1000);
    expect(clampSignedStretch(-0.2)).toBe(100);
    expect(clampSignedStretch(150.4)).toBe(150);
  });
});
