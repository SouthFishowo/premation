/**
 * framePerf's contract: stages recorded inside a frame land in the rolling
 * window; stages outside a frame, and frames discarded as blits, do not.
 */

import { framePerf, PerfStage, perfBegin, perfEnd, PERF_WINDOW, measureGpuDone } from './framePerf';

let clock = 0;
beforeEach(() => {
  clock = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  framePerf.reset();
  framePerf.enabled = true;
});
afterEach(() => jest.restoreAllMocks());

function frame(stages: Array<[number, number]>, commit = true): void {
  framePerf.beginFrame();
  for (const [stage, ms] of stages) {
    perfBegin(stage as never);
    clock += ms;
    perfEnd(stage as never);
  }
  framePerf.endFrame(commit);
}

describe('framePerf', () => {
  it('records per-stage ms and run counts for committed frames', () => {
    frame([[PerfStage.snapshot, 4], [PerfStage.raster, 1], [PerfStage.raster, 2]]);
    frame([[PerfStage.snapshot, 6]]);
    const s = framePerf.sample();
    expect(s.frames).toBe(2);
    expect(s.stages.snapshot.mean).toBe(5);
    expect(s.stages.snapshot.last).toBe(6);
    // 3ms of raster in frame one, none in frame two: 1.5 ms/frame, 1 run/frame.
    expect(s.stages.raster.mean).toBe(1.5);
    expect(s.stages.raster.perFrame).toBe(1);
  });

  it('ignores stages outside a frame (idle pump, export) and discarded blit frames', () => {
    perfBegin(PerfStage.snapshot);
    clock += 50;
    perfEnd(PerfStage.snapshot);
    frame([[PerfStage.snapshot, 9]], false);
    expect(framePerf.sample().frames).toBe(0);
  });

  it('times only the OUTERMOST of a re-entered stage', () => {
    framePerf.beginFrame();
    perfBegin(PerfStage.textureFeed);
    clock += 1;
    perfBegin(PerfStage.textureFeed);
    clock += 2;
    perfEnd(PerfStage.textureFeed);
    clock += 3;
    perfEnd(PerfStage.textureFeed);
    framePerf.endFrame();
    const t = framePerf.sample().stages.textureFeed;
    expect(t.mean).toBe(6);
    expect(t.perFrame).toBe(1);
  });

  it('p95 picks the slow tail and the window rolls', () => {
    for (let i = 0; i < PERF_WINDOW + 20; i++) frame([[PerfStage.total, i < 20 ? 1000 : i % 20 === 0 ? 30 : 10]]);
    const s = framePerf.sample();
    expect(s.frames).toBe(PERF_WINDOW);
    // The first 20 (1000 ms) rolled out of the window.
    expect(s.stages.total.p95).toBe(30);
    expect(s.stages.total.mean).toBeLessThan(12);
  });

  it('is inert when disabled', () => {
    framePerf.enabled = false;
    frame([[PerfStage.snapshot, 5]]);
    expect(framePerf.sample().frames).toBe(0);
  });

  it('GPU completion is feature-detected: no queue method, no sample', async () => {
    measureGpuDone(null);
    measureGpuDone({});
    expect(framePerf.sample().gpuDoneMs).toBeNull();
    let resolve!: () => void;
    measureGpuDone({ onSubmittedWorkDone: () => new Promise<void>((r) => { resolve = r; }) });
    clock += 7;
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(framePerf.sample().gpuDoneMs).toBe(7);
  });
});
