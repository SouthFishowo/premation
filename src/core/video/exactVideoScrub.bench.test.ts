/**
 * Scrub benchmark — `npm run bench`. NOT part of the default `jest` run.
 *
 * What it measures is the part of scrubbing decidable above the codec: how
 * much decoder work a drag generates, how much of it reaches the screen, and
 * how long the picture takes to settle once the pointer stops. A timed fake
 * decoder stands in for WebCodecs (each fed chunk costs `MS_PER_CHUNK` of
 * wall time inside `flush()`, and `reset()` abandons the rest), and a 60 Hz
 * drag sweeps the playhead across long-GOP footage.
 *
 * Two runs over the same drag:
 *
 *   serial       every seek queued and decoded in order (the old behaviour,
 *                and still what export and the tracker get)
 *   latest-wins  the interactive policy (default keep/starvation thresholds)
 *
 * Reported per run: seeks requested, GOP decodes started, decodes aborted,
 * seeks superseded, frames delivered, chunks actually decoded, mean latency
 * of delivered frames, and SETTLE — pointer stop → the final frame landing.
 *
 * Real decode cost is not modelled beyond "linear in the GOP prefix", which
 * is the shape that makes deep 4K GOPs slow. For production numbers see the
 * probe recipe at the end of `docs`-free notes in the B2 report:
 * `window.__motionVideoDecode.reset()` → scrub → `.stats()` in the app.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  ExactVideoSource,
  type DecoderIO,
  type DecodedFrameLike,
  type EncodedChunkInit,
} from './exactVideoSource';
import type { DemuxedVideo } from './mp4Demuxer';
import { resetVideoDecodeStats, snapshotVideoDecodeStats } from './decodeStats';

const FPS = 30;
const GOP = 60; // 2 s GOPs, typical of camera / phone H.264 and HEVC
const FRAMES = 600;
const MS_PER_CHUNK = 2; // ≈ a 4K hardware decode; a deep target costs ~120 ms
const TICK_MS = 16;
const DRAG_TICKS = 120; // a 2 s drag…
const DRAG_FRAMES_PER_TICK = 4; // …across 480 frames

function demux(): DemuxedVideo {
  const samples = [];
  for (let i = 0; i < FRAMES; i++) {
    samples.push({ data: new Uint8Array([i & 255]), dts: i * 512, cts: i * 512, isKey: i % GOP === 0, duration: 512 });
  }
  return { codec: 'avc1.640033', codedWidth: 3840, codedHeight: 2160, timescale: 15360, description: null, samples };
}

function timedIO(counter: { chunks: number }): DecoderIO {
  return {
    createDecoder(_c, handlers) {
      let pending: EncodedChunkInit[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      let rejectFlush: ((e: unknown) => void) | null = null;
      let startedAt = 0;
      let fedCount = 0;
      return {
        decode(chunk) { pending.push(chunk as EncodedChunkInit); },
        flush() {
          const batch = pending;
          pending = [];
          fedCount = batch.length;
          startedAt = performance.now();
          return new Promise<void>((resolve, reject) => {
            rejectFlush = reject;
            timer = setTimeout(() => {
              timer = null;
              rejectFlush = null;
              counter.chunks += batch.length;
              for (const c of batch) {
                handlers.output({ timestamp: c.timestamp, close() { /* fake */ } });
              }
              resolve();
            }, batch.length * MS_PER_CHUNK);
          });
        },
        reset() {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
            // Work done before the abort still cost decoder time.
            counter.chunks += Math.min(fedCount, Math.floor((performance.now() - startedAt) / MS_PER_CHUNK));
          }
          pending = [];
          const e = new Error('reset');
          e.name = 'AbortError';
          rejectFlush?.(e);
          rejectFlush = null;
        },
        close() {
          if (timer !== null) clearTimeout(timer);
        },
      };
    },
    createChunk: (init) => init,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RunResult {
  mode: 'serial' | 'latest-wins';
  requested: number;
  decodesStarted: number;
  decodesAborted: number;
  superseded: number;
  delivered: number;
  chunksDecoded: number;
  meanLatencyMs: number;
  settleMs: number;
}

async function run(mode: RunResult['mode']): Promise<RunResult> {
  resetVideoDecodeStats();
  const counter = { chunks: 0 };
  const src = new ExactVideoSource(demux(), timedIO(counter));
  const latencies: number[] = [];
  let lastLanded = 0;
  let last: Promise<unknown> = Promise.resolve();
  let lastTarget = -1;
  const t0 = performance.now();
  for (let tick = 0; tick < DRAG_TICKS; tick++) {
    // Sweep into the deep end of each GOP so targets are expensive.
    const target = 40 + tick * DRAG_FRAMES_PER_TICK;
    const requestedAt = performance.now();
    lastTarget = target;
    last = src.frameAt(target, mode === 'latest-wins' ? { latest: true } : {}).then(
      (f: DecodedFrameLike) => {
        const now = performance.now();
        latencies.push(now - requestedAt);
        if (f.timestamp === Math.round((lastTarget * 1e6) / FPS)) lastLanded = now;
      },
      () => undefined,
    );
    await sleep(TICK_MS);
  }
  const stopAt = performance.now();
  await last;
  const settleMs = (lastLanded || performance.now()) - stopAt;
  const stats = snapshotVideoDecodeStats();
  src.close();
  void t0;
  return {
    mode,
    requested: stats.seekRequests,
    decodesStarted: stats.seekDecodes,
    decodesAborted: stats.abortedDecodes,
    superseded: stats.superseded,
    delivered: latencies.length,
    chunksDecoded: counter.chunks,
    meanLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    settleMs: Math.max(0, settleMs),
  };
}

it('scrub: serial vs latest-wins', async () => {
  const serial = await run('serial');
  const latest = await run('latest-wins');
  const rows = [serial, latest].map((r) => ({
    ...r,
    meanLatencyMs: Math.round(r.meanLatencyMs),
    settleMs: Math.round(r.settleMs),
  }));
  // eslint-disable-next-line no-console
  console.table(rows);
  const out = { at: new Date().toISOString(), params: { GOP, FRAMES, MS_PER_CHUNK, TICK_MS, DRAG_TICKS, DRAG_FRAMES_PER_TICK }, rows };
  const dir = join(process.cwd(), '.artifacts', 'bench');
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(out, null, 2);
  writeFileSync(join(dir, 'videoScrub.latest.json'), json);
  writeFileSync(join(dir, `videoScrub.${out.at.replace(/[:.]/g, '-')}.json`), json);

  // The claims the policy exists to make, loosely enough for a busy machine.
  expect(latest.settleMs).toBeLessThan(serial.settleMs);
  expect(latest.chunksDecoded).toBeLessThan(serial.chunksDecoded);
});
