/**
 * The export gate, for the native tier.
 *
 * The rule is the one the generator block already follows and it is the whole
 * reason this hook exists: wrong pixels on screen are recoverable, wrong pixels
 * in a file are not. So an export waits for a plugin's compiled module, and a
 * frame it could not get REFUSES rather than shipping whatever the fallback
 * path happened to leave on the canvas.
 *
 * Driven through the shared fake bridge, so the scheduler, its exact mode and
 * its error list are the real ones; the render backend is a stand-in because
 * jsdom has no GPU and none of what is asserted here is about pixels.
 */

import { renderOffline } from './offlineRenderer';
import {
  FAKE_NATIVE_ID,
  FAKE_NATIVE_LOAD_INPUT,
  allowFakeNative,
  installFakeNativeBridge,
  removeFakeNativeBridge,
  type FakeNativeBridge,
} from '@core/plugins/native/nativeBridge.testkit';
import { invokeNative, loadNativePlugin, resetNativeClientForTests } from '@core/plugins/native/nativeClient';
import { resetNativeConsentForTests } from '@core/plugins/native/nativeTrust';
import { nativeScheduler, resetNativeSchedulerForTests } from '@core/plugins/native/nativeScheduler';
import type { NativeCallOutcome } from '@core/plugins/native/nativeAbi';

type Diag = { code: string; detail: string; layerId?: string };

/** Minimal backend stand-in: renderOffline only needs these members. */
function fakeBackend() {
  let frame = 0;
  const diags: Diag[] = [];
  return {
    attach() {},
    resize() {},
    setExactMediaTiming() {},
    dispose() {},
    renderFrame() { frame += 1; },
    takeMediaWaits: () => [],
    lastFrameDiagnostics: () => diags,
    /** What the last `renderFrame` was handed — the layerErrors under test. */
    setDiagnostics(next: Diag[]) { diags.splice(0, diags.length, ...next); },
    get framesRendered() { return frame; },
  };
}

jest.mock('@core/rendering/createRenderBackend', () => ({
  createRenderBackend: () => (globalThis as { __fakeBackend?: unknown }).__fakeBackend,
}));

const params = { width: 32, height: 32, fps: 10, durationSec: 0.1 }; // one frame

let bridge: FakeNativeBridge;

beforeEach(() => {
  resetNativeClientForTests();
  resetNativeConsentForTests();
  resetNativeSchedulerForTests(null);
  bridge = installFakeNativeBridge();
  (globalThis as { __fakeBackend?: unknown }).__fakeBackend = fakeBackend();
});

afterEach(() => {
  removeFakeNativeBridge();
  delete (globalThis as { __fakeBackend?: unknown }).__fakeBackend;
});

async function bringUp(): Promise<void> {
  allowFakeNative();
  expect((await loadNativePlugin(FAKE_NATIVE_LOAD_INPUT)).loaded).toBe(true);
}

it('costs a project with no native plugin nothing but an empty settle', async () => {
  const frames: number[] = [];
  await renderOffline(params, (_c, i) => { frames.push(i); });
  expect(frames).toEqual([0]);
  // Never created one: the module state a project without native plugins pays
  // for is still nothing at all.
  expect(nativeScheduler()).toBeNull();
});

it('waits for an outstanding native call before the frame is handed to the sink', async () => {
  await bringUp();
  // A box rather than a bare `let`: the assignment happens in a closure, and
  // control-flow analysis would otherwise narrow the variable to `null`.
  const gate: { release: null | ((v: NativeCallOutcome) => void) } = { release: null };
  bridge.render = () => new Promise((resolve) => { gate.release = resolve; });

  const call = invokeNative(FAKE_NATIVE_ID, 'warm', null);
  // In flight, and the export is about to start.
  expect(nativeScheduler()?.pendingCount()).toBe(1);

  const delivered: number[] = [];
  const render = renderOffline(params, (_c, i) => { delivered.push(i); });

  // A whole turn of the event loop, which is more than enough for a frame this
  // size — and nothing has been handed to the sink, because the addon has not
  // answered. That is the wait.
  await new Promise((r) => setTimeout(r, 0));
  expect(delivered).toEqual([]);

  gate.release?.({ ok: true, elapsedMs: 1, result: { call: 'invoke', result: null } });
  await render;
  await call;
  expect(delivered).toEqual([0]);
});

it('switches the scheduler into exact mode for the export, and back after', async () => {
  await bringUp();
  let exactDuringExport: boolean | null = null;
  bridge.render = () => {
    exactDuringExport = nativeScheduler()?.exactMode() ?? null;
    return { ok: true, elapsedMs: 1, result: { call: 'invoke', result: null } };
  };

  const call = invokeNative(FAKE_NATIVE_ID, 'warm', null);
  await renderOffline(params, () => {});
  await call;

  // The call was made BEFORE the export, so it read exact mode as the export
  // set it — which is the property that matters: nothing is coalesced or
  // benched while a deliverable is being written.
  expect(nativeScheduler()?.exactMode()).toBe(false);
  expect(exactDuringExport).not.toBeNull();
});

it('refuses the frame when a native call failed, naming the plugin', async () => {
  await bringUp();
  bridge.render = () => ({ ok: false, code: 'crashed', error: 'the process stopped' });
  // Failed before the export's first settle, so its error is waiting in the list.
  await invokeNative(FAKE_NATIVE_ID, 'warm', null);

  const be = (globalThis as { __fakeBackend?: ReturnType<typeof fakeBackend> }).__fakeBackend!;
  // The backend reports what the snapshot carried, which is where the gate
  // reads its diagnostics from — the same channel a skipped layer uses.
  be.renderFrame = function renderFrame(this: unknown, snap: { layerErrors?: Array<{ message: string }> }) {
    be.setDiagnostics((snap.layerErrors ?? []).map((e) => ({ code: 'layer-skipped', detail: e.message })));
  } as never;

  // Named, because "the export stopped" with no attribution is the report this
  // whole tier would otherwise generate. Once: the error list is TAKEN, so a
  // second export is not still refusing over the first one's failure.
  await expect(renderOffline(params, () => {})).rejects.toThrow(
    new RegExp(`${FAKE_NATIVE_ID}[^]*native[^]*the process stopped`, 'i'),
  );
  await expect(renderOffline(params, () => {})).resolves.toBe(1);
});
