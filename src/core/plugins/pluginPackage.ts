/**
 * Reading a plugin package — the only thing that turns bytes on disk into
 * something installable.
 *
 * Two shapes are accepted because they are the two shapes that actually exist:
 * a **`.zip`/`.mplugin` archive** (what a user downloads) and a **folder** (what
 * an author is working in). Both reduce to the same thing: a map of
 * package-relative paths to text, with `plugin.json` at the root.
 *
 * Nothing here executes anything. The manifest is parsed and validated first,
 * precisely so the manager can show the user what a package claims and what it
 * wants BEFORE any of its code is handed to a sandbox.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { parseManifest, type PluginManifest } from './manifest';

/** A plugin package that parsed and validated. */
export interface PluginPackage {
  manifest: PluginManifest;
  /** Package-relative path → file text. Entry module and panels included. */
  files: Record<string, string>;
  /**
   * Package-relative path → raw bytes, for the media a package may now ship.
   *
   * Separate from `files` rather than a union type, because every existing
   * reader of `files` wants text and would otherwise have to start narrowing.
   * Empty for the overwhelming majority of packages.
   */
  binaries: Record<string, Uint8Array>;
}

export interface PackageResult {
  pkg: PluginPackage | null;
  errors: string[];
}

/**
 * Per-file and total size ceilings.
 *
 * A plugin is source code, not an asset library — a package in the megabytes is
 * either a mistake or an attempt to fill the user's storage quota, and installed
 * packages are persisted, so the ceiling is what keeps a bad one from taking the
 * whole `localStorage` budget with it.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;

/** The three ceilings, as one thing a caller can pass. */
export interface PackageLimits {
  maxFileBytes: number;
  maxPackageBytes: number;
  maxFiles: number;
}

/**
 * What a package downloaded from the registry may be. The default everywhere.
 *
 * Unchanged from the numbers above, which are kept as named exports because
 * several surfaces quote them in copy.
 */
export const REGISTRY_LIMITS: PackageLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxPackageBytes: MAX_PACKAGE_BYTES,
  maxFiles: MAX_FILES,
};

/**
 * What a package the user put on their own disk may be.
 *
 * ── Why the two tiers differ by 64× ──────────────────────────────────────────
 *
 * The registry ceiling is not a statement about how big a plugin can reasonably
 * be. It bounds what an ANONYMOUS PUBLISHER can push into a user's browser
 * storage over the network, in a quota shared with the account token — so it is
 * deliberately mean.
 *
 * A folder under `…/Plugins` is a different proposition: the user, or the
 * machine's administrator, put it there, and what makes a plugin more than a
 * script is exactly the things that do not fit in 2 MB — a segmentation model,
 * a set of LUTs, a font, a mesh library compiled to WebAssembly. Holding those
 * to the registry's number would refuse the packages this tier exists for, and
 * would push authors back to base64-in-a-.js, which is the same bytes plus 33%
 * with no size check at all.
 *
 * Mirrored in `electron/pluginLoader.ts`, which applies the same numbers while
 * READING, before any of it is in memory. Both are needed: that one stops the
 * app dying on a mis-set search path, this one is the check that runs over
 * whatever actually arrived.
 */
export const LOCAL_LIMITS: PackageLimits = {
  maxFileBytes: 64 * 1024 * 1024,
  maxPackageBytes: 512 * 1024 * 1024,
  maxFiles: 5000,
};

/** Text extensions a package may contain. Anything else is dropped. */
const TEXT_EXT = /\.(js|mjs|json|html|htm|css|svg|txt|md|wgsl|glsl)$/i;

/**
 * Binary media a package may ship.
 *
 * Added with the asset API: a plugin that applies a look needs to be able to
 * carry its own lookup texture or example image, and the alternative was
 * base64 in a `.js` file, which is the same bytes plus 33% and no size check.
 * SVG stays in `TEXT_EXT` — it is markup, and treating it as opaque bytes
 * would lose the one thing that makes it useful in a panel.
 *
 * ── `.wasm` ──────────────────────────────────────────────────────────────────
 *
 * A plugin may ship compiled code and instantiate it in the worker. That reads
 * like a widening and is not: the module is INSIDE the signed package, so it
 * carries the same signature, the same 2 MB per-file cap and the same 8 MB
 * package cap as the JavaScript beside it, and it receives no imports the
 * plugin's own JS does not hand it. It reaches nothing that JS could not.
 *
 * What it buys is the difference between scripting and a platform: solvers,
 * mesh libraries, codecs and tracers are written in another language and cannot
 * usefully be ported. Refusing it would not make the sandbox smaller — it would
 * push the same work into hand-written asm.js, which is the same power with
 * worse ergonomics and no size check.
 *
 * `WebAssembly.instantiateStreaming` is removed at lockdown: it takes a network
 * response, and the worker has no network. See `pluginWorker.ts`.
 *
 * ── The asset extensions added with local installs ───────────────────────────
 *
 * `.bin .onnx` (weights), `.glb .gltf` (meshes), `.ttf .otf .woff2` (fonts),
 * `.cube` (LUTs), `.exr .hdr` (HDR images), `.mp3 .wav` (audio). All of it is
 * DATA a plugin hands to its own code through `package.read` — nothing here is
 * executed by the host, and nothing here is a native module. `.node`, `.dll`,
 * `.so`, `.dylib` and `.exe` are absent and stay absent: a compiled library in
 * a package would run in this process, which is a different tier with its own
 * signing gate.
 *
 * Allowed in BOTH tiers, unlike the size ceilings. A 2 MB lookup texture in a
 * registry package is already bounded by the registry's own limits; refusing it
 * by extension as well would only make authors rename the file.
 */
const BINARY_EXT = /\.(png|jpg|jpeg|webp|wasm|bin|onnx|glb|gltf|ttf|otf|woff2|cube|exr|hdr|mp3|wav)$/i;

const MANIFEST_NAME = 'plugin.json';

/**
 * Largest inflation ratio a single file may claim before we call it hostile.
 *
 * The real defence is the absolute `originalSize` check below — this is the
 * second one, for the shape of archive that stays under the absolute ceiling
 * while still being pathological.
 */
const MAX_INFLATION_RATIO = 200;

/** Normalise a zip/dir entry path: forward slashes, no leading `./`. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Strip the single wrapping directory a zip usually has.
 *
 * Zipping a folder produces `my-plugin/plugin.json`, not `plugin.json`, and
 * refusing that would fail for the most ordinary way of producing a package.
 * Only stripped when EVERY entry shares the prefix, so a flat archive and a
 * multi-folder one are both left alone.
 */
function commonRoot(paths: readonly string[]): string | null {
  if (paths.length === 0 || paths.includes(MANIFEST_NAME)) return null;
  const first = paths[0]!.split('/')[0];
  if (!first || !paths.every((p) => p.startsWith(`${first}/`))) return null;
  return first;
}

function stripPrefix<T>(map: Record<string, T>, prefix: string | null): Record<string, T> {
  if (!prefix) return map;
  const out: Record<string, T> = {};
  for (const [p, v] of Object.entries(map)) {
    out[p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : p] = v;
  }
  return out;
}

/** Validate a raw path→text map as a package. Shared by both entry points. */
export function readPluginFiles(
  rawFiles: Record<string, string>,
  rawBinaries: Record<string, Uint8Array> = {},
): PackageResult {
  // The prefix is decided by ALL the package's paths at once — computing it
  // from the text files alone would leave a media subdirectory unstripped and
  // every path in the manifest pointing at nothing.
  const prefix = commonRoot([...Object.keys(rawFiles), ...Object.keys(rawBinaries)]);
  const files = stripPrefix(rawFiles, prefix);
  const binaries = stripPrefix(rawBinaries, prefix);
  const manifestText = files[MANIFEST_NAME];
  if (manifestText === undefined) {
    return {
      pkg: null,
      errors: [`No ${MANIFEST_NAME} found at the root of the package.`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (err) {
    return { pkg: null, errors: [`${MANIFEST_NAME} is not valid JSON: ${(err as Error).message}`] };
  }

  const { manifest, errors } = parseManifest(parsed);
  if (!manifest) return { pkg: null, errors };

  const main = normalize(manifest.main);
  if (files[main] === undefined) {
    return { pkg: null, errors: [`"main" points at ${manifest.main}, which is not in the package.`] };
  }
  // Every declared panel, not just the one legacy `panel` — a manifest naming a
  // panel that is not in the package produces an empty frame at open time,
  // which is a long way from where the mistake was made.
  for (const panel of manifest.contributes.panels) {
    if (files[normalize(panel.entry)] === undefined) {
      return {
        pkg: null,
        errors: [`Panel "${panel.id}" points at ${panel.entry}, which is not in the package.`],
      };
    }
  }

  return { pkg: { manifest, files, binaries }, errors: [] };
}

/** Should this entry be read at all? Shared by the filter and the folder path. */
function isPackageFile(path: string): boolean {
  if (path.endsWith('/')) return false; // directory entry
  if (path.split('/').includes('..')) return false; // zip-slip
  if (path.split('/').some((s) => s.startsWith('__MACOSX') || s === '.DS_Store')) return false;
  return path === MANIFEST_NAME || TEXT_EXT.test(path) || BINARY_EXT.test(path);
}

/**
 * Read a `.zip` / `.mplugin` archive. Never throws.
 *
 * ZIP BOMBS. The size checks used to run entirely after `unzipSync(bytes)`,
 * which inflates the WHOLE archive into memory first — so the 8 MB ceiling was
 * being applied to the compressed bytes, and a compliant 8 MB archive could
 * expand to gigabytes and take the app out before a single check ran. The
 * ceilings only mean anything if they are applied to the DECLARED uncompressed
 * size, in the filter, before fflate allocates for an entry. They are also
 * re-checked against the real inflated length afterwards, because the declared
 * size is a field in an attacker-supplied header and believing it is the same
 * mistake one level down.
 */
export function readPluginZip(
  bytes: Uint8Array,
  /** `LOCAL_LIMITS` for a package that was already on the user's own disk. */
  limits: PackageLimits = REGISTRY_LIMITS,
): PackageResult {
  const { maxFileBytes: MAX_FILE_BYTES, maxPackageBytes: MAX_PACKAGE_BYTES, maxFiles: MAX_FILES } = limits;
  if (bytes.byteLength > MAX_PACKAGE_BYTES) {
    return { pkg: null, errors: [`Package is larger than ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB.`] };
  }

  // Set by the filter. fflate's filter cannot abort the whole read, so the
  // refusal is recorded and reported once it returns.
  let refusal: string | null = null;
  let declaredTotal = 0;
  let kept = 0;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        const path = normalize(file.name);
        if (!isPackageFile(path)) return false;
        if (refusal) return false;

        if (file.originalSize > MAX_FILE_BYTES) {
          refusal = `${path} unpacks to more than ${Math.round(MAX_FILE_BYTES / 1024)} KB.`;
          return false;
        }
        // A file that claims to be 200× its stored size is not a plugin.
        if (file.size > 0 && file.originalSize / file.size > MAX_INFLATION_RATIO) {
          refusal = `${path} is compressed ${Math.round(file.originalSize / file.size)}× — refused as a zip bomb.`;
          return false;
        }
        declaredTotal += file.originalSize;
        if (declaredTotal > MAX_PACKAGE_BYTES) {
          refusal = `Package unpacks to more than ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB.`;
          return false;
        }
        kept += 1;
        if (kept > MAX_FILES) {
          refusal = `Package contains more than ${MAX_FILES} files.`;
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    return { pkg: null, errors: [`Could not read the archive: ${(err as Error).message}`] };
  }
  if (refusal) return { pkg: null, errors: [refusal] };

  const files: Record<string, string> = {};
  const binaries: Record<string, Uint8Array> = {};
  let total = 0;
  for (const [rawPath, data] of Object.entries(entries)) {
    const path = normalize(rawPath);
    if (!isPackageFile(path)) continue;
    // Verified against what actually came out, not what the header promised.
    if (data.byteLength > MAX_FILE_BYTES) {
      return { pkg: null, errors: [`${path} is larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB.`] };
    }
    total += data.byteLength;
    if (total > MAX_PACKAGE_BYTES) {
      return { pkg: null, errors: [`Package is larger than ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB.`] };
    }
    if (BINARY_EXT.test(path)) binaries[path] = data;
    else files[path] = strFromU8(data);
  }
  return readPluginFiles(files, binaries);
}

/**
 * Read the `FileList` from a folder picker (`<input webkitdirectory>`).
 *
 * The browser hands back every file with a `webkitRelativePath` rooted at the
 * chosen folder, which is exactly the "single wrapping directory" case above.
 */
export async function readPluginFolder(
  fileList: readonly File[],
  limits: PackageLimits = REGISTRY_LIMITS,
): Promise<PackageResult> {
  const { maxFileBytes: MAX_FILE_BYTES, maxPackageBytes: MAX_PACKAGE_BYTES, maxFiles: MAX_FILES } = limits;
  if (fileList.length === 0) return { pkg: null, errors: ['That folder is empty.'] };
  if (fileList.length > MAX_FILES) return { pkg: null, errors: [`Folder contains more than ${MAX_FILES} files.`] };

  const files: Record<string, string> = {};
  const binaries: Record<string, Uint8Array> = {};
  let total = 0;
  for (const f of fileList) {
    const rel = normalize((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    const base = rel.split('/').pop() ?? rel;
    // A folder has no compression, so there is no bomb here — but the same
    // predicate decides membership, so the two entry points cannot drift.
    if (!isPackageFile(rel) || (base !== MANIFEST_NAME && !TEXT_EXT.test(base) && !BINARY_EXT.test(base))) continue;
    if (f.size > MAX_FILE_BYTES) return { pkg: null, errors: [`${rel} is larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB.`] };
    total += f.size;
    if (total > MAX_PACKAGE_BYTES) {
      return { pkg: null, errors: [`Folder is larger than ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB.`] };
    }
    if (BINARY_EXT.test(base)) binaries[rel] = new Uint8Array(await f.arrayBuffer());
    else files[rel] = await f.text();
  }
  return readPluginFiles(files, binaries);
}

/**
 * Validate a payload that was read somewhere else — the main process, for a
 * plugin found in a folder on this machine.
 *
 * The ceilings are re-applied HERE even though `electron/pluginLoader.ts`
 * applied them while reading. Not belt-and-braces: the two checks answer
 * different questions. That one stops the app dying on a search path pointed at
 * a home directory; this one is the check that runs over whatever actually
 * arrived, on the side that decides whether to install it, and it is the only
 * one that still runs if the payload ever reaches here another way.
 */
export function readPluginPayload(
  files: Record<string, string>,
  binaries: Record<string, Uint8Array>,
  limits: PackageLimits = LOCAL_LIMITS,
): PackageResult {
  const paths = [...Object.keys(files), ...Object.keys(binaries)];
  if (paths.length === 0) return { pkg: null, errors: ['That folder holds no plugin files.'] };
  if (paths.length > limits.maxFiles) {
    return { pkg: null, errors: [`Package contains more than ${limits.maxFiles} files.`] };
  }

  let total = 0;
  const encoder = new TextEncoder();
  for (const [path, text] of Object.entries(files)) {
    // UTF-8 length, not `String.length`: a package of CJK source would pass a
    // code-unit count and blow the real one.
    const size = encoder.encode(text).byteLength;
    if (size > limits.maxFileBytes) {
      return { pkg: null, errors: [`${path} is larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB.`] };
    }
    total += size;
  }
  for (const [path, bytes] of Object.entries(binaries)) {
    if (bytes.byteLength > limits.maxFileBytes) {
      return { pkg: null, errors: [`${path} is larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB.`] };
    }
    total += bytes.byteLength;
  }
  if (total > limits.maxPackageBytes) {
    return {
      pkg: null,
      errors: [`Package is larger than ${Math.round(limits.maxPackageBytes / 1024 / 1024)} MB.`],
    };
  }

  // The same predicate the zip and folder readers use, so a path one of them
  // would have dropped cannot arrive by this route instead.
  const keptFiles: Record<string, string> = {};
  const keptBinaries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) {
    if (isPackageFile(normalize(path))) keptFiles[normalize(path)] = text;
  }
  for (const [path, bytes] of Object.entries(binaries)) {
    if (isPackageFile(normalize(path))) keptBinaries[normalize(path)] = bytes;
  }
  return readPluginFiles(keptFiles, keptBinaries);
}

/** Route a picked file by extension. Zip magic is checked, not trusted from the name. */
export async function readPluginFile(
  file: File,
  limits: PackageLimits = REGISTRY_LIMITS,
): Promise<PackageResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
  if (isZip) return readPluginZip(bytes, limits);
  return {
    pkg: null,
    errors: [
      `“${file.name}” is not a plugin package. A package is a .zip (or .mplugin) archive containing plugin.json — or pick the plugin's folder instead.`,
    ],
  };
}
