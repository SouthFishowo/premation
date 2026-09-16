/**
 * What the exact-frame cache stores, who closes it, and how it asks.
 *
 * The cache used to redraw every decoded frame into a canvas of its own. It
 * now keeps what the decode path hands over — an ImageBitmap, or (one per
 * source, interactive cache only) the decoder's own VideoFrame for a direct
 * GPU upload — so ownership became something to get wrong: a frame closed
 * twice throws on the next upload, a frame never closed pins a hardware
 * decoder slot until the decoder stalls. jsdom has neither class, so fakes
 * are installed as the globals the cache's `instanceof` checks read.
 */

import { ExactVideoFrameCache, type ExactSourceLike, type LoadedExactSource } from './exactVideoFrames';
import {
  ExactVideoSource,
  SupersededError,
  TransientDecodeError,
  type DecoderIO,
  type DecodedFrameLike,
  type EncodedChunkInit,
  type FrameRequest,
} from '@core/video/exactVideoSource';
import type { DemuxedVideo } from '@core/video/mp4Demuxer';

const FPS = 30;
const FRAMES = 24;

class FakeBitmap {
  closes = 0;
  constructor(public width: number, public height: number, public timestamp: number) {}
  close(): void {
    this.closes += 1;
    this.width = 0;
    this.height = 0;
  }
}

class FakeVideoFrame {
  closes = 0;
  constructor(public timestamp: number, public displayWidth = 4, public displayHeight = 4) {}
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const tsOf = (i: number): number => Math.round((i / FPS) * 1e6);

function indexAt(timeUs: number): number {
  let idx = 0;
  while (idx + 1 < FRAMES && ((idx + 1) / FPS) * 1e6 <= timeUs) idx += 1;
  return idx;
}

/** A source that hands out a fresh owned frame per request and records how it was asked. */
function handingSource(opts: { raw?: boolean; reject?: (idx: number) => unknown } = {}) {
  const handed: Array<FakeBitmap | FakeVideoFrame> = [];
  const reqs: Array<FrameRequest | undefined> = [];
  const source: ExactSourceLike = {
    frameIndexAt: indexAt,
    frameAt(presIdx: number, req?: FrameRequest): Promise<DecodedFrameLike> {
      reqs.push(req);
      const err = opts.reject?.(presIdx);
      if (err) return Promise.reject(err);
      const f = opts.raw && req?.raw ? new FakeVideoFrame(tsOf(presIdx)) : new FakeBitmap(4, 4, tsOf(presIdx));
      handed.push(f);
      return Promise.resolve(f as unknown as DecodedFrameLike);
    },
    close: jest.fn(),
  };
  return { source, handed, reqs };
}

function loaderFor(source: ExactSourceLike, extra: Partial<LoadedExactSource> = {}) {
  return (): Promise<LoadedExactSource> => Promise.resolve({ source, width: 4, height: 4, ...extra });
}

describe('exact-frame cache ownership', () => {
  it('stores handed-over bitmaps as they are, and closes every one exactly once', async () => {
    const s = handingSource();
    // 100-byte budget → the 8-frame floor, so eviction runs.
    const cache = new ExactVideoFrameCache(100, loaderFor(s.source), () => true);
    cache.get('a.mp4', 0);
    await flush();
    for (let i = 0; i < 14; i++) {
      cache.get('a.mp4', (i * 1.5) / FPS);
      await flush();
    }
    const stats = cache.stats('a.mp4')!;
    expect(stats.kinds).toEqual({ canvas: 0, bitmap: stats.frames, videoFrame: 0 });
    expect(stats.frames).toBe(8);
    // Evicted ones are closed already; resident ones are still open.
    expect(s.handed.filter((f) => f.closes === 1)).toHaveLength(s.handed.length - 8);
    cache.clear();
    for (const f of s.handed) expect(f.closes).toBe(1);
  });

  it('always asks to take; latest and raw only under the interactive policy, raw never for rotated footage', async () => {
    const priv = handingSource();
    const privCache = new ExactVideoFrameCache(1 << 20, loaderFor(priv.source), () => true);
    privCache.get('a.mp4', 0);
    await flush();
    privCache.get('a.mp4', 0);
    expect(priv.reqs[0]).toEqual({ take: true });

    const live = handingSource();
    const liveCache = new ExactVideoFrameCache(1 << 20, loaderFor(live.source), () => true, undefined, {
      latestWins: true,
      directFrames: true,
    });
    liveCache.get('a.mp4', 0);
    await flush();
    liveCache.get('a.mp4', 0);
    expect(live.reqs[0]).toEqual({ take: true, latest: true, raw: true });

    const rotated = handingSource();
    const rotCache = new ExactVideoFrameCache(1 << 20, loaderFor(rotated.source, { rotation: 90 }), () => true, undefined, {
      latestWins: true,
      directFrames: true,
    });
    rotCache.get('a.mp4', 0);
    await flush();
    rotCache.get('a.mp4', 0);
    expect(rotated.reqs[0]).toEqual({ take: true, latest: true });
    privCache.clear();
    liveCache.clear();
    rotCache.clear();
  });

  it('holds at most ONE VideoFrame per source; the previous one is demoted and closed once', async () => {
    const s = handingSource({ raw: true });
    const cache = new ExactVideoFrameCache(1 << 20, loaderFor(s.source), () => true, undefined, {
      directFrames: true,
    });
    cache.get('a.mp4', 0);
    await flush();
    for (const idx of [0, 5, 10, 15]) {
      cache.get('a.mp4', idx / FPS);
      await flush();
      const r = cache.get('a.mp4', idx / FPS);
      expect(r).toMatchObject({ state: 'frame', presIndex: idx, exact: true });
      expect((r as { image: unknown }).image).toBeInstanceOf(FakeVideoFrame);
      expect(cache.stats('a.mp4')!.kinds!.videoFrame).toBe(1);
      const open = s.handed.filter((f) => f.closes === 0);
      expect(open).toHaveLength(1);
    }
    cache.clear();
    for (const f of s.handed) expect(f.closes).toBe(1);
  });

  it('`canvas` converts a stored frame once, closing the original', async () => {
    const s = handingSource();
    const cache = new ExactVideoFrameCache(1 << 20, loaderFor(s.source), () => true);
    cache.get('a.mp4', 0.2);
    await flush();
    cache.get('a.mp4', 0.2);
    await flush();
    const r = cache.get('a.mp4', 0.2) as { image: unknown; canvas: HTMLCanvasElement };
    expect(r.image).toBeInstanceOf(FakeBitmap);
    const c = r.canvas;
    expect(c).toBeInstanceOf(HTMLCanvasElement);
    expect(s.handed[0]!.closes).toBe(1);
    expect(r.canvas).toBe(c); // idempotent
    const again = cache.get('a.mp4', 0.2) as { image: unknown };
    expect(again.image).toBe(c);
    expect(cache.stats('a.mp4')!.kinds).toEqual({ canvas: 1, bitmap: 0, videoFrame: 0 });
    cache.clear();
    expect(s.handed[0]!.closes).toBe(1);
  });

  it('superseded seeks are not failures and do not repaint; transient decode errors are not failures', async () => {
    let mode: 'superseded' | 'transient' = 'superseded';
    const s = handingSource({
      reject: (idx) => (mode === 'superseded' ? new SupersededError(idx) : new TransientDecodeError('worker crashed')),
    });
    const cache = new ExactVideoFrameCache(1 << 20, loaderFor(s.source), () => true, undefined, { latestWins: true });
    const repaint = jest.fn();
    cache.get('a.mp4', 0);
    await flush();
    cache.onChange(repaint);
    for (let i = 0; i < 6; i++) {
      cache.get('a.mp4', (i * 3) / FPS);
      await flush();
    }
    expect(cache.unavailable('a.mp4')).toBe(false);
    expect(repaint).not.toHaveBeenCalled();

    mode = 'transient';
    for (let i = 0; i < 6; i++) {
      cache.get('a.mp4', (i * 3 + 1) / FPS);
      await flush();
    }
    expect(cache.unavailable('a.mp4')).toBe(false);
    expect(repaint).toHaveBeenCalled(); // re-ask → resume at the playhead
    cache.clear();
  });

  it('a frame that lands after clear() is closed, not stored', async () => {
    let land: ((f: DecodedFrameLike) => void) | null = null;
    const frame = new FakeBitmap(4, 4, 0);
    const source: ExactSourceLike = {
      frameIndexAt: indexAt,
      frameAt: () => new Promise((r) => { land = r; }),
      close: jest.fn(),
    };
    const cache = new ExactVideoFrameCache(1 << 20, loaderFor(source), () => true);
    cache.get('a.mp4', 0);
    await flush();
    cache.get('a.mp4', 0);
    cache.clear();
    land!(frame as unknown as DecodedFrameLike);
    await flush();
    expect(frame.closes).toBe(1);
  });
});

describe('latest-wins scrubbing through the real session', () => {
  /** A decoder that only finishes a flush when released. */
  function gatedIO() {
    const gates: Array<() => void> = [];
    let resets = 0;
    const io: DecoderIO = {
      createDecoder(_c, handlers) {
        let pending: EncodedChunkInit[] = [];
        let rejectFlush: ((e: unknown) => void) | null = null;
        return {
          decode(chunk) { pending.push(chunk as EncodedChunkInit); },
          flush() {
            const batch = pending;
            pending = [];
            return new Promise<void>((resolve, reject) => {
              rejectFlush = reject;
              gates.push(() => {
                for (const c of batch) handlers.output(new FakeBitmap(4, 4, c.timestamp) as unknown as DecodedFrameLike);
                resolve();
              });
            });
          },
          reset() {
            resets += 1;
            pending = [];
            gates.length = 0;
            const e = new Error('reset');
            e.name = 'AbortError';
            rejectFlush?.(e);
          },
          close() { /* ok */ },
        };
      },
      createChunk: (init) => init,
    };
    return { io, release: () => { const gate = gates.shift(); gate?.(); return !!gate; }, resets: () => resets };
  }

  function demux(): DemuxedVideo {
    const samples = [];
    for (let i = 0; i < 96; i++) {
      samples.push({ data: new Uint8Array([i]), dts: i * 512, cts: i * 512, isKey: i % 8 === 0, duration: 512 });
    }
    return { codec: 'avc1.4d400a', codedWidth: 4, codedHeight: 4, timescale: 15360, description: null, samples };
  }

  it('a drag across the clip lands only the frame the playhead stopped on', async () => {
    const h = gatedIO();
    const d = demux();
    const cache = new ExactVideoFrameCache(
      1 << 20,
      () => Promise.resolve({
        source: new ExactVideoSource(d, h.io, 12, { keepInFlightMs: -1, starvationMs: 0, now: () => 0 }),
        width: 4,
        height: 4,
      }),
      () => true,
      undefined,
      { latestWins: true },
    );
    cache.get('a.mp4', 0);
    await flush(); // load
    // One render per vsync, the playhead moving 7 frames each time.
    const stops = [7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77, 83];
    for (const idx of stops) {
      cache.get('a.mp4', idx / FPS);
      await flush();
    }
    // Let the decoder finish whatever it is still holding.
    for (let i = 0; i < 20; i++) {
      h.release();
      await flush();
    }
    const last = stops[stops.length - 1]!;
    expect(cache.get('a.mp4', last / FPS)).toMatchObject({ state: 'frame', presIndex: last, exact: true });
    // Nothing the drag passed over was ever captured by the render cache.
    expect(cache.stats('a.mp4')!.frames).toBe(1);
    expect(h.resets()).toBe(stops.length - 1);
    expect(cache.unavailable('a.mp4')).toBe(false);
    expect(cache.waits()).toHaveLength(0);
    cache.clear();
  });
});
