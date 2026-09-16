/**
 * The frame pipeline: bounded concurrency, back-pressure, and no silent holes.
 */

import { FramePipeline, SequentialWriter, defaultConcurrency } from './framePipeline';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('defaultConcurrency', () => {
  it('is cores − 1, clamped to 2..6', () => {
    expect(defaultConcurrency(1)).toBe(2);
    expect(defaultConcurrency(4)).toBe(3);
    expect(defaultConcurrency(32)).toBe(6);
  });
});

describe('FramePipeline', () => {
  it('admits up to the limit without waiting, then applies back-pressure', async () => {
    const p = new FramePipeline({ concurrency: 2 });
    const resolvers: Array<() => void> = [];
    const job = () => new Promise<void>((r) => resolvers.push(r));
    await p.push(job);
    await p.push(job);
    expect(p.pending).toBe(2);
    let third = false;
    const pushing = p.push(job).then(() => { third = true; });
    await tick();
    expect(third).toBe(false);          // blocked: the queue is full
    resolvers[0]!();
    await pushing;
    expect(third).toBe(true);           // admitted once one finished
    expect(p.pending).toBe(2);
    resolvers[1]!(); resolvers[2]!();
    await p.drain();
    expect(p.pending).toBe(0);
  });

  it('lets the producer run ahead: k encodes overlap, the render never waits on one', async () => {
    const p = new FramePipeline({ concurrency: 3 });
    let maxOverlap = 0, running = 0;
    const job = () => new Promise<void>((r) => {
      running++; maxOverlap = Math.max(maxOverlap, running);
      setTimeout(() => { running--; r(); }, 5);
    });
    for (let i = 0; i < 9; i++) await p.push(job);
    await p.drain();
    expect(maxOverlap).toBe(3);
  });

  it('holds the first failure and rethrows it on the next push and on drain', async () => {
    const p = new FramePipeline({ concurrency: 4 });
    await p.push(async () => { throw new Error('disk full'); });
    await tick();
    await expect(p.push(async () => {})).rejects.toThrow('disk full');
    await expect(p.drain()).rejects.toThrow('disk full');
  });

  it('close waits and then refuses pushes, without throwing the held failure', async () => {
    const p = new FramePipeline({ concurrency: 2 });
    await p.push(async () => { throw new Error('x'); });
    await p.close();
    await expect(p.push(async () => {})).rejects.toThrow('closed');
  });
});

describe('SequentialWriter', () => {
  it('runs jobs strictly in push order even when earlier ones are slower', async () => {
    const w = new SequentialWriter({ maxQueued: 4 });
    const done: number[] = [];
    let running = 0;
    let maxRunning = 0;
    for (let i = 0; i < 8; i++) {
      await w.push(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        // Descending delays: a concurrent queue would finish these backwards.
        await new Promise((r) => setTimeout(r, 8 - i));
        done.push(i);
        running--;
      });
    }
    await w.drain();
    expect(done).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(maxRunning).toBe(1);
  });

  it('returns to the producer while a write is in flight, then applies back-pressure', async () => {
    const w = new SequentialWriter({ maxQueued: 2 });
    const resolvers: Array<() => void> = [];
    const job = () => new Promise<void>((r) => resolvers.push(r));
    await w.push(job); // running — the render of the next frame overlaps it
    await w.push(job); // queued behind it
    expect(w.pending).toBe(2);
    let third = false;
    const pushing = w.push(job).then(() => { third = true; });
    await tick();
    expect(third).toBe(false);
    resolvers[0]!();
    await pushing;
    expect(third).toBe(true);
    await tick();
    resolvers[1]!();
    await tick();
    resolvers[2]!();
    await w.drain();
    expect(w.pending).toBe(0);
  });

  it('skips everything queued behind a failure — no frame after a hole — and rethrows it', async () => {
    const w = new SequentialWriter({ maxQueued: 3 });
    const ran: number[] = [];
    await w.push(async () => { ran.push(0); throw new Error('encoder died'); });
    await w.push(async () => { ran.push(1); });
    await expect(w.drain()).rejects.toThrow('encoder died');
    expect(ran).toEqual([0]);
    await expect(w.push(async () => { ran.push(2); })).rejects.toThrow('encoder died');
  });

  it('wakes a producer blocked on back-pressure when the queue fails', async () => {
    const w = new SequentialWriter({ maxQueued: 1 });
    let fail!: (e: Error) => void;
    await w.push(() => new Promise<void>((_r, j) => { fail = j; }));
    const blocked = w.push(async () => {});
    await tick();
    fail(new Error('pipe closed'));
    await expect(blocked).rejects.toThrow('pipe closed');
  });

  it('close waits for queued jobs and then refuses pushes without throwing', async () => {
    const w = new SequentialWriter();
    await w.push(async () => { throw new Error('x'); });
    await w.close();
    await expect(w.push(async () => {})).rejects.toThrow('closed');
  });
});
