/**
 * When the RAM preview may be SERVED, and when it may be FILLED.
 *
 * Extracted for the reason `idleCacheSpan` was: the decision lives in the
 * middle of the viewport's render loop, where a condition that is subtly too
 * wide shows up as wrong pixels on screen and a condition that is subtly too
 * narrow shows up as nothing at all — and neither is visible from in there.
 *
 * ## What was wrong
 *
 * Both halves used to be `if (playing)`. Scrubbing back over a fully green
 * region therefore re-rendered every frame from scratch: not a cache that
 * missed, a cache nobody asked. And the only paused WRITER was the idle pump,
 * which needs 1.5s of quiet — an active scrub re-arms that timer on every move,
 * so a scrub could never leave anything behind either.
 *
 * ## Why the gate existed, and what it should actually have said
 *
 * The hazard is real and narrower than the gate was. An interactive repaint can
 * happen MID-GESTURE without bumping any revision, so the invalidation key does
 * not move while the picture does. Filling then stores a half-dragged frame to
 * be blitted back later; serving then paints the pre-gesture frame over a live
 * drag. `interacting` is exactly that condition, and the render-quality store
 * already tracks it — so a SETTLED playhead, which is the whole of scrubbing
 * between gestures, is as cacheable as playback ever was.
 *
 * Three further conditions, each of which cost a real bug when reasoned about
 * in situ rather than written down:
 *
 * **Onion skins.** A paused-only feature that renders its ghosts INTO the
 * content canvas. Serving a blit skips the painter entirely, so the ghosts
 * silently vanish wherever the cache happens to be warm — which looks exactly
 * like the feature being broken, and only on some frames.
 *
 * **The frame grid.** Cache keys are frame indices, but a paused render draws
 * `time`, and `setTime` stores whatever it is given — its callers round the
 * FRAME they pass alongside and are free to leave the time between two of them.
 * Playback never has this problem, because it renders `f / fps` exactly, which
 * is why nothing checked. Serving frame 31 to a playhead at 1.017s, or filing
 * that render under 31, is a sub-frame lie that surfaces as footage one frame
 * out from everything else.
 *
 * **Media exactness.** A frame holding stand-in video pixels (an element
 * mid-seek, a decode still warming) must never enter the cache, or it replays
 * its stale footage at that timecode on every later pass. This one was already
 * enforced on the playback path; it is stated here so both paths share one
 * definition instead of two copies that can drift.
 */

/** How close to a frame boundary still counts as being on it. Three orders of
 *  magnitude under a frame at any sane rate, and far above float noise from
 *  `frame / fps` round trips. */
const GRID_EPSILON = 1e-3;

export interface PreviewCacheState {
  /** Transport state. Playback always renders on the grid and never mid-gesture. */
  playing: boolean;
  /** A drag/scrub gesture is in flight (render-quality store). */
  interacting: boolean;
  /** Onion skins are on — they paint into the content canvas. */
  onionSkins: boolean;
  /** Playhead, in seconds, as the render will draw it. */
  timeSec: number;
  fps: number;
  /** The integer frame the cache key uses for this playhead. */
  frame: number;
}

/**
 * Is `timeSec` actually the frame the key names?
 *
 * Exported because it is the condition most likely to be got wrong somewhere
 * else, and a test of it reads better than a test of the whole gate.
 */
export function isOnFrameGrid(timeSec: number, fps: number, frame: number): boolean {
  if (!(fps > 0) || !Number.isFinite(timeSec) || !Number.isFinite(frame)) return false;
  return Math.abs(timeSec * fps - frame) < GRID_EPSILON;
}

/** May a cached frame be blitted instead of rendering this one? */
export function mayServeCachedFrame(s: PreviewCacheState): boolean {
  if (s.playing) return true;
  if (s.interacting) return false;
  if (s.onionSkins) return false;
  return isOnFrameGrid(s.timeSec, s.fps, s.frame);
}

/**
 * Cached frames a PLAYBACK blit must have ahead of it before it is worth
 * taking.
 *
 * ## The toggle storm this exists to stop
 *
 * Serving a cache hit during playback is not free: the blit path bypasses
 * `renderFrame` entirely, so it also has to PARK the playback `<video>`
 * elements (at the end of the cached run) to keep their decoders tracking the
 * playhead. The live path, one frame later, needs those same elements AT the
 * playhead. Alternate between the two paths every frame and the element is
 * park-seeked and then immediately demanded back — a hard mid-GOP seek, which
 * freezes; while its decode is in flight the exact tier deliberately serves
 * the nearest ALREADY-DECODED neighbour (an old frame, `exact: false`) and
 * repaints as the real ones land, which fast-passes.
 *
 * Freeze → old frames → rapid catch-up: the "old disk" playback report, and it
 * is the SHAPE of the cache that causes it, not its contents. At 4K on a
 * hi-dpi display RAM holds ~16 frames, so the cached set is fragmented — an
 * isolated hit, a gap, another hit — and every fragment boundary is one of
 * these toggles. An isolated one-frame hit saves one render and costs a seek:
 * strictly worse than rendering it live.
 *
 * So a playback blit requires a RUN: this many cached frames ahead of the one
 * being served. Runs exist precisely when the cache is genuinely useful (a
 * warmed second pass, disk promotion keeping ahead of the playhead) and do not
 * exist in the fragmented case that causes the storm. Near the end of a real
 * run this renders a few frames live that were technically cached — a small
 * waste, paid to never enter the blit path for a fragment. Paused serving is
 * unaffected: with no playhead advancing there is no next-frame toggle, so a
 * single paused hit is pure win.
 *
 * Three frames (~100ms at 30fps) is one video-element seek's worth of runway —
 * enough that parking the element at the run's end is a real instruction
 * rather than "seek to now" issued sixty times a second.
 */
export const MIN_PLAYBACK_BLIT_RUN = 3;

/** Consecutive over-budget live renders before single-frame blits are allowed,
 *  and consecutive in-budget ones before they are withdrawn. Asymmetric like the
 *  adaptive-resolution hysteresis: quick to help, slow to stop helping, so the
 *  decision cannot flip back and forth frame to frame. */
const SLOW_LIVE_TO_ENTER = 3;
const FAST_LIVE_TO_EXIT = 30;
/** How much dearer than a blit a live render must be before a lone hit wins. */
const LIVE_OVER_BLIT = 2;

/**
 * When a SHORT run is still worth blitting.
 *
 * The run rule above assumes the live render keeps up. When it does not — a
 * comp whose every live frame already exceeds the frame period — the premise
 * inverts: the live path is dropping frames regardless, an isolated cached hit
 * is a correct frame at the cost of one 2D blit, and the park that goes with it
 * targets the playhead itself (the run ends where it starts), so it asks the
 * video element for exactly the frame the next live render wants anyway.
 *
 * Both costs are MEASURED, never assumed: `noteLiveRender` is fed the per-frame
 * playback render time (renderQualityStore.reportPlaybackFrame), `noteBlit` the
 * frame cache's own copy time, which is the same frame-sized 2D drawImage a
 * blit performs. Until both exist nothing changes.
 *
 * Flicker is what the hysteresis is for: the decision is entered after three
 * slow live frames and left only after thirty fast ones. Blit frames report no
 * live time at all, so a stretch of blits cannot talk the policy out of itself.
 * What it cannot see is resolution — a cache warmed at Full served between live
 * frames degraded by adaptive resolution alternates sharpness, as the paused
 * serve always has.
 */
export class PlaybackBlitPolicy {
  private liveMs = NaN;
  private blitMs = NaN;
  private slow = false;
  private over = 0;
  private under = 0;

  /** One live playback render: its cost and the frame period it had. */
  noteLiveRender(ms: number, budgetMs: number): void {
    if (!Number.isFinite(ms) || !(budgetMs > 0)) return;
    this.liveMs = Number.isNaN(this.liveMs) ? ms : this.liveMs * 0.7 + ms * 0.3;
    if (ms > budgetMs) {
      this.over += 1;
      this.under = 0;
      if (this.over >= SLOW_LIVE_TO_ENTER) this.slow = true;
    } else {
      this.under += 1;
      this.over = 0;
      if (this.under >= FAST_LIVE_TO_EXIT) this.slow = false;
    }
  }

  /** One frame-sized 2D copy (the cache's own copy, a blit's twin). */
  noteBlit(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.blitMs = Number.isNaN(this.blitMs) ? ms : this.blitMs * 0.8 + ms * 0.2;
  }

  /** May a cached frame with a run shorter than MIN_PLAYBACK_BLIT_RUN be served? */
  get singleFrameBlits(): boolean {
    if (!this.slow || Number.isNaN(this.blitMs) || Number.isNaN(this.liveMs)) return false;
    return this.liveMs > Math.max(this.blitMs, 0.1) * LIVE_OVER_BLIT;
  }

  reset(): void {
    this.liveMs = NaN;
    this.blitMs = NaN;
    this.slow = false;
    this.over = 0;
    this.under = 0;
  }
}

/** The viewport's policy, fed by the render-quality store and the frame cache. */
export const playbackBlitPolicy = new PlaybackBlitPolicy();

/**
 * Is this playback hit worth blitting, given where its cached run ends?
 *
 * `contiguousEnd` is `FrameCache.contiguousEnd(frame)`: the last frame of the
 * unbroken cached run containing `frame` (or `frame` itself when isolated).
 * A shorter run is served only when `policy` has measured the live render to
 * be the slower path — see `PlaybackBlitPolicy`.
 */
export function playbackBlitWorthwhile(
  frame: number,
  contiguousEnd: number,
  policy: Pick<PlaybackBlitPolicy, 'singleFrameBlits'> | null = playbackBlitPolicy,
): boolean {
  if (contiguousEnd - frame >= MIN_PLAYBACK_BLIT_RUN) return true;
  return contiguousEnd >= frame && !!policy?.singleFrameBlits;
}

/**
 * May the frame just rendered by a PAUSED pass be stored?
 *
 * `mediaExact` is `lastFrameMediaExact() !== false` — false only when the
 * renderer knows it drew stand-in footage.
 */
export function mayFillFromPausedRender(
  s: Omit<PreviewCacheState, 'playing' | 'onionSkins'> & { mediaExact: boolean },
): boolean {
  if (s.interacting) return false;
  if (!s.mediaExact) return false;
  return isOnFrameGrid(s.timeSec, s.fps, s.frame);
}
