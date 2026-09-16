/**
 * Plugins that live in a FOLDER on this machine, found by the main process.
 *
 * ── Why a folder at all, when there is an installer and a registry ───────────
 *
 * Because that is how every host a professional already uses ships plugins.
 * After Effects scans `…/Common/Plug-ins/7.0/MediaCore` and its own `Plug-ins`
 * directory; OFX hosts scan `…/Common Files/OFX/Plugins` plus `OFX_PLUGIN_PATH`;
 * Resolve loads Fuses from a Fusion directory. A vendor installer writes files
 * into a known place and the host picks them up at launch — nobody drags a zip
 * into a panel. Everything in this file exists so a Premation plugin can be
 * delivered the same way.
 *
 * It is also the author's loop. An unpacked folder in the plugins directory is
 * the working copy: edit a file, reload the plugin, see it. The browser path
 * (`<input webkitdirectory>`) cannot do that — it re-reads only on a fresh user
 * gesture and forgets the directory when the app restarts.
 *
 * ── Why it is HERE and not in the renderer ───────────────────────────────────
 *
 * The renderer has no filesystem. That is not an inconvenience to route around;
 * it is the property that makes a compromised renderer survivable. So this
 * process does the walking and the reading, and hands the renderer BYTES —
 * which it then validates exactly as it validates a package a user dropped on
 * the window (`pluginPackage.ts`). Nothing here decides that a package is good.
 * It decides which paths may be looked at, and stops reading when a package is
 * too big to be one.
 *
 * ── What this tier deliberately will not carry ───────────────────────────────
 *
 * `.node`, `.dll`, `.so`, `.dylib`, `.exe`. A folder plugin is still JavaScript
 * and WebAssembly in a Worker; loading a native module would put a stranger's
 * compiled code in this process, which is a different product with a different
 * consent screen and its own signing gate. They are not in `ALLOWED_EXT`, so
 * they are skipped and REPORTED — a silently missing file would read as this
 * scanner being broken rather than as a tier boundary.
 *
 * ── The one exception, and its shape ─────────────────────────────────────────
 *
 * That tier now exists (`pluginNativeIpc.ts`), and it is still not this one.
 * What changed is narrow and worth stating exactly:
 *
 *   • A native module's BYTES still never reach the renderer. They are not in
 *     `files` and not in `binaries`. What comes back is a path, a size and a
 *     SHA-256 — which is what the consent screen needs to name, and all a
 *     loader needs to ask for.
 *   • Only the files the manifest DECLARES in `native.platforms` are described
 *     that way. A stray `.dll` beside them is still skipped and reported,
 *     exactly as before, because nothing said it was part of the package.
 *   • Nothing here loads anything. The compiled code is `require`d in a utility
 *     process, after a signature check and a separate consent step, from a path
 *     re-contained and re-hashed on the privileged side.
 */

import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { join, resolve, sep, extname, basename } from 'node:path';
import { app, shell, type WebContents } from 'electron';
import { handle } from './ipcGuard';

/**
 * Per-file, per-package and file-count ceilings for a LOCAL install.
 *
 * Much larger than the registry's (2 MB / 8 MB / 200 files in
 * `pluginPackage.ts`) and that asymmetry is the point. Those numbers bound what
 * an anonymous publisher can push into a user's browser storage over the
 * network. These bound a directory the user or their IT department put on their
 * own disk, holding the things that make a plugin more than a script: an ONNX
 * model, a LUT, a font, a mesh. Applying the registry's 2 MB here would refuse
 * exactly the packages this tier was built for.
 *
 * They are still ceilings. A "plugin" folder holding half a terabyte is a
 * mistake or a mis-set search path, and reading it would take the app down
 * before anyone could be told which directory was at fault.
 */
export const LOCAL_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const LOCAL_MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
export const LOCAL_MAX_FILES = 5000;

/**
 * How deep a scan goes below a search root.
 *
 * AE scans ten. Four is enough for `Plugins/<vendor>/<plugin>/<subdir>/file`
 * and short enough that a search path accidentally pointed at a home directory
 * costs a fraction of a second rather than a minute. A plugin's own files are
 * read to `MAX_PACKAGE_DEPTH` below its root, which is a separate number: the
 * scan is looking for `plugin.json`, and once it has found one it is reading a
 * package the user already chose to install.
 */
export const MAX_SCAN_DEPTH = 4;
const MAX_PACKAGE_DEPTH = 8;

/** The archive extension. `.zip` is accepted too — same bytes, worse name. */
export const PLUGIN_ARCHIVE_EXT = ['.mplugin', '.zip'];

/** `;` on Windows, `:` elsewhere — the platform's own path separator. */
export const ENV_PATH_VAR = 'MOTION_PLUGIN_PATH';

const MANIFEST_NAME = 'plugin.json';

/**
 * Text and asset extensions a local package may contain.
 *
 * Duplicated from `pluginPackage.ts` rather than imported, for the same reason
 * `pluginNet.ts` duplicates the private-address table: `electron/tsconfig.json`
 * compiles this directory alone, and reaching into `src/` would pull the
 * renderer's module graph into the main process. The renderer re-runs its own
 * copy over whatever comes back, so a drift here can only ever REFUSE something
 * the renderer would have taken — never the other way round.
 */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.json', '.html', '.htm', '.css', '.svg', '.txt', '.md',
  '.wgsl', '.glsl',
]);

/**
 * Binary assets. The reason the caps above are what they are.
 *
 * `.bin .onnx` (weights), `.glb .gltf` (meshes), `.ttf .otf .woff2` (fonts),
 * `.cube` (LUTs), `.exr .hdr` (HDR images), `.mp3 .wav` (audio), plus the
 * images and `.wasm` the registry tier already allowed. Every one of these is
 * data a plugin reads through `package.read` — none of them is executed by
 * anything but the plugin's own code.
 */
const ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.wasm',
  '.bin', '.onnx', '.glb', '.gltf', '.ttf', '.otf', '.woff2',
  '.cube', '.exr', '.hdr', '.mp3', '.wav',
]);

/**
 * Compiled modules. Named so a refusal can say WHY, not "unknown extension".
 *
 * Deliberately NOT merged into `ASSET_EXT`: an asset is data a plugin reads, a
 * native module is code the operating system executes, and the whole of the
 * native tier's gate hangs on the two being different lists. A file with one of
 * these extensions is described (path, size, hash) when the manifest declared
 * it and skipped when it did not — its bytes are never returned either way.
 *
 * `.dSYM` is a debug bundle rather than a loadable image, and is here because
 * an author who ships one alongside their `.dylib` should be told it was left
 * out rather than left wondering.
 */
const NATIVE_EXT = new Set(['.node', '.dll', '.so', '.dylib', '.exe', '.dsym', '.msi']);

/** Is this the kind of file the native tier carries? Extension only. */
export function isNativeModuleFile(path: string): boolean {
  return NATIVE_EXT.has(extname(basename(path)).toLowerCase());
}

/** Where a search path came from. Shown beside the plugin, so it is not a boolean. */
export type PluginPathKind = 'user' | 'machine' | 'env';

export interface PluginSearchPath {
  kind: PluginPathKind;
  dir: string;
}

/** One thing a scan found, before anything has been read or validated. */
export interface DiscoveredPlugin {
  /** Absolute path to the folder, or to the `.mplugin` file. */
  path: string;
  kind: 'folder' | 'archive';
  source: PluginPathKind;
  /** The search root it was found under, for grouping in the UI. */
  root: string;
  /** Raw `plugin.json` text for a folder; null for an archive (it is inside
   *  the zip, and the renderer is the side that opens zips). */
  manifestText: string | null;
  /**
   * The contents of `<archive>.sig`, when one sits beside the package.
   *
   * A SIDECAR rather than something inside the zip, because the signature is
   * over the archive's exact bytes — the same bytes the registry signs, checked
   * by the same `verifyPackageSignature` — and a signature stored inside the
   * thing it signs cannot be. `scripts/pack-plugin.mjs --key` writes it.
   */
  signatureText?: string;
  /** Newest mtime seen, so a watcher-driven reload can skip unchanged packages. */
  modifiedAt: number;
  /** Set when the candidate could not be read at all. */
  error?: string;
}

export interface LocalPackageRead {
  ok: boolean;
  error?: string;
  kind?: 'folder' | 'archive';
  /** Archive only: the bytes, for the renderer's zip reader and the signature check. */
  bytes?: Uint8Array;
  /** Folder only: package-relative path → text. */
  files?: Record<string, string>;
  /** Folder only: package-relative path → bytes. */
  binaries?: Record<string, Uint8Array>;
  /** Files the tier does not carry (native modules, unknown extensions). Capped. */
  skipped?: string[];
  /**
   * The compiled modules this package DECLARES, described rather than read.
   *
   * Folder only, and only for paths named in the manifest's `native.platforms`.
   * The hash is the point: it is what the user's consent is pinned to and what
   * the main process re-checks before loading, so measuring it here — once, off
   * the renderer's thread — is what makes "has this binary changed since you
   * allowed it" answerable without the bytes ever crossing.
   */
  native?: NativeBinaryInfo[];
}

/** One declared native module, as the scanner can describe it without loading it. */
export interface NativeBinaryInfo {
  /** Package-relative, exactly as the manifest spells it. */
  path: string;
  size: number;
  /** SHA-256 hex of the bytes on disk. */
  sha256: string;
}

/**
 * Folders a scan walks past without looking inside.
 *
 * Taken from AE's own rule, because plugin vendors already follow it: a
 * directory whose name ends in `()` is disabled, and one starting with `~` is a
 * backup or a work-in-progress the author did not mean to ship. Honouring the
 * convention means "rename it to turn it off" works here the way it does there,
 * with no new UI. Dot-directories are added — `.git` under a plugin folder is
 * thousands of files nobody wants read.
 */
export function isSkippedFolder(name: string): boolean {
  return name.endsWith('()') || name.startsWith('~') || name.startsWith('.') || name === 'node_modules';
}

/** Is this a file a package may contain? Extension only — never the contents. */
export function isAllowedPackageFile(path: string): boolean {
  const base = basename(path);
  if (base === MANIFEST_NAME) return true;
  const ext = extname(base).toLowerCase();
  return TEXT_EXT.has(ext) || ASSET_EXT.has(ext);
}

function isTextFile(path: string): boolean {
  const base = basename(path);
  return base === MANIFEST_NAME || TEXT_EXT.has(extname(base).toLowerCase());
}

function isArchive(path: string): boolean {
  return PLUGIN_ARCHIVE_EXT.includes(extname(path).toLowerCase());
}

/**
 * The machine-wide directory, per platform.
 *
 * The three are the platforms' own conventions rather than one invented
 * location: `%ProgramData%` is where Windows puts per-machine application data
 * an installer may write; `/Library/Application Support` is the macOS
 * equivalent (the user-level one is `~/Library/...`, which is `userData`);
 * `/usr/share` is where a Linux package manager puts read-only application
 * data. Returns null when the platform does not advertise one.
 */
export function machinePluginDir(
  platform: NodeJS.Platform,
  appName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === 'win32') {
    const programData = env.ProgramData || env.ALLUSERSPROFILE;
    return programData ? join(programData, appName, 'Plugins') : null;
  }
  if (platform === 'darwin') return join('/Library/Application Support', appName, 'Plugins');
  return join('/usr/share', appName.toLowerCase(), 'plugins');
}

/**
 * Split `MOTION_PLUGIN_PATH`.
 *
 * `;` on Windows and `:` elsewhere, matching `PATH` itself — an author who
 * knows one knows the other. A Windows drive letter is why the separator cannot
 * simply be `:` everywhere: `C:\x;D:\y` has to split on the semicolon.
 */
export function splitEnvPaths(raw: string | undefined, platform: NodeJS.Platform): string[] {
  if (!raw) return [];
  const sepChar = platform === 'win32' ? ';' : ':';
  return raw
    .split(sepChar)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Every directory a scan will look in, in precedence order.
 *
 * Env first, then the user's own, then the machine-wide one. Order matters only
 * for reporting — a duplicate id is resolved by VERSION, not by which folder it
 * was found in (see `localPlugins.ts`), because "whichever directory happened
 * to be first" is not a rule anyone can predict from the outside.
 */
export function pluginSearchPaths(opts: {
  platform: NodeJS.Platform;
  appName: string;
  userData: string;
  env?: NodeJS.ProcessEnv;
}): PluginSearchPath[] {
  const env = opts.env ?? process.env;
  const out: PluginSearchPath[] = [];
  for (const dir of splitEnvPaths(env[ENV_PATH_VAR], opts.platform)) {
    out.push({ kind: 'env', dir: resolve(dir) });
  }
  out.push({ kind: 'user', dir: join(opts.userData, 'Plugins') });
  const machine = machinePluginDir(opts.platform, opts.appName, env);
  if (machine) out.push({ kind: 'machine', dir: machine });

  // De-duplicated by resolved path: a user who points the env var at their own
  // Plugins folder should not see every plugin twice.
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = p.dir.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The filesystem calls this module makes. Injected so the walk is testable. */
export interface LoaderIo {
  readdir: (dir: string) => Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  stat: (path: string) => Promise<{ size: number; mtimeMs: number; isDirectory: boolean }>;
  readFile: (path: string) => Promise<Uint8Array>;
}

export const nodeIo: LoaderIo = {
  readdir: async (dir) =>
    (await readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    })),
  stat: async (path) => {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
  },
  readFile: async (path) => new Uint8Array(await readFile(path)),
};

/**
 * Walk one search root and list what looks like a plugin.
 *
 * A directory holding `plugin.json` IS a plugin and is not descended into — a
 * package's own `lib/` may contain anything, and treating a nested manifest as
 * a second plugin would install a package's fixtures. Anything else is
 * descended into until `MAX_SCAN_DEPTH`.
 *
 * A missing root is not an error. Most machines have no machine-wide plugins
 * directory and never will; reporting that as a failure would put a permanent
 * warning in the UI for the normal case.
 */
export async function scanPluginRoot(
  root: PluginSearchPath,
  io: LoaderIo = nodeIo,
): Promise<DiscoveredPlugin[]> {
  const found: DiscoveredPlugin[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    try {
      entries = await io.readdir(dir);
    } catch {
      // Unreadable, or gone between the parent listing and this call. Neither
      // is worth a message: the directory simply contributes nothing.
      return;
    }

    // A manifest here makes THIS the plugin, and the walk stops.
    if (entries.some((e) => e.isFile && e.name === MANIFEST_NAME)) {
      found.push(await describeFolder(dir, root, io));
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory) {
        if (isSkippedFolder(entry.name)) continue;
        await walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile && isArchive(entry.name)) {
        const path = join(dir, entry.name);
        let modifiedAt = 0;
        try { modifiedAt = (await io.stat(path)).mtimeMs; } catch { /* raced */ }
        // Bounded hard: a signature is ~100 bytes of base64 in a small JSON
        // object, and a file claiming to be one and being a gigabyte is not.
        let signatureText: string | undefined;
        try {
          const sigPath = `${path}.sig`;
          if ((await io.stat(sigPath)).size <= 8 * 1024) {
            signatureText = new TextDecoder().decode(await io.readFile(sigPath));
          }
        } catch { /* unsigned, which is the common case for a local package */ }
        found.push({
          path,
          kind: 'archive',
          source: root.kind,
          root: root.dir,
          manifestText: null,
          modifiedAt,
          ...(signatureText !== undefined ? { signatureText } : {}),
        });
      }
    }
  };

  await walk(root.dir, 0);
  return found;
}

/**
 * Describe a folder plugin from its manifest alone.
 *
 * Only `plugin.json` is read. A scan runs at every launch and on every
 * filesystem change; reading whole packages here would make a directory of
 * model-carrying plugins cost hundreds of megabytes of I/O to LIST. The payload
 * is fetched later, for the packages that are actually going to run.
 */
async function describeFolder(
  dir: string,
  root: PluginSearchPath,
  io: LoaderIo,
): Promise<DiscoveredPlugin> {
  const base: DiscoveredPlugin = {
    path: dir,
    kind: 'folder',
    source: root.kind,
    root: root.dir,
    manifestText: null,
    modifiedAt: 0,
  };
  try {
    const manifestPath = join(dir, MANIFEST_NAME);
    const info = await io.stat(manifestPath);
    if (info.size > LOCAL_MAX_FILE_BYTES) {
      return { ...base, error: `${MANIFEST_NAME} is implausibly large and was not read.` };
    }
    const bytes = await io.readFile(manifestPath);
    return {
      ...base,
      manifestText: new TextDecoder().decode(bytes),
      modifiedAt: info.mtimeMs,
    };
  } catch (err) {
    return { ...base, error: `Could not read ${MANIFEST_NAME}: ${(err as Error).message}` };
  }
}

/** Scan every configured root. */
export async function scanPlugins(
  paths: PluginSearchPath[],
  io: LoaderIo = nodeIo,
): Promise<DiscoveredPlugin[]> {
  const out: DiscoveredPlugin[] = [];
  for (const root of paths) out.push(...(await scanPluginRoot(root, io)));
  return out;
}

/**
 * Is `target` inside one of the roots we are willing to read?
 *
 * The renderer names the path, and the renderer is the untrusted side of this
 * boundary — without this, `plugins:read` is "read any file on the machine as
 * text", reachable from any bug that can put a string into an IPC call.
 * Compared on resolved paths with a trailing separator, so `…/Plugins-evil`
 * does not pass as a child of `…/Plugins`.
 */
export function isInsideRoots(target: string, roots: readonly string[]): boolean {
  const full = resolve(target);
  return roots.some((root) => {
    const base = resolve(root);
    if (full === base) return true;
    const prefix = base.endsWith(sep) ? base : base + sep;
    // Windows paths are case-insensitive; a comparison that is not would refuse
    // the same directory typed with a different drive-letter case.
    return process.platform === 'win32'
      ? full.toLowerCase().startsWith(prefix.toLowerCase())
      : full.startsWith(prefix);
  });
}

/**
 * Read one package off disk.
 *
 * An archive comes back as BYTES, untouched: the renderer already owns the zip
 * reader, the zip-bomb ceilings and the signature check, and a second
 * implementation here would be a second place for those to drift. A folder
 * comes back as the same `{ files, binaries }` shape the zip reader produces,
 * because everything downstream of this point should not be able to tell the
 * two apart.
 */
export async function readLocalPackage(
  target: string,
  io: LoaderIo = nodeIo,
): Promise<LocalPackageRead> {
  let info: { size: number; mtimeMs: number; isDirectory: boolean };
  try {
    info = await io.stat(target);
  } catch (err) {
    return { ok: false, error: `Could not read ${target}: ${(err as Error).message}` };
  }

  if (!info.isDirectory) {
    if (!isArchive(target)) {
      return { ok: false, error: `${basename(target)} is not a plugin package.` };
    }
    if (info.size > LOCAL_MAX_PACKAGE_BYTES) {
      return { ok: false, error: `${basename(target)} is larger than ${mb(LOCAL_MAX_PACKAGE_BYTES)} MB.` };
    }
    try {
      return { ok: true, kind: 'archive', bytes: await io.readFile(target) };
    } catch (err) {
      return { ok: false, error: `Could not read ${basename(target)}: ${(err as Error).message}` };
    }
  }

  const files: Record<string, string> = {};
  const binaries: Record<string, Uint8Array> = {};
  const skipped: string[] = [];
  /** Compiled files seen during the walk. Which ones COUNT is decided after it,
   *  because the manifest that declares them is itself one of the files. */
  const nativeSeen: Array<{ path: string; full: string; size: number }> = [];
  let total = 0;
  let count = 0;
  let refusal: string | null = null;

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (refusal || depth > MAX_PACKAGE_DEPTH) return;
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    try {
      entries = await io.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (refusal) return;
      const full = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (isSkippedFolder(entry.name)) continue;
        await walk(full, relPath, depth + 1);
        continue;
      }
      if (!entry.isFile) continue;
      if (isNativeModuleFile(entry.name)) {
        /*
          Noted, not read.

          Its size still counts against the package ceiling — a plugin folder
          holding six platform builds is as big as it is, whatever the bytes
          are for — but nothing reads it here and nothing returns it. Whether
          this file is part of the package at all is the manifest's word, and
          the manifest has not necessarily been seen yet.
        */
        let size = 0;
        try { size = (await io.stat(full)).size; } catch { continue; }
        if (size > LOCAL_MAX_FILE_BYTES) {
          refusal = `${relPath} is larger than ${mb(LOCAL_MAX_FILE_BYTES)} MB.`;
          return;
        }
        total += size;
        if (total > LOCAL_MAX_PACKAGE_BYTES) {
          refusal = `This package is larger than ${mb(LOCAL_MAX_PACKAGE_BYTES)} MB.`;
          return;
        }
        if (nativeSeen.length < 50) nativeSeen.push({ path: relPath, full, size });
        continue;
      }
      if (!isAllowedPackageFile(entry.name)) {
        // Capped, because a folder with a `node_modules`-shaped mistake in it
        // would otherwise hand the UI a list with ten thousand entries.
        if (skipped.length < 50) skipped.push(relPath);
        continue;
      }

      let size = 0;
      try { size = (await io.stat(full)).size; } catch { continue; }
      if (size > LOCAL_MAX_FILE_BYTES) {
        refusal = `${relPath} is larger than ${mb(LOCAL_MAX_FILE_BYTES)} MB.`;
        return;
      }
      total += size;
      if (total > LOCAL_MAX_PACKAGE_BYTES) {
        refusal = `This package is larger than ${mb(LOCAL_MAX_PACKAGE_BYTES)} MB.`;
        return;
      }
      count += 1;
      if (count > LOCAL_MAX_FILES) {
        refusal = `This package contains more than ${LOCAL_MAX_FILES} files.`;
        return;
      }

      try {
        const bytes = await io.readFile(full);
        if (isTextFile(entry.name)) files[relPath] = new TextDecoder().decode(bytes);
        else binaries[relPath] = bytes;
      } catch {
        // A file that vanished mid-read. The manifest check downstream decides
        // whether the package is still usable without it.
      }
    }
  };

  await walk(target, '', 0);
  if (refusal) return { ok: false, error: refusal };

  const { native, undeclared } = await describeNativeModules(files[MANIFEST_NAME], nativeSeen, io);
  for (const path of undeclared) {
    if (skipped.length < 50) skipped.push(path);
  }
  return {
    ok: true,
    kind: 'folder',
    files,
    binaries,
    skipped,
    ...(native.length > 0 ? { native } : {}),
  };
}

/**
 * Split the compiled files into "the manifest says this is the package's" and
 * "this was lying next to it", and hash the first group.
 *
 * The manifest is parsed here for exactly two keys and nothing else. That is
 * not a second implementation of the grammar — `parseManifest` in the renderer
 * remains the only thing that decides whether a manifest is VALID, and this
 * runs before it, on text that may turn out not to be a manifest at all.
 * Reading two keys out of untrusted JSON is the smallest thing that can answer
 * "which of these files did the author mean to ship".
 *
 * A declaration that names a file which is not there produces nothing: the
 * absence is reported by the loader when it fails to find a binary for this
 * platform, with a message about platforms, which is the one a user can act on.
 */
async function describeNativeModules(
  manifestText: string | undefined,
  seen: ReadonlyArray<{ path: string; full: string; size: number }>,
  io: LoaderIo,
): Promise<{ native: NativeBinaryInfo[]; undeclared: string[] }> {
  if (seen.length === 0) return { native: [], undeclared: [] };

  const declared = new Set<string>();
  try {
    const raw = manifestText ? (JSON.parse(manifestText) as unknown) : null;
    const nativeBlock = (raw as { native?: { platforms?: unknown } } | null)?.native;
    const platforms = nativeBlock?.platforms;
    if (platforms && typeof platforms === 'object' && !Array.isArray(platforms)) {
      for (const value of Object.values(platforms as Record<string, unknown>)) {
        // Normalised the way the walk spells its paths, so a manifest written
        // with backslashes on Windows still matches the file that was found.
        if (typeof value === 'string') declared.add(value.replace(/\\/g, '/').replace(/^\.\//, ''));
      }
    }
  } catch {
    // Not JSON, or not a manifest. Every compiled file is then undeclared,
    // which is the same answer this function gives for a package with no
    // `native` block — and the right one.
  }

  const native: NativeBinaryInfo[] = [];
  const undeclared: string[] = [];
  for (const file of seen) {
    if (!declared.has(file.path)) {
      undeclared.push(file.path);
      continue;
    }
    try {
      const bytes = await io.readFile(file.full);
      native.push({
        path: file.path,
        size: file.size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } catch {
      // Unreadable or gone. Left out rather than reported as a broken package:
      // a missing binary for THIS platform is a different, better message, and
      // one for another platform is not this machine's problem.
    }
  }
  return { native, undeclared };
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * Watch every search root and tell the renderer when something changed.
 *
 * Debounced hard, because one save in an editor is several filesystem events
 * (write, rename, attribute) and a build tool writing a bundle is dozens. What
 * is sent is a bare "something changed" rather than a path: the renderer
 * re-scans anyway, and a per-event path would invite it to act on a partially
 * written directory.
 *
 * `recursive` is honoured on Windows and macOS and not on Linux, where it
 * throws — caught, and the root is watched shallowly instead. A shallow watch
 * still catches a plugin folder appearing or disappearing, which is most of
 * what this is for.
 */
export function watchPluginRoots(dirs: readonly string[], onChange: () => void): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onChange(); }, 300);
  };

  for (const dir of dirs) {
    try {
      watchers.push(watch(dir, { recursive: true }, fire));
    } catch {
      try {
        watchers.push(watch(dir, fire));
      } catch {
        // The directory does not exist. Normal for the machine-wide root.
      }
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    watchers.length = 0;
  };
}

/**
 * The IPC surface.
 *
 * Four verbs and one event. Note what is absent: there is no "read this file",
 * no "write", and no way to name a directory that is not already a search root.
 * The renderer can ask what the roots are, what is in them, for the bytes of
 * one package inside them, and for the user's own folder to be opened in the
 * file manager.
 */
export function registerPluginLoaderIpc(): void {
  let unwatch: (() => void) | null = null;

  const paths = (): PluginSearchPath[] =>
    pluginSearchPaths({
      platform: process.platform,
      // `app.getName()` rather than the package name: it is the same value
      // `userData` is derived from, so the user folder and the machine-wide
      // folder cannot end up named differently in a packaged build.
      appName: app.getName(),
      userData: app.getPath('userData'),
    });

  handle('plugins:paths', () => paths());

  handle('plugins:scan', () => scanPlugins(paths()));

  handle('plugins:read', async (_event, target: unknown) => {
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: 'No package path was given.' } satisfies LocalPackageRead;
    }
    if (!isInsideRoots(target, paths().map((p) => p.dir))) {
      return {
        ok: false,
        error: 'That path is not inside a plugins folder.',
      } satisfies LocalPackageRead;
    }
    return readLocalPackage(target);
  });

  /**
   * Open the user's plugins folder, creating it if it is not there.
   *
   * Creating it is the point. "Put your plugin in `%APPDATA%/…/Plugins`" is a
   * sentence a user has to act on with a file manager and a path they cannot
   * copy; a button that opens the folder — which exists, because opening it
   * made it exist — is the whole instruction.
   */
  handle('plugins:openFolder', async () => {
    const userPath = paths().find((p) => p.kind === 'user');
    if (!userPath) return { ok: false, error: 'No user plugins folder is configured.' };
    try {
      await mkdir(userPath.dir, { recursive: true });
    } catch { /* it may exist already, or be read-only — try to open it anyway */ }
    const problem = await shell.openPath(userPath.dir);
    return problem ? { ok: false, error: problem } : { ok: true, dir: userPath.dir };
  });

  /**
   * Start or stop watching. Off by default, and turned on by developer mode.
   *
   * Not always-on: a recursive watch over a directory tree costs handles and
   * wakes the process on every write, and outside an author's edit/run loop
   * nothing is going to change between launches. The renderer owns the
   * developer-mode flag, so it is the side that asks.
   */
  handle('plugins:watch', (event, enabled: unknown) => {
    unwatch?.();
    unwatch = null;
    if (enabled !== true) return { ok: true, watching: false };
    const sender: WebContents = event.sender;
    unwatch = watchPluginRoots(paths().map((p) => p.dir), () => {
      if (!sender.isDestroyed()) sender.send('plugins:changed');
    });
    return { ok: true, watching: true };
  });
}
