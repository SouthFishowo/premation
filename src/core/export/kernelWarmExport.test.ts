/**
 * The export waits for a plugin's CPU kernel to load before it draws.
 *
 * A kernel module instantiates asynchronously. The preview accepts that and
 * redraws the layer when it lands, but the bake runs inside `renderFrame`, so
 * an export that does not wait writes the frame with the effect ABSENT — and
 * then reports success. The resulting file is missing an effect at exactly the
 * frames the module was still loading, which is the kind of failure nobody
 * attributes to the right cause.
 *
 * `warmPluginKernels` existed, documented for this caller, and was wired to
 * nothing. So the test is about the CALL, not about pixels: the fake backend
 * records the order, and a gated warm proves the frame is behind it.
 */

import { renderOffline } from './offlineRenderer';

const warmCalls: Array<Array<{ type: string }>> = [];
const gate: { release: null | (() => void) } = { release: null };

jest.mock('@core/effects/pluginCpuEffect', () => ({
  ...jest.requireActual('@core/effects/pluginCpuEffect'),
  warmPluginKernels: (effects: Array<{ type: string }>) => {
    warmCalls.push(effects);
    return gate.release ? Promise.resolve() : new Promise<void>((r) => { gate.release = r; });
  },
}));

const order: string[] = [];

function fakeBackend() {
  return {
    attach() {}, resize() {}, setExactMediaTiming() {}, dispose() {},
    renderFrame() { order.push('render'); },
    takeMediaWaits: () => [],
    lastFrameDiagnostics: () => [],
  };
}

jest.mock('@core/rendering/createRenderBackend', () => ({
  createRenderBackend: () => (globalThis as { __fakeBackend?: unknown }).__fakeBackend,
}));

beforeEach(() => {
  warmCalls.length = 0;
  order.length = 0;
  gate.release = null;
  (globalThis as { __fakeBackend?: unknown }).__fakeBackend = fakeBackend();
});

afterEach(() => {
  delete (globalThis as { __fakeBackend?: unknown }).__fakeBackend;
});

it('★ does not draw a frame until this frame\'s kernels have loaded', async () => {
  const delivered: number[] = [];
  const render = renderOffline(
    { width: 32, height: 32, fps: 10, durationSec: 0.1 },
    (_c, i) => { delivered.push(i); },
  );

  // A full turn of the loop — ample for a 32×32 frame — and nothing has drawn,
  // because the kernel has not loaded. That wait is the whole point.
  await new Promise((r) => setTimeout(r, 0));
  expect(warmCalls).toHaveLength(1);
  expect(order).toEqual([]);
  expect(delivered).toEqual([]);

  gate.release?.();
  await render;
  expect(order).toEqual(['render']);
  expect(delivered).toEqual([0]);
});

it('warms once per frame, from that frame\'s own effects', async () => {
  gate.release = () => {}; // resolve immediately: this test is about the calls
  const delivered: number[] = [];
  await renderOffline(
    { width: 32, height: 32, fps: 10, durationSec: 0.3 },
    (_c, i) => { delivered.push(i); },
  );
  expect(delivered).toEqual([0, 1, 2]);
  // One per frame, each an array — a frame whose layers carry no effects still
  // asks, because which layers are live changes frame to frame.
  expect(warmCalls).toHaveLength(3);
  for (const call of warmCalls) expect(Array.isArray(call)).toBe(true);
});
