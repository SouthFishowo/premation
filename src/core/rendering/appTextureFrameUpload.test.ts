/**
 * `AppTextureProvider.setFrame` — which source kind reaches the GPU.
 *
 * Exact video frames now arrive as canvases, ImageBitmaps or the decoder's own
 * VideoFrame, and each uploads as itself — the VideoFrame with no CPU copy at
 * all. Three things must hold around that, and each is pinned here against a
 * backend that records the upload source:
 *
 *  - the provider never closes a frame it was handed (the exact-frame cache
 *    owns it and closes it exactly once; a second close is a use-after-close
 *    on the next upload);
 *  - under exact media timing (export, the golden harness) a VideoFrame still
 *    goes through a canvas, so those pixels are the ones the canvas route has
 *    always produced;
 *  - a platform that refuses VideoFrame sources costs one throw, then the
 *    canvas route for the rest of the session.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider } from './AppTextureProvider';
import { resetVideoDecodeStats, videoDecodeStats } from '@core/video/decodeStats';

class FakeVideoFrame {
  closes = 0;
  constructor(public displayWidth = 64, public displayHeight = 36) {}
  close(): void {
    this.closes += 1;
  }
}

class FakeBitmap {
  closes = 0;
  constructor(public width = 64, public height = 36) {}
  close(): void {
    this.closes += 1;
  }
}

const g = globalThis as unknown as { ImageBitmap?: unknown; VideoFrame?: unknown };
const saved = { ImageBitmap: g.ImageBitmap, VideoFrame: g.VideoFrame };
beforeAll(() => {
  g.ImageBitmap = FakeBitmap;
  g.VideoFrame = FakeVideoFrame;
});
afterAll(() => {
  g.ImageBitmap = saved.ImageBitmap;
  g.VideoFrame = saved.VideoFrame;
});

class UploadRecorder extends NullBackend {
  readonly uploads: Array<{ type: string; ref: unknown }> = [];
  videoFrameAttempts = 0;
  refuseVideoFrames = false;

  override writeTexture(
    texture: Parameters<NullBackend['writeTexture']>[0],
    source: Parameters<NullBackend['writeTexture']>[1],
  ): void {
    const s = source as { type: string; frame?: unknown; bitmap?: unknown; canvas?: unknown };
    if (s.type === 'videoFrame') {
      this.videoFrameAttempts += 1;
      if (this.refuseVideoFrames) throw new TypeError('source type not supported');
    }
    this.uploads.push({ type: s.type, ref: s.frame ?? s.bitmap ?? s.canvas });
    super.writeTexture(texture, source);
  }
}

function setup(): { provider: AppTextureProvider; backend: UploadRecorder } {
  const backend = new UploadRecorder();
  const resources = new ResourceManager(backend);
  resources.beginFrame(1);
  return { provider: new AppTextureProvider(resources, {}), backend };
}

const drawn: unknown[] = [];
let ctxSpy: jest.SpyInstance;
beforeEach(() => {
  drawn.length = 0;
  resetVideoDecodeStats();
  // jsdom has no 2D context; the canvas route only needs drawImage.
  ctxSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage: (img: unknown) => drawn.push(img), imageSmoothingEnabled: true, imageSmoothingQuality: 'high' }) as never,
  );
});
afterEach(() => ctxSpy.mockRestore());

describe('setFrame upload source kinds', () => {
  it('uploads a VideoFrame as itself, once per signature, and never closes it', () => {
    const { provider, backend } = setup();
    const vf = new FakeVideoFrame();
    provider.setFrame('layer', vf as unknown as VideoFrame, 'xv:1');
    provider.setFrame('layer', vf as unknown as VideoFrame, 'xv:1'); // repaint, same frame
    expect(backend.uploads).toEqual([{ type: 'videoFrame', ref: vf }]);
    expect(drawn).toHaveLength(0); // no CPU-side copy
    expect(vf.closes).toBe(0);
    expect(videoDecodeStats.uploadsVideoFrame).toBe(1);
  });

  it('uploads an ImageBitmap as a bitmap and a canvas as a canvas', () => {
    const { provider, backend } = setup();
    const bmp = new FakeBitmap();
    provider.setFrame('a', bmp as unknown as ImageBitmap, 'xv:1');
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    provider.setFrame('b', canvas, 'xv:1');
    expect(backend.uploads).toEqual([
      { type: 'bitmap', ref: bmp },
      { type: 'canvas', ref: canvas },
    ]);
    expect(bmp.closes).toBe(0);
  });

  it('under exact media timing a VideoFrame goes through a canvas (export / golden pixels)', () => {
    const { provider, backend } = setup();
    provider.setExactMediaTiming(true);
    const vf = new FakeVideoFrame();
    provider.setFrame('layer', vf as unknown as VideoFrame, 'xv:1');
    expect(backend.videoFrameAttempts).toBe(0);
    expect(backend.uploads.map((u) => u.type)).toEqual(['canvas']);
    expect(drawn).toEqual([vf]);
    expect(vf.closes).toBe(0);
  });

  it('a backend that refuses VideoFrame sources costs one throw, then the canvas route for the session', () => {
    const { provider, backend } = setup();
    backend.refuseVideoFrames = true;
    const first = new FakeVideoFrame();
    provider.setFrame('layer', first as unknown as VideoFrame, 'xv:1');
    const second = new FakeVideoFrame();
    provider.setFrame('layer', second as unknown as VideoFrame, 'xv:2');
    expect(backend.videoFrameAttempts).toBe(1);
    expect(backend.uploads.map((u) => u.type)).toEqual(['canvas', 'canvas']);
    expect(drawn).toEqual([first, second]);
    expect(first.closes + second.closes).toBe(0);
  });

  it('never uploads a closed (0×0) ImageBitmap', () => {
    const { provider, backend } = setup();
    provider.setFrame('layer', new FakeBitmap(0, 0) as unknown as ImageBitmap, 'xv:1');
    expect(backend.uploads).toHaveLength(0);
  });
});
