/**
 * A plugin's packaged sprite atlas, on the texture provider's own seam.
 *
 * The decode lives in `@core/plugins/pluginAssetTextures` and is pinned there;
 * this is the other half — that the decoded bitmap reaches the GPU through the
 * SAME route an externally decoded video frame takes (`setFrame`), under the
 * `pluginAsset:` key the snapshot adapter puts on the renderable, and that it is
 * released by the ordinary `retain` sweep when nothing names it any more.
 *
 * None of it needs a GPU: `NullBackend` records the uploads, and the claims are
 * about identity and lifetime rather than pixels.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider } from './AppTextureProvider';
import { pluginAssetTextureKey } from '@core/plugins/pluginAssetTextures';

class UploadRecorder extends NullBackend {
  uploads = 0;

  override writeTexture(
    texture: Parameters<NullBackend['writeTexture']>[0],
    source: Parameters<NullBackend['writeTexture']>[1],
  ): void {
    this.uploads += 1;
    super.writeTexture(texture, source);
  }
}

function setup(): { provider: AppTextureProvider; backend: UploadRecorder } {
  const backend = new UploadRecorder();
  const resources = new ResourceManager(backend);
  resources.beginFrame(1);
  return { provider: new AppTextureProvider(resources, {}), backend };
}

/** What the decode hands back — a bitmap in the real thing, its size here. */
const atlas = { width: 128, height: 128 } as unknown as ImageBitmap;

const KEY = pluginAssetTextureKey('studio.sparks', 'sprites/atlas.png');

describe('the packaged atlas rides the frame seam', () => {
  it('resolves under the key the snapshot adapter put on the renderable', () => {
    const { provider } = setup();
    // Before the decode lands the key is unknown, and the provider answers with
    // its placeholder — `ready: false`, which is what the generator pass reads
    // to fall back to untextured points.
    expect(provider.get(KEY)!.ready).toBe(false);

    provider.setFrame(KEY, atlas, 'pluginasset:1');
    expect(provider.get(KEY)!.ready).toBe(true);
  });

  it('uploads once per DECODE, not once per frame', () => {
    const { provider, backend } = setup();
    provider.setFrame(KEY, atlas, 'pluginasset:1');
    const after = backend.uploads;
    const texture = provider.get(KEY)!.texture.id;

    // Sixty frames of a paused viewport re-stating the same atlas.
    for (let frame = 0; frame < 60; frame++) provider.setFrame(KEY, atlas, 'pluginasset:1');
    expect(backend.uploads).toBe(after);
    expect(provider.get(KEY)!.texture.id).toBe(texture);

    // A developer-mode reload decodes again, and the new revision is what makes
    // the upload notice — without it the pre-edit atlas stays on the GPU, which
    // reads as the edit not having saved.
    provider.setFrame(KEY, atlas, 'pluginasset:2');
    expect(backend.uploads).toBe(after + 1);
  });

  it('is released by the ordinary retain sweep once no layer names it', () => {
    const { provider } = setup();
    provider.setFrame(KEY, atlas, 'pluginasset:1');
    expect(provider.get(KEY)!.ready).toBe(true);

    // The plugin was uninstalled, so the generator produces no frame, so the
    // key is not in this frame's active set. Nothing special about it: the same
    // sweep that frees a deleted layer's image frees this.
    provider.retain(new Set());
    expect(provider.get(KEY)!.ready).toBe(false);
  });
});
