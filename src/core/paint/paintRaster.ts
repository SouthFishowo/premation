/**
 * Paint strokes → pixels, shared by EVERY raster that carries a layer's paint.
 *
 * This used to be a private method of the shape rasterizer, and that was the
 * whole of a real defect: only shape layers ever drew their paint. The Brush,
 * Eraser and Clone Stamp all accept image, video and text layers and record
 * strokes on them — one undo entry each — and then nothing drew those strokes,
 * in the preview or in an export. Extracted so the shape raster, the text
 * raster, the image bake and the per-frame video bake all run the SAME pass —
 * which is also what keeps preview and export identical.
 *
 * Draws in whatever space the caller's context is in: the caller sets the
 * transform so that the layer's centred local space (where strokes live) maps
 * onto its canvas. Paint composites over the canvas's current content — erase
 * cuts it, clone re-paints it shifted — so it must run after the layer's own
 * content and before its mask and effects.
 *
 * ## Two renderers, chosen per stroke
 *
 *  · DIRECT — the v1 pass, verbatim: a round-capped polyline, the soft edge a
 *    CSS blur, straight onto the target. Every stroke written before model v2
 *    (no spacing, untrimmed, untransformed, RGBA, Normal) takes it, so old
 *    documents and the golden frames render byte-identically.
 *  · BUFFERED — AE's brush: the stroke's coverage is built in a scratch buffer
 *    the size of its device bounds (dabs at Spacing with an elliptical
 *    Angle/Roundness tip and Hardness falloff, Flow accumulating; or the
 *    polyline when the stroke has no dab options), Last-Stroke-Only erasers cut
 *    it, it is filled (colour, or clone source), and composited once at the
 *    stroke's Opacity with its Mode and Channels. Opacity is a CAP on the whole
 *    stroke, not per dab — overlapping dabs never exceed it, as in AE.
 *
 * Tip stamps are cached per (device diameter, hardness, roundness, angle), so a
 * stroke of a thousand dabs rasterises one gradient, not a thousand.
 *
 * Pure apart from scratch-canvas allocation; no store imports, so the render
 * path can use it freely.
 */

import type { PaintBlend, PaintConfig, PaintStroke } from './paintStrokes';
import {
  hasStrokeTransform,
  strokeDabs,
  strokeTransformMatrix,
  strokeTransformScale,
  trimPolyline,
  usesDabs,
} from './paintDabs';

type Stroke = PaintStroke;
type Affine = [number, number, number, number, number, number];

/** True when the layer has a paint pass to run: at least one stroke, or Paint
 *  On Transparent (which hides the layer's own pixels even with no stroke live). */
export function hasPaintStrokes(paint: PaintConfig | null | undefined): paint is PaintConfig {
  return !!paint && Array.isArray(paint.strokes) && (paint.strokes.length > 0 || paint.onTransparent === true);
}

/**
 * The softness blur's standard deviation, in LOCAL px (the stroke's own units).
 * Hardness 1 is a hard edge; 0 spreads a third of the diameter.
 */
export function paintBlurSigma(s: Pick<PaintStroke, 'size' | 'hardness'>): number {
  return s.hardness < 1 ? ((1 - s.hardness) * s.size) / 3 : 0;
}

/**
 * How far paint reaches past its polyline, in local px: half the brush plus the
 * soft edge's visible tail (3σ). Padding by the half-width alone clipped every
 * feathered stroke near the raster edge — the blur's tail was sliced off flat.
 * A per-stroke Transform adds how far it can carry the stroke's bounds.
 */
export function paintReach(paint: PaintConfig | null | undefined): number {
  if (!hasPaintStrokes(paint)) return 0;
  let reach = 0;
  for (const s of paint.strokes) {
    let r = s.size / 2 + 3 * paintBlurSigma(s);
    if (hasStrokeTransform(s.transform)) {
      r *= strokeTransformScale(s.transform);
      r += transformShift(s);
    }
    if (r > reach) reach = r;
  }
  return reach;
}

/** Max distance a stroke transform moves any corner of the stroke's bounds. */
function transformShift(s: Stroke): number {
  const t = s.transform;
  if (!t || s.points.length === 0) return 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const m = strokeTransformMatrix(t);
  let d = 0;
  for (const [x, y] of [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]] as const) {
    d = Math.max(d, Math.hypot(m[0] * x + m[2] * y + m[4] - x, m[1] * x + m[3] * y + m[5] - y));
  }
  return d;
}

/**
 * Device px per local px under a context's current transform (area-preserving
 * mean of the two axes).
 *
 * Needed because `ctx.filter = blur(Npx)` is NOT transformed by the CTM — N is
 * canvas pixels regardless of `ctx.scale`. Measured in Chromium: the same
 * `blur(4px)` edge ramp is 109 px wide under scale 1 and under scale 4. So a
 * stroke's softness in LOCAL units has to be multiplied out, or the same stroke
 * came out 4× softer at a 1× raster than at a 4× one — softer on screen at
 * Draft quality, sharper in a full-resolution export.
 */
export function deviceScaleOf(ctx: Pick<CanvasRenderingContext2D, 'getTransform'>): number {
  if (typeof ctx.getTransform !== 'function') return 1;
  const m = ctx.getTransform();
  const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/** The CSS filter for a stroke's soft edge under a context with device scale `k`. */
export function paintBlurFilter(s: Pick<PaintStroke, 'size' | 'hardness'>, k: number): string {
  const sigma = paintBlurSigma(s);
  return sigma > 0 ? `blur(${sigma * k}px)` : 'none';
}

// ── Signature ──────────────────────────────────────────────────────────

/** Per-stroke signature, memoised on the stroke object: strokes are immutable
 *  once written (every edit replaces the array's objects), and a long stroke is
 *  thousands of points that a per-frame JSON.stringify would walk every frame. */
const strokeSigs = new WeakMap<object, string>();
/** Point hashes memoised on the ARRAY, so a per-frame resolved copy of a stroke
 *  (an animated Opacity, say) still hashes its path once. */
const arrayHashes = new WeakMap<object, string>();

function hashNumbers(arr: ReadonlyArray<{ x: number; y: number }> | ReadonlyArray<number>): string {
  const hit = arrayHashes.get(arr);
  if (hit !== undefined) return hit;
  // FNV-1a over the coordinates (to 1/1000 px) — collision-resistant enough for
  // a cache key and a fixed length whatever the stroke's size.
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    h ^= Math.round(v * 1000) | 0;
    h = Math.imul(h, 0x01000193);
  };
  for (const p of arr as ReadonlyArray<unknown>) {
    if (typeof p === 'number') mix(p);
    else { mix((p as { x: number }).x); mix((p as { y: number }).y); }
  }
  const out = (h >>> 0).toString(36);
  arrayHashes.set(arr, out);
  return out;
}

/** Keys that change a stroke's pixels beyond the v1 set. Time-range keys are
 *  absent on purpose: a resolved frame already dropped hidden strokes. */
const V2_PIXEL_KEYS = [
  'start', 'end', 'angle', 'roundness', 'spacing', 'flow', 'channels', 'blend', 'eraseMode', 'eraseTargetId',
  'dynamics', 'transform', 'cloneSourceId', 'cloneTime', 'cloneSourceW', 'cloneSourceH',
] as const;

function strokeSignature(s: PaintStroke): string {
  const hit = strokeSigs.get(s);
  if (hit !== undefined) return hit;
  let sig = `${s.id}:${s.mode}:${s.color}:${s.size}:${s.opacity}:${s.hardness}`
    + `:${s.cloneOffsetX ?? ''},${s.cloneOffsetY ?? ''}:${s.points.length}:${hashNumbers(s.points)}`;
  // v1 strokes keep the exact v1 key; v2 options append.
  const extra: Record<string, unknown> = {};
  let any = false;
  for (const k of V2_PIXEL_KEYS) {
    if (s[k] !== undefined) { extra[k] = s[k]; any = true; }
  }
  if (any) sig += `|${JSON.stringify(extra)}`;
  if (s.pressure) sig += `|p${hashNumbers(s.pressure)}`;
  if (s.tiltX) sig += `|tx${hashNumbers(s.tiltX)}`;
  if (s.tiltY) sig += `|ty${hashNumbers(s.tiltY)}`;
  strokeSigs.set(s, sig);
  return sig;
}

/** A compact cache-key term for a layer's paint ('' when it has none). */
export function paintSignature(paint: PaintConfig | null | undefined): string {
  if (!paint) return '';
  const body = hasPaintStrokes(paint) ? paint.strokes.map(strokeSignature).join(';') : '';
  return paint.onTransparent ? `T;${body}` : body;
}

// ── Scratch canvases & tip stamps ──────────────────────────────────────

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Grow-only scratch per role: a pass allocates a few canvases once, not a
 *  full-size canvas per stroke per frame. */
const scratch = new Map<string, HTMLCanvasElement>();

function scratchCanvas(role: 'stroke' | 'eraser' | 'tmp', w: number, h: number): CanvasRenderingContext2D | null {
  let c = scratch.get(role);
  if (!c || c.width < w || c.height < h) {
    c = newCanvas(Math.max(w, c?.width ?? 0), Math.max(h, c?.height ?? 0));
    scratch.set(role, c);
  }
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

const DEG = Math.PI / 180;
const STAMP_CACHE_MAX = 128;
const stamps = new Map<string, HTMLCanvasElement>();

/** Quantised stamp parameters and their cache key. Exported for tests. */
export function dabStampKey(diameterPx: number, hardness: number, roundness: number, angleDeg: number): {
  key: string; d: number; h: number; r: number; a: number;
} {
  const d = diameterPx < 8 ? Math.max(1, Math.round(diameterPx * 4) / 4) : Math.round(diameterPx);
  const h = Math.round(Math.max(0, Math.min(1, hardness)) * 100) / 100;
  const r = Math.round(Math.max(0.01, Math.min(1, roundness)) * 100) / 100;
  // An ellipse repeats every 180°, and a round tip has no angle at all.
  const a = r >= 1 ? 0 : (((Math.round(angleDeg) % 180) + 180) % 180);
  return { key: `${d}|${h}|${r}|${a}`, d, h, r, a };
}

/** Number of stamps currently cached (tests). */
export function dabStampCacheSize(): number {
  return stamps.size;
}

function getStamp(diameterPx: number, hardness: number, roundness: number, angleDeg: number): HTMLCanvasElement | null {
  const q = dabStampKey(diameterPx, hardness, roundness, angleDeg);
  const hit = stamps.get(q.key);
  if (hit) {
    // LRU touch.
    stamps.delete(q.key);
    stamps.set(q.key, hit);
    return hit;
  }
  const size = Math.ceil(q.d) + 2;
  const c = newCanvas(size, size);
  const sc = c.getContext('2d');
  if (!sc) return null;
  sc.translate(size / 2, size / 2);
  sc.rotate(q.a * DEG);
  sc.scale(1, q.r);
  sc.beginPath();
  sc.arc(0, 0, q.d / 2, 0, Math.PI * 2);
  if (q.h >= 0.999) {
    sc.fillStyle = '#fff';
  } else {
    // Solid core to Hardness, then a smoothstep falloff to the rim.
    const g = sc.createRadialGradient(0, 0, 0, 0, 0, q.d / 2);
    const ramp = (f: number): number => q.h + (1 - q.h) * f;
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(ramp(0), 'rgba(255,255,255,1)');
    g.addColorStop(ramp(0.25), 'rgba(255,255,255,0.844)');
    g.addColorStop(ramp(0.5), 'rgba(255,255,255,0.5)');
    g.addColorStop(ramp(0.75), 'rgba(255,255,255,0.156)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    sc.fillStyle = g;
  }
  sc.fill();
  stamps.set(q.key, c);
  if (stamps.size > STAMP_CACHE_MAX) {
    const oldest = stamps.keys().next().value;
    if (oldest !== undefined) stamps.delete(oldest);
  }
  return c;
}

// ── Compositing rules (pure) ───────────────────────────────────────────

/** AE Mode → canvas composite operation. */
export function blendOp(blend: PaintBlend | undefined): GlobalCompositeOperation {
  if (!blend || blend === 'normal') return 'source-over';
  if (blend === 'add') return 'lighter';
  return blend as GlobalCompositeOperation;
}

/** Can the stroke take the v1 direct pass? */
export function isDirectStroke(s: Stroke): boolean {
  if (usesDabs(s)) return false;
  if ((s.start ?? 0) > 0 || (s.end ?? 1) < 1) return false;
  if (hasStrokeTransform(s.transform)) return false;
  if (s.channels && s.channels !== 'rgba') return false;
  if (s.blend && s.blend !== 'normal') return false;
  if (s.mode === 'clone' && (s.cloneSourceId || s.cloneTime !== undefined)) return false;
  // Paint Only erasers draw direct too — onto the paint layer; only Last Stroke
  // Only needs the target stroke's buffer.
  if (s.mode === 'erase' && s.eraseMode === 'lastStroke') return false;
  return true;
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return 1;
  const n = parseInt(m[1]!, 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

// ── Drawing ────────────────────────────────────────────────────────────

/** A clone source other than the target's own pre-paint pixels. */
export interface CloneSourceImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

export interface PaintEnv {
  /**
   * The picture a clone stroke samples when it names another layer, or asks
   * for its own layer at another time. `layerId` undefined = this layer.
   * Null when the host cannot supply it — the stroke then falls back to this
   * layer's current pixels (self) or draws nothing (another layer).
   */
  cloneSource?: (layerId: string | undefined, time: number | undefined) => CloneSourceImage | null;
}

function snapshotOf(ctx: CanvasRenderingContext2D): HTMLCanvasElement | null {
  const snap = newCanvas(ctx.canvas.width, ctx.canvas.height);
  const sc = snap.getContext('2d');
  if (!sc) return null;
  sc.drawImage(ctx.canvas, 0, 0);
  return snap;
}

/**
 * Composite a layer's paint onto `ctx` in its current (layer-local) transform.
 *
 * Self-clone strokes sample the layer's content BENEATH the paint — one
 * snapshot before any stroke lands, shared by every clone stroke, so a clone
 * cannot recursively pick up earlier paint (matching AE's Clone Stamp sampling
 * the source frame, and keeping the pass order-stable).
 */
export function drawPaint(ctx: CanvasRenderingContext2D, paint: PaintConfig | null | undefined, env?: PaintEnv): void {
  if (!paint) return;
  const strokes = paint.strokes ?? [];
  if (strokes.length === 0 && !paint.onTransparent) return;
  const selfClone = strokes.some((s) => s.mode === 'clone' && !s.cloneSourceId);
  const source = selfClone || paint.onTransparent ? snapshotOf(ctx) : null;
  if (paint.onTransparent) {
    // Paint On Transparent: the layer's own pixels leave the picture; clone
    // strokes still sample them through the snapshot.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }
  renderStrokes(ctx, strokes, source, env);
}

/** v1 entry point, kept for callers holding a bare stroke list. */
export function drawPaintStrokes(ctx: CanvasRenderingContext2D, strokes: ReadonlyArray<Stroke>, env?: PaintEnv): void {
  if (!strokes || strokes.length === 0) return;
  drawPaint(ctx, { strokes: strokes as Stroke[] }, env);
}

function renderStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: ReadonlyArray<Stroke>,
  source: HTMLCanvasElement | null,
  env: PaintEnv | undefined,
): void {
  const k = deviceScaleOf(ctx);

  // Last Stroke Only erasers cut their target inside its own buffer.
  const index = new Map<string, number>();
  strokes.forEach((s, i) => index.set(s.id, i));
  const targeted = new Map<string, Stroke[]>();
  strokes.forEach((s, i) => {
    if (s.mode !== 'erase' || s.eraseMode !== 'lastStroke' || !s.eraseTargetId) return;
    const ti = index.get(s.eraseTargetId);
    if (ti === undefined || ti >= i) return;
    const list = targeted.get(s.eraseTargetId) ?? [];
    list.push(s);
    targeted.set(s.eraseTargetId, list);
  });

  // Paint Only erasers need the paint kept apart from the layer's source.
  const paintOnly = strokes.some((s) => s.mode === 'erase' && s.eraseMode === 'paintOnly');
  let paintCanvas: HTMLCanvasElement | null = null;
  let pctx: CanvasRenderingContext2D = ctx;
  if (paintOnly) {
    paintCanvas = newCanvas(ctx.canvas.width, ctx.canvas.height);
    const c = paintCanvas.getContext('2d');
    if (c) {
      pctx = c;
      if (typeof ctx.getTransform === 'function') pctx.setTransform(ctx.getTransform());
    } else {
      paintCanvas = null;
    }
  }

  ctx.save();
  for (const s of strokes) {
    if (s.points.length === 0 || s.size <= 0 || s.opacity <= 0) continue;
    if (s.mode === 'erase' && s.eraseMode === 'lastStroke') continue;
    const erasers = targeted.get(s.id);
    // Channel-restricted paint edits the layer's own channels, not the paint layer.
    const dest = s.mode === 'erase'
      ? (s.eraseMode === 'paintOnly' ? pctx : ctx)
      : s.channels && s.channels !== 'rgba' ? ctx : pctx;
    const both = s.mode === 'erase' && s.eraseMode !== 'paintOnly' && pctx !== ctx;

    if (isDirectStroke(s) && !erasers) {
      if (s.mode === 'clone') {
        drawCloneStroke(dest, s, source, k);
        continue;
      }
      drawDirect(dest, s, k);
      if (both) drawDirect(pctx, s, k);
      continue;
    }
    const buf = strokeBuffer(ctx, s, k, source, env, erasers);
    if (!buf) continue;
    composite(dest, buf, s);
    if (both) composite(pctx, buf, s);
  }
  ctx.filter = 'none';
  ctx.restore();

  if (paintCanvas) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.drawImage(paintCanvas, 0, 0);
    ctx.restore();
  }
}

/** The v1 pass for one paint/erase stroke. Unchanged, state writes included. */
function drawDirect(ctx: CanvasRenderingContext2D, s: Stroke, k: number): void {
  ctx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
  ctx.globalAlpha = Math.max(0, Math.min(1, s.opacity));
  ctx.strokeStyle = s.mode === 'erase' ? '#000' : s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.filter = paintBlurFilter(s, k);
  traceStroke(ctx, s.points, s.size);
}

/** A dab for a single point, else the polyline — filled/stroked with whatever
 *  style the caller set. */
function traceStroke(ctx: CanvasRenderingContext2D, points: ReadonlyArray<{ x: number; y: number }>, size: number): void {
  ctx.beginPath();
  if (points.length === 1) {
    const p = points[0]!;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
  ctx.stroke();
}

/**
 * One v1 clone stroke: the snapshot shifted by the clone offset, clipped to the
 * stroke's own shape, composited at the stroke's opacity.
 *
 * All the canvas work happens in DEVICE space so the snapshot lines up with
 * the target pixel-for-pixel; the LOCAL offset is carried across by mapping
 * it through the context's current transform (linear part only — an offset
 * is a vector, not a point).
 */
function drawCloneStroke(
  ctx: CanvasRenderingContext2D,
  s: Stroke,
  source: HTMLCanvasElement | null,
  k: number,
): void {
  if (!source) return;
  try {
    const m = ctx.getTransform();
    const ox = s.cloneOffsetX ?? 0;
    const oy = s.cloneOffsetY ?? 0;
    const devX = m.a * ox + m.c * oy;
    const devY = m.b * ox + m.d * oy;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    // Stroke-shaped alpha mask, drawn under the SAME transform.
    const mask = newCanvas(w, h);
    const mc = mask.getContext('2d');
    if (!mc) return;
    mc.setTransform(m);
    mc.strokeStyle = '#fff';
    mc.lineWidth = s.size;
    mc.lineCap = 'round';
    mc.lineJoin = 'round';
    mc.filter = paintBlurFilter(s, k);
    traceStroke(mc, s.points, s.size);

    // Shifted content, clipped to the mask. Sampling FROM p+offset and
    // painting AT p means drawing the snapshot moved by −offset.
    const fill = newCanvas(w, h);
    const fc = fill.getContext('2d');
    if (!fc) return;
    fc.drawImage(source, -devX, -devY);
    fc.globalCompositeOperation = 'destination-in';
    fc.drawImage(mask, 0, 0);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.max(0, Math.min(1, s.opacity));
    ctx.filter = 'none';
    ctx.drawImage(fill, 0, 0);
    ctx.restore();
  } catch {
    // A lost context or unreadable snapshot: skip the stroke rather than
    // aborting the whole paint pass.
  }
}

interface Buffer {
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  w: number;
  h: number;
}

function ctxMatrix(ctx: CanvasRenderingContext2D): Affine {
  if (typeof ctx.getTransform !== 'function') return [1, 0, 0, 1, 0, 0];
  const m = ctx.getTransform();
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

/** a ∘ b (apply b first). */
function mul(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** The stroke's local → device matrix under `ctx`. Exported for tests. */
export function strokeDeviceMatrix(ctxM: Affine, s: Pick<PaintStroke, 'transform'>): Affine {
  return hasStrokeTransform(s.transform) ? mul(ctxM, strokeTransformMatrix(s.transform)) : ctxM;
}

/** Device bounds of a stroke's coverage, clipped to the canvas; null when empty. */
function deviceBounds(s: Stroke, M: Affine, kk: number, cw: number, ch: number): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.points) {
    const x = M[0] * p.x + M[2] * p.y + M[4];
    const y = M[1] * p.x + M[3] * p.y + M[5];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const reach = (s.size / 2 + 3 * paintBlurSigma(s)) * kk + 2;
  const x0 = Math.max(0, Math.floor(minX - reach));
  const y0 = Math.max(0, Math.floor(minY - reach));
  const x1 = Math.min(cw, Math.ceil(maxX + reach));
  const y1 = Math.min(ch, Math.ceil(maxY + reach));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Draw a stroke's white coverage into `bctx` (whose pixel 0,0 is device bx,by). */
function drawCoverage(bctx: CanvasRenderingContext2D, s: Stroke, M: Affine, bx: number, by: number): void {
  const kk = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || 1;
  if (usesDabs(s)) {
    const rot = Math.atan2(M[1], M[0]) / DEG;
    // A local step of half a device pixel at most — finer adds nothing.
    for (const d of strokeDabs(s, 0.5 / kk)) {
      const px = d.size * kk;
      if (px <= 0 || d.alpha <= 0) continue;
      const stamp = getStamp(px, s.hardness, d.roundness, d.angle + rot);
      if (!stamp) continue;
      // A tip under a device pixel lays down its AREA's worth, not a whole pixel.
      bctx.globalAlpha = Math.max(0, Math.min(1, d.alpha * (px < 1 ? px * px : 1)));
      const x = M[0] * d.x + M[2] * d.y + M[4] - bx;
      const y = M[1] * d.x + M[3] * d.y + M[5] - by;
      bctx.drawImage(stamp, x - stamp.width / 2, y - stamp.height / 2);
    }
    bctx.globalAlpha = 1;
    return;
  }
  const pts = trimPolyline(s.points, s.start ?? 0, s.end ?? 1);
  if (!pts) return;
  bctx.save();
  bctx.setTransform(M[0], M[1], M[2], M[3], M[4] - bx, M[5] - by);
  bctx.strokeStyle = '#fff';
  bctx.lineWidth = s.size;
  bctx.lineCap = 'round';
  bctx.lineJoin = 'round';
  bctx.filter = paintBlurFilter(s, kk);
  traceStroke(bctx, pts, s.size);
  bctx.restore();
}

/** Build one stroke's filled buffer (coverage → erasers → colour/clone). */
function strokeBuffer(
  target: CanvasRenderingContext2D,
  s: Stroke,
  k: number,
  source: HTMLCanvasElement | null,
  env: PaintEnv | undefined,
  erasers: ReadonlyArray<Stroke> | undefined,
): Buffer | null {
  try {
    const m = ctxMatrix(target);
    const M = strokeDeviceMatrix(m, s);
    const kk = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || k;
    const b = deviceBounds(s, M, kk, target.canvas.width, target.canvas.height);
    if (!b) return null;
    const bctx = scratchCanvas('stroke', b.w, b.h);
    if (!bctx) return null;
    drawCoverage(bctx, s, M, b.x, b.y);

    for (const e of erasers ?? []) {
      const ectx = scratchCanvas('eraser', b.w, b.h);
      if (!ectx) break;
      drawCoverage(ectx, e, strokeDeviceMatrix(m, e), b.x, b.y);
      bctx.globalCompositeOperation = 'destination-out';
      bctx.globalAlpha = Math.max(0, Math.min(1, e.opacity));
      bctx.drawImage(ectx.canvas, 0, 0, b.w, b.h, 0, 0, b.w, b.h);
      bctx.globalAlpha = 1;
    }

    if (s.mode !== 'erase') {
      bctx.globalCompositeOperation = 'source-in';
      if (s.mode === 'paint') {
        bctx.fillStyle = s.color;
        bctx.fillRect(0, 0, b.w, b.h);
      } else if (!fillClone(bctx, s, m, b, source, env)) {
        return null;
      }
      bctx.globalCompositeOperation = 'source-over';
    }
    return { ctx: bctx, ...b };
  } catch {
    return null;
  }
}

/** Fill a clone stroke's coverage with its source. False when there is none. */
function fillClone(
  bctx: CanvasRenderingContext2D,
  s: Stroke,
  m: Affine,
  b: { x: number; y: number; w: number; h: number },
  source: HTMLCanvasElement | null,
  env: PaintEnv | undefined,
): boolean {
  const ox = s.cloneOffsetX ?? 0;
  const oy = s.cloneOffsetY ?? 0;
  const wantsEnv = !!s.cloneSourceId || s.cloneTime !== undefined;
  const img = wantsEnv ? env?.cloneSource?.(s.cloneSourceId, s.cloneTime) ?? null : null;
  if (img) {
    const w = s.cloneSourceW ?? img.width;
    const h = s.cloneSourceH ?? img.height;
    bctx.save();
    bctx.setTransform(m[0], m[1], m[2], m[3], m[4] - b.x, m[5] - b.y);
    bctx.translate(-ox, -oy);
    bctx.drawImage(img.image, -w / 2, -h / 2, w, h);
    bctx.restore();
    return true;
  }
  if (s.cloneSourceId || !source) return false;
  const devX = m[0] * ox + m[2] * oy;
  const devY = m[1] * ox + m[3] * oy;
  bctx.drawImage(source, -(b.x + devX), -(b.y + devY));
  return true;
}

/** Composite a filled buffer at the stroke's Opacity, Mode and Channels. */
function composite(dest: CanvasRenderingContext2D, buf: Buffer, s: Stroke): void {
  const opacity = Math.max(0, Math.min(1, s.opacity));
  dest.save();
  dest.setTransform(1, 0, 0, 1, 0, 0);
  dest.filter = 'none';
  const src = buf.ctx.canvas;
  const draw = (): void => dest.drawImage(src, 0, 0, buf.w, buf.h, buf.x, buf.y, buf.w, buf.h);
  if (s.mode === 'erase') {
    dest.globalCompositeOperation = 'destination-out';
    dest.globalAlpha = opacity;
    draw();
  } else if (s.channels === 'alpha') {
    // Alpha only: the brush's luminance is the alpha it paints toward. Black
    // clears, white leaves the layer as it is (there is no hidden colour to
    // bring back once a pixel is transparent).
    const cut = opacity * (1 - (s.mode === 'clone' ? 1 : luminance(s.color)));
    if (cut > 0) {
      dest.globalCompositeOperation = 'destination-out';
      dest.globalAlpha = cut;
      draw();
    }
  } else if (s.channels === 'rgb') {
    // Colour only, the layer's alpha untouched.
    const op = blendOp(s.blend);
    if (op === 'source-over') {
      dest.globalCompositeOperation = 'source-atop';
      dest.globalAlpha = opacity;
      draw();
    } else {
      const tctx = scratchCanvas('tmp', buf.w, buf.h);
      if (tctx) {
        tctx.drawImage(dest.canvas, buf.x, buf.y, buf.w, buf.h, 0, 0, buf.w, buf.h);
        tctx.globalCompositeOperation = op;
        tctx.globalAlpha = opacity;
        tctx.drawImage(src, 0, 0, buf.w, buf.h, 0, 0, buf.w, buf.h);
        dest.globalCompositeOperation = 'source-atop';
        dest.globalAlpha = 1;
        dest.drawImage(tctx.canvas, 0, 0, buf.w, buf.h, buf.x, buf.y, buf.w, buf.h);
      }
    }
  } else {
    dest.globalCompositeOperation = blendOp(s.blend);
    dest.globalAlpha = opacity;
    draw();
  }
  dest.restore();
}
