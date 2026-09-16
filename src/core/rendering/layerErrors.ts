/**
 * Per-layer error isolation — the shared vocabulary.
 *
 * One bad layer (effect params that make a bake throw, a malformed path, a NaN
 * transform reaching a matrix helper) used to throw out of `buildSnapshot` or
 * `snapshotToFrameScene` and blank the WHOLE frame: every other layer vanished
 * with it, and the viewport showed nothing until the offending edit was undone.
 *
 * The build stages now guard each layer on its own. A layer that throws is left
 * out, the rest of the frame renders, and what happened is recorded here as a
 * `LayerError`. That record is not optional decoration — it is what keeps the
 * isolation honest:
 *
 *   preview — keeps the frame and says, once, which layer was skipped;
 *   export  — REFUSES the frame, through the same `lastFrameDiagnostics` gate
 *             that already refuses unhonoured mattes and offline media. A
 *             delivered file must never silently lack a layer.
 *
 * Deliberately dependency-free (no stores, no event bus): `buildSnapshot` and
 * `snapshotToFrameScene` run inside the render-tests harness and export, and
 * must not drag the UI in. Surfacing lives in `engineDiagnostics.ts`.
 */

/** Which build stage a layer failed in. */
export type LayerErrorStage = 'snapshot' | 'scene';

export interface LayerError {
  layerId: string;
  /** The user-facing name when the stage knows it (the scene node's). */
  layerName?: string;
  stage: LayerErrorStage;
  /** The thrown message, already one line. */
  message: string;
}

/**
 * Cap on errors recorded per build. A pathological scene (every layer carrying
 * the same broken effect) must not turn a render problem into a memory
 * problem, and the 33rd identical record tells nobody anything the 1st did not.
 */
export const MAX_LAYER_ERRORS_PER_FRAME = 32;

/** A thrown value as one line of text. Only ever runs on the error path. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.split('\n')[0]!;
  return String(err).split('\n')[0]!;
}

/**
 * Append to a lazily-allocated list. Returns the list so callers can keep a
 * `null` until the first failure — the healthy path allocates nothing.
 */
export function pushLayerError(list: LayerError[] | null, error: LayerError): LayerError[] {
  const out = list ?? [];
  if (out.length < MAX_LAYER_ERRORS_PER_FRAME) out.push(error);
  return out;
}

/** The sentence preview and export both quote, so they describe one problem one way. */
export function describeLayerError(e: LayerError): string {
  const who = e.layerName ? `"${e.layerName}"` : e.layerId;
  const where = e.stage === 'snapshot' ? 'while building the frame' : 'while preparing it for the GPU';
  return `Layer ${who} failed ${where} and was skipped: ${e.message}`;
}
