/**
 * A generator layer, from the snapshot to the scene.
 *
 * The claim worth pinning is the one that broke the CPU particle path before it
 * had a render branch of its own: a generator layer's CARRIER is a comp-sized
 * solid, so a generator that fell through to the ordinary shape path would paint
 * the whole frame opaque black. The rest of this file is the ordinary layer
 * contract — blend, mask, matte, effects — reaching the field, which is the
 * entire reason the field is a texture rather than a render path.
 */

import { snapshotToFrameScene } from './snapshotToFrameScene';
import type { RenderSnapshot, RenderLayer } from './RenderBackend';
import { emptyGeneratorFrame } from '@core/plugins/generator';
import { depthEligible3D } from '@motion/renderer';

const FIELD = {
  instances: new Float32Array([0, 0, 0, 12, 0, 1, 1, 1, 1, 40, -10, 0, 8, 0, 1, 0, 0, 1]),
  count: 2,
  stride: 9,
  primitive: 'point' as const,
  cellSize: [1, 1] as readonly [number, number],
  blend: 'normal' as const,
  bounds: { x: -6, y: -14, width: 52, height: 20 },
  revision: 3,
};

function layer(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 'g1', kind: 'shape', x: 960, y: 540, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, width: 400, height: 300, fill: '#000', visible: true,
    generator: FIELD,
    ...over,
  };
}

const scene = (layers: RenderLayer[]) => snapshotToFrameScene(
  { width: 1920, height: 1080, background: '#101014', layers } as RenderSnapshot,
);

describe('a generator layer becomes a textured renderable', () => {
  it('never draws its carrier solid', () => {
    const [r] = scene([layer()]).renderables;
    expect(r!.kind).toBe('image');
    // The carrier's `fill` is nowhere in the output: what draws is the field.
    expect(r!.textureKey).toBe('generator:g1');
    expect(r!.generator!.count).toBe(2);
  });

  it('carries the layer box the instance positions are relative to', () => {
    const [r] = scene([layer()]).renderables;
    expect(r!.generator!.width).toBe(400);
    expect(r!.generator!.height).toBe(300);
  });

  it('passes the revision through, so the renderer can skip a re-upload', () => {
    const [r] = scene([layer()]).renderables;
    expect(r!.generator!.revision).toBe(3);
  });

  it('keeps blend, mask and matte on the composite, like any other layer', () => {
    const [r] = scene([
      layer({
        blend: 'add',
        mask: { paths: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] } as RenderLayer['mask'],
        matte: { mode: 'alpha', inverted: false },
        matteSourceId: 'src',
      }),
    ]).renderables;
    expect(r!.blend).toBe('add');
    expect(r!.maskTextureKey).toBe('mask:g1');
    expect(r!.matte).toEqual({ mode: 'alpha', inverted: false, sourceId: 'src' });
  });

  it('routes the plugin’s own sprite image through the texture provider', () => {
    const [r] = scene([layer({
      generator: { ...FIELD, textureAssetKey: 'sprites/spark.png', pluginId: 'studio.sparks' },
    })]).renderables;
    // The PLUGIN is in the key: two plugins shipping `sprites/spark.png` are
    // two images, and one key for both would paint one into the other's layer.
    expect(r!.generator!.textureKey).toBe('pluginAsset:studio.sparks/sprites/spark.png');
  });

  it('draws untextured when the frame names a texture with no owner', () => {
    // A hand-built frame, or one produced before its plugin went away. There is
    // no package to resolve the path in, so the renderable carries no texture
    // key and the field falls back to points rather than to a key nothing can
    // answer.
    const [r] = scene([layer({ generator: { ...FIELD, textureAssetKey: 'sprites/spark.png' } })]).renderables;
    expect(r!.generator!.textureKey).toBeUndefined();
  });

  it('carries the comp lens when the adapter resolved one', () => {
    const [r] = scene([layer({ generatorPerspective: 1200 })]).renderables;
    expect(r!.generator!.perspective).toBe(1200);
    const [flat] = scene([layer()]).renderables;
    expect(flat!.generator!.perspective).toBeUndefined();
  });

  it('emits an EMPTY field as a renderable too, not as nothing', () => {
    const [r] = scene([layer({ generator: emptyGeneratorFrame({ width: 400, height: 300 }) })]).renderables;
    // Still a layer: it holds its place in the stack, still selects, and a
    // layer matted by it goes transparent rather than keeping a stale field.
    expect(r!.kind).toBe('image');
    expect(r!.generator!.count).toBe(0);
  });
});

describe('the 3D gate', () => {
  it('excludes a generator from the depth group, like a precomp', () => {
    const [r] = scene([layer()]).renderables;
    // Its field has to be rendered into an offscreen BEFORE anything can sample
    // it, and a pass cannot sample the target it is writing.
    expect(depthEligible3D({ ...r!, threeD: { model: new Array(16).fill(0) } })).toBe(false);
  });
});
