/**
 * The native tier, wired into the app it was built for.
 *
 * Everything below this file has its own tests — the ABI, the trust gate, the
 * scheduler's lanes, the supervisor's restart arithmetic. What none of them can
 * say is whether any of it is REACHED, and that is what the five hooks here are
 * and what this file pins:
 *
 *   1. an effect kernel actually runs in the addon, and falls back to the
 *      plugin's JavaScript when the addon will not;
 *   2. a generator frame comes out of the addon and through the scheduler that
 *      owns determinism, with none of its rules bent for it;
 *   3. an export awaits native work and REFUSES a frame it could not get,
 *      instead of shipping whatever the fallback left behind;
 *   4. a crash reaches the plugin's own log, which is the surface an author
 *      opens when their effect stopped working;
 *   5. a takedown kills a live process, not only the sandboxed half.
 *
 * Driven through the shared fake bridge (`nativeBridge.testkit`), so everything
 * between the call site and the preload — the gate, the lanes, the budget, the
 * buffer hand-off — is the real code.
 */

import {
  FAKE_NATIVE_ID,
  FAKE_NATIVE_LOAD_INPUT,
  allowFakeNative,
  installFakeNativeBridge,
  removeFakeNativeBridge,
  type FakeNativeBridge,
} from './nativeBridge.testkit';
import {
  loadNativePlugin,
  nativeReady,
  nativeStatus,
  invokeNative,
  resetNativeClientForTests,
  watchNativeEvents,
} from './nativeClient';
import { resetNativeConsentForTests } from './nativeTrust';
import { nativeScheduler, resetNativeSchedulerForTests } from './nativeScheduler';
import {
  runEffectKernel,
  setPackageReader,
  resetKernelHostForTests,
} from '../kernel/kernelHost';
import { setKernelSchedulerForTests } from '../kernel/kernelPool';
import {
  requestGeneratorFrame,
  resetGeneratorsForTests,
  setGeneratorRunner,
  settleGenerators,
  takeGeneratorErrors,
} from '../generator/generatorScheduler';
import type { NativeCallOutcome } from './nativeAbi';
import type { EffectContribution } from '../effectSchema';
import type { KernelJob } from '../kernel/kernelTypes';

const HOST: KernelJob['host'] = {
  compWidth: 64, compHeight: 64, layerWidth: 2, layerHeight: 1,
  time: 1, compTime: 1, frame: 24, fps: 24, pixelScale: 1, downsample: 1, seed: 0.5,
};

/** The plugin's JavaScript twin of the same effect — what the fallback runs. */
const FALLBACK_KERNEL = `
exports.render = function (input, output) {
  output.set(input);
  globalThis.__fallbackRan = (globalThis.__fallbackRan || 0) + 1;
};`;

const EFFECT = {
  id: 'exposure',
  label: 'Exposure',
  shader: '',
  threadSafety: 'full',
  cpu: { module: 'fallback.js', entry: 'render', format: 'js' },
  params: {},
} as unknown as EffectContribution;

let bridge: FakeNativeBridge;

async function bringUp(): Promise<void> {
  allowFakeNative();
  const status = await loadNativePlugin(FAKE_NATIVE_LOAD_INPUT);
  expect(status.loaded).toBe(true);
}

beforeEach(() => {
  resetNativeClientForTests();
  resetNativeConsentForTests();
  resetNativeSchedulerForTests(null);
  resetKernelHostForTests();
  setKernelSchedulerForTests(null);
  resetGeneratorsForTests();
  delete (globalThis as Record<string, unknown>).__fallbackRan;
  bridge = installFakeNativeBridge();
});

afterEach(() => {
  setKernelSchedulerForTests(undefined);
  removeFakeNativeBridge();
});

// ── 1. Effect kernels ────────────────────────────────────────────────────────

describe('a native effect reaches the kernel host\'s caller', () => {
  const pixels = (): Uint8ClampedArray => new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);

  const run = (): Promise<Uint8ClampedArray | null> => runEffectKernel({
    pluginId: FAKE_NATIVE_ID,
    effect: EFFECT,
    effectId: `${FAKE_NATIVE_ID}.exposure`,
    instanceId: 'fx_1',
    pixels: pixels(),
    width: 2,
    height: 1,
    params: { stops: 1 },
    host: HOST,
  });

  it('runs the addon and hands its pixels back', async () => {
    await bringUp();
    bridge.render = () => ({
      ok: true,
      elapsedMs: 1,
      result: { call: 'effect', pixels: new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 255]) },
    });

    const out = await run();
    expect([...(out ?? [])]).toEqual([9, 9, 9, 255, 9, 9, 9, 255]);
    // The plugin-local id, not the namespaced one: an addon matches on the id
    // it registered, and `<pluginId>.<id>` is the host's own attribution string.
    expect(bridge.call.mock.calls[0]![0].request).toMatchObject({
      call: 'effect',
      effectId: 'exposure',
      instanceId: 'fx_1',
      params: { stops: 1 },
    });
  });

  it('keeps the caller\'s own buffer when the addon reports identity', async () => {
    await bringUp();
    bridge.render = () => ({ ok: true, elapsedMs: 1, result: { call: 'effect', identity: true } });
    const out = await run();
    expect([...(out ?? [])]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('falls through to the plugin\'s JavaScript when the addon refuses', async () => {
    await bringUp();
    setPackageReader({ read: async () => FALLBACK_KERNEL });
    bridge.render = () => ({ ok: false, code: 'failed', error: 'the addon threw' });

    const out = await run();
    expect(globalThis.__fallbackRan).toBe(1);
    expect([...(out ?? [])]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('asks nothing at all when the plugin has no native module', async () => {
    setPackageReader({ read: async () => FALLBACK_KERNEL });
    const out = await run();
    expect(bridge.call).not.toHaveBeenCalled();
    expect(globalThis.__fallbackRan).toBe(1);
    expect(out).not.toBeNull();
  });
});

// ── 2. Generator frames ──────────────────────────────────────────────────────

describe('a native generator frame reaches the scheduler', () => {
  const demand = (frame: number) => ({
    layerId: 'L1',
    pluginId: FAKE_NATIVE_ID,
    kindId: 'sparks',
    request: {
      layerTime: frame / 24,
      compTime: frame / 24,
      frame,
      fps: 24,
      compSize: { width: 64, height: 64 },
      layerSize: { width: 32, height: 32 },
      params: {},
      seed: 7,
    },
    exact: true,
  });

  const instances = (x: number): Float32Array =>
    new Float32Array([x, 0, 0, 4, 0, 1, 1, 1, 1]);

  it('produces the frame from the addon, through the same validator', async () => {
    await bringUp();
    const worker = jest.fn();
    setGeneratorRunner({ generate: worker });
    bridge.render = (request) => ({
      ok: true,
      elapsedMs: 1,
      result: {
        call: 'generate',
        instances: instances((request as { frame: number }).frame),
        count: 1,
        primitive: 'point',
      },
    });

    expect(requestGeneratorFrame(demand(3))).toBeNull(); // nothing produced yet
    expect(await settleGenerators(2000)).toEqual([]);
    const frame = requestGeneratorFrame(demand(3));
    expect(frame?.count).toBe(1);
    expect(frame?.instances[0]).toBe(3);
    // The plugin's Worker was never asked: the addon answered.
    expect(worker).not.toHaveBeenCalled();
    expect(takeGeneratorErrors()).toBeNull();
  });

  it('falls back to the plugin\'s Worker when the addon refuses, same frame', async () => {
    await bringUp();
    const worker = jest.fn(async () => ({
      instances: instances(99), count: 1, primitive: 'point' as const,
    }));
    setGeneratorRunner({ generate: worker });
    bridge.render = () => ({ ok: false, code: 'failed', error: 'no' });

    requestGeneratorFrame(demand(3));
    expect(await settleGenerators(2000)).toEqual([]);
    expect(requestGeneratorFrame(demand(3))?.instances[0]).toBe(99);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it('never blanks: the previous frame is served while the addon is working', async () => {
    await bringUp();
    setGeneratorRunner({ generate: jest.fn() });
    // A box rather than a bare `let`: assigned inside a closure, which
    // control-flow analysis would otherwise narrow to `null`.
    const gate: { release: null | (() => void) } = { release: null };
    bridge.render = (request) => {
      const produced = {
        ok: true as const,
        elapsedMs: 1,
        result: {
          call: 'generate' as const,
          instances: instances((request as { frame: number }).frame),
          count: 1,
          primitive: 'point' as const,
        },
      };
      if ((request as { frame: number }).frame === 3) return produced;
      return new Promise((resolve) => { gate.release = () => resolve(produced); });
    };

    requestGeneratorFrame(demand(3));
    await settleGenerators(2000);
    // Frame 4 is in flight. What the render path gets right now is frame 3 —
    // one frame behind, never empty.
    expect(requestGeneratorFrame(demand(4))?.instances[0]).toBe(3);
    gate.release?.();
    await settleGenerators(2000);
    expect(requestGeneratorFrame(demand(4))?.instances[0]).toBe(4);
  });
});

// ── 4. Crashes in the plugin's log ───────────────────────────────────────────

describe('what the host says about a process reaches somebody', () => {
  it('hands crash, disable and restart counts to the log subscriber', async () => {
    await bringUp();
    const seen: Array<{ type: string; restarts?: number }> = [];
    const off = watchNativeEvents((e) => seen.push({ type: e.type, ...(e.restarts !== undefined ? { restarts: e.restarts } : {}) }));

    // Three strikes, then the supervisor's verdict — the shape
    // `pluginNativeHost` produces, delivered the way the preload delivers it.
    for (let i = 1; i <= 3; i += 1) {
      bridge.emit({ type: 'crashed', pluginId: FAKE_NATIVE_ID, message: 'SIGSEGV', restarts: i });
    }
    bridge.emit({
      type: 'disabled',
      pluginId: FAKE_NATIVE_ID,
      message: 'It crashed 3 times. It is off for this session.',
    });

    expect(seen.map((e) => e.type)).toEqual(['crashed', 'crashed', 'crashed', 'disabled']);
    expect(seen[2]!.restarts).toBe(3);
    // And the status the UI reads agrees: off, with a reason.
    expect(nativeStatus(FAKE_NATIVE_ID)).toMatchObject({ loaded: false, disabled: true });
    expect(nativeReady(FAKE_NATIVE_ID, 'effect')).toBe(false);
    off();

    bridge.emit({ type: 'crashed', pluginId: FAKE_NATIVE_ID, restarts: 4 });
    expect(seen).toHaveLength(4); // unsubscribed
  });

  it('drops a disabled plugin\'s queued work rather than leaving it pending', async () => {
    // Serialised, so a second call really does wait behind the first.
    bridge.describe = { ...bridge.describe, threadSafety: 'unsafe' };
    await bringUp();
    const off = watchNativeEvents();
    const gate: { release: null | ((v: NativeCallOutcome) => void) } = { release: null };
    bridge.render = () => new Promise((resolve) => { gate.release = resolve; });

    // The scheduler does not exist until the first call — so make one, and put
    // a second behind it in the plugin's single lane.
    const running = invokeNative(FAKE_NATIVE_ID, 'x', null, { instanceId: 'fx_1' });
    const behind = invokeNative(FAKE_NATIVE_ID, 'y', null, { instanceId: 'fx_2' });
    expect(nativeScheduler()?.pendingCount()).toBe(2);

    bridge.emit({ type: 'disabled', pluginId: FAKE_NATIVE_ID });
    // The queued one is answered "this did not happen" rather than left waiting
    // on a process that is not coming back.
    await expect(behind).resolves.toBeNull();
    // And nothing new is attempted at all.
    expect(await invokeNative(FAKE_NATIVE_ID, 'z', null)).toBeNull();

    gate.release?.({ ok: false, code: 'failed', error: 'gone' });
    await running;
    off();
  });
});

// ── 5. Revocation ────────────────────────────────────────────────────────────

describe('a takedown reaches the process', () => {
  it('kills it, drops the consent, and refuses the next call', async () => {
    await bringUp();
    expect(nativeReady(FAKE_NATIVE_ID, 'effect')).toBe(true);

    const { killNativePlugin } = await import('./nativeClient');
    await killNativePlugin(FAKE_NATIVE_ID);

    expect(bridge.unload).toHaveBeenCalledWith(FAKE_NATIVE_ID, 'revoked');
    expect(nativeReady(FAKE_NATIVE_ID, 'effect')).toBe(false);
    expect(nativeStatus(FAKE_NATIVE_ID)).toBeNull();

    // And the consent went with it: bringing the same bytes back up asks again
    // rather than resuming on a grant that was withdrawn.
    const again = await loadNativePlugin(FAKE_NATIVE_LOAD_INPUT);
    expect(again).toMatchObject({ loaded: false, code: 'no-consent' });
  });
});

declare global {
  // eslint-disable-next-line no-var
  var __fallbackRan: number | undefined;
}
