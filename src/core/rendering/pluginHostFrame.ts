/**
 * The frame's own facts, for any plugin effect the scene walk finds.
 *
 * ── Why this is module state and not a parameter ─────────────────────────────
 *
 * `extractSpatialEffects` sits at the bottom of a recursive walk that already
 * carries a matrix, a scale and two flags through a dozen intermediate
 * functions. Threading a composition context down to it would add a parameter
 * that every one of those forwards and none of them reads — and every call site
 * in the tests would have to invent a composition to ask a question about one
 * effect.
 *
 * So it is set once at the top of `snapshotToFrameScene` and cleared when the
 * walk ends, exactly as `withStyleSilhouette` does in `canvas2dEffects`. The
 * clearing is the part that matters: a stale comp size left set is a plugin
 * effect sizing itself to a composition the user has closed, which is the kind
 * of bug that only appears after switching comps.
 *
 * ── What is here and what is not ─────────────────────────────────────────────
 *
 * Only the values that are the same for every layer in the frame. The layer's
 * own size and its own time come from the `RenderLayer` at the point of use —
 * they differ per layer, and a retimed layer's clock is not the comp's.
 */

/** The per-frame half of what a plugin kernel is handed. */
export interface PluginHostFrame {
  compWidth: number;
  compHeight: number;
  /** The playhead, in composition seconds. */
  compTime: number;
  fps: number;
  /**
   * Raster px per composition px.
   *
   * Set by the viewport when it knows its device pixel ratio and zoom; 1
   * otherwise, which is what an export at comp resolution actually is. A kernel
   * uses it to keep a screen-space feature (a 1px outline, a dither) the same
   * apparent size wherever it is drawn.
   */
  pixelScale: number;
  /** 1 at full quality, 2 at half, 4 at quarter — Adaptive Resolution's factor. */
  downsample: number;
}

const ABSENT: PluginHostFrame = {
  compWidth: 0,
  compHeight: 0,
  compTime: 0,
  fps: 0,
  // 1, not 0, for both scale factors: a kernel that divides by either gets the
  // identity rather than an infinity when nothing supplied them.
  pixelScale: 1,
  downsample: 1,
};

let current: PluginHostFrame | null = null;

/**
 * Install the frame's facts, or clear them with `null`.
 *
 * Takes the fields the snapshot knows and defaults the rest, so a caller that
 * has no view transform — an export, a golden harness — does not have to invent
 * numbers it would only be wrong about.
 */
export function setPluginHostFrame(
  frame: (Partial<PluginHostFrame> & { compWidth: number; compHeight: number }) | null,
): void {
  current = frame ? { ...ABSENT, ...frame } : null;
}

/** The frame's facts, or zeros outside a scene walk. Never null, so callers do
 *  not each invent a fallback and disagree about what `fps: 0` means. */
export function pluginHostFrame(): PluginHostFrame {
  return current ?? ABSENT;
}

/**
 * A stable per-instance seed in [0, 1), derived from an effect instance's id.
 *
 * ── Why not `Math.random()`, a counter, or the clock ─────────────────────────
 *
 * All three break the same thing. A noise field whose seed changes per frame
 * boils; one seeded from the wall clock is a different picture in preview and
 * in export, which is the single worst outcome for a render — the user checks
 * the preview and ships something else. A counter is stable within a session
 * and different in the next one, which is the same bug spread over a day.
 *
 * FNV-1a over the id: cheap, no dependencies, and — the property that matters —
 * a pure function of something that is already stable and already unique per
 * effect instance, so two copies of one effect on two layers differ and each
 * stays put across frames, sessions and machines.
 */
export function seedFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 first: `Math.imul` returns a SIGNED 32-bit int, and a negative seed
  // divided by 2³² is a negative number, which every `fract`-style use of it
  // would fold to the wrong place.
  return (hash >>> 0) / 4294967296;
}
