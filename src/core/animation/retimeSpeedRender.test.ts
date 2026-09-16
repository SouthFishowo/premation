/**
 * Speed % through the REAL snapshot builder, on a footage bar that is trimmed
 * and moved — the case every TikTok edit is, and the one a bar-less fixture
 * cannot see.
 *
 * `retime.test.ts` proves the integral. This proves the renderer shows it:
 * the in-point keeps its trimmed frame, speed integrates from there, and
 * dragging the bar carries the speed curve with it (speed keys live on the
 * clip axis, unlike `timeRemap`).
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';
import { SPEED_PROP } from './retime';

const VIDEO = 'retime-speed-vid';

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

describe('Speed % on a trimmed, moved footage bar', () => {
  it('keeps the in-point frame and plays at the keyed speed from there', () => {
    const { graph, anim, fps } = setup({ start: 2 * 30, duration: 10 * 30, sourceIn: 5 * 30 });
    const inSec = (2 * 30) / fps;
    const srcIn = (5 * 30) / fps;
    // Constant 50%, keyed on the clip axis (source-ish time).
    anim.setKeyframe(VIDEO, SPEED_PROP, srcIn, 50, 'linear');
    expect(sourceAt(graph, anim, inSec)).toBeCloseTo(srcIn, 2);
    expect(sourceAt(graph, anim, inSec + 4)).toBeCloseTo(srcIn + 2, 2);
  });

  it('reads past the bar end at 300% instead of jumping to raw time', () => {
    const { graph, anim, fps } = setup({ start: 30, duration: 4 * 30, sourceIn: 0 });
    const inSec = 30 / fps;
    anim.setKeyframe(VIDEO, SPEED_PROP, 0, 300, 'linear');
    // 3s into a 4s bar at 3× = 9s of source.
    expect(sourceAt(graph, anim, inSec + 3)).toBeCloseTo(9, 2);
  });

  it('ramps: a linear 100% → 25% key pair decelerates between them', () => {
    const { graph, anim, fps } = setup({ start: 0, duration: 10 * 30, sourceIn: 0 });
    void fps;
    anim.setKeyframe(VIDEO, SPEED_PROP, 1, 100, 'linear');
    anim.setKeyframe(VIDEO, SPEED_PROP, 2, 25, 'linear');
    const slope = (t: number): number => ((sourceAt(graph, anim, t + 0.1) ?? 0) - (sourceAt(graph, anim, t) ?? 0)) / 0.1;
    expect(slope(0.3)).toBeCloseTo(1, 1);
    expect(slope(5)).toBeCloseTo(0.25, 1);
    // Exact integral at the end of the ramp: 1 + (1 + 0.25)/2.
    expect(sourceAt(graph, anim, 2)).toBeCloseTo(1.625, 1);
  });

  it('keeps sub-frame source time in slow motion, so frame blending has something to blend', () => {
    // Rounded to the comp frame grid, 25% held each source frame for four comp
    // frames — Pixel Motion's bracket weight was always zero on a real bar.
    const { graph, anim, fps } = setup({ start: 0, duration: 10 * 30, sourceIn: 0 });
    anim.setKeyframe(VIDEO, SPEED_PROP, 0, 25, 'linear');
    const a = sourceAt(graph, anim, 40 / fps)!;
    const b = sourceAt(graph, anim, 41 / fps)!;
    expect(b - a).toBeCloseTo(0.25 / fps, 6);
  });

  it('the speed curve travels with a dragged bar', () => {
    const { graph, anim, fps } = setup({ start: 0, duration: 10 * 30, sourceIn: 0 });
    anim.setKeyframe(VIDEO, SPEED_PROP, 0, 100, 'step');
    anim.setKeyframe(VIDEO, SPEED_PROP, 1, 50, 'step');
    const before = sourceAt(graph, anim, 3);
    // Slide the bar 2 seconds later, as a timeline drag does.
    const layer = getTimelineController().getLayersForNode(VIDEO)[0]!;
    layer.clip.start += 2 * fps;
    getTimelineController().invalidateLayerIndex();
    expect(sourceAt(graph, anim, 5)).toBeCloseTo(before!, 2);
  });
});
