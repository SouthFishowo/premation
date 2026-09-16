/**
 * The two halves of "a package is more than one file": what the host SENDS to
 * the sandbox at boot, and what it hands back when a plugin asks for one of its
 * own files.
 *
 * `moduleGraph.test.ts` covers the planning; this covers the wiring, because
 * the planner being right is worth nothing if the boot message still carries
 * one module, or if `package.read` can be talked into reaching outside the
 * package it belongs to.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useSelectionStore } from '@stores/selectionStore';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { FakeWorker, useFakeWorkers, testPackage, bootPlugin } from './fakeWorker.testkit';
import type { PluginPackage } from './pluginPackage';

/** The base package, plus whatever files a case needs. */
function withFiles(
  files: Record<string, string>,
  binaries: Record<string, Uint8Array> = {},
): PluginPackage {
  const base = testPackage([]);
  return { ...base, files: { ...base.files, ...files }, binaries };
}

beforeAll(async () => {
  seedDefaultScene();
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  pluginHost.configure({
    getSelection: () => useSelectionStore.getState().ids,
    showPanel: () => {},
    hidePanel: () => {},
  });
});

afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  FakeWorker.last = null;
});

describe('the boot message', () => {
  it('carries every text file and names the entry', () => {
    const w = bootPlugin(withFiles({ 'lib/util.js': 'export const x = 1;' }));
    const boot = w.sent.find((m) => m.k === 'boot');
    expect(boot && boot.k === 'boot' && boot.entry).toBe('main.js');
    expect(boot && boot.k === 'boot' && Object.keys(boot.files ?? {})).toEqual(
      expect.arrayContaining(['main.js', 'lib/util.js']),
    );
  });

  /*
    Binaries stay out on purpose. A package may carry hundreds of megabytes of
    model weights, and structured-cloning all of it into the worker at every
    boot would cost the whole payload per start — for files the plugin may never
    open.
  */
  it('does not send binaries', () => {
    const w = bootPlugin(withFiles({}, { 'model.onnx': new Uint8Array([1, 2, 3]) }));
    const boot = w.sent.find((m) => m.k === 'boot');
    expect(boot && boot.k === 'boot' && boot.files?.['model.onnx']).toBeUndefined();
  });
});

describe('the installed record', () => {
  /*
    `install` built the record without `binaries`, so every asset a package
    shipped was dropped on the way in — harmless until something could read one.
  */
  it('keeps the binaries the package shipped', () => {
    bootPlugin(withFiles({}, { 'look.cube': new Uint8Array([7, 7]) }));
    expect(usePluginStore.getState().get('com.test.plugin')?.binaries?.['look.cube'])
      .toEqual(new Uint8Array([7, 7]));
  });
});

describe('package.read', () => {
  it('returns a binary file as bytes', async () => {
    const w = bootPlugin(withFiles({}, { 'model.onnx': new Uint8Array([1, 2, 3, 4]) }));
    const reply = await w.callAsync('package.read', 'model.onnx');
    expect(reply.ok).toBe(true);
    expect(reply.ok && new Uint8Array(reply.value as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  /*
    The reply is TRANSFERRED, so serving the stored array itself would neuter
    the installed record — the second read of the same file would come back
    empty, with nothing in the message to say why.
  */
  it('can be read twice — the stored copy is not handed away', async () => {
    const w = bootPlugin(withFiles({}, { 'model.onnx': new Uint8Array([9]) }));
    await w.callAsync('package.read', 'model.onnx');
    const second = await w.callAsync('package.read', 'model.onnx');
    expect(second.ok && new Uint8Array(second.value as ArrayBuffer)).toEqual(new Uint8Array([9]));
  });

  it('returns a text file as text when asked', async () => {
    const w = bootPlugin(withFiles({ 'shaders/blur.wgsl': '@fragment fn main() {}' }));
    const reply = await w.callAsync('package.read', 'shaders/blur.wgsl', 'text');
    expect(reply.ok && reply.value).toBe('@fragment fn main() {}');
  });

  it('encodes a text file when bytes were asked for', async () => {
    const w = bootPlugin(withFiles({ 'data.json': '{"a":1}' }));
    const reply = await w.callAsync('package.read', 'data.json', 'bytes');
    expect(reply.ok && new TextDecoder().decode(reply.value as ArrayBuffer)).toBe('{"a":1}');
  });

  it('refuses a file that is not in the package', async () => {
    const w = bootPlugin(withFiles({}));
    const reply = await w.callAsync('package.read', 'secrets.txt');
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error).toMatch(/not in this plugin's package/);
  });

  /*
    The containment claim, stated as a test. There is no path here that is not
    a key of the package record: `..` folds away, and what is left either names
    a file the package shipped or names nothing.
  */
  it.each(['../../etc/passwd', '/etc/passwd', '../other-plugin/main.js'])(
    'cannot escape the package with %p',
    async (path) => {
      const w = bootPlugin(withFiles({}));
      const reply = await w.callAsync('package.read', path);
      expect(reply.ok).toBe(false);
    },
  );

  it('refuses a path that is not a string', async () => {
    const w = bootPlugin(withFiles({}));
    const reply = await w.callAsync('package.read', 42);
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error).toMatch(/needs the path/);
  });

  it('refuses an unknown encoding rather than guessing', async () => {
    const w = bootPlugin(withFiles({ 'data.json': '{}' }));
    const reply = await w.callAsync('package.read', 'data.json', 'utf-16');
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error).toMatch(/"text" or "bytes"/);
  });

  it('needs no permission — a plugin granted nothing can read its own files', async () => {
    const w = bootPlugin(withFiles({ 'note.txt': 'hello' }), { granted: [] });
    const reply = await w.callAsync('package.read', 'note.txt', 'text');
    expect(reply.ok && reply.value).toBe('hello');
  });
});
