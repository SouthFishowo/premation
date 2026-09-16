/**
 * One layer the adapter cannot map must not throw the frame away.
 *
 * `flattenLayers` used to have no guard: a layer whose transform read threw (a
 * NaN reaching a matrix helper, effect params that break a packer) unwound out
 * of `snapshotToFrameScene`, and the viewport drew nothing at all. Now that
 * layer is skipped, its siblings still map, and the skip is recorded for the
 * backend to report (preview) and refuse (export).
 */

import { snapshotToFrameScene, takeSceneLayerErrors } from './snapshotToFrameScene';
import type { RenderLayer, RenderSnapshot } from './RenderBackend';

const shape = (id: string, x: number): RenderLayer => ({
  id,
  kind: 'shape',
  x,
  y: 50,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  width: 20,
  height: 20,
  fill: '#ff0000',
  visible: true,
}) as RenderLayer;

function throwingLayer(id: string): RenderLayer {
  const l = shape(id, 0) as unknown as Record<string, unknown>;
  Object.defineProperty(l, 'x', { enumerable: true, get() { throw new Error('NaN transform'); } });
  return l as unknown as RenderLayer;
}

const snapshot = (layers: RenderLayer[]): RenderSnapshot =>
  ({ width: 100, height: 100, background: '#000000', layers }) as RenderSnapshot;

describe('snapshotToFrameScene per-layer isolation', () => {
  afterEach(() => { takeSceneLayerErrors(); });

  it('skips the throwing layer and maps the rest', () => {
    const scene = snapshotToFrameScene(snapshot([shape('a', 10), throwingLayer('bad'), shape('b', 80)]));
    const ids = scene.renderables.map((r) => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('bad');
    expect(takeSceneLayerErrors()).toEqual([
      expect.objectContaining({ layerId: 'bad', stage: 'scene', message: expect.stringMatching(/NaN transform/) }),
    ]);
  });

  it('take clears the record, and a healthy frame records nothing', () => {
    snapshotToFrameScene(snapshot([throwingLayer('bad')]));
    expect(takeSceneLayerErrors()).not.toBeNull();
    expect(takeSceneLayerErrors()).toBeNull();
    snapshotToFrameScene(snapshot([shape('a', 10)]));
    expect(takeSceneLayerErrors()).toBeNull();
  });

  it('a new frame resets errors a previous frame left untaken', () => {
    snapshotToFrameScene(snapshot([throwingLayer('bad')]));
    snapshotToFrameScene(snapshot([shape('a', 10)]));
    expect(takeSceneLayerErrors()).toBeNull();
  });

  it('a healthy frame maps exactly as before (ids and order)', () => {
    const scene = snapshotToFrameScene(snapshot([shape('a', 10), shape('b', 80)]));
    expect(scene.renderables.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
