/**
 * Latest-wins seeks and frame ownership in `ExactVideoSource`.
 *
 * The scrub backlog this pins: a playhead dragged across a clip asks for a new
 * frame every vsync, each one a GOP decode slower than a vsync, and a plain
 * serial queue decoded every one of them in order — the picture trailed the
 * pointer and kept moving after it stopped. These tests drive a decoder whose
 * `flush()` only completes when the test says so, and a clock the test
 * advances, so "the decoder is still busy when the next seek arrives" is a
 * state the test holds rather than a race it hopes to hit.
 *
 * Turns matter: requests made in the SAME synchronous turn are one render's
 * worth of demand (Pixel Motion's bracket pair, a pulldown weave) and must not
 * cancel each other. `nextTurn()` is a macrotask boundary between renders.
 */

import {
  ExactVideoSource,
  isSuperseded,
  type DecoderIO,
  type DecodedFrameLike,
  type EncodedChunkInit,
  type SeekPolicy,
} from './exactVideoSource';
import type { DemuxedVideo } from './mp4Demuxer';
import { resetVideoDecodeStats, videoDecodeStats } from './decodeStats';

const TS = 15360;
const DUR = 512;
const GOP = 8;
const GOPS = 6;

/** 6 GOPs of 8, IPPP… (no reorder), 30fps. */
function demuxed(): DemuxedVideo {
  const samples = [];
  for (let i = 0; i < GOP * GOPS; i++) {
    samples.push({ data: new Uint8Array([i]), dts: i * DUR, cts: i * DUR, isKey: i % GOP === 0, duration: DUR });
  }
  return { codec: 'avc1.4d400a', codedWidth: 64, codedHeight: 48, timescale: TS, description: null, samples };
}

const frameUs = (i: number): number => Math.round((i * 1e6) / 30);
const nextTurn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface FakeFrame extends DecodedFrameLike {
  closes: number;
  raw: boolean;
}

function makeFrame(timestamp: number, raw: boolean): FakeFrame {
  return {
    timestamp,
    raw,
    closes: 0,
    close() {
      this.closes += 1;
    },
  };
}

/**
 * A decoder whose flush waits for `releaseFlush()`. Frames are "raw" (decoder
 * owned) until `retain` copies them — the copy closes the original, exactly as
 * the production adapter does.
 */
function gatedIO(opts: { withReset?: boolean; errorAfterFlush?: () => boolean } = {}) {
  const withReset = opts.withReset ?? true;
  const feeds: EncodedChunkInit[][] = [];
  const made: FakeFrame[] = [];
  const copies: FakeFrame[] = [];
  let resets = 0;
  let closes = 0;
  const gates: Array<() => void> = [];
  const lateOutputs: Array<() => void> = [];

  const io: DecoderIO = {
    createDecoder(_config, handlers) {
      const mine: EncodedChunkInit[] = [];
      feeds.push(mine);
      let pending: EncodedChunkInit[] = [];
      let rejectFlush: ((e: unknown) => void) | null = null;
      return {
        decode(chunk: unknown) {
          const c = chunk as EncodedChunkInit;
          mine.push(c);
          pending.push(c);
        },
        flush() {
          const batch = pending;
          pending = [];
          return new Promise<void>((resolve, reject) => {
            rejectFlush = reject;
            gates.push(() => {
              rejectFlush = null;
              for (const c of [...batch].sort((a, b) => a.timestamp - b.timestamp)) {
                const f = makeFrame(c.timestamp, true);
                made.push(f);
                handlers.output(f);
              }
              if (opts.errorAfterFlush?.()) handlers.error(new Error('bitstream error'));
              resolve();
            });
            // What an abandoned decoder might still emit after the session
            // moved on: the last frame of its batch, late.
            lateOutputs.push(() => {
              const c = batch[batch.length - 1];
              if (!c) return;
              const f = makeFrame(c.timestamp, true);
              made.push(f);
              handlers.output(f);
            });
          });
        },
        close() {
          closes += 1;
        },
        ...(withReset
          ? {
            reset() {
              resets += 1;
              pending = [];
              const rej = rejectFlush;
              rejectFlush = null;
              gates.length = 0;
              const e = new Error('reset');
              e.name = 'AbortError';
              rej?.(e);
            },
          }
          : {}),
      };
    },
    createChunk: (init) => init,
    retain(frame) {
      const f = frame as FakeFrame;
      if (!f.raw) return f;
      const copy = makeFrame(f.timestamp!, false);
      copies.push(copy);
      f.close();
      return copy;
    },
    isDecoderOwned: (frame) => (frame as FakeFrame).raw,
  };

  return {
    io,
    feeds,
    made,
    copies,
    resets: () => resets,
    decoderCloses: () => closes,
    /** Complete the oldest pending flush (emitting its frames). */
    releaseFlush: (): boolean => {
      const g = gates.shift();
      g?.();
      return !!g;
    },
    pendingFlushes: () => gates.length,
    emitLate: (): boolean => {
      const l = lateOutputs.shift();
      l?.();
      return !!l;
    },
  };
}

type Outcome =
  | { state: 'pending' }
  | { state: 'frame'; frame: FakeFrame }
  | { state: 'superseded' }
  | { state: 'error'; error: unknown };

function track(p: Promise<DecodedFrameLike>): { outcome: Outcome } {
  const box: { outcome: Outcome } = { outcome: { state: 'pending' } };
  p.then(
    (frame) => { box.outcome = { state: 'frame', frame: frame as FakeFrame }; },
    (error) => { box.outcome = isSuperseded(error) ? { state: 'superseded' } : { state: 'error', error }; },
  );
  return box;
}

const frameOf = (o: Outcome): FakeFrame => (o as { frame: FakeFrame }).frame;

/** Release flushes until nothing is pending (each release may start the next job). */
async function drain(h: ReturnType<typeof gatedIO>, clock?: { t: number }, stepMs = 0): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await nextTurn();
    if (clock) clock.t += stepMs;
    if (!h.releaseFlush()) {
      await nextTurn();
      if (h.pendingFlushes() === 0) return;
    }
  }
}

/** A controllable clock plus a policy that uses it. */
function clocked(extra: SeekPolicy = {}): { clock: { t: number }; policy: SeekPolicy } {
  const clock = { t: 0 };
  return { clock, policy: { now: () => clock.t, ...extra } };
}

beforeEach(resetVideoDecodeStats);

describe('ExactVideoSource latest-wins seeks', () => {
  it('a scrub burst resolves ONLY the newest seek, and no superseded seek ever lands later', async () => {
    const h = gatedIO();
    const { clock, policy } = clocked();
    const src = new ExactVideoSource(demuxed(), h.io, 12, policy);

    // Warm-up: one real decode teaches the source its cost — 8 chunks in
    // 200 ms is 25 ms/chunk, so a deep GOP decode is ~200 ms, well over the
    // 120 ms keep threshold.
    const warm = track(src.frameAt(7, { latest: true }));
    await nextTurn();
    clock.t = 200;
    await drain(h);
    expect(warm.outcome.state).toBe('frame');

    // The scrub: one seek per 16 ms vsync, each to the deep end of a
    // different GOP, while the decoder is always still busy.
    const targets = [15, 23, 31, 39, 47, 14, 22, 30, 38, 46, 13, 21];
    const boxes: Array<{ t: number; box: { outcome: Outcome } }> = [];
    for (const t of targets) {
      boxes.push({ t, box: track(src.frameAt(t, { latest: true })) });
      await nextTurn();
      clock.t += 16;
    }
    await drain(h, clock, 16);

    const last = boxes[boxes.length - 1]!;
    for (const { t, box } of boxes.slice(0, -1)) {
      expect({ t, state: box.outcome.state }).toEqual({ t, state: 'superseded' });
    }
    expect(last.box.outcome.state).toBe('frame');
    expect(frameOf(last.box.outcome).timestamp).toBe(frameUs(last.t));

    // An aborted decoder's stragglers are exact frames for THEIR index; they
    // may be cached, but must never resolve a request the scrub abandoned.
    while (h.emitLate()) { /* drain every straggler */ }
    await nextTurn();
    for (const { box } of boxes.slice(0, -1)) expect(box.outcome.state).toBe('superseded');

    // Each vsync aborted the in-flight decode (the newest seek always started
    // right after), and nothing waited in a queue behind it.
    expect(h.resets()).toBe(targets.length - 1);
    expect(videoDecodeStats.superseded).toBe(targets.length - 1);
    expect(videoDecodeStats.abortedDecodes).toBe(targets.length - 1);
    src.close();
  });

  it('queued seeks never start: a busy decoder runs the one it has, then only the newest', async () => {
    const h = gatedIO();
    // Nothing delivered yet → starvation guard keeps the in-flight decode.
    const src = new ExactVideoSource(demuxed(), h.io);
    const first = track(src.frameAt(3, { latest: true }));
    await nextTurn();
    const middle = [11, 19, 27, 35].map((t) => {
      const box = track(src.frameAt(t, { latest: true }));
      return box;
    });
    // …each in its own turn:
    for (let i = 0; i < middle.length; i++) await nextTurn();
    const newest = track(src.frameAt(43, { latest: true }));
    await drain(h);

    expect(first.outcome.state).toBe('frame'); // kept: the intermediate picture
    for (const m of middle) expect(m.outcome.state).toBe('superseded');
    expect(newest.outcome.state).toBe('frame');
    expect(frameOf(newest.outcome).timestamp).toBe(frameUs(43));
    const keys = h.feeds.flat().filter((c) => c.type === 'key').map((c) => c.timestamp);
    expect(keys).toEqual([frameUs(0), frameUs(40)]);
    expect(h.resets()).toBe(0);
    src.close();
  });

  it('starvation guard: with nothing delivered recently, a superseded in-flight decode still lands', async () => {
    const h = gatedIO();
    const { clock, policy } = clocked();
    const src = new ExactVideoSource(demuxed(), h.io, 12, policy);
    const warm = track(src.frameAt(7, { latest: true }));
    await nextTurn();
    clock.t = 200; // 25 ms/chunk
    await drain(h);
    expect(warm.outcome.state).toBe('frame');

    clock.t = 1000; // last delivery was 800 ms ago
    const a = track(src.frameAt(15, { latest: true }));
    await nextTurn();
    clock.t += 16;
    const b = track(src.frameAt(47, { latest: true }));
    await drain(h);
    expect(a.outcome.state).toBe('frame');
    expect(b.outcome.state).toBe('frame');
    expect(h.resets()).toBe(0);
    src.close();
  });

  it('a decode about to land is kept (short remaining estimate)', async () => {
    const h = gatedIO();
    const { clock, policy } = clocked();
    const src = new ExactVideoSource(demuxed(), h.io, 12, policy);
    const warm = track(src.frameAt(1, { latest: true }));
    await nextTurn();
    clock.t = 4; // 2 chunks in 4 ms → 2 ms/chunk
    await drain(h);
    expect(warm.outcome.state).toBe('frame');
    const a = track(src.frameAt(15, { latest: true })); // ~16 ms to go
    await nextTurn();
    clock.t += 5;
    const b = track(src.frameAt(47, { latest: true }));
    await drain(h);
    expect(a.outcome.state).toBe('frame');
    expect(b.outcome.state).toBe('frame');
    expect(h.resets()).toBe(0);
    src.close();
  });

  it('requests made in the SAME turn never cancel each other', async () => {
    const h = gatedIO();
    const src = new ExactVideoSource(demuxed(), h.io, 12, { keepInFlightMs: -1, starvationMs: 0, now: () => 0 });
    // One render asking for a bracket pair in two different GOPs.
    const a = track(src.frameAt(4, { latest: true }));
    const b = track(src.frameAt(20, { latest: true }));
    await drain(h);
    expect(a.outcome.state).toBe('frame');
    expect(b.outcome.state).toBe('frame');
    expect(h.resets()).toBe(0);
    src.close();
  });

  it('renew() keeps an in-flight seek alive across turns (convergence re-renders)', async () => {
    const h = gatedIO();
    const src = new ExactVideoSource(demuxed(), h.io, 12, { keepInFlightMs: -1, starvationMs: 0, now: () => 0 });
    const a = track(src.frameAt(12, { latest: true }));
    await nextTurn();
    // The same render repeats while the decode runs: it re-asks, it does not
    // issue anything new.
    expect(src.renew(12)).toBe(true);
    await nextTurn();
    expect(src.renew(12)).toBe(true);
    await drain(h);
    expect(a.outcome.state).toBe('frame');
    expect(h.resets()).toBe(0);
    expect(src.renew(12)).toBe(false); // nothing pending any more
    src.close();
  });

  it('a newer target inside the running GOP decode lets that decode finish and serves it from cache', async () => {
    const h = gatedIO();
    const src = new ExactVideoSource(demuxed(), h.io, 12, { keepInFlightMs: -1, starvationMs: 0, now: () => 0 });
    const a = track(src.frameAt(7, { latest: true })); // decodes GOP 0 through 7
    await nextTurn();
    const b = track(src.frameAt(5, { latest: true })); // same GOP, before 7
    await drain(h);
    expect(a.outcome.state).toBe('frame');
    expect(b.outcome.state).toBe('frame');
    expect(frameOf(b.outcome).timestamp).toBe(frameUs(5));
    expect(h.resets()).toBe(0);
    expect(h.feeds.flat()).toHaveLength(8); // one GOP prefix, fed once
    src.close();
  });

  it('requests outside the latest lane are never superseded (export, tracker)', async () => {
    const h = gatedIO();
    const src = new ExactVideoSource(demuxed(), h.io, 12, { keepInFlightMs: -1, starvationMs: 0, now: () => 0 });
    const exact = track(src.frameAt(9));
    await nextTurn();
    const scrub1 = track(src.frameAt(30, { latest: true }));
    await nextTurn();
    const scrub2 = track(src.frameAt(40, { latest: true }));
    await drain(h);
    expect(exact.outcome.state).toBe('frame');
    expect(frameOf(exact.outcome).timestamp).toBe(frameUs(9));
    expect(scrub1.outcome.state).toBe('superseded');
    expect(scrub2.outcome.state).toBe('frame');
    expect(h.resets()).toBe(0); // the exact request was never interrupted
    src.close();
  });

  it('without reset() an aborted decoder is closed and rebuilt; its late output is closed, not cached', async () => {
    const h = gatedIO({ withReset: false });
    const src = new ExactVideoSource(demuxed(), h.io, 12, { keepInFlightMs: -1, starvationMs: 0, now: () => 0 });
    const a = track(src.frameAt(10, { latest: true }));
    await nextTurn();
    const b = track(src.frameAt(34, { latest: true }));
    await nextTurn();
    expect(a.outcome.state).toBe('superseded');
    expect(h.decoderCloses()).toBe(1);
    // The abandoned decoder emits after all — its whole flush, late.
    const before = h.made.length;
    h.releaseFlush();
    const late = h.made.slice(before);
    expect(late.length).toBeGreaterThan(0);
    for (const f of late) expect(f.closes).toBe(1);
    await drain(h);
    expect(b.outcome.state).toBe('frame');
    expect(h.feeds).toHaveLength(2);
    src.close();
  });

  it('close() rejects queued and in-flight seeks instead of leaving them pending', async () => {
    const h = gatedIO();
    const src = new ExactVideoSource(demuxed(), h.io);
    const a = track(src.frameAt(10));
    const b = track(src.frameAt(30));
    await nextTurn();
    src.close();
    await nextTurn();
    expect(a.outcome.state).toBe('error');
    expect(b.outcome.state).toBe('error');
  });
});

describe('ExactVideoSource frame ownership', () => {
  it('take hands the frame over: the session never closes it, the caller closes it once', async () => {
    const h = gatedIO();
    const src = new ExactVideoSource(demuxed(), h.io);
    const p = track(src.frameAt(3, { take: true }));
    await drain(h);
    const taken = frameOf(p.outcome);
    expect(taken.raw).toBe(false); // a retained copy, not a pool frame
    src.close();
    expect(taken.closes).toBe(0);
    taken.close();
    // Every frame the decoder made was closed exactly once — the originals by
    // retain, the kept copies by close() — including the one we own.
    for (const f of h.made) expect(f.closes).toBe(1);
    for (const c of h.copies) expect(c.closes).toBe(1);
  });

  it('raw delivers the decoder-owned target and holds at most ONE raw frame', async () => {
    const h = gatedIO();
    const src = new ExactVideoSource(demuxed(), h.io, 12, { keepInFlightMs: -1, starvationMs: 0, now: () => 0 });
    // A raw seek whose target nobody takes: superseded by a covered request,
    // so its decode finishes and its raw frame stays in the session's cache.
    const a = track(src.frameAt(7, { latest: true, take: true, raw: true }));
    await nextTurn();
    const b = track(src.frameAt(6, { latest: true, take: true, raw: true }));
    await drain(h);
    // `a` was kept (covered) and resolves with its raw target; `b` is a hit on
    // a retained copy — only a job's own target is ever delivered raw.
    expect(frameOf(a.outcome).raw).toBe(true);
    expect(frameOf(b.outcome).raw).toBe(false);

    // Another raw target, other GOP.
    const c = track(src.frameAt(20, { latest: true, take: true, raw: true }));
    await drain(h);
    const rawFrame = frameOf(c.outcome);
    expect(rawFrame.raw).toBe(true);

    src.close();
    frameOf(a.outcome).close();
    frameOf(b.outcome).close();
    rawFrame.close();
    for (const f of h.made) expect(f.closes).toBe(1);
    for (const f of h.copies) expect(f.closes).toBe(1);
  });

  it('a raw target stranded in cache (its decode errored) is demoted, never lent out raw', async () => {
    let failNext = true;
    const h = gatedIO({ errorAfterFlush: () => failNext });
    const src = new ExactVideoSource(demuxed(), h.io);
    // The decode emits every frame — the raw target included — then errors,
    // so the job rejects and nobody takes the raw frame it left in cache.
    const a = track(src.frameAt(7, { take: true, raw: true }));
    await drain(h);
    expect(a.outcome.state).toBe('error');
    const raw7 = h.made.find((f) => f.timestamp === frameUs(7))!;
    expect(raw7.closes).toBe(0); // still held, still raw

    // A borrower hits it: it must get a copy, and the original must be closed
    // exactly once in the process.
    failNext = false;
    const b = track(src.frameAt(7));
    await drain(h);
    expect(frameOf(b.outcome).raw).toBe(false);
    expect(raw7.closes).toBe(1);

    // And a second raw target admitted later is the only raw frame held.
    const c = track(src.frameAt(20, { take: true, raw: true }));
    await drain(h);
    expect(frameOf(c.outcome).raw).toBe(true);
    frameOf(c.outcome).close();
    src.close();
    for (const f of h.made) expect(f.closes).toBe(1);
    for (const f of h.copies) expect(f.closes).toBe(1);
  });

  it('a borrower in the same turn is never handed the raw frame its neighbour took', async () => {
    const h = gatedIO();
    const src = new ExactVideoSource(demuxed(), h.io);
    const a = track(src.frameAt(7, { take: true, raw: true }));
    const b = track(src.frameAt(7)); // plain borrower, queued behind the raw job
    await drain(h);
    expect(frameOf(a.outcome).raw).toBe(true);
    // The raw frame went to its taker; the borrower got a retained copy.
    expect(frameOf(b.outcome).raw).toBe(false);
    frameOf(a.outcome).close();
    src.close();
    for (const f of h.made) expect(f.closes).toBe(1);
    for (const f of h.copies) expect(f.closes).toBe(1);
  });
});
