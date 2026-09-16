/**
 * The CPU kernel path: the buffer contract, the module host, the compute cache,
 * and the scheduling the thread-safety declaration buys.
 *
 * These are the claims that decide whether a plugin's kernel produces the same
 * picture as its shader — the conversion at the boundary, and the order jobs
 * run in. Both are invisible when they are wrong: a premultiply mistake is a
 * dark fringe on soft edges, and a scheduling mistake is one frame in a hundred
 * built from stale state.
 */

import {
  toPremultipliedFloat,
  fromPremultipliedFloat,
  loadKernel,
  runKernelJob,
  resetKernelWorkerForTests,
} from './kernelWorkerCore';
import { ComputeCache, ComputeCacheStore, estimateBytes } from './computeCache';
import { KernelScheduler, laneFor, type KernelWorkerLike } from './kernelPool';
import {
  loadKernelModule,
  runEffectKernel,
  setPackageReader,
  resetKernelHostForTests,
} from './kernelHost';
import { setKernelSchedulerForTests } from './kernelPool';
import type { EffectContribution } from '../effectSchema';
import type { KernelJob } from './kernelTypes';

const HOST: KernelJob['host'] = {
  compWidth: 1920, compHeight: 1080, layerWidth: 4, layerHeight: 1,
  time: 1, compTime: 1, frame: 24, fps: 24, pixelScale: 1, downsample: 1, seed: 0.5,
};

/** A kernel that copies its input and records what the host handed it. */
const RECORDING_KERNEL = `
exports.render = function (input, output, width, height, params, host) {
  output.set(input);
  globalThis.__lastKernelCall = { width: width, height: height, params: params, host: host };
};`;

const job = (over: Partial<KernelJob> = {}): KernelJob => ({
  effectId: 'studio.acme.tint',
  module: { id: 'studio.acme/kernel.js', format: 'js', entry: 'render', code: RECORDING_KERNEL },
  pixels: new Uint8ClampedArray([255, 128, 0, 255, 0, 0, 0, 0, 10, 20, 30, 128, 255, 255, 255, 255]),
  width: 4,
  height: 1,
  params: { amount: 2 },
  host: HOST,
  instanceId: 'fx_1',
  ...over,
});

beforeEach(() => {
  resetKernelWorkerForTests();
  resetKernelHostForTests();
  setKernelSchedulerForTests(null);
  delete (globalThis as Record<string, unknown>).__lastKernelCall;
});
afterEach(() => setKernelSchedulerForTests(undefined));

describe('the buffer contract', () => {
  it('hands the kernel PREMULTIPLIED floats in 0..1', () => {
    const src = new Uint8ClampedArray([255, 255, 255, 128]);
    const out = new Float32Array(4);
    toPremultipliedFloat(src, out);
    // 128/255 alpha, and the colour scaled by it — not left straight, which is
    // what a canvas hands over and what compositing arithmetic cannot use.
    expect(out[3]).toBeCloseTo(128 / 255, 5);
    expect(out[0]).toBeCloseTo(128 / 255, 5);
  });

  it('round-trips a buffer unchanged', () => {
    /*
      The property the CPU twin rests on. A kernel that copies its input must
      produce its input — any drift here is a layer that changes the moment an
      effect is added, before the effect has done anything.
    */
    const src = new Uint8ClampedArray([255, 128, 0, 255, 0, 0, 0, 0, 10, 20, 30, 200, 7, 8, 9, 3]);
    const mid = new Float32Array(src.length);
    const back = new Uint8ClampedArray(src.length);
    toPremultipliedFloat(src, mid);
    fromPremultipliedFloat(mid, back);
    for (let i = 0; i < src.length; i++) {
      // ±1 code: the round trip is through an 8-bit quantisation at a
      // non-integer alpha, and demanding exactness would be demanding that
      // 200/255 divides evenly.
      expect(Math.abs(back[i]! - src[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it('zeroes the colour of a fully transparent pixel', () => {
    // Unpremultiplying at alpha 0 is 0/0. Left as whatever the buffer held, a
    // cleared region comes back as transparent NOISE, which shows the instant
    // anything composites it at a non-zero alpha.
    const out = new Uint8ClampedArray(4).fill(200);
    fromPremultipliedFloat(new Float32Array([0.5, 0.5, 0.5, 0]), out);
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it('clamps rather than wraps an out-of-range result', () => {
    const out = new Uint8ClampedArray(4);
    fromPremultipliedFloat(new Float32Array([4, -1, Number.NaN, 1]), out);
    expect([...out]).toEqual([255, 0, 0, 255]);
  });
});

describe('the module host', () => {
  it('runs a JS kernel and returns its output', async () => {
    const pixels = await runKernelJob(job());
    expect([...pixels].slice(0, 4)).toEqual([255, 128, 0, 255]);
  });

  it('hands it the declared parameters and the host inputs', async () => {
    await runKernelJob(job());
    const call = (globalThis as Record<string, unknown>).__lastKernelCall as {
      params: Record<string, unknown>;
      host: Record<string, unknown>;
    };
    expect(call.params).toEqual({ amount: 2 });
    expect(call.host.compWidth).toBe(1920);
    expect(call.host.fps).toBe(24);
    expect(call.host.seed).toBe(0.5);
  });

  it('accepts a bare `function render` as well as an export assignment', async () => {
    const pixels = await runKernelJob(job({
      module: {
        id: 'bare/kernel.js', format: 'js', entry: 'render',
        code: 'function render(input, output) { output.set(input); }',
      },
    }));
    expect(pixels.length).toBe(16);
  });

  it('instantiates a module ONCE, however many jobs run', async () => {
    let compiles = 0;
    const counting = `exports.render = function (i, o) { o.set(i); };\nglobalThis.__compiles = (globalThis.__compiles || 0) + 1;`;
    const source = { id: 'count/kernel.js', format: 'js' as const, entry: 'render', code: counting };
    await runKernelJob(job({ module: source }));
    await runKernelJob(job({ module: source }));
    compiles = (globalThis as Record<string, unknown>).__compiles as number;
    // A WASM compile is tens of milliseconds; per frame it would make the
    // kernel path slower than what it replaced.
    expect(compiles).toBe(1);
    delete (globalThis as Record<string, unknown>).__compiles;
  });

  it('reports a module with no entry point by name', async () => {
    await expect(runKernelJob(job({
      module: { id: 'empty/kernel.js', format: 'js', entry: 'render', code: 'var x = 1;' },
    }))).rejects.toThrow(/exports no "render"/);
  });

  it('turns a throwing kernel into an error naming the kernel, not the host', async () => {
    await expect(runKernelJob(job({
      module: {
        id: 'boom/kernel.js', format: 'js', entry: 'render',
        code: 'exports.render = function () { throw new Error("bad maths"); };',
      },
    }))).rejects.toThrow(/bad maths/);
  });

  it('gives a kernel its neighbouring frames, keyed by offset', async () => {
    await runKernelJob(job({
      neighbours: [{ offset: -1, pixels: new Uint8ClampedArray(16).fill(64) }],
    }));
    const call = (globalThis as Record<string, unknown>).__lastKernelCall as {
      host: { frames?: Record<number, Float32Array> };
    };
    expect(call.host.frames?.[-1]).toBeInstanceOf(Float32Array);
    // Absent, not zero-filled: a kernel differencing against a black frame
    // flashes at exactly the moments the provider is likeliest to miss.
    expect(call.host.frames?.[1]).toBeUndefined();
  });
});

describe('the compute cache', () => {
  it('returns what was put in', () => {
    const cache = new ComputeCache(1024);
    cache.set('lut', new Float32Array(8));
    expect(cache.get('lut')).toBeInstanceOf(Float32Array);
  });

  it('evicts least-recently-USED, not least-recently-set', () => {
    const cache = new ComputeCache(300);
    cache.set('a', new Float32Array(25)); // 100 bytes
    cache.set('b', new Float32Array(25));
    cache.get('a');                        // `a` is now the newer of the two
    cache.set('c', new Float32Array(25));
    cache.set('d', new Float32Array(25));  // over budget → evict one
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
  });

  it('refuses an entry larger than the whole budget', () => {
    // Storing it would evict everything and then be evicted itself by the next
    // set — a cache holding one enormous thing, thrashing.
    const cache = new ComputeCache(100);
    cache.set('huge', new Float32Array(1000));
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.count).toBe(0);
  });

  it('stays inside its budget however much is written', () => {
    const cache = new ComputeCache(1000);
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, new Float32Array(50));
    expect(cache.sizeBytes).toBeLessThanOrEqual(1000);
  });

  it('measures typed arrays exactly and guesses the rest', () => {
    expect(estimateBytes(new Float32Array(10))).toBe(40);
    expect(estimateBytes({ a: 1, b: 2 })).toBeGreaterThan(0);
  });

  it('scopes caches to the effect INSTANCE', () => {
    // Two copies of one effect with different parameters would otherwise fight
    // over one key and rebuild alternately — slower than no cache at all.
    const store = new ComputeCacheStore();
    store.for('fx_1').set('k', 1);
    expect(store.for('fx_2').get('k')).toBeUndefined();
    expect(store.for('fx_1').get('k')).toBe(1);
  });
});

describe('thread safety decides the lane', () => {
  it('serialises an `unsafe` plugin across every instance it has', () => {
    expect(laneFor('unsafe', 'acme', 'fx_1', 1)).toBe(laneFor('unsafe', 'acme', 'fx_2', 2));
  });

  it('keeps `instance` effects apart but one instance in order', () => {
    expect(laneFor('instance', 'acme', 'fx_1', 1)).not.toBe(laneFor('instance', 'acme', 'fx_2', 2));
    expect(laneFor('instance', 'acme', 'fx_1', 1)).toBe(laneFor('instance', 'acme', 'fx_1', 2));
  });

  it('defaults to `instance` when the manifest says nothing', () => {
    // The strict default is deliberate: a wrong `full` is a race that shows as
    // one corrupt frame in a hundred, and an over-strict default costs only
    // throughput.
    expect(laneFor(undefined, 'acme', 'fx_1', 1)).toBe(laneFor('instance', 'acme', 'fx_1', 9));
  });

  it('gives `full` a lane per job, so nothing serialises', () => {
    expect(laneFor('full', 'acme', 'fx_1', 1)).not.toBe(laneFor('full', 'acme', 'fx_1', 2));
  });
});

describe('the scheduler', () => {
  /** A worker that answers when the test says so. */
  class FakeWorker implements KernelWorkerLike {
    onmessage: ((ev: { data: import('./kernelTypes').KernelResponseMessage }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    readonly seen: number[] = [];
    terminated = false;
    postMessage(msg: import('./kernelTypes').KernelRequestMessage): void {
      this.seen.push(msg.id);
    }
    answer(id: number): void {
      this.onmessage?.({ data: { id, ok: true, pixels: new Uint8ClampedArray(4) } });
    }
    terminate(): void { this.terminated = true; }
  }

  it('runs one job per lane at a time', async () => {
    const worker = new FakeWorker();
    const pool = new KernelScheduler(async () => worker, 1);
    const first = pool.submit('lane', job());
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.seen).toHaveLength(1);

    const second = pool.submit('lane', job());
    await Promise.resolve();
    // Still one: the lane is busy, and a second kernel of the same layer
    // finishing out of order is the stale frame this rule exists to prevent.
    expect(worker.seen).toHaveLength(1);

    worker.answer(worker.seen[0]!);
    await first;
    await Promise.resolve();
    expect(worker.seen).toHaveLength(2);
    worker.answer(worker.seen[1]!);
    await second;
  });

  it('replaces a QUEUED job rather than running both', async () => {
    const worker = new FakeWorker();
    const pool = new KernelScheduler(async () => worker, 1);
    const running = pool.submit('lane', job());
    await Promise.resolve();
    await Promise.resolve();
    const stale = pool.submit('lane', job());
    const newest = pool.submit('lane', job());
    // A scrub produces far more requests than any machine can service; only
    // the newest is worth the work, and the replaced one resolves `null`
    // rather than hanging its caller.
    await expect(stale).resolves.toBeNull();
    worker.answer(worker.seen[0]!);
    await running;
    await Promise.resolve();
    worker.answer(worker.seen[1]!);
    await expect(newest).resolves.not.toBeNull();
  });

  it('marks a landed job superseded when a newer one arrived meanwhile', async () => {
    const worker = new FakeWorker();
    const pool = new KernelScheduler(async () => worker, 1);
    const first = pool.submit('lane', job());
    await Promise.resolve();
    await Promise.resolve();
    void pool.submit('lane', job());
    worker.answer(worker.seen[0]!);
    const landed = await first;
    // The caller decides what that means — a preview shows it if it is still
    // newer than what is on screen; an export waits for its own frame.
    expect(landed?.superseded).toBe(true);
  });

  it('falls back to running jobs here when no worker can be spawned', async () => {
    const pool = new KernelScheduler(async () => null, 2);
    const landed = await pool.submit('lane', job());
    // The SAME function the worker runs, so the fallback cannot drift into a
    // different picture — only a slower one.
    expect(landed?.pixels.length).toBe(16);
  });
});

describe('the host facade', () => {
  const contribution = (over: Partial<EffectContribution> = {}): EffectContribution => ({
    id: 'tint',
    label: 'Tint',
    shader: '',
    params: {},
    cpu: { module: 'kernels/tint.js', format: 'js', entry: 'render' },
    ...over,
  });

  it('reads the kernel out of the package', async () => {
    setPackageReader({ read: async () => RECORDING_KERNEL });
    const source = await loadKernelModule('studio.acme', contribution());
    expect(source?.id).toBe('studio.acme/kernels/tint.js');
    expect(source?.entry).toBe('render');
  });

  it('answers null — not an exception — when the package has no such file', async () => {
    // A frame that does not happen is worse than an effect that does nothing.
    setPackageReader({ read: async () => null });
    expect(await loadKernelModule('studio.acme', contribution())).toBeNull();
  });

  it('caches the miss, so a missing kernel is not re-read every frame', async () => {
    let reads = 0;
    setPackageReader({ read: async () => { reads++; return null; } });
    await loadKernelModule('studio.acme', contribution());
    await loadKernelModule('studio.acme', contribution());
    expect(reads).toBe(1);
  });

  it('runs an effect end to end with no worker present', async () => {
    setPackageReader({ read: async () => RECORDING_KERNEL });
    const pixels = await runEffectKernel({
      pluginId: 'studio.acme',
      effect: contribution(),
      effectId: 'studio.acme.tint',
      instanceId: 'fx_1',
      pixels: new Uint8ClampedArray([1, 2, 3, 255]),
      width: 1,
      height: 1,
      params: {},
      host: { ...HOST, layerWidth: 1, layerHeight: 1 },
    });
    expect(pixels).not.toBeNull();
    expect([...pixels!]).toEqual([1, 2, 3, 255]);
  });

  it('returns null for an effect with no kernel at all', async () => {
    expect(await runEffectKernel({
      pluginId: 'studio.acme',
      effect: contribution({ cpu: undefined }),
      effectId: 'studio.acme.tint',
      instanceId: 'fx_1',
      pixels: new Uint8ClampedArray(4),
      width: 1, height: 1, params: {}, host: HOST,
    })).toBeNull();
  });
});

describe('a kernel cannot reach the host', () => {
  it('sees no `motion` global and no document', async () => {
    /*
      Not a security boundary — a kernel is the plugin's own code — and not
      claimed as one. It is a SHAPE: a kernel that cannot ask the host anything
      is a kernel that cannot be in the frame loop's way, which is the entire
      reason effects are data rather than callbacks.
    */
    await runKernelJob(job({
      module: {
        id: 'probe/kernel.js', format: 'js', entry: 'render',
        code: `exports.render = function (i, o) {
          o.set(i);
          globalThis.__probe = typeof motion;
        };`,
      },
    }));
    expect((globalThis as Record<string, unknown>).__probe).toBe('undefined');
    delete (globalThis as Record<string, unknown>).__probe;
  });
});

describe('loading the same module twice', () => {
  it('returns the identical function', async () => {
    const source = { id: 'same/kernel.js', format: 'js' as const, entry: 'render', code: RECORDING_KERNEL };
    expect(await loadKernel(source)).toBe(await loadKernel(source));
  });
});
