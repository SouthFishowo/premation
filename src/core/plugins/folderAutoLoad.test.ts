/**
 * Re-reading the plugins folders at boot.
 *
 * This is the only path in the whole tier that installs something without
 * anybody pressing anything, so its boundary is the thing worth pinning. It may
 * replace an installed plugin with newer bytes of the SAME plugin under the
 * SAME grants — which is what makes a plugins folder a plugins folder rather
 * than an importer you re-run every session.
 *
 * It may not do anything else, and each of the three refusals below is a way a
 * file on disk could otherwise have widened what a plugin is allowed to do
 * without the user being asked.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useSelectionStore } from '@stores/selectionStore';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setDeveloperMode, resetDeveloperModeForTests } from './developerMode';
import { useFakeWorkers } from './fakeWorker.testkit';
import { parseManifest } from './manifest';
import type { DiscoveredLocalPlugin, LocalPackageRead } from '@app-types/motionEditor';

const ID = 'com.test.ondisk';

function manifestJson(version: string, permissions: string[] = []): string {
  return JSON.stringify({
    id: ID,
    name: 'On Disk',
    version,
    description: 'A plugin that lives in a folder.',
    apiVersion: 1,
    main: 'main.js',
    permissions,
  });
}

/** What the fake bridge will report on the next scan. */
const disk = { manifest: manifestJson('2.0.0') };

function installBridge(): void {
  (window as unknown as { motionEditor?: unknown }).motionEditor = {
    plugins: {
      paths: async () => [{ kind: 'user' as const, dir: '/plugins' }],
      scan: async (): Promise<DiscoveredLocalPlugin[]> => [{
        path: '/plugins/on-disk',
        kind: 'folder',
        source: 'user',
        root: '/plugins',
        manifestText: disk.manifest,
        modifiedAt: 1,
      }],
      read: async (): Promise<LocalPackageRead> => ({
        ok: true,
        kind: 'folder',
        files: { 'plugin.json': disk.manifest, 'main.js': 'export function activate() {}' },
        binaries: {},
      }),
      openFolder: async () => ({ ok: true, dir: '/plugins' }),
      watch: async () => ({ ok: true, watching: true }),
      onChanged: () => () => {},
    },
  };
}

/** Put version 1.0.0 in the store, as if the user had loaded it once. */
function installV1(permissions: string[] = []): void {
  const { manifest } = parseManifest(JSON.parse(manifestJson('1.0.0', permissions)));
  const err = pluginHost.install(
    { manifest: manifest!, files: { 'main.js': 'export function activate() {}' }, binaries: {} },
    manifest!.permissions,
    { source: 'folder' },
  );
  if (err) throw new Error(err);
}

/** Run boot, and let the folder pass (which is async and not awaited) finish. */
async function boot(): Promise<void> {
  pluginHost.configure({
    getSelection: () => useSelectionStore.getState().ids,
    showPanel: () => {},
    hidePanel: () => {},
  });
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeAll(async () => {
  seedDefaultScene();
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
});

afterAll(() => {
  pluginHost.setWorkerFactory(null);
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

beforeEach(() => {
  installBridge();
  resetDeveloperModeForTests();
  disk.manifest = manifestJson('2.0.0');
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
});

it('replaces an installed copy with the newer bytes on disk', async () => {
  setDeveloperMode(true);
  installV1();
  await boot();
  expect(usePluginStore.getState().get(ID)?.manifest.version).toBe('2.0.0');
});

it('does not load a folder the user has never installed', async () => {
  setDeveloperMode(true);
  await boot();
  expect(usePluginStore.getState().get(ID)).toBeUndefined();
});

/*
  The escalation this guard exists for: a folder plugin's manifest is a file its
  author edits between one launch and the next, so yesterday's grant cannot
  authorise today's wider ask. It waits in the panel for the consent screen.
*/
it('does not load a copy whose manifest grew a permission', async () => {
  setDeveloperMode(true);
  installV1();
  disk.manifest = manifestJson('2.0.0', ['scene:write']);
  await boot();
  expect(usePluginStore.getState().get(ID)?.manifest.version).toBe('1.0.0');
});

it('does not load unsigned bytes while developer mode is off', async () => {
  installV1();
  await boot();
  expect(usePluginStore.getState().get(ID)?.manifest.version).toBe('1.0.0');
});

it('does nothing at all in a build with no filesystem bridge', async () => {
  setDeveloperMode(true);
  installV1();
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  await boot();
  expect(usePluginStore.getState().get(ID)?.manifest.version).toBe('1.0.0');
});
