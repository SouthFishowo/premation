/**
 * A time remap on a footage bar that does not start at comp 0.
 *
 * `timeRemap` values live on the chain axis (identity = comp time) and reach
 * the footage through the clip map. The map asked "is a bar live at the
 * VALUE's frame" — so the moment a remap value left the bar's comp range (any
 * speed above 100% near the out-point, or slow motion near a moved in-point)
 * it fell through to raw time and showed an unrelated frame.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';

const VIDEO = 'retime-bar-vid';

function compTrackId(): string {
  const track = getTimelineController().timeline.getTracks()[0];
  if (!track) throw new Error('composition track missing');
  return track.id;
}

function setup(clip: { start: number; duration: number; sourceIn: number }): { graph: SceneGraph; anim: AnimationEngine; fps: number } {
  const c = getTimelineController();
  c.timeline.addLayer(compTrackId(), { name: VIDEO, sourceId: VIDEO, clip });
  c.invalidateLayerIndex();
  const graph = new SceneGraph();
  graph.addChild(null as unknown as string, {
    id: VIDEO, name: VIDEO, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'v_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'video', assetId: 'a1', x: 0, y: 0, width: 100, height: 100 } },
    ],
  } as unknown as SceneNode);
  return { graph, anim: new AnimationEngine(), fps: c.timeline.getFrameRate().fps };
}

afterEach(() => {
  const c = getTimelineController();
  const track = c.timeline.getTrack(compTrackId());
  for (const l of [...(track?.layers ?? [])]) c.timeline.removeLayer(String(l.id));
  c.invalidateLayerIndex();
});

function sourceAt(graph: SceneGraph, anim: AnimationEngine, t: number): number | undefined {
  return buildSnapshot(graph, anim, t).layers.find((l) => l.id === VIDEO)?.sourceTime;
}

describe('time remap on an offset footage bar', () => {
  it('keeps the clip offset when a 200% remap runs past the bar end', () => {
    // A 5-second bar: at 200% the remap value leaves it after 2.5s.
    const { graph, anim, fps } = setup({ start: 60, duration: 5 * 30, sourceIn: 0 });
    const inSec = 60 / fps;
    // Identity at the in-point, then double speed.
    anim.setKeyframe(VIDEO, 'timeRemap', inSec, inSec, 'linear');
    anim.setKeyframe(VIDEO, 'timeRemap', inSec + 4, inSec + 8, 'linear');
    // 3s into the bar at 200% = 6s of source.
    const t = inSec + 3;
    expect(sourceAt(graph, anim, t)).toBeCloseTo(6, 2);
  });

  it('keeps the clip offset when slow motion reaches back before a trimmed in-point', () => {
    // Bar starts at comp 2s showing source 5s (trimmed head).
    const { graph, anim, fps } = setup({ start: 2 * 30, duration: 1000, sourceIn: 5 * 30 });
    const inSec = (2 * 30) / fps;
    const srcIn = (5 * 30) / fps;
    // Remap value 1s before the in-point on the chain axis = 1s before sourceIn.
    anim.setKeyframe(VIDEO, 'timeRemap', inSec, inSec - 1, 'linear');
    anim.setKeyframe(VIDEO, 'timeRemap', inSec + 4, inSec - 1, 'linear');
    expect(sourceAt(graph, anim, inSec + 1)).toBeCloseTo(srcIn - 1, 2);
  });
});
