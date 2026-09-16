/**
 * The seam the rest of the app calls, against a fake bridge.
 *
 * Two properties are pinned, and the second is the one that keeps the editor
 * usable:
 *
 *   • Nothing reaches the bridge until it is allowed to. An unsigned package,
 *     one with no consent, one revoked, one built for another machine — none of
 *     them produces a `load` call at all. The refusal happens on this side,
 *     where the manifest and the revocation list are.
 *   • Every failure DEGRADES to `null`. A plugin that is absent, refused,
 *     crashed, benched or built for another platform is indistinguishable at
 *     the call site from one that simply has no native module, because there is
 *     nothing a render can do differently about any of them.
 */

import { loadNativePlugin, nativeReady, resetNativeClientForTests, runNativeEffect, nativeStatus, killNativePlugin, unloadNativePlugin, watchNativeEvents } from './nativeClient';
import { recordNativeConsent, resetNativeConsentForTests } from './nativeTrust';
import { resetNativeSchedulerForTests } from './nativeScheduler';
import type { PluginManifest } from '../manifest';

const HASH = 'c'.repeat(64);

const MANIFEST = {
  id: 'studio.acme.fx',
  name: 'Acme FX',
  version: '1.0.0',
  description: 'fast things',
  apiVersion: 7,
  runtime: 'sandboxed',
  main: 'index.js',
  permissions: [],
  contributes: {},
  activationEvents: ['onStartup'],
  native: {
    abi: 1,
    platforms: { 'win32-x64': 'bin/win32-x64/fx.node' },
  },
} as unknown as PluginManifest;

interface FakeBridge {
  platform: string;
  arch: string;
  load: jest.Mock;
  call: jest.Mock;
  unload: jest.Mock;
  status: jest.Mock;
  stage: jest.Mock;
  unstage: jest.Mock;
  onEvent: jest.Mock;
}

let bridge: FakeBridge;
let eventHandlers: Array<(e: unknown) => void>;

function installBridge(present = true): void {
  eventHandlers = [];
  bridge = {
    platform: 'win32',
    arch: 'x64',
    load: jest.fn().mockResolvedValue({
      ok: true,
      describe: { name: 'Acme FX', version: '1.0.0', calls: ['effect'], pixelFormat: 'f32-premul', threadSafety: 'full', effects: [], generators: [], methods: [] },
    }),
    call: jest.fn(),
    unload: jest.fn().mockResolvedValue({ ok: true }),
    status: jest.fn().mockResolvedValue([]),
    stage: jest.fn(),
    unstage: jest.fn(),
    onEvent: jest.fn((h: (e: unknown) => void) => {
      eventHandlers.push(h);
      return () => { eventHandlers = eventHandlers.filter((f) => f !== h); };
    }),
  };
  (window as unknown as { motionEditor?: unknown }).motionEditor = present
    ? { platform: 'win32', pluginNative: bridge }
    : { platform: 'win32' };
}

function allowed(): void {
  recordNativeConsent(MANIFEST.id, {
    at: 1,
    version: '1.0.0',
    platformKey: 'win32-x64',
    binaryPath: 'bin/win32-x64/fx.node',
    sha256: HASH,
    basis: 'signed',
  });
}

const INPUT = {
  manifest: MANIFEST,
  dir: 'C:/Plugins/acme-fx',
  hashes: { 'bin/win32-x64/fx.node': HASH },
  signature: { ok: true, publisherKey: 'KEY' },
  developerMode: false,
};

beforeEach(() => {
  resetNativeClientForTests();
  resetNativeConsentForTests();
  resetNativeSchedulerForTests(null);
  installBridge();
});

describe('refusals that never reach the bridge', () => {
  it('says so, once, when the build has no native tier', async () => {
    installBridge(false);
    const status = await loadNativePlugin(INPUT);
    expect(status).toMatchObject({ loaded: false, code: 'no-native-tier' });
  });

  it('lists a package built for other machines as unavailable, not broken', async () => {
    bridge.platform = 'linux';
    const status = await loadNativePlugin(INPUT);
    expect(status).toMatchObject({
      loaded: false,
      code: 'unsupported-platform',
      unavailableHere: true,
      availablePlatforms: ['win32-x64'],
    });
    expect(bridge.load).not.toHaveBeenCalled();
  });

  it('refuses an unsigned package without asking main to load anything', async () => {
    const status = await loadNativePlugin({ ...INPUT, signature: null });
    expect(status).toMatchObject({ loaded: false, code: 'not-signed' });
    expect(bridge.load).not.toHaveBeenCalled();
  });

  it('stops at the consent step and marks it askable', async () => {
    const status = await loadNativePlugin(INPUT);
    expect(status).toMatchObject({ loaded: false, code: 'no-consent', askable: true });
    expect(bridge.load).not.toHaveBeenCalled();
  });

  it('does nothing at all for a package with no native block', async () => {
    const { native: _native, ...plain } = MANIFEST as PluginManifest & { native?: unknown };
    const status = await loadNativePlugin({ ...INPUT, manifest: plain as PluginManifest });
    expect(status).toMatchObject({ code: 'not-declared' });
  });
});

describe('loading', () => {
  it('hands main the directory, the path and the hash consent was pinned to', async () => {
    allowed();
    const status = await loadNativePlugin(INPUT);
    expect(bridge.load).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'studio.acme.fx',
      dir: 'C:/Plugins/acme-fx',
      binaryPath: 'bin/win32-x64/fx.node',
      sha256: HASH,
      abi: 1,
    }));
    expect(status).toMatchObject({ loaded: true });
    expect(status.describe?.calls).toEqual(['effect']);
  });

  it('carries main\'s own refusal through — it hashes the file, we do not', async () => {
    allowed();
    bridge.load.mockResolvedValue({ ok: false, code: 'hash-mismatch', error: 'not the one you allowed' });
    const status = await loadNativePlugin(INPUT);
    expect(status).toMatchObject({ loaded: false, code: 'hash-mismatch' });
  });
});

describe('calling an effect', () => {
  const pixels = () => new Uint8ClampedArray([1, 2, 3, 255]);

  it('does nothing when the plugin is not up', async () => {
    await expect(runNativeEffect({
      pluginId: MANIFEST.id,
      effectId: 'exposure',
      instanceId: 'i1',
      pixels: pixels(),
      width: 1,
      height: 1,
      params: {},
      host: {} as never,
    })).resolves.toBeNull();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('returns the pixels the addon wrote', async () => {
    allowed();
    await loadNativePlugin(INPUT);
    const out = new Uint8ClampedArray([9, 9, 9, 255]);
    bridge.call.mockResolvedValue({ ok: true, result: { call: 'effect', pixels: out }, elapsedMs: 2 });

    const result = await runNativeEffect({
      pluginId: MANIFEST.id,
      effectId: 'exposure',
      instanceId: 'i1',
      pixels: pixels(),
      width: 1,
      height: 1,
      params: { stops: 1 },
      host: {} as never,
    });
    expect(result).toBe(out);
  });

  it('hands the caller its OWN buffer back for an identity answer', async () => {
    allowed();
    await loadNativePlugin(INPUT);
    bridge.call.mockResolvedValue({ ok: true, result: { call: 'effect', identity: true }, elapsedMs: 1 });

    const mine = pixels();
    // The whole saving: no copy of the frame in either direction.
    await expect(runNativeEffect({
      pluginId: MANIFEST.id,
      effectId: 'exposure',
      instanceId: 'i1',
      pixels: mine,
      width: 1,
      height: 1,
      params: {},
      host: {} as never,
    })).resolves.toBe(mine);
  });

  it('degrades to null when the call fails, rather than throwing into a render', async () => {
    allowed();
    await loadNativePlugin(INPUT);
    bridge.call.mockResolvedValue({ ok: false, code: 'crashed', error: 'the process stopped' });
    await expect(runNativeEffect({
      pluginId: MANIFEST.id,
      effectId: 'exposure',
      instanceId: 'i1',
      pixels: pixels(),
      width: 1,
      height: 1,
      params: {},
      host: {} as never,
    })).resolves.toBeNull();
  });

  it('does not try a call the addon never said it implements', async () => {
    allowed();
    await loadNativePlugin(INPUT);
    expect(nativeReady(MANIFEST.id, 'effect')).toBe(true);
    expect(nativeReady(MANIFEST.id, 'generate')).toBe(false);
  });
});

describe('what the process tells us afterwards', () => {
  it('turns a crash into a status, without a call having failed', async () => {
    allowed();
    await loadNativePlugin(INPUT);
    const stop = watchNativeEvents();

    // Crashes happen to idle processes as often as to busy ones, which is why
    // this arrives as an event rather than as a failed call.
    for (const h of eventHandlers) h({ type: 'crashed', pluginId: MANIFEST.id, message: 'exited with 139', restarts: 1 });
    expect(nativeStatus(MANIFEST.id)).toMatchObject({ loaded: false, code: 'crashed', restarts: 1 });

    for (const h of eventHandlers) h({ type: 'disabled', pluginId: MANIFEST.id, message: 'off for this session' });
    expect(nativeStatus(MANIFEST.id)).toMatchObject({ disabled: true, code: 'disabled' });
    stop();
  });
});

describe('taking a plugin away', () => {
  it('unloads and forgets it', async () => {
    allowed();
    await loadNativePlugin(INPUT);
    await unloadNativePlugin(MANIFEST.id, 'uninstall');
    expect(bridge.unload).toHaveBeenCalledWith(MANIFEST.id, 'uninstall');
    expect(nativeStatus(MANIFEST.id)).toBeNull();
  });

  it('drops consent AND kills the process when it is revoked', async () => {
    allowed();
    await loadNativePlugin(INPUT);
    await killNativePlugin(MANIFEST.id);
    expect(bridge.unload).toHaveBeenCalledWith(MANIFEST.id, 'revoked');
    // Consent gone, so nothing starts it again on the next scan.
    const after = await loadNativePlugin(INPUT);
    expect(after).toMatchObject({ code: 'no-consent' });
  });
});
