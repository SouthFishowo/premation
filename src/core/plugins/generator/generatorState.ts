/**
 * How a stateful generator survives scrubbing.
 *
 * A particle simulation is a recurrence: frame N's state is frame N−1's state
 * stepped once. That is fine while the playhead moves forward one frame at a
 * time, and it is the whole problem the moment the user drags it — a scrub to
 * frame 400 has no frame 399 to step from, and neither does an export that
 * starts at an in-point, nor a preview that skipped frames under load.
 *
 * Three answers were possible and two are wrong:
 *
 *   · Step from wherever the simulation happens to be. Fastest, and it makes
 *     the picture depend on where the playhead has BEEN — the same frame renders
 *     differently in preview and in export, and differently in two exports of
 *     the same project. That is not a performance trade-off, it is a broken
 *     deliverable.
 *   · Re-run from frame 0 every time. Correct and unusable: dragging across a
 *     ten-second comp at 60 fps is 600 simulation steps per pointer move.
 *   · Checkpoint. Keep the state every N frames, and re-run only from the
 *     nearest one at or before the target.
 *
 * The third is what this module is, and it is deterministic for a reason worth
 * stating: every checkpoint was itself produced by running forward from the
 * start, so the state at frame K is the same object whether it was reached in
 * one run or resumed from a checkpoint at K−8. Which checkpoints happen to be
 * in the cache therefore cannot change the picture — only how long it takes to
 * produce. That property is what `checkpointSeekIsDeterministic` in the tests
 * pins, and it is why the cache can be evicted freely.
 *
 * ── What the host does NOT do ────────────────────────────────────────────────
 *
 * It never inspects, merges, or interpolates a plugin's state. The value is
 * opaque — whatever the plugin returned, held by reference, handed back on the
 * next request. Structured-cloning it across the worker boundary is already the
 * cost of the wire; copying it again here to be defensive would double the cost
 * of every frame of a 50 000-particle simulation to protect against a plugin
 * corrupting its own data.
 */

/** Frames between checkpoints. */
export const DEFAULT_CHECKPOINT_INTERVAL = 12;

/**
 * Checkpoints kept per layer.
 *
 * 64 at the default interval covers about twelve seconds of 60 fps timeline,
 * which is the span a user scrubs inside. Past that the cache evicts the
 * furthest checkpoint from the playhead rather than the oldest — a bounded LRU
 * keyed on recency would throw away the checkpoint at frame 0, which is the one
 * every cold seek starts from.
 */
export const MAX_CHECKPOINTS = 64;

/**
 * Frames re-simulated in one turn of the scheduler.
 *
 * A seek past the last checkpoint is bounded WORK, not a bounded RESULT: the
 * catch-up runs in chunks across turns and the viewport keeps showing the
 * previous frame until it lands. Capping the result instead — "close enough
 * after 240 frames" — would make the picture depend on how far the playhead
 * jumped, which is the determinism this module exists to protect.
 */
export const MAX_CATCH_UP_PER_TURN = 48;

/** One layer's simulation cursor and its checkpoints. */
export interface GeneratorStateCache {
  /**
   * Where the simulation currently is: the frame it last produced and the state
   * it ended that frame with. Null before the first run.
   */
  cursor: { frame: number; state: unknown } | null;
  /** frame → state at the END of that frame. */
  checkpoints: Map<number, unknown>;
  interval: number;
  /**
   * False once a generate returns no state, which is how a STATELESS generator
   * declares itself: it is a pure function of the request, so every frame is
   * reachable in one step and none of the machinery above applies.
   *
   * Undefined until the first result — the difference between "we know it is
   * stateless" and "we have not asked yet" decides whether a cold seek to frame
   * 400 runs one frame or four hundred.
   */
  stateful?: boolean;
}

export function createStateCache(interval = DEFAULT_CHECKPOINT_INTERVAL): GeneratorStateCache {
  return { cursor: null, checkpoints: new Map(), interval: Math.max(1, Math.trunc(interval)) };
}

/**
 * The frames that must be simulated, in order, to reach `target`.
 *
 * `from.state` is what the first of them starts with. An empty list is
 * impossible — reaching a frame always means producing it — so the caller never
 * has to handle "nothing to do" as a special case; `frames[0] === target` is the
 * fast path and reads as one.
 *
 * `truncated` says the plan was cut to `MAX_CATCH_UP_PER_TURN`: the frames
 * listed are still exactly the right ones to run, they just do not reach the
 * target yet, and the caller re-plans on its next turn.
 */
export interface SeekPlan {
  /** Frames to simulate, ascending, ending at `target` unless `truncated`. */
  frames: number[];
  /** The state the first frame in `frames` starts from. */
  state: unknown;
  truncated: boolean;
}

export function planSeek(cache: GeneratorStateCache, target: number): SeekPlan {
  const frame = Math.trunc(target);

  // Stateless, or not yet known to be stateful: one step, from nothing. The
  // "not yet known" half is deliberate — the first request a layer ever makes
  // is usually a scrub to wherever the playhead already is, and running four
  // hundred frames to answer it on the chance that the plugin turns out to be
  // stateful would make every generator feel broken on the frame it appears.
  if (cache.stateful !== true) return { frames: [frame], state: undefined, truncated: false };

  // The sequential case, which is every frame of playback and of export.
  if (cache.cursor && cache.cursor.frame === frame - 1) {
    return { frames: [frame], state: cache.cursor.state, truncated: false };
  }
  // Re-asking for the frame the cursor is already on. It still has to be
  // produced — the cache holds STATE, not instances — but from the state BEFORE
  // it, which is the nearest checkpoint at or before frame−1.
  const origin = nearestCheckpoint(cache, frame - 1);

  // A forward seek the cursor can still reach more cheaply than the checkpoint.
  const cursorFrame = cache.cursor && cache.cursor.frame < frame ? cache.cursor.frame : -Infinity;
  const start = cursorFrame > origin.frame
    ? { frame: cursorFrame, state: cache.cursor!.state }
    : origin;

  const first = start.frame + 1;
  const total = frame - first + 1;
  const run = Math.min(total, MAX_CATCH_UP_PER_TURN);
  const frames: number[] = [];
  for (let f = first; f < first + run; f++) frames.push(f);
  return { frames, state: start.state, truncated: run < total };
}

/**
 * The checkpoint at or before `frame`, or the start of time.
 *
 * Frame −1 with an undefined state IS the start of time here, and it is not a
 * sentinel: a simulation's first frame runs with no incoming state, which is
 * exactly what `planSeek` hands it for a cold seek.
 */
function nearestCheckpoint(cache: GeneratorStateCache, frame: number): { frame: number; state: unknown } {
  let best = -1;
  let state: unknown;
  for (const [f, s] of cache.checkpoints) {
    if (f <= frame && f > best) {
      best = f;
      state = s;
    }
  }
  return { frame: best, state };
}

/**
 * Record the result of simulating one frame.
 *
 * `state === undefined` on the FIRST recorded frame marks the generator
 * stateless for the rest of the session; afterwards it is taken at face value
 * (a simulation that legitimately has nothing to carry on one frame is not
 * suddenly a pure function).
 */
export function recordFrame(cache: GeneratorStateCache, frame: number, state: unknown): void {
  if (cache.stateful === undefined) cache.stateful = state !== undefined;
  cache.cursor = { frame, state };
  if (cache.stateful !== true) return;
  if (frame % cache.interval !== 0) return;
  cache.checkpoints.set(frame, state);
  if (cache.checkpoints.size > MAX_CHECKPOINTS) evictFurthest(cache, frame);
}

/**
 * Drop the checkpoint FURTHEST from where the playhead is working.
 *
 * Not least-recently-used: a scrub reads checkpoints near the playhead and
 * never touches frame 0, so an LRU would evict the one checkpoint that every
 * cold seek and every export start depends on, and the next jump backwards
 * would re-simulate from nothing. Distance is the right recency here.
 */
function evictFurthest(cache: GeneratorStateCache, around: number): void {
  let worst = -1;
  let worstDistance = -1;
  for (const f of cache.checkpoints.keys()) {
    const d = Math.abs(f - around);
    if (d > worstDistance) {
      worstDistance = d;
      worst = f;
    }
  }
  if (worst >= 0) cache.checkpoints.delete(worst);
}

/** Forget everything — the layer's params changed, so its past is not its past. */
export function resetStateCache(cache: GeneratorStateCache): void {
  cache.cursor = null;
  cache.checkpoints.clear();
  cache.stateful = undefined;
}
