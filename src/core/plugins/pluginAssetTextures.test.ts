/**
 * A plugin's packaged image, from the installed payload to a decoded bitmap.
 *
 * Every claim here is one that fails SILENTLY when it regresses — a sprite that
 * draws untextured, an atlas that stays the one decoded at startup, a log that
 * fills at frame rate — so each is pinned rather than left to a golden that
 * would only say "the picture changed".
 */

import {
  MAX_PLUGIN_TEXTURES,
  forgetPluginAssetTextures,
  parsePluginAssetTextureKey,
  pluginAssetFailure,
  pluginAssetTextureKey,
  pluginAssetWaits,
  requestPluginAssetTexture,
  resetPluginAssetTexturesForTests,
  setPluginAssetHost,
} from './pluginAssetTextures';

/** A stand-in ImageBitmap that can say whether it was closed. */
interface FakeBitmap {
  width: number;
  height: number;
  closed: boolean;
  close(): void;
}

let decoded: FakeBitmap[] = [];
let decodeSize = { width: 8, height: 8 };

/**
 * The stand-in decoder reads the blob's SIZE, not its bytes — jsdom's `Blob`
 * has no `arrayBuffer()`. A one-byte payload is the corrupt file.
 */
const CORRUPT_BYTES = new Uint8Array([0xff]);

const realCreateImageBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;

beforeEach(() => {
  decoded = [];
  decodeSize = { width: 8, height: 8 };
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async (blob: Blob) => {
    if (blob.size === CORRUPT_BYTES.length) throw new Error('not a picture');
    const bitmap: FakeBitmap = {
      width: decodeSize.width,
      height: decodeSize.height,
      closed: false,
      close() { this.closed = true; },
    };
    decoded.push(bitmap);
    return bitmap as unknown as ImageBitmap;
  };
});

afterEach(() => {
  resetPluginAssetTexturesForTests();
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = realCreateImageBitmap;
});

/** A host serving one file per plugin, counting reads and collecting log lines. */
function host(files: Record<string, Uint8Array>) {
  const reads: string[] = [];
  const logs: Array<{ pluginId: string; message: string }> = [];
  setPluginAssetHost({
    read: async (pluginId, path) => {
      reads.push(`${pluginId}/${path}`);
      return files[`${pluginId}/${path}`] ?? null;
    },
    log: (pluginId, message) => { logs.push({ pluginId, message }); },
  });
  return { reads, logs };
}

/** Let every queued decode settle, the way the export convergence loop does. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    const waits = pluginAssetWaits();
    if (waits.length === 0) return;
    await Promise.all(waits);
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('the texture key', () => {
  it('names the plugin as well as the path', () => {
    // Two plugins shipping the same file name are two images. A key on the path
    // alone would have one painting the other's sprites.
    expect(pluginAssetTextureKey('a.b', 'sprites/atlas.png'))
      .toBe('pluginAsset:a.b/sprites/atlas.png');
    expect(pluginAssetTextureKey('a.c', 'sprites/atlas.png'))
      .not.toBe(pluginAssetTextureKey('a.b', 'sprites/atlas.png'));
  });

  it('round-trips, and refuses anything that is not one of ours', () => {
    expect(parsePluginAssetTextureKey('pluginAsset:a.b/sprites/atlas.png'))
      .toEqual({ pluginId: 'a.b', path: 'sprites/atlas.png' });
    expect(parsePluginAssetTextureKey('asset:layer1')).toBeNull();
    expect(parsePluginAssetTextureKey('pluginAsset:a.b')).toBeNull();
    expect(parsePluginAssetTextureKey('pluginAsset:a.b/')).toBeNull();
  });
});

describe('resolution', () => {
  it('reads the file out of the plugin package and decodes it', async () => {
    const h = host({ 'a.b/sprites/atlas.png': PNG });
    expect(requestPluginAssetTexture('a.b', 'sprites/atlas.png')).toBeNull();
    await settle();
    const image = requestPluginAssetTexture('a.b', 'sprites/atlas.png');
    expect(image).not.toBeNull();
    expect(image!.width).toBe(8);
    expect(h.reads).toEqual(['a.b/sprites/atlas.png']);
  });

  it('draws the untextured fallback while the decode is in flight', () => {
    host({ 'a.b/x.png': PNG });
    // The render path is synchronous; "not yet" is null, never a wait.
    expect(requestPluginAssetTexture('a.b', 'x.png')).toBeNull();
    expect(requestPluginAssetTexture('a.b', 'x.png')).toBeNull();
  });

  it('upgrades the moment the decode lands, and says so once', async () => {
    host({ 'a.b/x.png': PNG });
    const ready = jest.fn();
    requestPluginAssetTexture('a.b', 'x.png', ready);
    requestPluginAssetTexture('a.b', 'x.png', ready);
    expect(ready).not.toHaveBeenCalled();
    await settle();
    // The same callback registered twice is one repaint, not two.
    expect(ready).toHaveBeenCalledTimes(1);
    expect(requestPluginAssetTexture('a.b', 'x.png')).not.toBeNull();
  });
});

describe('caching', () => {
  it('decodes once for every layer and every frame that names the file', async () => {
    const h = host({ 'a.b/x.png': PNG });
    requestPluginAssetTexture('a.b', 'x.png');
    requestPluginAssetTexture('a.b', 'x.png');
    await settle();
    for (let frame = 0; frame < 60; frame++) requestPluginAssetTexture('a.b', 'x.png');
    expect(h.reads).toHaveLength(1);
    expect(decoded).toHaveLength(1);
  });

  it('keeps two plugins’ same-named files apart', async () => {
    const h = host({ 'a.b/x.png': PNG, 'a.c/x.png': PNG });
    requestPluginAssetTexture('a.b', 'x.png');
    requestPluginAssetTexture('a.c', 'x.png');
    await settle();
    expect(h.reads.sort()).toEqual(['a.b/x.png', 'a.c/x.png']);
    expect(requestPluginAssetTexture('a.b', 'x.png'))
      .not.toBe(requestPluginAssetTexture('a.c', 'x.png'));
  });

  it('bounds the cache and closes what it drops', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_PLUGIN_TEXTURES; i++) files[`a.b/${i}.png`] = PNG;
    host(files);
    for (let i = 0; i <= MAX_PLUGIN_TEXTURES; i++) {
      requestPluginAssetTexture('a.b', `${i}.png`);
      // Settled one at a time so `used` is a true LRU order rather than a tie.
      await settle();
    }
    expect(decoded).toHaveLength(MAX_PLUGIN_TEXTURES + 1);
    // The least recently used one went, and its off-heap pixels went with it.
    expect(decoded[0]!.closed).toBe(true);
    expect(decoded[MAX_PLUGIN_TEXTURES]!.closed).toBe(false);
  });
});

describe('eviction', () => {
  it('drops one plugin’s textures on uninstall, and closes their bitmaps', async () => {
    host({ 'a.b/x.png': PNG, 'a.c/x.png': PNG });
    requestPluginAssetTexture('a.b', 'x.png');
    requestPluginAssetTexture('a.c', 'x.png');
    await settle();
    forgetPluginAssetTextures('a.b');
    expect(decoded[0]!.closed).toBe(true);
    expect(decoded[1]!.closed).toBe(false);
    // The other plugin is untouched — still there, still the same bitmap.
    expect(requestPluginAssetTexture('a.c', 'x.png')).not.toBeNull();
  });

  it('re-reads after a reload, and the new decode has a NEW revision', async () => {
    const h = host({ 'a.b/x.png': PNG });
    requestPluginAssetTexture('a.b', 'x.png');
    await settle();
    const before = requestPluginAssetTexture('a.b', 'x.png')!;

    // What a developer-mode folder reload does: the plugin is unregistered and
    // registered again, so its cached pixels go.
    forgetPluginAssetTextures('a.b');
    requestPluginAssetTexture('a.b', 'x.png');
    await settle();
    const after = requestPluginAssetTexture('a.b', 'x.png')!;

    expect(h.reads).toHaveLength(2);
    // The revision is what the GPU upload is keyed on — equal revisions would
    // leave the pre-edit atlas on screen, which reads as the edit not saving.
    expect(after.revision).not.toBe(before.revision);
  });

  it('closes a decode that landed after its plugin went away', async () => {
    host({ 'a.b/x.png': PNG });
    requestPluginAssetTexture('a.b', 'x.png');
    forgetPluginAssetTextures('a.b');
    // Not through `settle`: an evicted entry is no longer a wait anybody has —
    // an export must not block on a plugin that has gone away. The orphaned
    // decode still has to close what it produced, so drain the microtasks.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.closed).toBe(true);
  });
});

describe('export awaits the decode', () => {
  it('reports the decode as an outstanding wait until it lands', async () => {
    host({ 'a.b/x.png': PNG });
    requestPluginAssetTexture('a.b', 'x.png');
    expect(pluginAssetWaits()).toHaveLength(1);
    await settle();
    // Settled work is not re-awaited — otherwise the convergence loop would
    // never see an empty list and would spend every pass it has.
    expect(pluginAssetWaits()).toHaveLength(0);
  });

  it('settles a FAILED decode too, rather than leaving the loop hanging', async () => {
    host({ 'a.b/bad.png': CORRUPT_BYTES });
    requestPluginAssetTexture('a.b', 'bad.png');
    await settle();
    expect(pluginAssetWaits()).toHaveLength(0);
  });

  it('tells "still decoding" apart from "will never decode"', async () => {
    /*
      The distinction the export gate turns on. A frame whose texture is still
      decoding is NOT exact and must not be encoded; a frame whose texture will
      never decode is as good as it will ever get, and marking it inexact would
      refuse every export for ever over one missing file — with a message about
      video decoding, which is where the user would then go looking.
    */
    host({ 'a.b/bad.png': CORRUPT_BYTES });
    requestPluginAssetTexture('a.b', 'bad.png');
    expect(pluginAssetFailure('a.b', 'bad.png')).toBeNull();
    await settle();
    expect(pluginAssetFailure('a.b', 'bad.png')).not.toBeNull();
  });
});

describe('failures', () => {
  it('names a missing file in the plugin’s own log, exactly once', async () => {
    const h = host({});
    requestPluginAssetTexture('a.b', 'sprites/atlas.png');
    await settle();
    // A generator names its texture on every frame it produces, so "once" is
    // the whole claim: the second copy of the sentence tells nobody anything.
    for (let frame = 0; frame < 60; frame++) {
      expect(requestPluginAssetTexture('a.b', 'sprites/atlas.png')).toBeNull();
    }
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.pluginId).toBe('a.b');
    expect(h.logs[0]!.message).toContain('sprites/atlas.png');
    expect(pluginAssetFailure('a.b', 'sprites/atlas.png')).toContain('not in this plugin');
  });

  it('names a corrupt image, and never retries it', async () => {
    const h = host({ 'a.b/bad.png': CORRUPT_BYTES });
    requestPluginAssetTexture('a.b', 'bad.png');
    await settle();
    requestPluginAssetTexture('a.b', 'bad.png');
    await settle();
    expect(h.reads).toHaveLength(1);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.message).toContain('not a picture');
  });

  it('refuses an image past the guaranteed GPU limit, and closes it', async () => {
    const h = host({ 'a.b/huge.png': PNG });
    decodeSize = { width: 8192, height: 8 };
    requestPluginAssetTexture('a.b', 'huge.png');
    await settle();
    expect(requestPluginAssetTexture('a.b', 'huge.png')).toBeNull();
    expect(decoded[0]!.closed).toBe(true);
    expect(h.logs[0]!.message).toMatch(/8192×8/);
  });

  it('is a named failure, not a throw, when no host is installed', async () => {
    setPluginAssetHost(null);
    requestPluginAssetTexture('a.b', 'x.png');
    await settle();
    expect(pluginAssetFailure('a.b', 'x.png')).toMatch(/cannot read plugin package files/);
  });
});
