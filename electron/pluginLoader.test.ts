/**
 * The folder scanner.
 *
 * What is pinned here is everything that decides WHICH BYTES this process is
 * willing to read: the search paths per platform, the skip convention, the
 * extension allowlist (and the native modules it deliberately excludes), the
 * ceilings, and the containment check that stops `plugins:read` being a general
 * file reader. The IPC wiring itself goes through `ipcGuard` like every other
 * channel and is covered by `ipcRegistration.test.ts`.
 */

/*
  `electron` is mocked because IMPORTING it is what breaks under jest — the
  same reason modelDownload.test.ts does it. Nothing here calls into it.
*/
jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  app: { getName: () => 'Premation', getPath: () => '/userData' },
  shell: { openPath: async () => '' },
}));

import {
  isSkippedFolder,
  isAllowedPackageFile,
  isInsideRoots,
  machinePluginDir,
  splitEnvPaths,
  pluginSearchPaths,
  scanPluginRoot,
  scanPlugins,
  readLocalPackage,
  LOCAL_MAX_FILE_BYTES,
  LOCAL_MAX_FILES,
  ENV_PATH_VAR,
  type LoaderIo,
} from './pluginLoader';
import { join, resolve } from 'node:path';

/**
 * An in-memory filesystem shaped like the one this module walks.
 *
 * Keys are POSIX-ish paths; lookups normalise the platform separator so the
 * same fixture describes the same tree on Windows and on CI.
 */
function fakeIo(tree: Record<string, string | Uint8Array>, sizes: Record<string, number> = {}): LoaderIo {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const paths = Object.keys(tree).map(norm);

  const childrenOf = (dir: string): Array<{ name: string; isDirectory: boolean; isFile: boolean }> => {
    const prefix = `${norm(dir)}/`;
    const seen = new Map<string, boolean>(); // name → isDirectory
    let exists = false;
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      exists = true;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    if (!exists) throw new Error(`ENOENT: ${dir}`);
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory }));
  };

  return {
    readdir: async (dir) => childrenOf(dir),
    stat: async (path) => {
      const p = norm(path);
      if (p in tree || paths.includes(p)) {
        const value = tree[p];
        const size = sizes[p] ?? (typeof value === 'string' ? value.length : (value?.byteLength ?? 0));
        return { size, mtimeMs: 111, isDirectory: false };
      }
      if (paths.some((q) => q.startsWith(`${p}/`))) return { size: 0, mtimeMs: 111, isDirectory: true };
      throw new Error(`ENOENT: ${path}`);
    },
    readFile: async (path) => {
      const value = tree[norm(path)];
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
    },
  };
}

describe('the skip convention', () => {
  it.each([['old()'], ['~wip'], ['.git'], ['node_modules']])('skips %s', (name) => {
    expect(isSkippedFolder(name)).toBe(true);
  });

  it('keeps an ordinary folder', () => {
    expect(isSkippedFolder('color-studio')).toBe(false);
  });
});

describe('the extension allowlist', () => {
  it.each([
    'plugin.json', 'main.js', 'worker.mjs', 'panel.html', 'shader.wgsl', 'shader.glsl',
    'model.onnx', 'mesh.glb', 'look.cube', 'font.woff2', 'sound.wav', 'weights.bin', 'kernel.wasm',
  ])('accepts %s', (name) => {
    expect(isAllowedPackageFile(name)).toBe(true);
  });

  /*
    The tier boundary. A native module in a plugins folder is not a smaller
    version of this feature — it is a stranger's compiled code in the main
    process, which has its own gate and is not built. If this list ever accepts
    one of these, that gate was bypassed by an extension table.
  */
  it.each(['evil.node', 'evil.dll', 'evil.so', 'evil.dylib', 'evil.exe', 'setup.msi', 'run.sh'])(
    'refuses %s',
    (name) => {
      expect(isAllowedPackageFile(name)).toBe(false);
    },
  );
});

describe('search paths', () => {
  it('uses ProgramData on Windows', () => {
    expect(machinePluginDir('win32', 'Premation', { ProgramData: 'C:\\ProgramData' }))
      .toBe(join('C:\\ProgramData', 'Premation', 'Plugins'));
  });

  it('uses the shared Application Support folder on macOS', () => {
    expect(machinePluginDir('darwin', 'Premation', {}))
      .toBe(join('/Library/Application Support', 'Premation', 'Plugins'));
  });

  it('uses /usr/share on Linux, lowercased', () => {
    expect(machinePluginDir('linux', 'Premation', {})).toBe(join('/usr/share', 'premation', 'plugins'));
  });

  it('has no machine-wide folder on Windows without ProgramData', () => {
    expect(machinePluginDir('win32', 'Premation', {})).toBeNull();
  });

  it('splits the env override on the platform separator', () => {
    expect(splitEnvPaths('C:\\a;D:\\b', 'win32')).toEqual(['C:\\a', 'D:\\b']);
    expect(splitEnvPaths('/a:/b', 'linux')).toEqual(['/a', '/b']);
    expect(splitEnvPaths(undefined, 'linux')).toEqual([]);
  });

  it('puts the env override first and de-duplicates', () => {
    const paths = pluginSearchPaths({
      platform: 'linux',
      appName: 'Premation',
      userData: '/home/u/.config/Premation',
      env: { [ENV_PATH_VAR]: `/dev/plugins:${join('/home/u/.config/Premation', 'Plugins')}` },
    });
    expect(paths[0]).toEqual({ kind: 'env', dir: resolve('/dev/plugins') });
    // The second env entry IS the user folder — listed once, as the env entry.
    expect(paths.filter((p) => p.dir === resolve(join('/home/u/.config/Premation', 'Plugins')))).toHaveLength(1);
    expect(paths.some((p) => p.kind === 'machine')).toBe(true);
  });
});

describe('scanning', () => {
  const io = fakeIo({
    '/plugins/color-studio/plugin.json': '{"id":"color-studio"}',
    '/plugins/color-studio/main.js': 'export function activate() {}',
    // Nested under a vendor directory — found at depth 2.
    '/plugins/acme/fx-engine/plugin.json': '{"id":"fx-engine"}',
    // A package's own subdirectory holding a manifest-shaped fixture must not
    // become a second plugin.
    '/plugins/color-studio/fixtures/plugin.json': '{"id":"not-a-plugin"}',
    '/plugins/disabled()/plugin.json': '{"id":"off"}',
    '/plugins/~backup/plugin.json': '{"id":"backup"}',
    '/plugins/shipped.mplugin': 'PK\u0003\u0004…',
  });

  it('finds folders and archives, and honours the skip convention', async () => {
    const found = await scanPluginRoot({ kind: 'user', dir: '/plugins' }, io);
    const paths = found.map((f) => f.path.replace(/\\/g, '/')).sort();
    expect(paths).toEqual([
      '/plugins/acme/fx-engine',
      '/plugins/color-studio',
      '/plugins/shipped.mplugin',
    ]);
  });

  it('reads the manifest text for a folder and leaves an archive to the renderer', async () => {
    const found = await scanPluginRoot({ kind: 'user', dir: '/plugins' }, io);
    const folder = found.find((f) => f.kind === 'folder' && f.path.includes('color-studio'));
    expect(folder?.manifestText).toBe('{"id":"color-studio"}');
    expect(found.find((f) => f.kind === 'archive')?.manifestText).toBeNull();
  });

  it('carries the path kind through, so the UI can say where a plugin came from', async () => {
    const found = await scanPlugins([{ kind: 'machine', dir: '/plugins' }], io);
    expect(found.every((f) => f.source === 'machine')).toBe(true);
  });

  /*
    A signature lives BESIDE the archive, not inside it — it is over the
    archive's exact bytes, which something inside those bytes cannot be. The
    scanner picks it up so the renderer can verify before anything is unzipped.
  */
  it('picks up a .sig sidecar next to an archive', async () => {
    const signed = fakeIo({
      '/plugins/p.mplugin': 'PK…',
      '/plugins/p.mplugin.sig': '{"signature":"AAAA","publicKey":"BBBB"}',
    });
    const found = await scanPluginRoot({ kind: 'user', dir: '/plugins' }, signed);
    expect(found).toHaveLength(1);
    expect(found[0]!.signatureText).toBe('{"signature":"AAAA","publicKey":"BBBB"}');
  });

  it('leaves signatureText unset when there is no sidecar', async () => {
    const found = await scanPluginRoot({ kind: 'user', dir: '/plugins' }, io);
    expect(found.find((f) => f.kind === 'archive')?.signatureText).toBeUndefined();
  });

  it('stops at the depth limit', async () => {
    const deep = fakeIo({ '/p/a/b/c/d/e/plugin.json': '{}' });
    expect(await scanPluginRoot({ kind: 'user', dir: '/p' }, deep)).toEqual([]);
  });

  it('treats a missing root as empty rather than as a failure', async () => {
    expect(await scanPluginRoot({ kind: 'machine', dir: '/nope' }, io)).toEqual([]);
  });
});

describe('reading a package', () => {
  it('returns text and binaries separately, and reports what it skipped', async () => {
    const io = fakeIo({
      '/plugins/p/plugin.json': '{"id":"p"}',
      '/plugins/p/src/main.js': 'import "./util.js";',
      '/plugins/p/src/util.js': 'export const x = 1;',
      '/plugins/p/models/seg.onnx': new Uint8Array([1, 2, 3]),
      '/plugins/p/native/accel.node': new Uint8Array([9]),
      '/plugins/p/node_modules/dep/index.js': 'nope',
    });
    const read = await readLocalPackage('/plugins/p', io);
    expect(read.ok).toBe(true);
    expect(Object.keys(read.files ?? {}).sort()).toEqual(['plugin.json', 'src/main.js', 'src/util.js']);
    expect(read.binaries?.['models/seg.onnx']).toEqual(new Uint8Array([1, 2, 3]));
    expect(read.skipped).toEqual(['native/accel.node']);
  });

  it('refuses a file over the per-file ceiling', async () => {
    const io = fakeIo(
      { '/plugins/p/plugin.json': '{}', '/plugins/p/huge.bin': new Uint8Array([0]) },
      { '/plugins/p/huge.bin': LOCAL_MAX_FILE_BYTES + 1 },
    );
    const read = await readLocalPackage('/plugins/p', io);
    expect(read.ok).toBe(false);
    expect(read.error).toMatch(/huge\.bin is larger than/);
  });

  it('refuses a package with too many files', async () => {
    const tree: Record<string, string> = { '/plugins/p/plugin.json': '{}' };
    for (let i = 0; i < LOCAL_MAX_FILES + 1; i += 1) tree[`/plugins/p/f${i}.js`] = 'x';
    const read = await readLocalPackage('/plugins/p', fakeIo(tree));
    expect(read.ok).toBe(false);
    expect(read.error).toMatch(/more than \d+ files/);
  });

  it('hands an archive back as bytes, untouched', async () => {
    const io = fakeIo({ '/plugins/a.mplugin': new Uint8Array([0x50, 0x4b, 3, 4]) });
    const read = await readLocalPackage('/plugins/a.mplugin', io);
    expect(read.kind).toBe('archive');
    expect(read.bytes).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
  });

  it('refuses a file that is not a package', async () => {
    const io = fakeIo({ '/plugins/notes.txt': 'hello' });
    expect((await readLocalPackage('/plugins/notes.txt', io)).ok).toBe(false);
  });
});

describe('containment', () => {
  /*
    Without this, `plugins:read` is "read any file on this machine and hand it
    to the renderer as text". The renderer names the path.
  */
  it('accepts a path inside a root', () => {
    expect(isInsideRoots(join('/plugins', 'p'), ['/plugins'])).toBe(true);
    expect(isInsideRoots('/plugins', ['/plugins'])).toBe(true);
  });

  it('refuses a sibling whose name merely starts the same way', () => {
    expect(isInsideRoots('/plugins-evil/p', ['/plugins'])).toBe(false);
  });

  it('refuses a traversal out of the root', () => {
    expect(isInsideRoots(join('/plugins', '..', '..', 'etc', 'passwd'), ['/plugins'])).toBe(false);
  });

  it('refuses when there are no roots at all', () => {
    expect(isInsideRoots('/anything', [])).toBe(false);
  });
});
