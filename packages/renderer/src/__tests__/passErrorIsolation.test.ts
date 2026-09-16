/**
 * One failing render pass must cost one pass, not the frame — and never the
 * renderer.
 *
 * Before the guard, a pass that threw unwound out of `RenderGraph.execute`,
 * skipped every later pass AND `Renderer.endFrame`, and left `inFrame` set, so
 * every subsequent `beginFrame` threw "already in a frame": the viewport stayed
 * dead until the editor was reopened. The guard's contract, pinned here:
 *
 *   • the failing pass is skipped, the others still run, the frame presents;
 *   • the loss is STATED (a `pass-failed` diagnostic), because a frame missing
 *     a pass looks finished and export must be able to refuse it;
 *   • a pass left open is closed (`abortOpenPass`) so WebGPU's encoder stays valid;
 *   • the next frame renders normally.
 */

import { Renderer } from '../core/renderer/Renderer';
import { NullBackend } from '../gpu/backends/NullBackend';
import { RenderPass, SURFACE, type RenderPassContext } from '../rendergraph/RenderPass';
import { buildFrameScene } from '../integration/buildFrameScene';
import { Color } from '../core/math/Color';

class ThrowingPass extends RenderPass {
  readonly name = 'boom';
  override readonly writes = [SURFACE];
  runs = 0;
  constructor(private readonly shouldThrow: () => boolean) {
    super();
  }
  execute(ctx: RenderPassContext): void {
    this.runs += 1;
    if (!this.shouldThrow()) return;
    // Begin a pass and throw before ending it — the WebGPU-invalidating case.
    ctx.services.backend.beginRenderPass({ label: 'boom', color: { target: 'surface' } } as never);
    throw new Error('uniform pack overflowed');
  }
}

function setup(shouldThrow: () => boolean = () => true) {
  const backend = new NullBackend();
  const abortOpenPass = jest.fn();
  (backend as unknown as { abortOpenPass: () => void }).abortOpenPass = abortOpenPass;
  let t = 0;
  const renderer = new Renderer({ backend, now: () => (t += 16) });
  const pass = new ThrowingPass(shouldThrow);
  renderer.renderGraph.addPass(pass);
  return { backend, renderer, pass, abortOpenPass };
}

const scene = () =>
  buildFrameScene(
    { id: 'comp', size: { width: 320, height: 240 }, background: Color.of(0, 0, 0, 1) },
    [{ id: 'a', kind: 'rect' as const, x: 10, y: 10, width: 40, height: 40, color: Color.white() }],
  );

describe('render pass error isolation', () => {
  it('skips the failing pass, runs the rest, and reports it', async () => {
    const { backend, renderer, abortOpenPass } = setup();
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 320, height: 240, overlays: { grid: false, checkerboard: false } });

    const result = renderer.render(vp, scene());

    expect(backend.passLog).toEqual(expect.arrayContaining(['clear', 'background', 'composition']));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'pass-failed', detail: expect.stringMatching(/"boom".*uniform pack overflowed/) }),
    ]);
    expect(abortOpenPass).toHaveBeenCalledTimes(1);
  });

  it('leaves the renderer usable: the next frame renders and indexes normally', async () => {
    let fail = true;
    const { renderer, pass } = setup(() => fail);
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 320, height: 240, overlays: { grid: false } });

    expect(renderer.render(vp, scene()).frame.index).toBe(1);
    fail = false;
    const second = renderer.render(vp, scene());
    expect(second.frame.index).toBe(2);
    expect(second.diagnostics).toEqual([]);
    expect(pass.runs).toBe(2);
  });

  it('a healthy frame reports nothing and never aborts a pass', async () => {
    const { renderer, abortOpenPass } = setup(() => false);
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 320, height: 240, overlays: { grid: false } });
    expect(renderer.render(vp, scene()).diagnostics).toEqual([]);
    expect(abortOpenPass).not.toHaveBeenCalled();
  });

  it('a throw outside any pass still ends the frame', async () => {
    const { renderer } = setup(() => false);
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 320, height: 240, overlays: { grid: false } });
    const spy = jest.spyOn(renderer.renderGraph, 'execute').mockImplementationOnce(() => {
      throw new Error('target resolution failed');
    });
    const result = renderer.render(vp, scene());
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({ code: 'pass-failed', detail: expect.stringMatching(/target resolution failed/) }));
    spy.mockRestore();
    // Not wedged in a frame.
    expect(() => renderer.render(vp, scene())).not.toThrow();
  });

  it('a failing submit does not wedge the renderer in a frame', async () => {
    const { backend, renderer } = setup(() => false);
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 320, height: 240, overlays: { grid: false } });
    const endFrame = jest.spyOn(backend, 'endFrame').mockImplementationOnce(() => {
      throw new Error('device lost during submit');
    });
    expect(() => renderer.render(vp, scene())).toThrow(/device lost/);
    endFrame.mockRestore();
    expect(() => renderer.render(vp, scene())).not.toThrow();
  });
});
