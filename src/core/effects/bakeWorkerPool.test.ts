/**
 * The bake pool's scheduling contract (see bakeWorkerPool.ts): one job per lane
 * at a time, latest-wins for queued jobs, `superseded` for jobs a newer submit
 * overtook while running, lanes in parallel, failures rejected rather than
 * swallowed, and a pool with no workers still finishing what it was given.
 */

import { BakeScheduler, type BakeWorkerLike } from './bakeWorkerPool';
import type { BakeJobInput, BakeRequestMessage } from './bakeWorkerCore';

/** A worker the test drives by hand: jobs sit in `inbox` until `finish`. */
class ManualWorker implements BakeWorkerLike {
  onmessage: BakeWorkerLike['onmessage'] = null;
  onerror: BakeWorkerLike['onerror'] = null;
  inbox: BakeRequestMessage[] = [];
  terminated = false;
  postMessage(msg: BakeRequestMessage): void {
    this.inbox.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Reply to the oldest job with its first pixel byte + 1. */
  finish(): void {
    const msg = this.inbox.shift()!;
    const px = new Uint8ClampedArray(msg.job.pixels);
    px[0] = (px[0] ?? 0) + 1;
    this.onmessage?.({ data: { id: msg.id, ok: true, pixels: px } });
  }
  fail(): void {
    const msg = this.inbox.shift()!;
    this.onmessage?.({ data: { id: msg.id, ok: false, error: 'kernel threw' } });
  }
}

const job = (tag: number): BakeJobInput => ({
  w: 1, h: 1, pixels: new Uint8ClampedArray([tag, 0, 0, 255]), effects: [], fillOpacity: 1,
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function pool(n: number): { s: BakeScheduler; workers: ManualWorker[]; local: jest.Mock } {
  const workers: ManualWorker[] = [];
  const local = jest.fn((j: BakeJobInput) => new Uint8ClampedArray(j.pixels));
  const s = new BakeScheduler(async () => {
    const w = new ManualWorker();
    workers.push(w);
    return w;
  }, n, local);
  return { s, workers, local };
}

describe('BakeScheduler', () => {
  it('coalesces queued jobs per lane: latest wins, the replaced submit resolves null without running', async () => {
    const { s, workers } = pool(1);
    const first = s.submit('asset:a', job(10));
    await flush();
    const second = s.submit('asset:a', job(20));
    const third = s.submit('asset:a', job(30));
    await flush();
    // One job in the worker; the second never posted.
    expect(workers[0]!.inbox.map((m) => m.job.pixels[0])).toEqual([10]);
    await expect(second).resolves.toBeNull();

    workers[0]!.finish();
    const r1 = await first;
    // Finished, but a newer submit arrived while it ran.
    expect(r1).toEqual({ pixels: new Uint8ClampedArray([11, 0, 0, 255]), superseded: true });
    await flush();
    expect(workers[0]!.inbox.map((m) => m.job.pixels[0])).toEqual([30]);
    workers[0]!.finish();
    await expect(third).resolves.toEqual({ pixels: new Uint8ClampedArray([31, 0, 0, 255]), superseded: false });
  });

  it('never runs two jobs of one lane at once, even with idle workers', async () => {
    const { s, workers } = pool(2);
    const a1 = s.submit('asset:a', job(1));
    await flush();
    const a2 = s.submit('asset:a', job(2));
    await flush();
    const busy = workers.reduce((n, w) => n + w.inbox.length, 0);
    expect(busy).toBe(1);
    const owner = workers.find((w) => w.inbox.length === 1)!;
    owner.finish();
    await a1;
    await flush();
    const next = workers.find((w) => w.inbox.length === 1)!;
    expect(next.inbox[0]!.job.pixels[0]).toBe(2);
    next.finish();
    await expect(a2).resolves.toMatchObject({ superseded: false });
  });

  it('runs different lanes in parallel', async () => {
    const { s, workers } = pool(2);
    const a = s.submit('asset:a', job(1));
    const b = s.submit('asset:b', job(2));
    await flush();
    expect(workers.map((w) => w.inbox.length)).toEqual([1, 1]);
    workers[1]!.finish();
    workers[0]!.finish();
    await expect(a).resolves.toMatchObject({ superseded: false });
    await expect(b).resolves.toMatchObject({ superseded: false });
  });

  it('rejects a job the worker failed, and keeps scheduling', async () => {
    const { s, workers } = pool(1);
    const bad = s.submit('asset:a', job(1));
    const good = s.submit('asset:b', job(2));
    await flush();
    workers[0]!.fail();
    await expect(bad).rejects.toThrow('kernel threw');
    await flush();
    workers[0]!.finish();
    await expect(good).resolves.toMatchObject({ superseded: false });
  });

  it('a crashed worker rejects its job; with none left, queued work runs locally', async () => {
    const { s, workers, local } = pool(1);
    const running = s.submit('asset:a', job(1));
    const queued = s.submit('asset:b', job(2));
    await flush();
    workers[0]!.onerror?.(new Event('error'));
    await expect(running).rejects.toThrow('bake worker error');
    await expect(queued).resolves.toMatchObject({ pixels: new Uint8ClampedArray([2, 0, 0, 255]) });
    expect(local).toHaveBeenCalledTimes(1);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('with no worker at all, every job runs locally', async () => {
    const local = jest.fn((j: BakeJobInput) => new Uint8ClampedArray(j.pixels));
    const s = new BakeScheduler(async () => null, 2, local);
    await expect(s.submit('asset:a', job(7))).resolves.toEqual({ pixels: new Uint8ClampedArray([7, 0, 0, 255]), superseded: false });
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('transfers the job buffer to the worker', async () => {
    const posted: Transferable[][] = [];
    const w = new ManualWorker();
    w.postMessage = (msg: BakeRequestMessage, transfer?: Transferable[]): void => {
      w.inbox.push(msg);
      posted.push(transfer ?? []);
    };
    const s = new BakeScheduler(async () => w, 1, () => new Uint8ClampedArray(4));
    const input = job(5);
    void s.submit('asset:a', input);
    await flush();
    expect(posted[0]).toEqual([input.pixels.buffer]);
  });
});
