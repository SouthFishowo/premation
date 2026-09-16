/**
 * The frame cache's deferred copy: the snapshot is taken inside the render tick,
 * the copy lands later, and it lands ONLY if it is still the truth for that
 * frame — no newer put, no key change, no purge in between.
 *
 * jsdom has no `createImageBitmap`, which is why every other cache suite runs
 * the synchronous copy; here a fake one is installed.
 */

import { FrameCache } from './frameCache';

function src(w = 4, h = 4): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 5));

type FakeBitmap = { width: number; height: number; close: jest.Mock };
let snapshots: Array<{ source: HTMLCanvasElement; bitmap: FakeBitmap }>;
const g = globalThis as unknown as { createImageBitmap?: unknown };

beforeEach(() => {
  snapshots = [];
  g.createImageBitmap = jest.fn(async (source: HTMLCanvasElement) => {
    const bitmap = { width: source.width, height: source.height, close: jest.fn() };
    snapshots.push({ source, bitmap });
    return bitmap;
  });
});
afterEach(() => {
  delete g.createImageBitmap;
});

describe('FrameCache deferred copies', () => {
  it('snapshots in the tick, copies later, and counts the pending frame as cached meanwhile', async () => {
    const cache = new FrameCache();
    cache.setKey('k', 4, 4);
    cache.put(3, src());
    expect(g.createImageBitmap).toHaveBeenCalledTimes(1);
    // Not stored yet — but the idle pump's probe must not render it again.
    expect(cache.size).toBe(0);
    expect(cache.has(3)).toBe(true);
    expect(cache.pendingCopies).toBe(1);
    await settle();
    expect(cache.size).toBe(1);
    expect(cache.get(3)).not.toBeNull();
    expect(cache.pendingCopies).toBe(0);
    expect(snapshots[0]!.bitmap.close).toHaveBeenCalled();
  });

  it('drops a copy whose key changed before it landed — pre-edit pixels never enter the new generation', async () => {
    const cache = new FrameCache();
    cache.setKey('before-edit', 4, 4);
    cache.put(0, src());
    cache.setKey('after-edit', 4, 4);
    expect(cache.has(0)).toBe(false);
    await settle();
    expect(cache.size).toBe(0);
    expect(cache.get(0)).toBeNull();
    // Nor did it sneak into the parked generation under the old key.
    cache.setKey('before-edit', 4, 4);
    expect(cache.get(0)).toBeNull();
    expect(snapshots[0]!.bitmap.close).toHaveBeenCalled();
  });

  it('drops a copy that a purge overtook', async () => {
    const cache = new FrameCache();
    cache.setKey('k', 4, 4);
    cache.put(0, src());
    cache.clear();
    await settle();
    expect(cache.size).toBe(0);
  });

  it('a newer put for the same frame wins over an older copy still in flight', async () => {
    const cache = new FrameCache();
    cache.setKey('k', 4, 4);
    cache.put(7, src(4, 4));
    cache.put(7, src(8, 8));
    await settle();
    expect(cache.size).toBe(1);
    expect(cache.get(7)!.width).toBe(8);
    expect(snapshots.every((s) => s.bitmap.close.mock.calls.length === 1)).toBe(true);
  });

  it('copies synchronously past the pending cap, so a starved main thread cannot pile up snapshots', () => {
    const cache = new FrameCache();
    cache.setKey('k', 4, 4);
    for (let f = 0; f < 10; f++) cache.put(f, src());
    expect(cache.pendingCopies).toBe(6);
    expect(cache.size).toBe(4);
    for (let f = 0; f < 10; f++) expect(cache.has(f)).toBe(true);
  });

  it('a snapshot that throws copies synchronously; one that rejects turns deferral off for good', async () => {
    g.createImageBitmap = jest.fn(() => { throw new Error('InvalidStateError'); });
    const cache = new FrameCache();
    cache.setKey('k', 4, 4);
    cache.put(0, src());
    expect(cache.size).toBe(1);

    const rejecting = jest.fn(async () => { throw new Error('detached'); });
    g.createImageBitmap = rejecting;
    const cache2 = new FrameCache();
    cache2.setKey('k', 4, 4);
    cache2.put(0, src());
    await settle();
    expect(cache2.has(0)).toBe(false); // that frame's pixels were gone
    cache2.put(1, src());
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(cache2.size).toBe(1); // …but every later frame is copied again
  });

  it('asyncCopies:false keeps the synchronous contract', () => {
    const cache = new FrameCache(undefined, { asyncCopies: false });
    cache.setKey('k', 4, 4);
    cache.put(0, src());
    expect(g.createImageBitmap).not.toHaveBeenCalled();
    expect(cache.size).toBe(1);
  });

  it('reports what a frame-sized copy costs', async () => {
    const costs: number[] = [];
    const cache = new FrameCache(undefined, { onCopyCost: (ms) => costs.push(ms) });
    cache.setKey('k', 4, 4);
    cache.put(0, src());
    await settle();
    expect(costs).toHaveLength(1);
    expect(costs[0]).toBeGreaterThanOrEqual(0);
  });
});
