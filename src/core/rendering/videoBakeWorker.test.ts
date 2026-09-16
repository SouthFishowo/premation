/**
 * CPU-baked VIDEO through the bake worker pool: preview keeps the previous bake
 * up and swaps when the job lands, coalesces a burst of frames to the newest,
 * never files a pre-seek picture under the requested time, and — under exact
 * media timing (export / golden harness) — reports unsettled until the exact
 * bake for the exact frame is on the texture, with the landing promise joining
 * the existing media waits the offline convergence loop already awaits.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider, type ImageBakeSpec, type VideoFactory } from './AppTextureProvider';
import { BakeScheduler, setBakeSchedulerForTests, type BakeWorkerLike } from '@core/effects/bakeWorkerPool';
import type { BakeRequestMessage } from '@core/effects/bakeWorkerCore';
import type { Effect } from '@core/effects/effects';

class ManualWorker implements BakeWorkerLike {
  onmessage: BakeWorkerLike['onmessage'] = null;
  onerror: BakeWorkerLike['onerror'] = null;
  inbox: BakeRequestMessage[] = [];
  postMessage(msg: BakeRequestMessage): void { this.inbox.push(msg); }
  terminate(): void {}
  finish(): void {
    const msg = this.inbox.shift()!;
    this.onmessage?.({ data: { id: msg.id, ok: true, pixels: new Uint8ClampedArray(msg.job.pixels) } });
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A video element whose seeks the test lands by hand. */
function fakeVideo(): HTMLVideoElement & { seeking: boolean } {
  return {
    readyState: 4, currentTime: 0, seeking: false, videoWidth: 32, videoHeight: 18,
    addEventListener: () => {}, removeEventListener: () => {}, pause: () => {}, load: () => {},
  } as unknown as HTMLVideoElement & { seeking: boolean };
}

// A stack that forces the bake and may go to a worker (no text).
const VEGAS: Effect = { id: 'v', type: 'vegas', params: {} } as Effect;
const BAKE: ImageBakeSpec = { effects: [VEGAS], width: 32, height: 18 };

function setup(): {
  provider: AppTextureProvider; video: ReturnType<typeof fakeVideo>; worker: ManualWorker; changes: jest.Mock;
  sigOf: () => string | undefined; bakesPosted: () => number;
} {
  const worker = new ManualWorker();
  let posted = 0;
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (m): void => { posted++; post(m); };
  setBakeSchedulerForTests(new BakeScheduler(async () => worker, 1, () => new Uint8ClampedArray(0)));
  const backend = new NullBackend();
  const resources = new ResourceManager(backend);
  resources.beginFrame(1);
  const video = fakeVideo();
  const videoFactory: VideoFactory = () => video;
  const provider = new AppTextureProvider(resources, { videoFactory });
  const changes = jest.fn();
  provider.onChange = changes;
  const sigOf = (): string | undefined =>
    (provider as unknown as { frameEntries: Map<string, { signature: string }> }).frameEntries.get('asset:v')?.signature;
  return { provider, video, worker, changes, sigOf, bakesPosted: () => posted };
}

/** Land the element's pending seek, as `seeked` would. */
const landSeek = (v: ReturnType<typeof fakeVideo>): void => { v.seeking = false; };

afterEach(() => setBakeSchedulerForTests(undefined));

describe('setVideoBaked through the bake worker pool', () => {
  it('PREVIEW: bakes off-thread, keeps the previous bake up, swaps on landing', async () => {
    const { provider, video, worker, changes, sigOf } = setup();
    // First request: the element is sent to t=1 and has not landed.
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 1, BAKE)).toBe(false);
    await flush();
    expect(worker.inbox).toHaveLength(1);
    expect(sigOf()).toBeUndefined(); // nothing baked yet — nothing flashed either
    worker.finish();
    await flush();
    // The pre-seek picture is shown, but filed as such.
    expect(sigOf()).toMatch(/:seeking$/);
    expect(changes).toHaveBeenCalled();

    landSeek(video);
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 1, BAKE)).toBe(false);
    await flush();
    // Re-baking the settled frame; the stand-in stays up meanwhile.
    expect(sigOf()).toMatch(/:seeking$/);
    worker.finish();
    await flush();
    expect(sigOf()).not.toMatch(/:seeking$/);
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 1, BAKE)).toBe(true);
  });

  it('PREVIEW: a burst of frames coalesces to the newest; an overtaken job still shows until it is replaced', async () => {
    const { provider, video, worker, sigOf, bakesPosted } = setup();
    const at = (t: number): boolean => {
      const r = provider.setVideoBaked('asset:v', 'clip.mp4', t, BAKE);
      landSeek(video);
      return r;
    };
    at(1);
    await flush();
    at(2); at(3); at(4);
    await flush();
    // t=1 in the worker; 2 and 3 were replaced in the queue by 4.
    expect(worker.inbox).toHaveLength(1);
    worker.finish();
    await flush();
    expect(sigOf()).toContain('vb:1.0000');
    worker.finish();
    await flush();
    expect(sigOf()).toContain('vb:4.0000');
    expect(bakesPosted()).toBe(2);
    // Every burst frame was requested mid-seek; the settled pass bakes t=4 once more.
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 4, BAKE)).toBe(false);
    await flush();
    worker.finish();
    await flush();
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 4, BAKE)).toBe(true);
    expect(bakesPosted()).toBe(3);
  });

  it('EXPORT: the exact bake of the exact frame, awaited through the existing media waits', async () => {
    const { provider, video, worker, sigOf } = setup();
    provider.setExactMediaTiming(true);

    // Pass 1: the seek is requested. No pre-seek bake is even started.
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 2, BAKE)).toBe(false);
    provider.takeMediaWaits(); // the seek wait (an event the fake never fires)
    await flush();
    expect(worker.inbox).toHaveLength(0);
    expect(sigOf()).toBeUndefined();

    // Pass 2, after `seeked`: the bake goes to the pool and its landing is a wait.
    landSeek(video);
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 2, BAKE)).toBe(false);
    const waits = provider.takeMediaWaits();
    expect(waits.length).toBeGreaterThan(0);
    // A repeat pass while it bakes neither re-submits nor claims settled.
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 2, BAKE)).toBe(false);
    await flush();
    expect(worker.inbox).toHaveLength(1);

    let awaited = false;
    const all = Promise.all(waits).then(() => { awaited = true; });
    await flush();
    expect(awaited).toBe(false);
    worker.finish();
    await all;

    // Pass 3: the texture holds exactly this frame's bake.
    expect(sigOf()).toContain('vb:2.0000');
    expect(sigOf()).not.toMatch(/:seeking$/);
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 2, BAKE)).toBe(true);
  });

  it('a stack with a text readout stays on the main thread', async () => {
    const { provider, video, worker, sigOf } = setup();
    const text: ImageBakeSpec = { effects: [VEGAS, { id: 'n', type: 'numbers', params: {} } as Effect], width: 32, height: 18 };
    provider.setVideoBaked('asset:v', 'clip.mp4', 1, text);
    landSeek(video);
    expect(provider.setVideoBaked('asset:v', 'clip.mp4', 1, text)).toBe(true);
    await flush();
    expect(worker.inbox).toHaveLength(0);
    expect(sigOf()).toContain('vb:1.0000');
  });
});
