/**
 * The scanner's one concession to the native tier.
 *
 * The rule C1 wrote still holds: compiled files are not carried. What is added
 * is narrow enough to state in three lines, and each one is a test here:
 *
 *   • A compiled file the manifest DECLARED comes back described — a path, a
 *     size and a SHA-256 — and never as bytes.
 *   • A compiled file the manifest did not declare is skipped and reported,
 *     exactly as before.
 *   • The hash is measured off disk, because it is what the consent step names
 *     and what the loader pins to.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  app: { getName: () => 'Premation', getPath: () => '/userData' },
  shell: { openPath: async () => '' },
}));

import { createHash } from 'node:crypto';
import { isNativeModuleFile, readLocalPackage, type LoaderIo } from './pluginLoader';

const BINARY = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
const BINARY_SHA = createHash('sha256').update(BINARY).digest('hex');

/** An in-memory tree, shaped like the one the loader walks. */
function fakeIo(tree: Record<string, string | Uint8Array>): LoaderIo {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const paths = Object.keys(tree).map(norm);
  return {
    readdir: async (dir) => {
      const prefix = `${norm(dir)}/`;
      const seen = new Map<string, boolean>();
      let exists = false;
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        exists = true;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(rest, false);
        else seen.set(rest.slice(0, slash), true);
      }
      if (!exists) throw new Error(`ENOENT ${dir}`);
      return [...seen].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory }));
    },
    stat: async (path) => {
      const key = norm(path);
      const value = tree[key] ?? tree[Object.keys(tree).find((k) => norm(k) === key) ?? ''];
      if (value === undefined) {
        if (paths.some((p) => p.startsWith(`${key}/`))) {
          return { size: 0, mtimeMs: 1, isDirectory: true };
        }
        throw new Error(`ENOENT ${path}`);
      }
      const size = typeof value === 'string' ? value.length : value.byteLength;
      return { size, mtimeMs: 1, isDirectory: false };
    },
    readFile: async (path) => {
      const key = norm(path);
      const value = tree[Object.keys(tree).find((k) => norm(k) === key) ?? ''];
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
    },
  };
}

const manifest = (native?: unknown): string =>
  JSON.stringify({ id: 'a.b', name: 'B', version: '1.0.0', main: 'index.js', ...(native ? { native } : {}) });

describe('recognising a compiled file', () => {
  it('knows the loadable images and the debug bundle beside them', () => {
    for (const name of ['fx.node', 'fx.dll', 'fx.so', 'fx.dylib', 'setup.exe', 'fx.dSYM', 'setup.msi']) {
      expect(isNativeModuleFile(name)).toBe(true);
    }
    for (const name of ['fx.wasm', 'fx.js', 'model.onnx']) {
      expect(isNativeModuleFile(name)).toBe(false);
    }
  });
});

describe('reading a package that declares one', () => {
  const tree = {
    '/plugins/fx/plugin.json': manifest({ abi: 1, platforms: { 'win32-x64': 'bin/win32-x64/fx.node' } }),
    '/plugins/fx/index.js': 'export function activate() {}',
    '/plugins/fx/bin/win32-x64/fx.node': BINARY,
  };

  it('describes the declared binary and returns none of its bytes', async () => {
    const read = await readLocalPackage('/plugins/fx', fakeIo(tree));
    expect(read.ok).toBe(true);
    expect(read.native).toEqual([
      { path: 'bin/win32-x64/fx.node', size: BINARY.byteLength, sha256: BINARY_SHA },
    ]);
    // The line that matters: compiled code never reaches the renderer.
    expect(read.binaries?.['bin/win32-x64/fx.node']).toBeUndefined();
    expect(read.files?.['bin/win32-x64/fx.node']).toBeUndefined();
    expect(read.skipped).toEqual([]);
  });

  it('skips and reports a compiled file the manifest did not declare', async () => {
    const read = await readLocalPackage('/plugins/fx', fakeIo({
      ...tree,
      '/plugins/fx/bin/win32-x64/helper.dll': BINARY,
    }));
    expect(read.native?.map((n) => n.path)).toEqual(['bin/win32-x64/fx.node']);
    // Reported rather than silently missing — a missing file reads as the
    // scanner being broken rather than as a tier boundary.
    expect(read.skipped).toEqual(['bin/win32-x64/helper.dll']);
  });

  it('treats every compiled file as undeclared when there is no native block', async () => {
    const read = await readLocalPackage('/plugins/fx', fakeIo({
      ...tree,
      '/plugins/fx/plugin.json': manifest(),
    }));
    expect(read.native).toBeUndefined();
    expect(read.skipped).toEqual(['bin/win32-x64/fx.node']);
  });

  it('treats a manifest that is not JSON the same way', async () => {
    const read = await readLocalPackage('/plugins/fx', fakeIo({
      ...tree,
      '/plugins/fx/plugin.json': '{ not json',
    }));
    expect(read.native).toBeUndefined();
    expect(read.skipped).toEqual(['bin/win32-x64/fx.node']);
  });

  it('matches a manifest path written with backslashes', async () => {
    const read = await readLocalPackage('/plugins/fx', fakeIo({
      ...tree,
      '/plugins/fx/plugin.json': manifest({ abi: 1, platforms: { 'win32-x64': '.\\bin\\win32-x64\\fx.node' } }),
    }));
    expect(read.native?.map((n) => n.path)).toEqual(['bin/win32-x64/fx.node']);
  });

  it('omits the field entirely for a package with no compiled files', async () => {
    const read = await readLocalPackage('/plugins/plain', fakeIo({
      '/plugins/plain/plugin.json': manifest(),
      '/plugins/plain/index.js': 'export function activate() {}',
    }));
    expect(read.ok).toBe(true);
    expect(read.native).toBeUndefined();
  });

  it('still refuses a binary past the per-file ceiling', async () => {
    const huge = new Uint8Array(0);
    const io = fakeIo({ ...tree, '/plugins/fx/bin/win32-x64/fx.node': huge });
    // Size comes from `stat`, so it is overridden rather than allocated.
    const wrapped: LoaderIo = {
      ...io,
      stat: async (path) => (path.endsWith('fx.node')
        ? { size: 1024 * 1024 * 1024, mtimeMs: 1, isDirectory: false }
        : io.stat(path)),
    };
    const read = await readLocalPackage('/plugins/fx', wrapped);
    expect(read.ok).toBe(false);
    expect(read.error).toContain('larger than');
  });
});
