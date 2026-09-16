/**
 * WebGL2 context loss is OBSERVABLE, and recovery does not re-lose the context.
 *
 * The jest environment has no WebGL, so this drives the backend with a stub GL
 * and a canvas that really dispatches events — the same shape
 * `WEBGL_lose_context.loseContext()` produces in a browser: a
 * `webglcontextlost` event (which must be `preventDefault`ed, or the browser
 * never restores), then `webglcontextrestored`.
 *
 * `onContextChange` had no production caller before; MotionRendererBackend now
 * subscribes to it to rebuild the renderer. These tests pin the half of that
 * contract the backend owns.
 */

import { WebGL2Backend } from '../gpu/backends/WebGL2Backend';

function makeGl() {
  let lost = false;
  const loseContext = jest.fn(() => { lost = true; });
  const restoreContext = jest.fn(() => { lost = false; });
  const gl = {
    isContextLost: jest.fn(() => lost),
    MAX_TEXTURE_SIZE: 0x0d33,
    FRAMEBUFFER: 0x8d40,
    getParameter: jest.fn(() => 4096),
    createVertexArray: jest.fn(() => ({})),
    deleteVertexArray: jest.fn(),
    bindFramebuffer: jest.fn(),
    enable: jest.fn(),
    getExtension: jest.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext, restoreContext } : null)),
  };
  return { gl, loseContext, restoreContext, setLost: (v: boolean) => { lost = v; } };
}

/** A canvas stand-in with a working listener registry. */
function makeCanvas(gl: unknown) {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  return {
    getContext: jest.fn(() => gl),
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => listeners.get(type)?.delete(fn),
    dispatch(type: string): { preventDefault: jest.Mock } {
      const event = { type, preventDefault: jest.fn() };
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event as unknown as Event);
      return event;
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

describe('WebGL2Backend context loss', () => {
  it('reports loss (preventDefault-ed) and restore to subscribers', async () => {
    const { gl, setLost } = makeGl();
    const canvas = makeCanvas(gl);
    const backend = new WebGL2Backend();
    await backend.initialize({ canvas: canvas as unknown as HTMLCanvasElement });

    const onLost = jest.fn();
    const onRestored = jest.fn();
    backend.onContextChange(onLost, onRestored);

    setLost(true);
    const lostEvent = canvas.dispatch('webglcontextlost');
    // Without preventDefault the browser never fires `restored`.
    expect(lostEvent.preventDefault).toHaveBeenCalled();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(backend.isLost()).toBe(true);

    setLost(false);
    canvas.dispatch('webglcontextrestored');
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(backend.isLost()).toBe(false);
  });

  it('unsubscribe stops notifications', async () => {
    const { gl } = makeGl();
    const canvas = makeCanvas(gl);
    const backend = new WebGL2Backend();
    await backend.initialize({ canvas: canvas as unknown as HTMLCanvasElement });
    const onLost = jest.fn();
    const off = backend.onContextChange(onLost, () => {});
    off();
    canvas.dispatch('webglcontextlost');
    expect(onLost).not.toHaveBeenCalled();
  });

  it('a normal dispose loses the context; a recovery dispose keeps it for the replacement', async () => {
    const normal = makeGl();
    const a = new WebGL2Backend();
    await a.initialize({ canvas: makeCanvas(normal.gl) as unknown as HTMLCanvasElement });
    a.dispose();
    expect(normal.loseContext).toHaveBeenCalledTimes(1);

    const recovery = makeGl();
    const canvas = makeCanvas(recovery.gl);
    const b = new WebGL2Backend();
    await b.initialize({ canvas: canvas as unknown as HTMLCanvasElement });
    b.retainContextOnDispose = true;
    b.dispose();
    expect(recovery.loseContext).not.toHaveBeenCalled();
    // Listeners still come off, so the teardown cannot report itself as a loss.
    expect(canvas.listenerCount('webglcontextlost')).toBe(0);

    // And the replacement adopts the SAME live context without a restore dance.
    const c = new WebGL2Backend();
    await expect(c.initialize({ canvas: canvas as unknown as HTMLCanvasElement })).resolves.toBeUndefined();
    expect(recovery.restoreContext).not.toHaveBeenCalled();
    expect(c.isLost()).toBe(false);
  });
});
