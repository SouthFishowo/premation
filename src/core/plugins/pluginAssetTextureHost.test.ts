/**
 * The wiring between a real installed plugin and the packaged-texture cache.
 *
 * `pluginAssetTextures.test.ts` drives the cache through a stub host, which
 * proves the caching and the eviction RULES and nothing about whether anything
 * ever installs the real host or calls the eviction. Those are the two lines
 * that quietly do not exist when a feature ships broken, so they are pinned
 * here against the actual `PluginHost`.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useSelectionStore } from '@stores/selectionStore';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { FakeWorker, useFakeWorkers, testPackage, bootPlugin } from './fakeWorker.testkit';
import {
  forgetPluginAssetTextures,
  pluginAssetFailure,
  pluginAssetWaits,
  requestPluginAssetTexture,
} from './pluginAssetTextures';
import type { PluginPackage } from './pluginPackage';

const ATLAS = 'sprites/atlas.png';
const PLUGIN = 'com.test.plugin';

/** A package that ships one image, the way a sprite generator's would. */
function withAtlas(bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])): PluginPackage {
  const base = testPackage([]);
  return { ...base, binaries: { [ATLAS]: bytes } };
}

let decodes = 0;
const realCreateImageBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;

beforeAll(async () => {
  seedDefaultScene();
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  pluginHost.configure({
    getSelection: () => useSelectionStore.getState().ids,
    showPanel: () => {},
    hidePanel: () => {},
  });
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => {
    decodes += 1;
    return { width: 16, height: 16, close() {} } as unknown as ImageBitmap;
  };
});

afterAll(() => {
  pluginHost.setWorkerFactory(null);
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = realCreateImageBitmap;
});

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  // Not `resetPluginAssetTexturesForTests` — that would drop the host the
  // module under test installs at import, which is half of what is being tested.
  forgetPluginAssetTextures();
  FakeWorker.last = null;
  decodes = 0;
});

const settle = async (): Promise<void> => {
  for (let pass = 0; pass < 4; pass++) {
    const waits = pluginAssetWaits();
    if (waits.length === 0) return;
    await Promise.all(waits);
  }
};

describe('the host is wired to the installed payload', () => {
  it('resolves a packaged image through the same route package.read takes', async () => {
    bootPlugin(withAtlas());
    expect(requestPluginAssetTexture(PLUGIN, ATLAS)).toBeNull();
    await settle();
    expect(requestPluginAssetTexture(PLUGIN, ATLAS)).not.toBeNull();
    expect(decodes).toBe(1);
  });

  it('names a file the package does not hold, in that plugin’s own log', async () => {
    bootPlugin(withAtlas());
    requestPluginAssetTexture(PLUGIN, 'sprites/missing.png');
    await settle();
    expect(pluginAssetFailure(PLUGIN, 'sprites/missing.png')).not.toBeNull();
    const log = pluginHost.log(PLUGIN);
    const line = log.filter((l) => l.text.includes('sprites/missing.png'));
    expect(line).toHaveLength(1);
    expect(line[0]!.level).toBe('error');
  });

  it('cannot be talked into reaching outside the package', async () => {
    bootPlugin(withAtlas());
    // `..` folds away in `normalizePath` and the folded path names nothing in
    // the record — a miss, not an escape. Same containment `package.read` has.
    requestPluginAssetTexture(PLUGIN, '../../secrets.png');
    await settle();
    expect(pluginAssetFailure(PLUGIN, '../../secrets.png')).not.toBeNull();
  });
});

describe('a plugin going away takes its textures with it', () => {
  it('drops them on uninstall, so nothing keeps painting from a package that is gone', async () => {
    bootPlugin(withAtlas());
    requestPluginAssetTexture(PLUGIN, ATLAS);
    await settle();
    expect(requestPluginAssetTexture(PLUGIN, ATLAS)).not.toBeNull();

    pluginHost.uninstall(PLUGIN);
    // Not merely "a stale bitmap is still returned": the cache is empty, so the
    // next ask goes back to a payload that no longer exists and fails.
    expect(requestPluginAssetTexture(PLUGIN, ATLAS)).toBeNull();
    await settle();
    expect(pluginAssetFailure(PLUGIN, ATLAS)).not.toBeNull();
  });

  it('re-reads after a reinstall, which is what a developer-mode reload is', async () => {
    bootPlugin(withAtlas());
    requestPluginAssetTexture(PLUGIN, ATLAS);
    await settle();
    const before = requestPluginAssetTexture(PLUGIN, ATLAS)!;

    // The same id installed again — the edit-and-reload loop. Re-registering
    // unregisters first, which is where the eviction hangs.
    bootPlugin(withAtlas(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])));
    requestPluginAssetTexture(PLUGIN, ATLAS);
    await settle();
    const after = requestPluginAssetTexture(PLUGIN, ATLAS)!;

    expect(decodes).toBe(2);
    // The revision is what the GPU upload keys on. Equal revisions would leave
    // the pre-edit atlas on screen — the stale-after-reload bug.
    expect(after.revision).not.toBe(before.revision);
  });
});
