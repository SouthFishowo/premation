/**
 * Time Stretch is ONE undo step: the clip bar (engine history), the stretch
 * factor (scene) and where the keyframes land on the comp axis all come back
 * with a single undo, and all go again with a single redo.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { getTimelineController, keyframeToCompTime } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';
import { applyTimeStretch } from './layerTimeCommands';

const ROOT = 'comp_root';
const ID = 'ts_video';

beforeEach(() => {
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
      { id: `${ID}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'video', x: 100, y: 100, width: 50, height: 50 } },
    ],
  } as unknown as SceneNode);
  const c = getTimelineController();
  c.reset();
  c.syncFromScene(ROOT);
  const bar = c.getLayersForNode(ID)[0]!;
  bar.clip.start = 0;
  bar.clip.duration = 60;
  bar.clip.sourceIn = 0;
  c.invalidateLayerIndex();
  defaultAnimation.setTrackKeyframes(ID, 'opacity', [{ t: 0, value: 0 }, { t: 1, value: 100 }]);
});

const barLength = (): number => getTimelineController().getLayersForNode(ID)[0]!.clip.duration;
const keyComp = (): number => keyframeToCompTime(ID, 1, 'opacity');

describe('Time Stretch undo', () => {
  it('apply → undo once restores everything → redo once reapplies everything', async () => {
    const before = { bar: barLength(), stretch: getNodeLayerTime(ID).stretch, key: keyComp() };
    const history = getCommandSystem().getHistory();
    const entries = history.getEntries().length;

    await applyTimeStretch([ID], 200, 'in', 0);
    const after = { bar: barLength(), stretch: getNodeLayerTime(ID).stretch, key: keyComp() };
    expect(after.bar).toBe(before.bar * 2);
    expect(after.stretch).toBe(200);
    expect(after.key).toBeCloseTo(before.key * 2, 5);
    expect(history.getEntries().length).toBe(entries + 1);

    history.undo();
    expect(barLength()).toBe(before.bar);
    expect(getNodeLayerTime(ID).stretch).toBe(before.stretch);
    expect(keyComp()).toBeCloseTo(before.key, 5);

    history.redo();
    expect(barLength()).toBe(after.bar);
    expect(getNodeLayerTime(ID).stretch).toBe(200);
    expect(keyComp()).toBeCloseTo(after.key, 5);
  });
});
