/**
 * The CPU effect bake as a self-contained JOB — the unit the bake worker pool
 * runs off the main thread, and the unit the main thread runs itself when no
 * worker is available.
 *
 * ── Why a job, and why the main thread runs the same function ──────────────
 *
 * A bake used to be `applyEffectChain` over a canvas the caller had just drawn
 * into. That canvas cannot cross a thread boundary; its pixels can. So the job
 * is exactly the chain's inputs as data — the prepared layer pixels (content,
 * paint and mask already drawn by the caller, which owns the fonts, the clone
 * sources and the decoded footage), the length-scaled effect stack, fill
 * opacity and the mask stack for scoped effects — and its result is pixels.
 *
 * Determinism is structural rather than hoped for: the worker's message
 * handler and the main-thread fallback both call `runBakeJob`, so one input
 * produces one output wherever it runs. `bakeWorker.test.ts` holds both routes
 * (and a direct `applyEffectChain` over an identically-seeded canvas) to byte
 * equality on the same input.
 *
 * ── What may NOT go to a worker ────────────────────────────────────────────
 *
 * Text. Fonts registered on the document are not visible in a worker, so
 * Numbers and Timecode would render in a fallback face — a different picture,
 * not a slower one. `bakeJobWorkerSafe` keeps any stack containing a text
 * readout on the main thread. Everything else the chain draws is pure maths
 * over its params plus canvas ops OffscreenCanvas supports.
 */

import type { Effect } from './effects';
import type { LayerMask } from './mask';
import { applyEffectChain } from './effectBake';

/** A bake's inputs as transferable data. */
export interface BakeJobInput {
  w: number;
  h: number;
  /** Straight-alpha RGBA, `w × h × 4` — the prepared layer, pre-chain. */
  pixels: Uint8ClampedArray;
  /** The stack, lengths ALREADY scaled to this raster (`scaleEffectLengths`). */
  effects: ReadonlyArray<Effect>;
  fillOpacity: number;
  /** Mask stack for effect-scoped masks (M6); the layer mask is pre-applied. */
  mask?: LayerMask;
}

/** Makes a same-realm canvas: `document.createElement` on the main thread, an
 *  OffscreenCanvas in the worker. Typed as the DOM element because that is
 *  what the chain is written against; the two are call-compatible for every
 *  operation the chain performs. */
export type BakeCanvasFactory = (w: number, h: number) => HTMLCanvasElement;

/**
 * Effects that draw TEXT — the one thing a worker cannot reproduce (see the
 * module header). Kept beside the predicate rather than derived from the
 * kernels because the property is about font visibility, which no kernel
 * signature expresses; `bakeWorker.test.ts` pins it against every `fillText`
 * caller in the effect modules.
 */
const TEXT_DRAWING_EFFECTS: ReadonlySet<string> = new Set(['numbers', 'timecode']);

/** Test seam: the text-drawing classification. */
export function textDrawingEffects(): ReadonlySet<string> {
  return TEXT_DRAWING_EFFECTS;
}

/**
 * May this stack bake in a worker?
 *
 * False when any enabled effect draws text — see above — and false for a PLUGIN
 * effect, which is the second thing a bake worker cannot reproduce and for a
 * structurally similar reason. A plugin's CPU kernel is instantiated per realm
 * and registered on the main thread from the installed package; a bake worker
 * has neither the registry nor the package, so the chain would silently skip
 * the effect and hand back a layer with it missing. That is the exact failure
 * the CPU twin exists to remove, so it must not be reintroduced by the pool.
 *
 * The cost is that a layer carrying a plugin kernel bakes on the main thread.
 * Acceptable, and bounded: it is one effect's worth of layers, not every layer,
 * and the alternative — shipping kernel bytes to every bake worker on every
 * job — costs more than it saves for a module that is usually already warm
 * where it is.
 */
export function bakeJobWorkerSafe(effects: ReadonlyArray<Effect> | undefined): boolean {
  return !(effects ?? []).some(
    (e) => e.enabled !== false && (TEXT_DRAWING_EFFECTS.has(e.type) || e.type.includes('.')),
  );
}

/**
 * Run one bake job to completion and return its pixels (a fresh buffer the
 * caller owns). Seeds a canvas from `job.pixels` with `putImageData`, runs the
 * chain, reads the result back.
 *
 * The seed is part of the contract, not an implementation detail: a canvas
 * stores premultiplied colour, so pixels that went in through putImageData can
 * come back a code different at partial alpha. Both routes seed the same way,
 * which is what makes them byte-identical to each other.
 */
export function runBakeJob(job: BakeJobInput, makeCanvas: BakeCanvasFactory): Uint8ClampedArray {
  const { w, h } = job;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('bake job: no 2d context');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const seed = ctx.createImageData(w, h);
  seed.data.set(job.pixels);
  ctx.putImageData(seed, 0, 0);
  applyEffectChain(ctx, w, h, job.effects, makeCanvas, job.fillOpacity, job.mask);
  return ctx.getImageData(0, 0, w, h).data;
}

// ── Worker protocol ─────────────────────────────────────────────────────────

export interface BakeRequestMessage {
  id: number;
  job: BakeJobInput;
}

export type BakeResponseMessage =
  | { id: number; ok: true; pixels: Uint8ClampedArray }
  | { id: number; ok: false; error: string };

/**
 * The worker's whole message handler, as a function of its inputs — exported so
 * the determinism test drives the exact code the worker runs, not a copy.
 * `post` receives the reply and the buffers to transfer with it.
 */
export function handleBakeRequest(
  msg: BakeRequestMessage,
  makeCanvas: BakeCanvasFactory,
  post: (reply: BakeResponseMessage, transfer: Transferable[]) => void,
): void {
  try {
    const pixels = runBakeJob(msg.job, makeCanvas);
    post({ id: msg.id, ok: true, pixels }, [pixels.buffer]);
  } catch (err) {
    post({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }, []);
  }
}
