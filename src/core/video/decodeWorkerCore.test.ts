/**
 * The decode worker's logic against a fake `VideoDecoder`.
 *
 * What is pinned here is everything the worker decides on its own: which
 * outputs cross as copies and which as the decoder's frame, what is dropped
 * below the floor, when feeding stops for backpressure and resumes on acks,
 * what a reset throws away, and that every decoder frame is closed exactly
 * once — in the output callback, before anything else runs.
 */

import { createDecodeWorkerCore, MAX_IN_FLIGHT_FRAMES, type DecodeWorkerEnv } from './decodeWorkerCore';
import { packChunks, type DecodeResponse } from './decodeWire';
import type { EncodedChunkInit } from './exactVideoSource';

interface NFrame {
  timestamp: number;
  displayWidth: number;
  displayHeight: number;
  closes: number;
  close(): void;
}

interface Copy {
  kind: 'bitmap';
  of: NFrame;
  close(): void;
}

function harness(opts: { emitOnDecode?: boolean; failConfigure?: boolean } = {}) {
  const posts: Array<{ msg: DecodeResponse; transfer: Transferable[] }> = [];
  const frames: NFrame[] = [];
  const copies: Copy[] = [];

  class FakeDecoder {
    configured: object[] = [];
    decoded: EncodedChunkInit[] = [];
    pending: EncodedChunkInit[] = [];
    resets = 0;
    closed = false;
    constructor(readonly init: { output: (f: NFrame) => void; error: (e: Error) => void }) {}
    get decodeQueueSize(): number {
      return 0;
    }
    configure(c: object): void {
      this.configured.push(c);
    }
    decode(chunk: unknown): void {
      const c = chunk as EncodedChunkInit;
      this.decoded.push(c);
      if (opts.emitOnDecode) this.emit(c.timestamp);
      else this.pending.push(c);
    }
    emit(ts: number): NFrame {
      const f: NFrame = {
        timestamp: ts,
        displayWidth: 16,
        displayHeight: 9,
        closes: 0,
        close() {
          this.closes += 1;
        },
      };
      frames.push(f);
      this.init.output(f);
      return f;
    }
    flush(): Promise<void> {
      const batch = this.pending;
      this.pending = [];
      for (const c of [...batch].sort((a, b) => a.timestamp - b.timestamp)) this.emit(c.timestamp);
      return Promise.resolve();
    }
    reset(): void {
      this.resets += 1;
      this.pending = [];
    }
    close(): void {
      this.closed = true;
    }
  }

  const decoders: FakeDecoder[] = [];
  const env: DecodeWorkerEnv = {
    createDecoder: (init) => {
      if (opts.failConfigure) throw new ReferenceError('VideoDecoder is not defined');
      const d = new FakeDecoder(init as never);
      decoders.push(d);
      return d as never;
    },
    createChunk: (init) => ({ type: init.type, timestamp: init.timestamp, durationUs: init.duration, data: init.data }),
    copyFrame: (frame) => {
      const f = frame as unknown as NFrame;
      const copy: Copy = { kind: 'bitmap', of: f, close() { /* bitmap */ } };
      copies.push(copy);
      f.close();
      return copy as unknown as ImageBitmap;
    },
    post: (msg, transfer) => {
      posts.push({ msg, transfer });
    },
  };
  const core = createDecodeWorkerCore(env);
  return { core, posts, frames, copies, decoders };
}

const CONFIG = { codec: 'avc1.4d400a', codedWidth: 16, codedHeight: 9 };

function batch(from: number, to: number) {
  const chunks: EncodedChunkInit[] = [];
  for (let i = from; i <= to; i++) {
    chunks.push({ type: i === from ? 'key' : 'delta', timestamp: i * 1000, durationUs: 1000, data: new Uint8Array([i]) });
  }
  return packChunks(chunks);
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const ofOp = <T extends DecodeResponse['op']>(posts: Array<{ msg: DecodeResponse }>, op: T) =>
  posts.filter((p) => p.msg.op === op) as unknown as Array<{ msg: Extract<DecodeResponse, { op: T }>; transfer: Transferable[] }>;

describe('decode worker core', () => {
  it('copies kept frames and closes each original in the output callback; the raw target crosses as itself', async () => {
    const h = harness();
    h.core.handle({ op: 'configure', id: 1, config: CONFIG });
    h.core.handle({ op: 'hints', id: 1, floorUs: 0, rawUs: 3000 });
    const b = batch(0, 3);
    h.core.handle({ op: 'decode', id: 1, chunks: b.chunks, bytes: b.bytes });
    h.core.handle({ op: 'flush', id: 1, seq: 7 });
    await tick();

    const framePosts = ofOp(h.posts, 'frame');
    expect(framePosts.map((p) => p.msg.timestamp)).toEqual([0, 1000, 2000, 3000]);
    for (const p of framePosts.slice(0, 3)) {
      const payload = p.msg.frame as unknown as Copy;
      expect(payload.kind).toBe('bitmap');
      expect(payload.of.closes).toBe(1); // closed before it was posted
      expect(p.transfer).toEqual([payload]); // transferred, never cloned
    }
    const raw = framePosts[3]!;
    expect((raw.msg.frame as unknown as NFrame).closes).toBe(0); // the receiver owns it now
    expect(raw.transfer).toEqual([raw.msg.frame]);
    // The flush reply comes after every frame of the request.
    const flushedAt = h.posts.findIndex((p) => p.msg.op === 'flushed');
    expect(flushedAt).toBeGreaterThan(h.posts.indexOf(raw as never));
    expect(h.core.inFlight).toBe(4);
  });

  it('below the hint floor: closed without a copy and reported as dropped', async () => {
    const h = harness();
    h.core.handle({ op: 'configure', id: 1, config: CONFIG });
    h.core.handle({ op: 'hints', id: 1, floorUs: 2000 });
    const b = batch(0, 3);
    h.core.handle({ op: 'decode', id: 1, chunks: b.chunks, bytes: b.bytes });
    h.core.handle({ op: 'flush', id: 1, seq: 1 });
    await tick();
    expect(ofOp(h.posts, 'dropped').map((p) => p.msg.timestamp)).toEqual([0, 1000]);
    expect(h.copies.map((c) => c.of.timestamp)).toEqual([2000, 3000]);
    for (const f of h.frames) expect(f.closes).toBe(1);
  });

  it('stops feeding at the in-flight bound, resumes on acks, and answers flush only once the backlog drained', async () => {
    const h = harness({ emitOnDecode: true });
    h.core.handle({ op: 'configure', id: 1, config: CONFIG });
    const b = batch(0, 19);
    h.core.handle({ op: 'decode', id: 1, chunks: b.chunks, bytes: b.bytes });
    h.core.handle({ op: 'flush', id: 1, seq: 3 });
    await tick();
    const d = h.decoders[0]!;
    expect(d.decoded).toHaveLength(MAX_IN_FLIGHT_FRAMES);
    expect(ofOp(h.posts, 'flushed')).toHaveLength(0);

    h.core.handle({ op: 'ack', count: MAX_IN_FLIGHT_FRAMES });
    expect(d.decoded).toHaveLength(2 * MAX_IN_FLIGHT_FRAMES);
    await tick();
    expect(ofOp(h.posts, 'flushed')).toHaveLength(0);

    h.core.handle({ op: 'ack', count: MAX_IN_FLIGHT_FRAMES });
    expect(d.decoded).toHaveLength(20);
    await tick();
    const flushed = h.posts.findIndex((p) => p.msg.op === 'flushed');
    expect(flushed).toBeGreaterThan(-1);
    const lastFrame = h.posts.map((p) => p.msg.op).lastIndexOf('frame');
    expect(flushed).toBeGreaterThan(lastFrame);
    expect(ofOp(h.posts, 'frame')).toHaveLength(20);
  });

  it('reset drops held-back chunks, answers waiting flushes as aborted, and reconfigures', async () => {
    const h = harness({ emitOnDecode: true });
    h.core.handle({ op: 'configure', id: 1, config: CONFIG });
    const b = batch(0, 19);
    h.core.handle({ op: 'decode', id: 1, chunks: b.chunks, bytes: b.bytes });
    h.core.handle({ op: 'flush', id: 1, seq: 5 });
    h.core.handle({ op: 'reset', id: 1 });
    const d = h.decoders[0]!;
    expect(d.resets).toBe(1);
    expect(d.configured).toHaveLength(2);
    const flushed = ofOp(h.posts, 'flushed');
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.msg).toMatchObject({ seq: 5, aborted: true });
    h.core.handle({ op: 'ack', count: MAX_IN_FLIGHT_FRAMES });
    await tick();
    expect(d.decoded).toHaveLength(MAX_IN_FLIGHT_FRAMES); // the backlog is gone
  });

  it('close closes the decoder, and a straggling output is closed rather than posted', () => {
    const h = harness();
    h.core.handle({ op: 'configure', id: 1, config: CONFIG });
    const d = h.decoders[0]!;
    h.core.handle({ op: 'close', id: 1 });
    expect(d.closed).toBe(true);
    const before = h.posts.length;
    const late = d.emit(5000);
    expect(late.closes).toBe(1);
    expect(h.posts).toHaveLength(before);
  });

  it('reports a configure the platform cannot run as unsupported', () => {
    const h = harness({ failConfigure: true });
    h.core.handle({ op: 'configure', id: 9, config: CONFIG });
    expect(ofOp(h.posts, 'error')[0]!.msg).toMatchObject({ id: 9, unsupported: true });
  });

  it('answers a flush for an unknown decoder instead of leaving it pending', () => {
    const h = harness();
    h.core.handle({ op: 'flush', id: 42, seq: 1 });
    expect(ofOp(h.posts, 'flushed')[0]!.msg).toMatchObject({ id: 42, seq: 1 });
    expect(ofOp(h.posts, 'flushed')[0]!.msg.error).toBeDefined();
  });
});
