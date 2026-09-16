/**
 * A file inside a plugin's own package, as pixels the renderer can bind.
 *
 * ── What this closes ─────────────────────────────────────────────────────────
 *
 * A generator frame may name a `textureAssetKey` — `sprites/atlas.png` — and
 * until now nothing resolved it: the validator accepted the path, the snapshot
 * adapter built a `pluginAsset:…` texture key out of it, and no provider had
 * ever heard of that key. Every textured generator drew the untextured
 * fallback, forever, and the only trace was a comment in a harness scene.
 *
 * The missing half was a way to READ the file, which the local-install work
 * added (`PluginHost.readPackageFile`, behind `motion.package.read`). This is
 * the host's own use of the same route: the path is resolved inside the
 * installed payload and nowhere else, so a plugin naming a texture can reach
 * exactly what it shipped and nothing on the machine.
 *
 * ── One decode per (plugin, path) ────────────────────────────────────────────
 *
 * The cache is keyed on the plugin AND the path, never on the path alone: two
 * plugins shipping `sprites/atlas.png` are two different images, and a cache
 * that collapsed them would paint one plugin's art into another's layer. Every
 * layer and every frame that names the same file shares one `ImageBitmap` and
 * one GPU upload — a fifty-thousand-sprite system costs one decode for its
 * whole life, and ten layers of it still cost one.
 *
 * ── Why the bitmaps must be closed, and who closes them ──────────────────────
 *
 * An `ImageBitmap`'s pixels are off-heap and are not reclaimed by GC in any
 * timely way, so a dropped bitmap holds its full decoded size until the page
 * unloads. This module owns every bitmap it creates and is the only thing that
 * closes them: the texture provider is handed the bitmap for an upload and
 * explicitly does not retain it (see `AppTextureProvider.setFrame`). Eviction
 * happens on a plugin going away, on the cache's own ceiling, and on teardown —
 * and a `revision` on each decode is what makes the upload notice.
 *
 * ── Nothing is imported from the app graph ───────────────────────────────────
 *
 * The package bytes arrive through an injected host, the way the generator
 * scheduler's runner does and for the same reason: this module is reached from
 * the render path, which also runs in the golden harness and the export worker,
 * neither of which has a plugin store. `PluginHost` installs the real one; the
 * harness installs its own.
 */

/** The texture-key namespace. One string, quoted by the snapshot adapter. */
export const PLUGIN_ASSET_PREFIX = 'pluginAsset:';

/**
 * The provider key a packaged file is registered under.
 *
 * The plugin id is IN the key rather than beside it, because the key is all the
 * renderer carries — `Renderable.generator.textureKey` is a string, and a key
 * that named only the path would have two plugins' atlases fighting over one
 * entry in the provider's map.
 */
export function pluginAssetTextureKey(pluginId: string, path: string): string {
  return `${PLUGIN_ASSET_PREFIX}${pluginId}/${path}`;
}

/** Split a key built by `pluginAssetTextureKey`, or null for anything else. */
export function parsePluginAssetTextureKey(
  key: string,
): { pluginId: string; path: string } | null {
  if (!key.startsWith(PLUGIN_ASSET_PREFIX)) return null;
  const rest = key.slice(PLUGIN_ASSET_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { pluginId: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/** How the bytes are fetched, and where a failure is reported. */
export interface PluginAssetHost {
  /**
   * One file out of the plugin's INSTALLED payload, or null when it holds no
   * such file. Never a filesystem path — see `PluginHost.readPackageFile`.
   */
  read(pluginId: string, path: string): Promise<Uint8Array | string | null>;
  /** Appended to that plugin's own log, which is where a user looks. */
  log?(pluginId: string, message: string): void;
}

let host: PluginAssetHost | null = null;

/** Install the route to the installed payloads. */
export function setPluginAssetHost(next: PluginAssetHost | null): void {
  host = next;
}

/** A decoded packaged image, ready to upload. */
export interface PluginAssetImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /**
   * Bumped on every decode, so an upload keyed on it re-uploads after a plugin
   * reload. Without it a developer editing `atlas.png` and reloading the folder
   * plugin would keep seeing the texture the app decoded at startup — the
   * stale-after-reload bug, which looks exactly like the edit not saving.
   */
  revision: number;
}

/**
 * Longest edge a packaged texture may have.
 *
 * The GPU's own limit can be as low as 4096 on WebGL2, and a texture over it
 * fails to allocate rather than degrading — so this is the smallest guaranteed
 * ceiling, applied to the DECODED size. A 200-byte PNG can declare 30000×30000;
 * the header is the part the plugin controls.
 */
export const MAX_PLUGIN_TEXTURE_DIMENSION = 4096;

/** Decoded bytes held across every cached packaged texture. */
export const MAX_PLUGIN_TEXTURE_BYTES = 64 * 1024 * 1024;

/** Cached packaged textures, whatever their size. */
export const MAX_PLUGIN_TEXTURES = 16;

interface Entry {
  pluginId: string;
  path: string;
  image: PluginAssetImage | null;
  /** The decode in flight, or null. Awaited by export; never by preview. */
  pending: Promise<void> | null;
  /** Why this file will never decode. Set once, reported once. */
  failure: string | null;
  /** Decoded bytes, for the budget. Zero until it lands. */
  bytes: number;
  /** Monotonic touch order — the cache's LRU. */
  used: number;
  /** Fired once when a decode lands, so the viewport repaints. */
  waiting: Set<() => void>;
}

const entries = new Map<string, Entry>();
let revisionSeq = 0;
let useSeq = 0;
let heldBytes = 0;

/**
 * The decoded image for a packaged file, or null while it is not there yet.
 *
 * SYNCHRONOUS, because the render path is: `requestGeneratorFrame` cannot wait
 * and neither can the texture feed that follows it. The first call starts the
 * decode and returns null; `onReady` fires when it lands, and the caller turns
 * that into a repaint. Until then the sprite path draws its untextured
 * fallback — a particle system that is grey for a frame while its atlas decodes
 * is a far better failure than one that is empty and reads as broken.
 *
 * Null is also the permanent answer for a file that will not decode. The
 * failure is named in the plugin's log once, not once per frame.
 */
export function requestPluginAssetTexture(
  pluginId: string,
  path: string,
  onReady?: () => void,
): PluginAssetImage | null {
  const key = pluginAssetTextureKey(pluginId, path);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      pluginId,
      path,
      image: null,
      pending: null,
      failure: null,
      bytes: 0,
      used: 0,
      waiting: new Set(),
    };
    entries.set(key, entry);
  }
  entry.used = ++useSeq;
  if (entry.failure !== null) return null;
  if (entry.image) return entry.image;
  if (onReady) entry.waiting.add(onReady);
  if (!entry.pending) entry.pending = decodeInto(key, entry);
  return null;
}

/**
 * Decodes still in flight, as promises that never reject.
 *
 * The export convergence loop takes these alongside the video waits: a
 * deliverable that shipped untextured sprites because a PNG had not finished
 * decoding would be wrong in a file, silently, and wrong pixels in a file are
 * not recoverable.
 */
export function pluginAssetWaits(): Promise<void>[] {
  const out: Promise<void>[] = [];
  for (const entry of entries.values()) {
    if (entry.pending) out.push(entry.pending);
  }
  return out;
}

/** Why this packaged file will never draw, or null. */
export function pluginAssetFailure(pluginId: string, path: string): string | null {
  return entries.get(pluginAssetTextureKey(pluginId, path))?.failure ?? null;
}

/**
 * Forget one plugin's decoded textures — or, with no argument, all of them.
 *
 * Called when a plugin is uninstalled, disabled or re-registered (which is what
 * a developer-mode folder reload does). Holding the bitmaps would mean a
 * plugin that is gone still painting, and — worse for the person it happens to
 * — a plugin that was RELOADED still painting the image it shipped before the
 * edit.
 */
export function forgetPluginAssetTextures(pluginId?: string): void {
  for (const [key, entry] of [...entries]) {
    if (pluginId !== undefined && entry.pluginId !== pluginId) continue;
    release(entry);
    entries.delete(key);
  }
}

/** Test seam. Drops the cache AND the injected host. */
export function resetPluginAssetTexturesForTests(): void {
  forgetPluginAssetTextures();
  host = null;
  revisionSeq = 0;
  useSeq = 0;
  heldBytes = 0;
}

function release(entry: Entry): void {
  const bitmap = entry.image?.bitmap;
  if (bitmap && typeof bitmap.close === 'function') {
    try {
      bitmap.close();
    } catch {
      /* already closed */
    }
  }
  heldBytes -= entry.bytes;
  entry.bytes = 0;
  entry.image = null;
  entry.waiting.clear();
}

/**
 * Decode one file, and never throw.
 *
 * The promise is what export awaits, so it has to settle whatever happens —
 * a rejection here would take the convergence loop with it and turn "this
 * plugin shipped a corrupt PNG" into "the export crashed".
 */
async function decodeInto(key: string, entry: Entry): Promise<void> {
  try {
    const image = await decodeOne(entry.pluginId, entry.path);
    // The entry may have been evicted (plugin uninstalled) while we decoded;
    // the bitmap is then ours to close and nobody's to draw.
    if (entries.get(key) !== entry) {
      if (typeof image.bitmap.close === 'function') image.bitmap.close();
      return;
    }
    entry.image = image;
    entry.bytes = image.width * image.height * 4;
    heldBytes += entry.bytes;
    evictToBudget(entry);
  } catch (err) {
    fail(entry, err instanceof Error ? err.message : String(err));
  } finally {
    entry.pending = null;
    const waiting = [...entry.waiting];
    entry.waiting.clear();
    for (const fn of waiting) fn();
  }
}

async function decodeOne(pluginId: string, path: string): Promise<PluginAssetImage> {
  if (!host) throw new Error('this host cannot read plugin package files.');
  if (typeof createImageBitmap !== 'function') {
    throw new Error('this build cannot decode images.');
  }
  const raw = await host.read(pluginId, path);
  if (raw === null || raw === undefined) {
    throw new Error(`"${path}" is not in this plugin's package.`);
  }
  // A text file asked for as an image: `.svg` is stored as markup and is the
  // one that legitimately arrives this way, so it is encoded rather than
  // refused — `createImageBitmap` decides whether it is a picture.
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  // No object URL: a Blob goes straight to the decoder, and a URL that has to
  // be revoked is a leak waiting for the one early return that forgets to.
  const blob = new Blob([bytes as BlobPart]);
  // THE ALPHA INVARIANT: textures hold premultiplied alpha, and the decode is
  // the only boundary that governs it on both backends (see `decodeOptions` in
  // AppTextureProvider). A packaged sprite is an ordinary straight-alpha file.
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
  const width = bitmap.width;
  const height = bitmap.height;
  if (width < 1 || height < 1) {
    if (typeof bitmap.close === 'function') bitmap.close();
    throw new Error(`"${path}" decoded to an empty image.`);
  }
  if (width > MAX_PLUGIN_TEXTURE_DIMENSION || height > MAX_PLUGIN_TEXTURE_DIMENSION) {
    if (typeof bitmap.close === 'function') bitmap.close();
    throw new Error(
      `"${path}" is ${width}×${height}; a package texture may be at most `
      + `${MAX_PLUGIN_TEXTURE_DIMENSION} px on a side.`,
    );
  }
  return { bitmap, width, height, revision: ++revisionSeq };
}

/**
 * Hold the cache to its ceilings, never dropping the entry just decoded.
 *
 * Evicting the newest would put the cache in a loop: the layer asks again next
 * frame, decodes again, evicts again, and the "one decode per file" promise
 * becomes one decode per frame with a GPU re-upload behind it.
 */
function evictToBudget(keep: Entry): void {
  for (;;) {
    let live = 0;
    for (const entry of entries.values()) if (entry.image) live += 1;
    if (live <= MAX_PLUGIN_TEXTURES && heldBytes <= MAX_PLUGIN_TEXTURE_BYTES) return;
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, entry] of entries) {
      if (entry === keep || !entry.image || entry.used >= oldest) continue;
      oldest = entry.used;
      oldestKey = key;
    }
    if (oldestKey === null) return;
    release(entries.get(oldestKey)!);
    entries.delete(oldestKey);
  }
}

/**
 * Record a permanent failure and say so once, in the plugin's own log.
 *
 * Once, because a generator names its texture on every frame it produces: the
 * sixtieth copy of a sentence tells nobody anything the first did not, and a
 * log that fills at frame rate is a log nobody can read.
 */
function fail(entry: Entry, message: string): void {
  if (entry.failure !== null) return;
  entry.failure = message;
  host?.log?.(entry.pluginId, `texture "${entry.path}" could not be loaded — ${message}`);
}
