/**
 * Render from the clock pump: a redraw requested inside the playback pump's
 * animation frame is drawn in THAT frame, not the next one — and never twice
 * in one frame.
 *
 * `requestRender` is rAF-coalesced; the pump advances the playhead from inside
 * a rAF callback, so before `flushRender` every played frame reached the screen
 * one vsync late. These tests drive a fake rAF so "which frame" is observable.
 */

import { getWorkspaceController } from './WorkspaceController';
import { flushRenderNow } from '@core/perf/framePump';

type FrameCb = (ts: number) => void;

let queue: Map<number, FrameCb>;
let nextId: number;

beforeEach(() => {
  queue = new Map();
  nextId = 1;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb as FrameCb);
    return id;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    queue.delete(id);
  });
});
afterEach(() => jest.restoreAllMocks());

/** Run every callback queued for one animation frame, at timestamp `ts`. */
function runFrame(ts: number): void {
  const due = [...queue.entries()];
  queue.clear();
  for (const [, cb] of due) cb(ts);
}

describe('WorkspaceController.flushRender', () => {
  it('draws a pending redraw immediately and cancels its queued rAF', () => {
    const c = getWorkspaceController();
    const seen: number[] = [];
    const off = c.onRender(() => seen.push(1));
    // Drain anything the controller queued at construction.
    runFrame(0);
    seen.length = 0;

    c.requestRender();
    expect(queue.size).toBe(1);
    expect(c.flushRender(16)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(queue.size).toBe(0); // the next frame has nothing left to draw
    off();
  });

  it('with nothing pending it does nothing', () => {
    const c = getWorkspaceController();
    const seen: number[] = [];
    const off = c.onRender(() => seen.push(1));
    runFrame(0);
    seen.length = 0;
    expect(c.flushRender(32)).toBe(false);
    expect(seen).toHaveLength(0);
    off();
  });

  it('refuses a second render inside the same animation frame', () => {
    const c = getWorkspaceController();
    const seen: number[] = [];
    const off = c.onRender(() => seen.push(1));
    runFrame(0);
    seen.length = 0;

    // Frame 48: the controller's own rAF renders (a hover, say)…
    c.requestRender();
    runFrame(48);
    expect(seen).toHaveLength(1);
    // …then, in the same frame, the pump moves the clock and flushes.
    c.requestRender();
    expect(c.flushRender(48)).toBe(false);
    expect(seen).toHaveLength(1);
    // The new time is drawn on the next frame instead.
    runFrame(64);
    expect(seen).toHaveLength(2);
    off();
  });

  it('is reachable through framePump without importing the controller', () => {
    const c = getWorkspaceController();
    const seen: number[] = [];
    const off = c.onRender(() => seen.push(1));
    runFrame(0);
    seen.length = 0;
    c.requestRender();
    flushRenderNow(80);
    expect(seen).toHaveLength(1);
    off();
  });
});
