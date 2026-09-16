/**
 * Deterministic offline renderer. Replaces realtime MediaRecorder
 * sampling (which drops frames and is non-reproducible) with a fixed-timestep
 * loop: every frame's time is `index / fps` exactly, so the same project always
 * renders byte-identical frames regardless of machine speed.
 *
 * The loop renders each frame into an offscreen Canvas2D backend and hands the
 * canvas to a sink (`onFrame`) — PNG-sequence zipping, MediaRecorder feeding,
 * etc. It yields between frames so the UI stays responsive and supports
 * cancellation via an AbortSignal.
 *
 * The frame-timing maths is pure and unit-tested; the render loop needs a DOM
 * canvas so it runs in the browser / render worker, not under jsdom.
 */

import { createRenderBackend } from '@core/rendering/createRenderBackend';
import { buildSnapshot, COMP_WIDTH, COMP_HEIGHT, DEFAULT_COMP, type SnapshotComp } from '@core/rendering/buildSnapshot';
import type { MotionBlurConfig } from '@core/effects/motionBlur';
import type { RenderView } from '@core/rendering/RenderBackend';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
// Shared with the tracking walks — see that module for why an `await` alone
// does not hand the thread back.
import { yieldToUi } from '@core/loading/yieldToUi';
import {
  hasGeneratorLayers,
  setGeneratorExactMode,
  settleGenerators,
  takeGeneratorErrors,
} from '@core/plugins/generator';
import {
  setNativeExactMode,
  settleNative,
  takeNativeErrors,
} from '@core/plugins/native';
import { warmPluginKernels } from '@core/effects/pluginCpuEffect';
import { defaultAnimation } from '@motion/animation';

export interface OfflineRenderParams {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Comp size + background/transparency; defaults handled by buildSnapshot. */
  comp?: SnapshotComp;
  /** Optional inclusive frame range (defaults to the whole duration). */
  startFrame?: number;
  endFrame?: number;
  /** Motion blur (threaded from the viewport settings so export matches). */
  motionBlur?: MotionBlurConfig;
  /**
   * Hand the thread back only once this many ms have passed since the last
   * yield, instead of after every frame. Absent: yield every frame, which is
   * what the interactive walks built on this loop (auto-trace, reframe) want.
   *
   * A delivered export sets it. Electron 32 has no `scheduler.yield`, so each
   * yield is a `setTimeout(0)` — clamped to 4 ms once nested — and on a comp
   * that renders in 10 ms that clamp alone was a third of the export's wall
   * clock. Frames still yield promptly when they are slow (one heavy frame
   * already exceeds the budget), so progress and Cancel stay responsive.
   */
  yieldBudgetMs?: number;
}

/**
 * Exact fit-contain of the comp into the output frame — the backend's implicit
 * fallback fit insets by 8% (preview "float" framing), which exported every
 * frame with a border. Pure, exported for tests.
 */
export function exportView(
  outW: number,
  outH: number,
  comp?: SnapshotComp,
): RenderView {
  const cw = comp?.width ?? COMP_WIDTH;
  const ch = comp?.height ?? COMP_HEIGHT;
  const scale = Math.min(outW / cw, outH / ch);
  return { scale, offsetX: (outW - cw * scale) / 2, offsetY: (outH - ch * scale) / 2 };
}

/**
 * The comp settings for a DELIVERED frame — today, drop guide layers.
 *
 * Deliberately a sibling of `exportView`, meant to be called on the adjacent
 * line, because there is no single funnel every export path passes through:
 * `offlineRenderer`, `exportManager` (both the sequence and the poster
 * thumbnail) and `exportPreview` each call `buildSnapshot` themselves. Four
 * call sites is four chances to forget, which is the §2·0 shape.
 *
 * Two things narrow it. One DEFINITION of "for export" lives here, so the rule
 * cannot drift between the four. And `exportPathsMarkForExport.test.ts` reads
 * this directory's source, finds every `buildSnapshot(` call in it, and asserts
 * each is paired with this helper — derived from the code rather than from a
 * list someone maintains, so a fifth export path is caught the day it appears.
 *
 * `exportPreview` counts as an export path on purpose: it shows what the file
 * will contain, so a guide layer visible there would be a preview that lies.
 */
export function exportComp(comp?: SnapshotComp): SnapshotComp & { forExport: true } {
  // `comp` is optional on every export path, and `buildSnapshot` would have
  // substituted its defaults for `undefined`. Substituting them HERE keeps that
  // behaviour while still marking the frame — passing `undefined` through would
  // be the one case that silently kept guide layers in the output.
  return { ...DEFAULT_COMP, ...comp, forExport: true };
}

// ── Pure frame timing (deterministic, tested) ────────────────────────

/** Total frames for a duration at a frame rate (at least 1). */
export function frameCount(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps));
}

/** Exact time (seconds) of frame `index` — the fixed timestep. */
export function frameTimeAt(index: number, fps: number): number {
  return index / fps;
}

/** Every frame time across the duration (fixed timestep). */
export function frameTimes(durationSec: number, fps: number): number[] {
  const n = frameCount(durationSec, fps);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i / fps);
  return out;
}

/** Resolve an inclusive [start,end] frame range within the duration. */
export function resolveRange(params: OfflineRenderParams): { start: number; end: number } {
  const total = frameCount(params.durationSec, params.fps);
  const start = Math.max(0, params.startFrame ?? 0);
  const end = Math.min(total - 1, params.endFrame ?? total - 1);
  return { start, end: Math.max(start, end) };
}

// ── The render loop ──────────────────────────────────────────────────

/**
 * The yield budget a DELIVERED export renders with (`yieldBudgetMs`): about
 * twenty progress repaints a second, which is as responsive as a progress bar
 * and a Cancel button need to be.
 */
export const EXPORT_YIELD_BUDGET_MS = 48;

/**
 * How long one frame waits for its plugin generators.
 *
 * Between the per-generate budget (20 s in export) and the media convergence
 * cap (15 s), because a single frame may legitimately need SEVERAL generate
 * calls: a simulation resuming from a checkpoint replays in chunks, and an
 * export that starts at frame 400 begins with one of those. Shorter than the
 * sum of what it is waiting for would turn a slow first frame into a refused
 * export.
 */
export const GENERATOR_SETTLE_MS = 30_000;

/**
 * How long one frame waits for a plugin's COMPILED addon.
 *
 * The same 30 s, for the same reason and deliberately not a second number: a
 * frame may hold several native calls (an effect per layer, plus whatever the
 * bake queued), each with its own per-call timeout in the plugin's process, and
 * this is the ceiling on all of them together rather than on any one.
 */
export const NATIVE_SETTLE_MS = 30_000;

export type FrameSink = (
  canvas: HTMLCanvasElement,
  frame: number,
  total: number,
  backend?: import('@core/rendering/RenderBackend').RenderBackend,
) => void | Promise<void>;

/**
 * Render each frame deterministically into an offscreen canvas and pass it to
 * `onFrame`. Returns the number of frames rendered. Aborts cleanly if the
 * signal fires (throws AbortError).
 */
export async function renderOffline(
  params: OfflineRenderParams,
  onFrame: FrameSink,
  signal?: AbortSignal,
): Promise<number> {
  const canvas = document.createElement('canvas');
  const backend = createRenderBackend('auto', 'auxiliary');
  try {
    backend.attach(canvas);
    backend.resize(params.width, params.height, 1);
    // Frame-accurate media: sub-millisecond video seeks + collected waits, so a
    // captured frame can never show the PREVIOUS frame's footage. Without this,
    // seeks were async fire-and-forget with a ±0.05s deadband — every exported
    // video layer lagged a frame and stuttered at ~half rate.
    backend.setExactMediaTiming?.(true);

    if (backend.readyPromise) {
      await backend.readyPromise;
    }

    // A backend that failed to initialise still accepts renderFrame — it just
    // stores the snapshot and draws nothing. Every frame then reads back as an
    // untouched canvas, and the export completes "successfully" with a file that
    // is uniformly black. That is the single worst failure this pipeline can
    // have, because nothing anywhere reports it, so it is checked here.
    if (backend.initFailed) {
      throw new Error(
        backend.initErrorMessage ??
          'The renderer could not be initialized, so there is nothing to export. Restarting the app usually clears this.',
      );
    }

    const { start, end } = resolveRange(params);
    const total = end - start + 1;
    const yieldBudget = params.yieldBudgetMs ?? 0;
    let lastYield = performance.now();
    /*
      One frame's snapshot. A closure rather than an inline call because a
      generator layer needs it TWICE: the first build states which frames its
      plugin must produce, and the second picks up the geometry that arrived.
      One call site keeps the two identical — including `exportComp`, which
      `exportPathsMarkForExport.test.ts` reads this source to check.
    */
    const buildFrame = (t: number) => buildSnapshot(
      defaultSceneGraph,
      defaultAnimation,
      t,
      undefined,
      undefined,
      exportView(params.width, params.height, params.comp), // 1:1 comp→frame (no preview inset)
      params.motionBlur,
      exportComp(params.comp),
    );

    /*
      Plugin generators produce geometry off this thread, and an export must
      have the EXACT frame rather than the most recent one.

      `setGeneratorExactMode` switches the scheduler out of its preview
      behaviour for the whole export: no look-ahead competing with the frame
      being waited on, the longer per-frame budget, and every request tracked so
      `settleGenerators` knows what is outstanding. Restored in the `finally`
      below, so a cancelled or failed export does not leave the viewport in
      export mode.

      `setNativeExactMode` is the same switch for the compiled tier, in the same
      words on purpose: nothing coalesced, nothing dropped, and the preview
      budget that benches a slow addon lifted for the duration — an export that
      quietly took an effect's JavaScript fallback would produce a different
      picture from the one the user approved in the viewport.
    */
    setGeneratorExactMode(true);
    setNativeExactMode(true);
    for (let i = start; i <= end; i++) {
      if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
      const t = frameTimeAt(i, params.fps);
      let snap = buildFrame(t);
      /*
        Await the generator frames this snapshot asked for.

        Only when something asked — `hasGeneratorLayers` is false for every
        project without one, so this is a map-size check and a branch, and the
        second build never happens.

        A layer that does not land in time becomes a DIAGNOSTIC, through the
        same `layerErrors` channel a layer that threw during the build uses, and
        the gate below refuses the frame. It must not fall through: the
        scheduler would serve the previous frame's particles, the export would
        succeed, and the file would contain a simulation that stutters at
        exactly the frames the plugin was slow on — which nobody would ever
        attribute to this.
      */
      if (hasGeneratorLayers()) {
        const unmet = await settleGenerators(GENERATOR_SETTLE_MS);
        if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
        snap = buildFrame(t);
        const failed = takeGeneratorErrors();
        if (unmet.length > 0 || (failed && failed.length > 0)) {
          snap.layerErrors = [
            ...(snap.layerErrors ?? []),
            ...unmet.map((layerId) => ({
              layerId,
              stage: 'snapshot' as const,
              message:
                `its plugin did not produce frame ${i} within ${GENERATOR_SETTLE_MS} ms`,
            })),
            ...(failed ?? []).map((e) => ({
              layerId: e.layerId,
              stage: 'snapshot' as const,
              message: `${e.pluginId}.${e.kindId}: ${e.message}`,
            })),
          ];
        }
      }
      /*
        And the compiled tier, reported the same way.

        A separate gate rather than a branch of the one above, because the two
        wait for different things. A native GENERATOR's call is awaited inside
        the generator pump and is already covered by `settleGenerators`; a
        native EFFECT's is outstanding against a layer's bake, with no generator
        layer waiting on it, so nothing above would ever notice it.

        Unconditional, unlike the generator block: `settleNative` resolves an
        empty list without allocating a scheduler when nothing has ever called
        one, and gating on "is there native work RIGHT NOW" would drop the
        errors of a call that failed quickly — which is precisely the frame that
        must not ship. No second `buildFrame`: what a native effect produces
        reaches the bake, not the snapshot.

        The rule is the generator block's, for the reason stated there: a frame
        that is missing native work is REFUSED, never written with whatever the
        fallback path happened to leave behind.
      */
      const unmetNative = await settleNative(NATIVE_SETTLE_MS);
      if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
      const nativeFailed = takeNativeErrors();
      if (unmetNative.length > 0 || nativeFailed.length > 0) {
        snap.layerErrors = [
          ...(snap.layerErrors ?? []),
          ...unmetNative.map((instanceId) => ({
            layerId: instanceId,
            stage: 'snapshot' as const,
            message:
              `its plugin's native module did not answer for frame ${i} within ${NATIVE_SETTLE_MS} ms`,
          })),
          ...nativeFailed.map((e) => ({
            layerId: e.instanceId,
            stage: 'snapshot' as const,
            message: `${e.pluginId} (native): ${e.message}`,
          })),
        ];
      }
      /*
        Warm this frame's plugin CPU kernels BEFORE anything draws.

        A kernel module instantiates asynchronously. A preview accepts that and
        takes the one-frame warm-up — the layer redraws when the module lands.
        An export cannot: the bake runs inside `renderFrame`, so a frame drawn
        while the module is still loading is written with that effect simply
        ABSENT, and the export then reports success. The user gets a file that
        is missing an effect at exactly the frames the module was still loading,
        with nothing anywhere saying so.

        Cheap after the first frame: `warmPluginKernels` skips every module that
        is loaded or already known to be missing, so this is a walk of the
        frame's effects and nothing else. A module that cannot load is recorded
        as missing rather than retried, so a broken package costs one attempt
        for the whole export, not one per frame.
      */
      await warmPluginKernels(snap.layers.flatMap((l) => l.effects ?? []));
      if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
      backend.renderFrame(snap);
      // Converge media: while a render started async media work (video seeks,
      // first decode, blend-cache fills), await it and re-render. The element
      // waits are internally time-capped; the exact-decoder waits are not, so
      // each pass carries its own ceiling — a wedged decode must degrade the
      // frame, never hang the export forever with no error and no progress.
      for (let pass = 0; pass < 4; pass++) {
        const waits = backend.takeMediaWaits?.();
        if (!waits || waits.length === 0) break;
        let capTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(waits),
          new Promise<void>((resolve) => { capTimer = setTimeout(resolve, 15_000); }),
        ]);
        clearTimeout(capTimer);
        if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
        backend.renderFrame(snap);
      }
      // EXPORT half of the M8a split: FAIL, do not warn.
      //
      // The preview shows the same notice and keeps the frame, because a human
      // is looking at it and can act. Here the frame is about to be encoded into
      // a file someone ships, and a warning in a log next to a delivered MP4 is
      // not a warning anyone acts on. Wrong pixels on screen are recoverable;
      // wrong pixels in a deliverable are not.
      //
      // Thrown BEFORE onFrame, so a frame known to be wrong is never handed to
      // the sink. A refused export beats a half-written file that looks finished.
      //
      // Read BEFORE the media-exactness gate below, deliberately: a lost GPU
      // device or a layer that threw also leaves that frame's footage
      // unconverged, and checking exactness first reported a device loss as
      // "the video decode did not finish" — sending the user to transcode
      // footage that was never the problem. The diagnostic names the cause.
      const diags = backend.lastFrameDiagnostics?.() ?? [];
      if (diags.length > 0) {
        const lines = diags.map((d) => `  • ${d.detail}${d.layerId ? ` (layer ${d.layerId})` : ''}`);
        throw new Error(
          `Export stopped at frame ${i}: ${diags.length} compositing operation(s) could not be `
          + `honoured, so this frame would not match the composition.\n${lines.join('\n')}`,
        );
      }

      // The exactness gate, closing the loophole the header promises is shut:
      // the renderer KNOWS when a frame holds stand-in video pixels
      // (nearest-neighbour while a decode is in flight, an element mid-seek,
      // a warming source) via lastFrameMediaExact() — but only the RAM
      // preview cache ever read it. The DELIVERABLE accepted the stale frame:
      // after the 4-pass cap or the 15s race, the loop fell through and
      // encoded whatever pixels were there, silently. M8b's rule is the
      // opposite — wrong pixels on screen are recoverable; wrong pixels in a
      // file are not — so a frame that never converged REFUSES, like every
      // other known-bad frame above.
      if (backend.lastFrameMediaExact?.() === false) {
        throw new Error(
          `Export stopped at frame ${i}: the video decode for this frame did not finish in time, `
          + 'so the frame would contain stale footage pixels. Re-run the export; if this repeats, '
          + 'generate a proxy for the footage or transcode it (Media Settings ▸ Proxy).',
        );
      }

      await onFrame(canvas, i - start, total, backend);
      // Yield so progress paints, the editor stays usable, and cancellation can
      // interrupt between frames — on a time budget when the caller set one.
      if (yieldBudget <= 0 || performance.now() - lastYield >= yieldBudget) {
        await yieldToUi();
        lastYield = performance.now();
      }
    }
    return total;
  } finally {
    setGeneratorExactMode(false);
    setNativeExactMode(false);
    backend.dispose();
  }
}

/**
 * Render a SINGLE frame to a PNG blob (AE's "Save Frame As"). Reuses the exact
 * deterministic offline path — same backend, same 1:1 comp→frame view — so a
 * saved still matches a video export frame-for-frame. Returns null if the
 * canvas can't encode. `mime` may be 'image/png' (lossless, default) or
 * 'image/jpeg'.
 */
export async function renderStillFrame(
  params: OfflineRenderParams,
  frameIndex: number,
  mime: 'image/png' | 'image/jpeg' = 'image/png',
  quality = 0.92,
): Promise<Blob | null> {
  let blob: Blob | null = null;
  await renderOffline(
    { ...params, startFrame: frameIndex, endFrame: frameIndex },
    async (canvas) => {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), mime, quality),
      );
    },
  );
  return blob;
}
