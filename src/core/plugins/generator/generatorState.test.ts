/**
 * Checkpoints and the seek rule.
 *
 * The property being pinned is the one the whole feature rests on: **the same
 * frame gives the same instances, however the playhead got there.** A particle
 * system that depended on where the user had scrubbed would render one thing in
 * the viewport and another in the file, and nobody would ever suspect the
 * scheduler.
 *
 * The oracle is a full replay from frame 0 — the definition of "correct" — and
 * the test drives the scheduler through paths a user actually takes (play,
 * scrub back, scrub forward, jump to the end, jump home) asserting the result
 * equals the oracle every time.
 */

import {
  DEFAULT_CHECKPOINT_INTERVAL,
  MAX_CATCH_UP_PER_TURN,
  MAX_CHECKPOINTS,
  createStateCache,
  planSeek,
  recordFrame,
  resetStateCache,
} from './generatorState';
import {
  requestGeneratorFrame,
  resetGeneratorsForTests,
  setGeneratorRunner,
  type GeneratorDemand,
} from './generatorScheduler';

describe('planSeek', () => {
  it('runs ONE frame while nothing is known to be stateful', () => {
    const cache = createStateCache();
    expect(planSeek(cache, 400)).toEqual({ frames: [400], state: undefined, truncated: false });
  });

  it('runs one frame for a generator that declared itself stateless', () => {
    const cache = createStateCache();
    recordFrame(cache, 0, undefined);
    expect(cache.stateful).toBe(false);
    expect(planSeek(cache, 999).frames).toEqual([999]);
  });

  it('steps once when the target follows the cursor — playback and export', () => {
    const cache = createStateCache();
    recordFrame(cache, 0, { n: 0 });
    recordFrame(cache, 1, { n: 1 });
    expect(planSeek(cache, 2)).toEqual({ frames: [2], state: { n: 1 }, truncated: false });
  });

  it('resumes from the nearest checkpoint at or before a backward seek', () => {
    const cache = createStateCache(4);
    for (let f = 0; f <= 20; f++) recordFrame(cache, f, { n: f });
    // Checkpoints at 0, 4, 8, 12, 16, 20. Seeking to 10 replays 9 and 10 from
    // the checkpoint at 8 — not from 0, and not from the cursor at 20.
    expect(planSeek(cache, 10)).toEqual({ frames: [9, 10], state: { n: 8 }, truncated: false });
  });

  it('prefers the CURSOR over a checkpoint for a short forward seek', () => {
    const cache = createStateCache(16);
    for (let f = 0; f <= 20; f++) recordFrame(cache, f, { n: f });
    // Checkpoint at 16, cursor at 20: reaching 23 from the cursor is three
    // steps, from the checkpoint seven.
    expect(planSeek(cache, 23)).toEqual({ frames: [21, 22, 23], state: { n: 20 }, truncated: false });
  });

  it('replays from the checkpoint before the target when re-asked for the cursor’s own frame', () => {
    const cache = createStateCache(4);
    for (let f = 0; f <= 8; f++) recordFrame(cache, f, { n: f });
    // Frame 8 has to be PRODUCED again (the cache holds state, not instances),
    // and producing it means starting from the state before it.
    expect(planSeek(cache, 8)).toEqual({ frames: [5, 6, 7, 8], state: { n: 4 }, truncated: false });
  });

  it('chunks a long cold seek rather than capping the result', () => {
    const cache = createStateCache();
    recordFrame(cache, 0, { n: 0 });
    const plan = planSeek(cache, 500);
    expect(plan.truncated).toBe(true);
    expect(plan.frames).toHaveLength(MAX_CATCH_UP_PER_TURN);
    expect(plan.frames[0]).toBe(1);
  });

  it('reaches the start of time when neither a checkpoint nor the cursor helps', () => {
    const cache = createStateCache(4);
    recordFrame(cache, 0, { n: 0 });
    // Wind the cursor PAST the target as well, so neither origin is usable and
    // the plan has to fall back to the start — frame 0 with no incoming state,
    // which is what a simulation's first step really is.
    recordFrame(cache, 9, { n: 9 });
    cache.checkpoints.clear();
    const plan = planSeek(cache, 3);
    expect(plan.frames).toEqual([0, 1, 2, 3]);
    expect(plan.state).toBeUndefined();
  });
});

describe('the checkpoint cache', () => {
  it('keeps one every N frames and nothing in between', () => {
    const cache = createStateCache();
    for (let f = 0; f <= DEFAULT_CHECKPOINT_INTERVAL * 2; f++) recordFrame(cache, f, { n: f });
    expect([...cache.checkpoints.keys()]).toEqual([
      0, DEFAULT_CHECKPOINT_INTERVAL, DEFAULT_CHECKPOINT_INTERVAL * 2,
    ]);
  });

  it('evicts the FURTHEST checkpoint, so frame 0 survives a long timeline', () => {
    const cache = createStateCache(1);
    for (let f = 0; f <= MAX_CHECKPOINTS + 10; f++) recordFrame(cache, f, { n: f });
    expect(cache.checkpoints.size).toBeLessThanOrEqual(MAX_CHECKPOINTS);
    // Working near the end, the cache keeps the end. Frame 0 is the furthest
    // and is the one that goes — which is correct HERE, and is why the eviction
    // is by distance from the playhead rather than by age.
    expect([...cache.checkpoints.keys()].every((f) => f > 0)).toBe(true);

    // Working near the start instead, frame 0 is the closest and stays.
    const home = createStateCache(1);
    for (let f = 0; f <= MAX_CHECKPOINTS + 10; f++) recordFrame(home, f, { n: f });
    for (let f = 0; f <= 3; f++) recordFrame(home, f, { n: f });
    expect(home.checkpoints.has(0)).toBe(true);
  });

  it('forgets everything on reset', () => {
    const cache = createStateCache();
    recordFrame(cache, 0, { n: 0 });
    resetStateCache(cache);
    expect(cache.cursor).toBeNull();
    expect(cache.checkpoints.size).toBe(0);
    expect(cache.stateful).toBeUndefined();
  });
});

/**
 * End to end, through the scheduler: a recurrence whose value at frame N is the
 * sum 0+1+…+N, so the instance's x is `N(N+1)/2` and NOTHING else. A resume
 * from the wrong state cannot coincidentally produce it.
 */
describe('a seek gives the same pixels as a full replay', () => {
  const oracle = (frame: number): number => (frame * (frame + 1)) / 2;

  const demand = (frame: number): GeneratorDemand => ({
    layerId: 'L1',
    pluginId: 'studio.acme',
    kindId: 'sparks',
    request: {
      layerTime: frame / 30, compTime: frame / 30, frame, fps: 30,
      compSize: { width: 1920, height: 1080 },
      layerSize: { width: 400, height: 300 },
      params: {}, seed: 7,
    },
  });

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 60; i++) await Promise.resolve();
  };

  /** Ask for a frame and keep pumping until the scheduler produces THAT frame. */
  const produce = async (frame: number): Promise<number> => {
    for (let turn = 0; turn < 60; turn++) {
      requestGeneratorFrame(demand(frame));
      await settle();
      const f = requestGeneratorFrame(demand(frame));
      // A chunked catch-up serves the previous frame until it arrives; the
      // oracle check below is what distinguishes "not yet" from "wrong".
      if (f && f.instances[1] === frame) return f.instances[0]!;
    }
    throw new Error(`frame ${frame} never arrived`);
  };

  beforeEach(() => {
    resetGeneratorsForTests();
    setGeneratorRunner({
      async generate(_p, _k, request) {
        const req = request as { frame: number; state?: { sum: number } };
        const sum = (req.state?.sum ?? 0) + req.frame;
        return {
          // x = the running sum, y = the frame this buffer belongs to.
          instances: new Float32Array([sum, req.frame, 0, 10, 0, 1, 1, 1, 1]),
          count: 1,
          primitive: 'point',
          state: { sum },
        };
      },
    });
  });

  it('matches the oracle along every path a user takes', async () => {
    // Play forward from the start.
    for (let f = 0; f <= 6; f++) expect(await produce(f)).toBe(oracle(f));
    // Scrub backwards inside the checkpointed region.
    expect(await produce(2)).toBe(oracle(2));
    // Jump far forward, past every checkpoint — a chunked catch-up.
    expect(await produce(80)).toBe(oracle(80));
    // Jump home.
    expect(await produce(0)).toBe(oracle(0));
    // And back to the middle, which is now reachable from either side.
    expect(await produce(40)).toBe(oracle(40));
  });

  it('gives the same answer with a cold cache as with a warm one', async () => {
    const warm = await produce(30);
    resetGeneratorsForTests();
    setGeneratorRunner({
      async generate(_p, _k, request) {
        const req = request as { frame: number; state?: { sum: number } };
        const sum = (req.state?.sum ?? 0) + req.frame;
        return {
          instances: new Float32Array([sum, req.frame, 0, 10, 0, 1, 1, 1, 1]),
          count: 1, primitive: 'point', state: { sum },
        };
      },
    });
    expect(await produce(30)).toBe(warm);
    expect(warm).toBe(oracle(30));
  });
});
