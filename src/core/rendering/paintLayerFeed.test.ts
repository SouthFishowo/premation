/**
 * Paint on non-shape layers: the seams that used to drop it.
 *
 * Only the shape rasterizer drew `layer.paint`, so strokes recorded on image,
 * video and text layers never reached a texture. These pin the two places the
 * fix has to agree: the text raster's cache key must turn over when paint
 * changes (or the first raster is served forever), and a painted Frame Mix clip
 * must route to the `asset:` key its per-frame paint bake uploads — not to the
 * `vfa:`/`vfb:` keys nobody feeds for it.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider } from './AppTextureProvider';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import type { PaintConfig, PaintStroke } from '@core/paint/paintStrokes';

const stroke = (over: Partial<PaintStroke> = {}): PaintStroke => ({
  id: 'p1',
  points: [{ x: -10, y: 0 }, { x: 10, y: 0 }],
  color: '#00ff00',
  size: 8,
  opacity: 1,
  hardness: 1,
  mode: 'paint',
  ...over,
});

function provider(): AppTextureProvider {
  const resources = new ResourceManager(new NullBackend());
  resources.beginFrame(1);
  return new AppTextureProvider(resources, {});
}

describe('text raster carries paint', () => {
  const spec = { text: 'Hello', fontSize: 48, color: '#ffffff', width: 300, height: 80 };

  it('re-rasterizes when a stroke is added, and reuses while it is unchanged', () => {
    const p = provider();
    p.setText('text:t', spec);
    const bare = p.get('text:t')!.texture.id;
    const paint: PaintConfig = { strokes: [stroke()] };
    p.setText('text:t', { ...spec, paint });
    const painted = p.get('text:t')!.texture.id;
    expect(painted).not.toBe(bare);
    // A fresh config holding the same stroke objects is the same picture.
    p.setText('text:t', { ...spec, paint: { strokes: [...paint.strokes] } });
    expect(p.get('text:t')!.texture.id).toBe(painted);
  });
});

describe('a painted Frame Mix clip routes to its paint bake', () => {
  const video = (paint?: PaintConfig) => ({
    id: 'clip',
    kind: 'video',
    src: 'blob:clip',
    x: 400, y: 300, rotation: 0, scaleX: 1, scaleY: 1,
    width: 320, height: 180, opacity: 1, visible: true,
    frameBlend: { mode: 'mix', a: 0, b: 1 / 30, weight: 0.5 },
    ...(paint ? { paint } : {}),
  });
  const keysOf = (layer: ReturnType<typeof video>): string[] =>
    snapshotToFrameScene({ width: 800, height: 600, background: '#000000', layers: [layer] } as never)
      .renderables.map((r) => r.textureKey ?? '');

  it('unpainted keeps the two blend keys', () => {
    expect(keysOf(video())).toEqual(['vfa:clip', 'vfb:clip']);
  });

  it('painted draws once from asset:', () => {
    expect(keysOf(video({ strokes: [stroke()] }))).toEqual(['asset:clip']);
  });
});
