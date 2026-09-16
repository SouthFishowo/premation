/**
 * The vector-raster fast path (`RasterReuse` in AppTextureProvider): a
 * `setText` / `setPath` call whose inputs are provably unchanged re-serves the
 * texture without rebuilding its signature — and ANY input that would have
 * changed the signature must still produce a new raster.
 *
 * Measured through the pool: every distinct raster is one `raster:` texture
 * created on the backend, so "reused" = no new texture, "invalidated" = one.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider, type TextSpec } from './AppTextureProvider';
import type { RenderLayer } from './RenderBackend';

class CountingBackend extends NullBackend {
  readonly created: string[] = [];
  override createTexture(desc: Parameters<NullBackend['createTexture']>[0]): ReturnType<NullBackend['createTexture']> {
    this.created.push(String((desc as { label?: string }).label ?? ''));
    return super.createTexture(desc);
  }
}

function setup(): { provider: AppTextureProvider; rasters: () => number; signatureOf: (k: string) => string | undefined } {
  const backend = new CountingBackend();
  const resources = new ResourceManager(backend);
  resources.beginFrame(1);
  const provider = new AppTextureProvider(resources, {});
  const internals = provider as unknown as {
    textEntries: Map<string, { signature: string }>;
    pathEntries: Map<string, { signature: string }>;
  };
  return {
    provider,
    rasters: () => backend.created.filter((l) => l.startsWith('raster:')).length,
    signatureOf: (k) => internals.textEntries.get(k)?.signature ?? internals.pathEntries.get(k)?.signature,
  };
}

const TEXT: TextSpec = { text: 'Hello', fontSize: 32, color: '#ffffff', width: 120, height: 48 };

describe('text raster reuse', () => {
  it('re-serves an unchanged text without a new raster, and keeps the same signature', () => {
    const { provider, rasters, signatureOf } = setup();
    provider.setText('text:a', { ...TEXT }, 'h1');
    const sig = signatureOf('text:a');
    const hits = provider.rasterStats().hits;
    expect(rasters()).toBe(1);
    // A NEW spec object with the same values — what a rebuilt snapshot hands over.
    provider.setText('text:a', { ...TEXT }, 'h1');
    provider.setText('text:a', { ...TEXT }, 'h1');
    expect(rasters()).toBe(1);
    expect(signatureOf('text:a')).toBe(sig);
    // The skipped rasterize still counts as the cache hit it is.
    expect(provider.rasterStats().hits).toBe(hits + 2);
  });

  it.each<[string, Partial<TextSpec>]>([
    ['text', { text: 'Hellp' }],
    ['fill opacity (not in the content hash)', { fillOpacity: 0.5 }],
    ['font width axis (not in the content hash)', { fontWidth: 120 }],
    ['baseline shift', { baselineShift: 4 }],
    ['text stroke width', { textStrokeWidth: 2 }],
    ['box size', { width: 121 }],
  ])('a changed %s makes a new raster even under the same content hash', (_label, patch) => {
    const { provider, rasters } = setup();
    provider.setText('text:a', { ...TEXT }, 'h1');
    provider.setText('text:a', { ...TEXT, ...patch }, 'h1');
    expect(rasters()).toBe(2);
  });

  it('a changed content hash (runs, glyphs, extras…) makes a new raster', () => {
    const { provider, rasters } = setup();
    provider.setText('text:a', { ...TEXT }, 'h1');
    // The object fields sign through the hash: same scalars, new digest, new
    // runs — the full signature must be rebuilt and differ.
    provider.setText('text:a', { ...TEXT, runs: [{ start: 0, end: 2, style: { fontWeight: '900' } }] as never }, 'h2');
    expect(rasters()).toBe(2);
  });

  it('a scale change that crosses a resolution tier makes a new raster', () => {
    const { provider, rasters } = setup();
    provider.setText('text:a', { ...TEXT }, 'h1');
    provider.setText('text:a', { ...TEXT, scaleX: 3, scaleY: 3 }, 'h1');
    expect(rasters()).toBe(2);
  });

  it('without a content hash every call takes the full path (and still dedupes by signature)', () => {
    const { provider, rasters } = setup();
    provider.setText('text:a', { ...TEXT });
    provider.setText('text:a', { ...TEXT });
    expect(rasters()).toBe(1);
    provider.setText('text:a', { ...TEXT, runs: [{ start: 0, end: 2, style: { fontWeight: '900' } }] as never });
    expect(rasters()).toBe(2);
  });
});

function shape(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 's', kind: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, depth: 0, opacity: 1,
    width: 100, height: 60, visible: true, fill: '#ff0000', primitive: 'path',
    pathPoints: [
      { x: -50, y: -30, inX: -50, inY: -30, outX: -50, outY: -30 },
      { x: 50, y: -30, inX: 50, inY: -30, outX: 50, outY: -30 },
      { x: 0, y: 30, inX: 0, inY: 30, outX: 0, outY: 30 },
    ],
    contentHash: 'p1',
    ...over,
  } as RenderLayer;
}

describe('path raster reuse', () => {
  it('re-serves an unchanged path', () => {
    const { provider, rasters, signatureOf } = setup();
    provider.setPath('path:s', shape());
    const sig = signatureOf('path:s');
    provider.setPath('path:s', shape({ x: 40, rotation: 12 })); // transform-only
    expect(rasters()).toBe(1);
    expect(signatureOf('path:s')).toBe(sig);
  });

  it.each<[string, Partial<RenderLayer>]>([
    ['box (a derived face inheriting its source hash)', { width: 90 }],
    ['fill opacity', { fillOpacity: 0.4 }],
    ['fill', { fill: '#00ff00' }],
    ['stroke', { stroke: { enabled: true, width: 3, color: '#000', align: 'center', opacity: 1, dash: [] } as never }],
    ['content hash', { contentHash: 'p2' }],
  ])('a changed %s makes a new raster', (_label, patch) => {
    const { provider, rasters } = setup();
    provider.setPath('path:s', shape());
    provider.setPath('path:s', shape(patch));
    expect(rasters()).toBe(2);
  });

  it('a CPU-baked layer never takes the fast path, so its effect params still sign the key', () => {
    const { provider, rasters } = setup();
    // Fill opacity < 1 routes the layer through the bake; its effect stack then
    // carries post-hash entries the content hash cannot vouch for.
    provider.setPath('path:s', shape({ fillOpacity: 0.5 }));
    provider.setPath('path:s', shape({ fillOpacity: 0.5 }));
    expect(rasters()).toBe(1);
    const internals = provider as unknown as { pathEntries: Map<string, { reuse?: unknown }> };
    expect(internals.pathEntries.get('path:s')?.reuse).toBeUndefined();
  });
});
