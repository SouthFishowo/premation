/**
 * Direct VideoFrame uploads — parity with the canvas route they replace.
 *
 * An exact video frame used to reach the GPU as a 2D canvas it had been drawn
 * into. It can now go as the decoder's `VideoFrame`. The pixels are produced
 * by the browser in both cases, so what can differ is what THIS code asks
 * for: the premultiply request, the flip, the colour conversion and the copy
 * size. These tests hold those requests equal between the two source kinds on
 * both backends, through recording fakes (jsdom has no GPU).
 *
 * The copy size is the one deliberate difference in input: a VideoFrame's
 * coded size can exceed its display size (macroblock padding, anamorphic
 * PAR), and the texture is allocated at DISPLAY size — what a canvas draw
 * produces — so the upload must use display dimensions too.
 */

import { WebGL2Backend } from '../gpu/backends/WebGL2Backend';
import { WebGPUBackend } from '../gpu/backends/WebGPUBackend';
import type { TextureHandle, TextureSource } from '../gpu/types';

const FRAME = {
  displayWidth: 320,
  displayHeight: 180,
  codedWidth: 336,
  codedHeight: 192,
  close: () => undefined,
} as unknown as VideoFrame;

/** A stand-in canvas: the backends read only its size (this project runs
 *  without a DOM). */
function canvasOf(w: number, h: number): HTMLCanvasElement {
  return { width: w, height: h } as unknown as HTMLCanvasElement;
}

describe('WebGL2 VideoFrame upload', () => {
  function recordingBackend() {
    const calls: unknown[][] = [];
    const gl = {
      TEXTURE_2D: 0x0de1,
      RGBA8: 0x8058,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
      bindTexture: (...a: unknown[]) => calls.push(['bindTexture', ...a]),
      pixelStorei: (...a: unknown[]) => calls.push(['pixelStorei', ...a]),
      texImage2D: (...a: unknown[]) => calls.push(['texImage2D', ...a]),
    };
    const backend = Object.create(WebGL2Backend.prototype) as WebGL2Backend;
    Object.assign(backend, { gl, capabilities: {} });
    const texture = { native: { texture: { id: 1 }, format: 'rgba8unorm' } } as unknown as TextureHandle;
    return { backend, calls, texture };
  }

  it('makes the same unpack requests as a canvas, with the frame as the source', () => {
    const viaCanvas = recordingBackend();
    const canvas = canvasOf(320, 180);
    viaCanvas.backend.writeTexture(viaCanvas.texture, { type: 'canvas', canvas });

    const direct = recordingBackend();
    direct.backend.writeTexture(direct.texture, { type: 'videoFrame', frame: FRAME });

    const strip = (calls: unknown[][], source: unknown) =>
      calls.map((c) => c.map((arg) => (arg === source ? '<source>' : arg)));
    expect(strip(direct.calls, FRAME)).toEqual(strip(viaCanvas.calls, canvas));
    const tex = direct.calls.find((c) => c[0] === 'texImage2D')!;
    expect(tex[tex.length - 1]).toBe(FRAME);
    // Premultiplied destination, exactly as for every honest source.
    expect(direct.calls).toContainEqual(['pixelStorei', 0x9241, true]);
  });

  it('honours alreadyPremultiplied the same way', () => {
    const b = recordingBackend();
    b.backend.writeTexture(b.texture, { type: 'videoFrame', frame: FRAME, alreadyPremultiplied: true } as TextureSource);
    expect(b.calls).toContainEqual(['pixelStorei', 0x9241, false]);
  });
});

describe('WebGPU VideoFrame upload', () => {
  function recordingBackend() {
    const copies: Array<{ source: Record<string, unknown>; dest: Record<string, unknown>; size: Record<string, unknown> }> = [];
    const device = {
      queue: {
        copyExternalImageToTexture: (source: Record<string, unknown>, dest: Record<string, unknown>, size: Record<string, unknown>) => {
          copies.push({ source, dest, size });
        },
        writeTexture: () => undefined,
      },
    };
    const backend = Object.create(WebGPUBackend.prototype) as WebGPUBackend;
    Object.assign(backend, { device });
    const gpuTexture = { format: 'rgba8unorm' };
    const texture = { native: gpuTexture } as unknown as TextureHandle;
    return { backend, copies, texture, gpuTexture };
  }

  it('copies at DISPLAY size with the same destination request as a canvas', () => {
    const viaCanvas = recordingBackend();
    const canvas = canvasOf(320, 180);
    viaCanvas.backend.writeTexture(viaCanvas.texture, { type: 'canvas', canvas });

    const direct = recordingBackend();
    direct.backend.writeTexture(direct.texture, { type: 'videoFrame', frame: FRAME });

    const c = viaCanvas.copies[0]!;
    const d = direct.copies[0]!;
    expect(d.source).toEqual({ source: FRAME });
    expect(d.size).toEqual({ width: 320, height: 180 });
    expect(d.size).toEqual(c.size);
    // Same destination request: premultiplied, and neither sets flipY or a
    // colorSpace — both take the spec default (no flip, sRGB).
    expect(d.dest).toEqual({ texture: direct.gpuTexture, premultipliedAlpha: true });
    expect(c.dest).toEqual({ texture: viaCanvas.gpuTexture, premultipliedAlpha: true });
    expect(Object.keys(d.source)).toEqual(Object.keys(c.source));
  });
});
