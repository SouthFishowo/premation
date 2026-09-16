/**
 * The decode-worker client, end to end over a loopback "worker".
 *
 * jsdom has no Worker, so the worker here is the real `decodeWorkerCore`
 * behind a fake that delivers messages on later macrotasks in both directions
 * — the ordering a real MessagePort gives. On top sits a real
 * `ExactVideoSource`, so these tests exercise the exact stack the render path
 * uses: session → client → wire → core → decoder.
 *
 * What is pinned: same frames as the in-thread IO; one transfer per feed
 * burst; acks keep a long GOP flowing past the in-flight bound; a crash fails
 * pending work as TRANSIENT and the next request restarts the worker; a
 * worker that never ran, a worker without VideoDecoder, a spawn that throws
 * and a crash loop all fall back to the in-thread IO; a silent worker trips
 * the watchdog; frames for a closed decoder are closed.
 */

import { createDecodeWorkerCore, type DecodeWorkerEnv } from './decodeWorkerCore';
import type { DecodeRequest, DecodeResponse } from './decodeWire';
import {
  ExactVideoSource,
  isTransientDecodeError,
  webCodecsIO,
  type DecoderIO,
  type DecodedFrameLike,
  type EncodedChunkInit,
} from './exactVideoSource';
import type { DemuxedVideo } from './mp4Demuxer';
import { WorkerDecodeClient, renderDecodeIO, type WorkerLike } from './workerDecoderIO';
import { resetVideoDecodeStats, videoDecodeStats } from './decodeStats';

const TS = 15360;
const DUR = 512;

function demuxed(gop = 8, count = 48): DemuxedVideo {
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push({ data: new Uint8Array([i, i]), dts: i * DUR, cts: i * DUR, isKey: i % gop === 0, duration: DUR });
  }
  return { codec: 'avc1.4d400a', codedWidth: 16, codedHeight: 9, timescale: TS, description: new Uint8Array([1, 2]), samples };
}

const frameUs = (i: number): number => Math.round((i * 1e6) / 30);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Wait for `cond`; a condition that throws (worker not spawned yet) is "not yet". */
const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  const holds = (): boolean => {
    try {
      return cond();
    } catch {
      return false;
    }
  };
  while (!holds()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await tick();
  }
};

interface Copy extends DecodedFrameLike {
  closes: number;
}

type DecoderMode = 'normal' | 'emitOnDecode' | 'hang';

/** A worker env whose decoder emits on flush (or per decode, or never). */
function workerEnv(mode: DecoderMode, post: DecodeWorkerEnv['post'], copies: Copy[]): DecodeWorkerEnv {
  return {
    createDecoder: (init) => {
      let pending: EncodedChunkInit[] = [];
      const emit = (ts: number): void => {
        init.output({ timestamp: ts, displayWidth: 16, displayHeight: 9, close() { /* original */ } });
      };
      return {
        decodeQueueSize: 0,
        configure() { /* ok */ },
        decode(chunk: unknown) {
          const c = chunk as { timestamp: number };
          if (mode === 'emitOnDecode') emit(c.timestamp);
          else pending.push(c as EncodedChunkInit);
        },
        flush() {
          if (mode === 'hang') return new Promise<void>(() => { /* never */ });
          const b = pending;
          pending = [];
          for (const c of [...b].sort((x, y) => x.timestamp - y.timestamp)) emit(c.timestamp);
          return Promise.resolve();
        },
        reset() { pending = []; },
        close() { /* ok */ },
      };
    },
    createChunk: (init) => init,
    copyFrame: (frame) => {
      const copy: Copy = {
        timestamp: frame.timestamp,
        closes: 0,
        close() {
          this.closes += 1;
        },
      };
      copies.push(copy);
      frame.close();
      return copy as unknown as ImageBitmap;
    },
    post,
  };
}

class LoopbackWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  terminated = false;
  readonly sent: DecodeRequest[] = [];
  readonly transfers: Transferable[][] = [];
  private readonly core;

  constructor(mode: DecoderMode, copies: Copy[], opts: { ready?: boolean; videoDecoder?: boolean } = {}) {
    this.core = createDecodeWorkerCore(
      workerEnv(mode, (msg) => this.deliver(msg), copies),
    );
    if (opts.ready !== false) {
      this.deliver({ op: 'ready', videoDecoder: opts.videoDecoder ?? true, offscreen: true });
    }
  }

  private deliver(msg: DecodeResponse): void {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: msg } as MessageEvent);
    }, 0);
  }

  postMessage(msg: unknown, transfer: Transferable[] = []): void {
    this.sent.push(msg as DecodeRequest);
    this.transfers.push(transfer);
    setTimeout(() => {
      if (!this.terminated) this.core.handle(msg as DecodeRequest);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(): void {
    this.onerror?.(new Event('error'));
  }
}

/** An in-thread IO fake that records use — stands in for webCodecsIO. */
function recordingFallback(): { io: DecoderIO; created: () => number } {
  let created = 0;
  const io: DecoderIO = {
    createDecoder(_config, handlers) {
      created += 1;
      let pending: EncodedChunkInit[] = [];
      return {
        decode(chunk) { pending.push(chunk as EncodedChunkInit); },
        async flush() {
          for (const c of pending) handlers.output({ timestamp: c.timestamp, close() { /* ok */ } });
          pending = [];
        },
        close() { /* ok */ },
      };
    },
    createChunk: (init) => init,
  };
  return { io, created: () => created };
}

beforeEach(resetVideoDecodeStats);

describe('WorkerDecodeClient', () => {
  it('decodes through the worker exactly what the session asks for, one transfer per feed burst', async () => {
    const copies: Copy[] = [];
    const workers: LoopbackWorker[] = [];
    const client = new WorkerDecodeClient({
      spawn: () => {
        const w = new LoopbackWorker('normal', copies);
        workers.push(w);
        return w;
      },
    });
    const d = demuxed();
    const src = new ExactVideoSource(d, client);
    const f5 = await src.frameAt(5);
    expect(f5.timestamp).toBe(frameUs(5));
    const f13 = await src.frameAt(13);
    expect(f13.timestamp).toBe(frameUs(13));

    const w = workers[0]!;
    expect(workers).toHaveLength(1);
    const decodes = w.sent.filter((m) => m.op === 'decode') as Array<Extract<DecodeRequest, { op: 'decode' }>>;
    expect(decodes.map((m) => m.chunks.length)).toEqual([6, 6]); // GOP 0 through 5, GOP 1 through 13
    // Each burst travelled as ONE fresh buffer — never a view of the file.
    for (const m of decodes) {
      expect(m.bytes.byteLength).toBe(m.chunks.length * 2);
      expect(m.bytes).not.toBe(d.samples[0]!.data.buffer);
    }
    const decodeTransfers = w.transfers.filter((_t, i) => w.sent[i]!.op === 'decode');
    expect(decodeTransfers.every((t) => t.length === 1)).toBe(true);
    // The hints precede the burst they describe.
    const firstHints = w.sent.findIndex((m) => m.op === 'hints');
    const firstDecode = w.sent.findIndex((m) => m.op === 'decode');
    expect(firstHints).toBeGreaterThan(-1);
    expect(firstHints).toBeLessThan(firstDecode);
    src.close();
    client.dispose();
  });

  it('acknowledges frames so a GOP longer than the in-flight bound keeps flowing', async () => {
    const copies: Copy[] = [];
    let worker: LoopbackWorker | null = null;
    const client = new WorkerDecodeClient({
      spawn: () => (worker = new LoopbackWorker('emitOnDecode', copies)),
    });
    const src = new ExactVideoSource(demuxed(40, 40), client, 40);
    const f = await src.frameAt(35);
    expect(f.timestamp).toBe(frameUs(35));
    const acked = worker!.sent
      .filter((m): m is Extract<DecodeRequest, { op: 'ack' }> => m.op === 'ack')
      .reduce((n, m) => n + m.count, 0);
    expect(acked).toBeGreaterThanOrEqual(36);
    src.close();
    client.dispose();
  });

  it('a crash fails in-flight work as TRANSIENT and the next request restarts the worker', async () => {
    const copies: Copy[] = [];
    const workers: LoopbackWorker[] = [];
    const client = new WorkerDecodeClient({
      spawn: () => {
        const w = new LoopbackWorker(workers.length === 0 ? 'hang' : 'normal', copies);
        workers.push(w);
        return w;
      },
    });
    const src = new ExactVideoSource(demuxed(), client);
    const first = src.frameAt(10).then(() => 'resolved', (e: unknown) => e);
    await until(() => workers[0]!.sent.some((m) => m.op === 'flush'));
    await tick(); // let 'ready' land: this worker DID run
    workers[0]!.crash();
    const err = await first;
    expect(isTransientDecodeError(err)).toBe(true);
    expect(workers[0]!.terminated).toBe(true);

    // Resume: the next request builds a fresh decoder on a fresh worker.
    const again = await src.frameAt(10);
    expect(again.timestamp).toBe(frameUs(10));
    expect(workers).toHaveLength(2);
    expect(videoDecodeStats.workerRestarts).toBe(1);
    src.close();
    client.dispose();
  });

  it('a worker that dies before reporting ready is never restarted — decoding falls back in-thread', async () => {
    const copies: Copy[] = [];
    const fallback = recordingFallback();
    const workers: LoopbackWorker[] = [];
    const client = new WorkerDecodeClient({
      fallback: fallback.io,
      spawn: () => {
        const w = new LoopbackWorker('normal', copies, { ready: false });
        workers.push(w);
        return w;
      },
    });
    const src = new ExactVideoSource(demuxed(), client);
    const first = src.frameAt(3).then(() => 'resolved', (e: unknown) => e);
    await until(() => workers.length === 1 && workers[0]!.onerror !== null);
    workers[0]!.crash();
    expect(isTransientDecodeError(await first)).toBe(true);
    expect(client.usingWorker).toBe(false);

    const f = await src.frameAt(3);
    expect(f.timestamp).toBe(frameUs(3));
    expect(workers).toHaveLength(1);
    expect(fallback.created()).toBe(1);
    src.close();
  });

  it('a worker without VideoDecoder, or a spawn that throws, falls back in-thread', async () => {
    const copies: Copy[] = [];
    const fbA = recordingFallback();
    const noDecoder = new WorkerDecodeClient({
      fallback: fbA.io,
      spawn: () => new LoopbackWorker('normal', copies, { videoDecoder: false }),
    });
    const srcA = new ExactVideoSource(demuxed(), noDecoder);
    const a = await srcA.frameAt(2).then(() => 'resolved', (e: unknown) => e);
    // Either the ready message landed first (straight to fallback) or it
    // failed the pending decode as transient — never a codec failure.
    if (a !== 'resolved') expect(isTransientDecodeError(a)).toBe(true);
    expect((await srcA.frameAt(2)).timestamp).toBe(frameUs(2));
    expect(fbA.created()).toBeGreaterThanOrEqual(1);
    srcA.close();

    const fbB = recordingFallback();
    const throws = new WorkerDecodeClient({
      fallback: fbB.io,
      spawn: () => {
        throw new Error('blocked');
      },
    });
    const srcB = new ExactVideoSource(demuxed(), throws);
    const b = await srcB.frameAt(2).then(() => 'resolved', (e: unknown) => e);
    if (b !== 'resolved') expect(isTransientDecodeError(b)).toBe(true);
    expect((await srcB.frameAt(2)).timestamp).toBe(frameUs(2));
    expect(throws.usingWorker).toBe(false);
    srcB.close();
  });

  it('gives up on the worker after too many crashes inside the window', async () => {
    const copies: Copy[] = [];
    const fallback = recordingFallback();
    const workers: LoopbackWorker[] = [];
    const client = new WorkerDecodeClient({
      fallback: fallback.io,
      maxRestarts: 1,
      spawn: () => {
        const w = new LoopbackWorker('hang', copies);
        workers.push(w);
        return w;
      },
    });
    const src = new ExactVideoSource(demuxed(), client);
    for (let round = 0; round < 2; round++) {
      const p = src.frameAt(4).then(() => 'resolved', (e: unknown) => e);
      await until(() => workers.length === round + 1 && workers[round]!.sent.some((m) => m.op === 'flush'));
      await tick();
      workers[round]!.crash();
      expect(isTransientDecodeError(await p)).toBe(true);
    }
    expect(client.usingWorker).toBe(false);
    expect((await src.frameAt(4)).timestamp).toBe(frameUs(4));
    expect(fallback.created()).toBe(1);
    expect(workers).toHaveLength(2);
    src.close();
  });

  it('the watchdog treats a worker that stops answering a flush as crashed', async () => {
    const copies: Copy[] = [];
    const workers: LoopbackWorker[] = [];
    const client = new WorkerDecodeClient({
      watchdogMs: 30,
      spawn: () => {
        const w = new LoopbackWorker(workers.length === 0 ? 'hang' : 'normal', copies);
        workers.push(w);
        return w;
      },
    });
    const src = new ExactVideoSource(demuxed(), client);
    const err = await src.frameAt(6).then(() => 'resolved', (e: unknown) => e);
    expect(isTransientDecodeError(err)).toBe(true);
    expect(workers[0]!.terminated).toBe(true);
    expect((await src.frameAt(6)).timestamp).toBe(frameUs(6));
    src.close();
    client.dispose();
  });

  it('frames arriving for a decoder the session already closed are closed on arrival', async () => {
    const copies: Copy[] = [];
    let worker: LoopbackWorker | null = null;
    const client = new WorkerDecodeClient({
      spawn: () => (worker = new LoopbackWorker('normal', copies)),
    });
    const src = new ExactVideoSource(demuxed(), client);
    const p = src.frameAt(7).then(() => 'resolved', () => 'rejected');
    // Close as soon as the flush is on its way: the worker answers it, but
    // the frames land after the session let go.
    await until(() => worker!.sent.some((m) => m.op === 'flush'));
    src.close();
    expect(await p).toBe('rejected');
    await until(() => copies.length === 8);
    for (let i = 0; i < 5; i++) await tick();
    for (const c of copies) expect(c.closes).toBe(1);
    client.dispose();
  });
});

describe('renderDecodeIO', () => {
  it('is the in-thread IO where there is no Worker (jsdom, CLI harness contexts)', () => {
    expect(typeof Worker).toBe('undefined');
    expect(renderDecodeIO()).toBe(webCodecsIO);
  });
});
