/**
 * The plugin host's half of the native tier.
 *
 * Everything the tier can do was already built and tested; what is asserted
 * here is that the app ever asks it to. Four hooks, and each one is a failure
 * that is invisible when it is missing:
 *
 *   • an install brings a declared module UP — otherwise the tier exists and no
 *     plugin ever reaches it;
 *   • a crash lands in the plugin's OWN log, which is the surface an author
 *     opens when their effect stopped working — otherwise a process dies and
 *     the editor says nothing anywhere;
 *   • uninstall, disable and a registry takedown all kill the process —
 *     otherwise "off" and "withdrawn" describe only the sandboxed half of a
 *     plugin, while native code keeps running;
 *   • staged binaries are collected — otherwise a profile accumulates a copy of
 *     every addon ever installed, named after a hash nothing will load again.
 *
 * A plugin with no `native` block must take none of these paths, which is the
 * last assertion in each group.
 */

import { webcrypto } from 'node:crypto';
import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useSelectionStore } from '@stores/selectionStore';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { useFakeWorkers, testPackage } from './fakeWorker.testkit';
import { parseManifest } from './manifest';
import {
  resetRevocationsForTests,
  seedRevocationsForTests,
  type RevocationList,
} from './revocation';
import {
  FAKE_NATIVE_BINARY,
  FAKE_NATIVE_HASH,
  FAKE_NATIVE_ID,
  allowFakeNative,
  installFakeNativeBridge,
  removeFakeNativeBridge,
  type FakeNativeBridge,
} from './native/nativeBridge.testkit';
import { nativeStatus, resetNativeClientForTests } from './native/nativeClient';
import { resetNativeConsentForTests } from './native/nativeTrust';
import { resetNativeSchedulerForTests } from './native/nativeScheduler';
import type { PluginPackage } from './pluginPackage';

// `sha256Hex` goes through WebCrypto, which this jsdom build does not carry.
// Node's own is the same implementation the renderer would use.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const MAIN = 'export function activate() {}';

/** The example SDK package's shape: one effect, one declared binary. */
function nativePackage(binaryBytes?: Uint8Array): PluginPackage {
  const { manifest, errors } = parseManifest({
    id: FAKE_NATIVE_ID,
    name: 'Acme FX',
    version: '1.0.0',
    description: 'A plugin with a compiled module.',
    apiVersion: 1,
    main: 'main.js',
    permissions: [],
    native: { abi: 1, platforms: { 'win32-x64': FAKE_NATIVE_BINARY } },
  });
  if (!manifest) throw new Error(errors.join(' '));
  return {
    manifest,
    files: { 'main.js': MAIN },
    ...(binaryBytes ? { binaries: { [FAKE_NATIVE_BINARY]: binaryBytes } } : { binaries: {} }),
  };
}

/** The `{ dir, hashes }` a folder read produces (`loadLocalPackage`). */
const FOLDER = { dir: 'C:/Plugins/acme-fx', hashes: { [FAKE_NATIVE_BINARY]: FAKE_NATIVE_HASH } };

let bridge: FakeNativeBridge;

/** Let `install`'s fire-and-forget native bring-up finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

beforeAll(async () => {
  seedDefaultScene();
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
});

afterAll(() => {
  pluginHost.setWorkerFactory(null);
  pluginHost.stopWatchingNative();
  removeFakeNativeBridge();
});

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetRevocationsForTests();
  resetNativeClientForTests();
  resetNativeConsentForTests();
  resetNativeSchedulerForTests(null);
  bridge = installFakeNativeBridge();
  allowFakeNative();
});

// ── Install ──────────────────────────────────────────────────────────────────

describe('installing brings a declared module up', () => {
  it('loads a folder package where it lies, with the hashes the scan measured', async () => {
    expect(pluginHost.install(nativePackage(), [], { source: 'folder', publisherKey: 'KEY', native: FOLDER })).toBeNull();
    await settle();

    expect(bridge.load).toHaveBeenCalledTimes(1);
    expect(bridge.load.mock.calls[0]![0]).toMatchObject({
      pluginId: FAKE_NATIVE_ID,
      dir: FOLDER.dir,
      binaryPath: FAKE_NATIVE_BINARY,
      sha256: FAKE_NATIVE_HASH,
      abi: 1,
    });
    expect(bridge.stage).not.toHaveBeenCalled();
    expect(nativeStatus(FAKE_NATIVE_ID)?.loaded).toBe(true);
  });

  it('stages an archive\'s binary first, and loads the staged name', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    // Consent is pinned to the bytes, so it has to be pinned to THESE.
    const digest = await webcrypto.subtle.digest('SHA-256', Buffer.from(bytes));
    const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    resetNativeConsentForTests();
    const { recordNativeConsent } = await import('./native/nativeTrust');
    recordNativeConsent(FAKE_NATIVE_ID, {
      at: 1, version: '1.0.0', platformKey: 'win32-x64',
      binaryPath: 'fx.node', sha256: sha, basis: 'signed',
    });

    expect(pluginHost.install(nativePackage(bytes), [], { source: 'file', publisherKey: 'KEY' })).toBeNull();
    await settle();

    expect(bridge.stage).toHaveBeenCalledTimes(1);
    expect(bridge.stage.mock.calls[0]![0]).toMatchObject({ pluginId: FAKE_NATIVE_ID, relPath: FAKE_NATIVE_BINARY, sha256: sha });
    // The staged file's BARE name, in the staging directory — not the author's
    // path inside the zip, which means nothing once the file is out of it.
    expect(bridge.load.mock.calls[0]![0]).toMatchObject({
      dir: 'C:/Staging/acme-fx/abc',
      binaryPath: 'fx.node',
      sha256: sha,
    });
  });

  it('touches nothing for a plugin with no native block', async () => {
    expect(pluginHost.install(testPackage([]), [])).toBeNull();
    await settle();
    expect(bridge.load).not.toHaveBeenCalled();
    expect(bridge.stage).not.toHaveBeenCalled();
  });

  it('installs anyway, and says why, when the module will not load', async () => {
    bridge.load.mockResolvedValueOnce({ ok: false, code: 'abi-mismatch', error: 'built for ABI 2.0' });
    expect(pluginHost.install(nativePackage(), [], { source: 'folder', publisherKey: 'KEY', native: FOLDER })).toBeNull();
    await settle();

    expect(usePluginStore.getState().get(FAKE_NATIVE_ID)).toBeDefined();
    expect(pluginHost.log(FAKE_NATIVE_ID).map((l) => l.text).join('\n')).toMatch(/ABI 2\.0/);
  });
});

// ── Crashes in the log ───────────────────────────────────────────────────────

describe('what the process does reaches the plugin\'s own log', () => {
  const boot = (): void => {
    pluginHost.configure({
      getSelection: () => useSelectionStore.getState().ids,
      showPanel: () => {},
      hidePanel: () => {},
    });
  };

  it('records a crash and the session disable, one line each', async () => {
    pluginHost.install(nativePackage(), [], { source: 'folder', publisherKey: 'KEY', native: FOLDER });
    await settle();
    boot();

    bridge.emit({ type: 'crashed', pluginId: FAKE_NATIVE_ID, message: 'SIGSEGV', restarts: 1 });
    bridge.emit({ type: 'crashed', pluginId: FAKE_NATIVE_ID, message: 'SIGSEGV', restarts: 2 });
    bridge.emit({ type: 'crashed', pluginId: FAKE_NATIVE_ID, message: 'SIGSEGV', restarts: 3 });
    bridge.emit({
      type: 'disabled',
      pluginId: FAKE_NATIVE_ID,
      message: 'native module: it crashed 3 times and is off for this session.',
    });

    const lines = pluginHost.log(FAKE_NATIVE_ID).filter((l) => l.text.includes('native module'));
    expect(lines).toHaveLength(4);
    expect(lines[2]!.text).toMatch(/SIGSEGV.*restart 3/);
    expect(lines[3]!.text).toMatch(/off for this session/);
    expect(lines.every((l) => l.level === 'error')).toBe(true);
    // And the tier agrees it is off.
    expect(nativeStatus(FAKE_NATIVE_ID)?.disabled).toBe(true);
  });

  it('does not log a process merely starting or idling out', async () => {
    pluginHost.install(nativePackage(), [], { source: 'folder', publisherKey: 'KEY', native: FOLDER });
    await settle();
    boot();
    const before = pluginHost.log(FAKE_NATIVE_ID).length;

    bridge.emit({ type: 'stopped', pluginId: FAKE_NATIVE_ID });
    bridge.emit({ type: 'ready', pluginId: FAKE_NATIVE_ID });

    expect(pluginHost.log(FAKE_NATIVE_ID)).toHaveLength(before);
  });
});

// ── Killing the process ──────────────────────────────────────────────────────

describe('off means off, for the compiled half too', () => {
  beforeEach(async () => {
    pluginHost.install(nativePackage(), [], { source: 'folder', publisherKey: 'KEY', native: FOLDER });
    await settle();
    bridge.unload.mockClear();
    bridge.unstage.mockClear();
  });

  it('uninstall kills the process and deletes what was staged', async () => {
    pluginHost.uninstall(FAKE_NATIVE_ID);
    await settle();
    expect(bridge.unload).toHaveBeenCalledWith(FAKE_NATIVE_ID, 'revoked');
    expect(bridge.unstage).toHaveBeenCalledWith(FAKE_NATIVE_ID);
  });

  it('disabling kills the process', async () => {
    pluginHost.setEnabled(FAKE_NATIVE_ID, false);
    await settle();
    expect(bridge.unload).toHaveBeenCalledWith(FAKE_NATIVE_ID, 'revoked');
    expect(nativeStatus(FAKE_NATIVE_ID)).toBeNull();
  });

  it('a registry takedown kills the process', async () => {
    const list: RevocationList = {
      seq: 1,
      issuedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      entries: [{ id: FAKE_NATIVE_ID, reason: 'Exfiltrated project data.' }],
    };
    seedRevocationsForTests(list);

    pluginHost.configure({
      getSelection: () => useSelectionStore.getState().ids,
      showPanel: () => {},
      hidePanel: () => {},
    });
    await settle();

    expect(usePluginStore.getState().get(FAKE_NATIVE_ID)?.enabled).toBe(false);
    expect(bridge.unload).toHaveBeenCalledWith(FAKE_NATIVE_ID, 'revoked');
  });
});

// ── The staging sweep ────────────────────────────────────────────────────────

describe('staged binaries are collected', () => {
  it('deletes a staging directory whose plugin is gone, and leaves the rest', async () => {
    pluginHost.install(nativePackage(), [], { source: 'folder', publisherKey: 'KEY', native: FOLDER });
    await settle();
    bridge.unstage.mockClear();
    bridge.staged.mockResolvedValue([FAKE_NATIVE_ID, 'com.gone.one', 'com.gone.two']);

    pluginHost.configure({
      getSelection: () => useSelectionStore.getState().ids,
      showPanel: () => {},
      hidePanel: () => {},
    });
    await settle();

    const swept = bridge.unstage.mock.calls.map((c) => c[0] as string);
    expect(swept).toEqual(['com.gone.one', 'com.gone.two']);
    // Never the installed one: a sweep that could delete a live plugin's binary
    // would be a boot that breaks the plugin it was tidying up after.
    expect(swept).not.toContain(FAKE_NATIVE_ID);
  });
});
