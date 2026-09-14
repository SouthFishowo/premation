/**
 * Per-keyframe SPATIAL interpolation (AE Keyframe Interpolation ▸ Spatial):
 * linear / bezier / continuous / auto, Convert Vertex, and the renderer's
 * sampler honouring each mode.
 */

import {
  AnimationEngine,
  sampleTrack,
  autoSpatialTangents,
  effectiveSpatialTangents,
  type Keyframe,
} from '@motion/animation';
import type { SceneNode } from '@core/types';
import {
  motionPathTangents,
  setPathTangent,
  isPathTangentContinuous,
  setSpatialInterpolation,
  spatialInterpAt,
  toggleVertexInterpolation,
  hasPathTangents,
  motionPathTimeWindow,
} from './motionPath';

const node = { id: 'n1', components: [{ id: 't', type: 'Transform', props: { x: 0, y: 0 } }] } as unknown as SceneNode;

/** A 90° corner: (0,0) → (100,0) → (100,100) at t = 0, 1, 2. */
function corner(): AnimationEngine {
  const e = new AnimationEngine();
  for (const [t, x, y] of [[0, 0, 0], [1, 100, 0], [2, 100, 100]] as const) {
    e.setKeyframe('n1', 'x', t, x);
    e.setKeyframe('n1', 'y', t, y);
  }
  return e;
}

const pos = (e: AnimationEngine, t: number): { x: number; y: number } => ({
  x: e.sample('n1', 'x', t)!,
  y: e.sample('n1', 'y', t)!,
});

describe('tangent computation per mode (pure)', () => {
  const kfs: Keyframe[] = [
    { t: 0, value: 0 },
    { t: 1, value: 100, si: 7, so: 9 },
    { t: 3, value: 40 },
  ];

  it('auto = Catmull-Rom from the neighbours, scaled by each side’s duration', () => {
    // chord slope (40-0)/3; out spans 2s, in spans 1s
    const m = 40 / 3;
    expect(autoSpatialTangents(kfs, 1).so).toBeCloseTo((m * 2) / 3);
    expect(autoSpatialTangents(kfs, 1).si).toBeCloseTo((-m * 1) / 3);
    expect(autoSpatialTangents(kfs, 0).si).toBeUndefined();
    expect(autoSpatialTangents(kfs, 2).so).toBeUndefined();
  });

  it('linear ignores stored tangents; auto ignores them too; bezier/continuous/absent use them', () => {
    const with_ = (mode: Keyframe['spatialInterp']): Keyframe[] => kfs.map((k, i) => (i === 1 ? { ...k, spatialInterp: mode } : k));
    expect(effectiveSpatialTangents(with_('linear'), 1)).toEqual({});
    expect(effectiveSpatialTangents(with_('auto'), 1)).toEqual(autoSpatialTangents(kfs, 1));
    expect(effectiveSpatialTangents(with_('bezier'), 1)).toEqual({ si: 7, so: 9 });
    expect(effectiveSpatialTangents(with_('continuous'), 1)).toEqual({ si: 7, so: 9 });
    expect(effectiveSpatialTangents(kfs, 1)).toEqual({ si: 7, so: 9 });
  });

  it('the sampler honours linear = a straight segment even with stale tangents stored', () => {
    const curved: Keyframe[] = [{ t: 0, value: 0, so: 80 }, { t: 1, value: 100, si: 80 }];
    const track = (k: Keyframe[]) => ({ nodeId: 'n', prop: 'x', keyframes: k });
    expect(sampleTrack(track(curved), 0.25)).not.toBeCloseTo(25);
    const linear = curved.map((k) => ({ ...k, spatialInterp: 'linear' as const }));
    for (const t of [0.1, 0.25, 0.5, 0.9]) expect(sampleTrack(track(linear), t)).toBeCloseTo(t * 100);
  });

  it('the sampler honours auto = computed tangents (tracks a moved neighbour)', () => {
    const base: Keyframe[] = [{ t: 0, value: 0 }, { t: 1, value: 100, spatialInterp: 'auto' }, { t: 2, value: 0 }];
    const track = (k: Keyframe[]) => ({ nodeId: 'n', prop: 'x', keyframes: k });
    // Interior peak with equal neighbours ⇒ flat tangents ⇒ overshoot-free, but curved.
    const a = sampleTrack(track(base), 0.5)!;
    const moved = base.map((k, i) => (i === 2 ? { ...k, value: 200 } : k));
    const b = sampleTrack(track(moved), 0.5)!;
    expect(a).not.toBeCloseTo(b); // tangent recomputed from the neighbour
  });
});

describe('setSpatialInterpolation on a motion-path vertex', () => {
  it('linear: straight segments both sides of the vertex', () => {
    const e = corner();
    setSpatialInterpolation('n1', 1, 'auto', e);
    setSpatialInterpolation('n1', 1, 'linear', e);
    expect(spatialInterpAt('n1', 1, e)).toBe('linear');
    const p = pos(e, 0.5);
    expect(p.y).toBeCloseTo(0); // first leg stays on y = 0
    expect(motionPathTangents(node, e)[1]!.in).toBeNull(); // no handles on a corner
  });

  it('auto: the path rounds the corner and handles show the computed tangents', () => {
    const e = corner();
    setSpatialInterpolation('n1', 1, 'auto', e);
    expect(spatialInterpAt('n1', 1, e)).toBe('auto');
    expect(pos(e, 0.5).y).toBeLessThan(-0.5); // bows outward before the corner
    const tan = motionPathTangents(node, e)[1]!;
    // chord (0,0)→(100,100) over 2s: slope (50,50)/s, out over 1s → (50/3, 50/3)
    expect(tan.out!.x).toBeCloseTo(100 + 50 / 3);
    expect(tan.out!.y).toBeCloseTo(50 / 3);
    expect(isPathTangentContinuous('n1', 1, e)).toBe(true);
  });

  it('bezier from a corner bakes the auto handles and breaks them', () => {
    const e = corner();
    setSpatialInterpolation('n1', 1, 'bezier', e);
    const x = e.getTrackKeyframes('n1', 'x')!.find((k) => k.t === 1)!;
    expect(x.spatialInterp).toBe('bezier');
    expect(x.so).toBeCloseTo(50 / 3);
    expect(isPathTangentContinuous('n1', 1, e)).toBe(false);
  });

  it('continuous re-aims the in handle opposite the out handle, keeping its length', () => {
    const e = corner();
    setPathTangent('n1', 1, 'out', { x: 130, y: 0 }, false, e); // out = (30, 0)
    setPathTangent('n1', 1, 'in', { x: 100, y: -20 }, false, e); // in = (0, -20) — broken
    setSpatialInterpolation('n1', 1, 'continuous', e);
    const x = e.getTrackKeyframes('n1', 'x')!.find((k) => k.t === 1)!;
    const y = e.getTrackKeyframes('n1', 'y')!.find((k) => k.t === 1)!;
    expect(x.si).toBeCloseTo(-20);
    expect(y.si).toBeCloseTo(0);
    expect(x.continuous).toBe(true);
  });

  it('Convert Vertex toggles corner ↔ auto-bezier', () => {
    const e = corner();
    expect(toggleVertexInterpolation('n1', 1, e)).toBe('auto');
    expect(toggleVertexInterpolation('n1', 1, e)).toBe('linear');
    expect(toggleVertexInterpolation('n1', 1, e)).toBe('auto');
  });

  it('dragging a handle of an auto vertex converts it to continuous; Alt-drag to bezier', () => {
    const e = corner();
    setSpatialInterpolation('n1', 1, 'auto', e);
    setPathTangent('n1', 1, 'out', { x: 140, y: 10 }, true, e);
    expect(spatialInterpAt('n1', 1, e)).toBe('continuous');
    setPathTangent('n1', 1, 'out', { x: 150, y: 0 }, false, e);
    expect(spatialInterpAt('n1', 1, e)).toBe('bezier');
  });

  it('an Alt-drag on an auto vertex freezes the OTHER handle where it was', () => {
    const e = corner();
    setSpatialInterpolation('n1', 1, 'auto', e);
    const before = motionPathTangents(node, e)[1]!.in!;
    setPathTangent('n1', 1, 'out', { x: 150, y: 0 }, false, e);
    const after = motionPathTangents(node, e)[1]!.in!;
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('hasPathTangents counts an auto vertex (the Straighten button must show)', () => {
    const e = corner();
    expect(hasPathTangents('n1', e)).toBe(false);
    setSpatialInterpolation('n1', 1, 'auto', e);
    expect(hasPathTangents('n1', e)).toBe(true);
  });

  it('updateKeyframe keeps the mode (a retime must not drop it)', () => {
    const e = corner();
    setSpatialInterpolation('n1', 1, 'auto', e);
    e.updateKeyframe('n1', 'x', 1, { t: 1.5 });
    expect(e.getTrackKeyframes('n1', 'x')!.find((k) => k.t === 1.5)!.spatialInterp).toBe('auto');
  });
});

describe('motionPathTimeWindow', () => {
  it('all / none / a span centred on the playhead', () => {
    expect(motionPathTimeWindow('all', 2, 5)).toEqual({ min: -Infinity, max: Infinity });
    expect(motionPathTimeWindow('none', 2, 5)).toBeNull();
    expect(motionPathTimeWindow('window', 2, 5)).toEqual({ min: 4, max: 6 });
  });
});
