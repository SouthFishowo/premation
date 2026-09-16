/**
 * The fake native bridge, shared.
 *
 * The same stand-in `nativeClient.test.ts` drives the seam with, lifted out so
 * the INTEGRATION tests can use the one fake rather than a second one that is
 * free to disagree with it about the ABI. There is exactly one description of
 * how a plugin's process behaves in a test, and it is this file.
 *
 * It is a bridge, not an addon: what it fakes is the preload's surface, so
 * everything above it — the trust gate, the scheduler, the lanes, the callers
 * wired into the kernel host and the generator scheduler — is the real code.
 * What an addon would compute is the `render` function handed in.
 */

import { recordNativeConsent } from './nativeTrust';
import type { NativeCallOutcome, NativeDescribe, NativeRequest } from './nativeAbi';
import type { PluginManifest } from '../manifest';

export const FAKE_NATIVE_ID = 'studio.acme.fx';
export const FAKE_NATIVE_HASH = 'c'.repeat(64);
export const FAKE_NATIVE_BINARY = 'bin/win32-x64/fx.node';

export const FAKE_NATIVE_MANIFEST = {
  id: FAKE_NATIVE_ID,
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
    platforms: { 'win32-x64': FAKE_NATIVE_BINARY },
  },
} as unknown as PluginManifest;

export const FAKE_NATIVE_LOAD_INPUT = {
  manifest: FAKE_NATIVE_MANIFEST,
  dir: 'C:/Plugins/acme-fx',
  hashes: { [FAKE_NATIVE_BINARY]: FAKE_NATIVE_HASH },
  signature: { ok: true, publisherKey: 'KEY' },
  developerMode: false,
};

/** The consent the trust gate looks for. Pinned to the hash, like a real one. */
export function allowFakeNative(): void {
  recordNativeConsent(FAKE_NATIVE_ID, {
    at: 1,
    version: '1.0.0',
    platformKey: 'win32-x64',
    binaryPath: FAKE_NATIVE_BINARY,
    sha256: FAKE_NATIVE_HASH,
    basis: 'signed',
  });
}

export interface FakeNativeBridge {
  platform: string;
  arch: string;
  load: jest.Mock;
  call: jest.Mock;
  unload: jest.Mock;
  status: jest.Mock;
  stage: jest.Mock;
  unstage: jest.Mock;
  staged: jest.Mock;
  onEvent: jest.Mock;
  /** Push a crash / disable / ready / stopped at every subscriber. */
  emit(event: { type: string; pluginId: string; message?: string; restarts?: number }): void;
  /** What `describe()` reports. Mutate before `loadNativePlugin`. */
  describe: NativeDescribe;
  /** What a call resolves to. Replace to make the addon answer differently. */
  render: (request: NativeRequest) => Promise<NativeCallOutcome> | NativeCallOutcome;
}

/**
 * Put a fake `window.motionEditor.pluginNative` in place.
 *
 * `present: false` installs a bridge-less build — the browser edition, where
 * there are no processes at all and every native call must degrade silently.
 */
export function installFakeNativeBridge(present = true): FakeNativeBridge {
  let handlers: Array<(e: unknown) => void> = [];

  const bridge: FakeNativeBridge = {
    platform: 'win32',
    arch: 'x64',
    describe: {
      name: 'Acme FX',
      version: '1.0.0',
      calls: ['effect', 'generate', 'invoke'],
      pixelFormat: 'f32-premul',
      threadSafety: 'full',
      effects: [{ id: 'exposure' }],
      generators: ['sparks'],
      methods: [],
    },
    render: () => ({ ok: false, code: 'no-such-call', error: 'the fake addon was given no render' }),
    load: jest.fn(async () => ({ ok: true, describe: bridge.describe })),
    call: jest.fn(async (request: { request: NativeRequest }) => bridge.render(request.request)),
    unload: jest.fn(async () => ({ ok: true })),
    status: jest.fn(async () => []),
    stage: jest.fn(async () => ({ ok: true, dir: 'C:/Staging/acme-fx/abc' })),
    unstage: jest.fn(async () => ({ ok: true })),
    staged: jest.fn(async () => []),
    onEvent: jest.fn((h: (e: unknown) => void) => {
      handlers.push(h);
      return () => { handlers = handlers.filter((f) => f !== h); };
    }),
    emit(event) {
      for (const h of [...handlers]) h(event);
    },
  };

  (window as unknown as { motionEditor?: unknown }).motionEditor = present
    ? { platform: 'win32', pluginNative: bridge }
    : { platform: 'win32' };
  return bridge;
}

export function removeFakeNativeBridge(): void {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
}
