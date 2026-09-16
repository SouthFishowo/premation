/**
 * Brush-dab painting shared by the path-following PAINT effects — AE's Stroke,
 * Write-on (brush form) and Scribble.
 *
 * All three are the same machine in After Effects: a round brush with a Size
 * and a Hardness is stamped repeatedly (along a mask, along a keyframed
 * position, along a generated zig-zag) and the result is composited onto the
 * layer by a Paint Style. Written once here so the three agree on what a dab
 * looks like, how overlapping dabs combine and what "Reveal Original Image"
 * means — three private copies would drift on exactly the details (the soft
 * rim, the build-up) a side-by-side comparison with AE shows first.
 *
 * Pure `Uint8ClampedArray` / `Float32Array` maths, no canvas, so the kernels
 * are testable in jest and identical in preview and export.
 */

import type { MaskMode, MaskPath } from './mask';
import { maskPathPolyline } from './mask';
import type { EffectParams } from './effects';

export interface PaintPoint {
  x: number;
  y: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── Paint Style / Composite ──────────────────────────────────────────

/**
 * AE's three Paint Style (Stroke, Write-on) / Composite (Scribble) choices, in
 * AE's menu order. Stored as the enum NUMBER, so the order is part of the file
 * format — append, never reorder.
 */
export const PAINT_STYLE = {
  onOriginal: 0,
  onTransparent: 1,
  revealOriginal: 2,
} as const;

export const PAINT_STYLE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: PAINT_STYLE.onOriginal, label: 'On Original Image' },
  { value: PAINT_STYLE.onTransparent, label: 'On Transparent' },
  { value: PAINT_STYLE.revealOriginal, label: 'Reveal Original Image' },
];

// ── The dab ──────────────────────────────────────────────────────────

/**
 * Coverage of one round dab at distance `d` from its centre, 0..1.
 *
 * Hardness is the fraction of the radius that is solid; the rest falls off on
 * a smoothstep, which is the profile AE's brushes read as (a linear ramp shows
 * a visible cone on a dark ground). At full hardness the soft band is thinner
 * than a pixel, so the rim is antialiased over one pixel instead — without that
 * a 100 %-hard brush stair-steps.
 */
export function dabCoverage(d: number, radius: number, hardness01: number): number {
  const r = Math.max(0, radius);
  if (d >= r + 0.5) return 0;
  const inner = clamp01(hardness01) * r;
  const soft = r - inner;
  if (soft < 1) return clamp01(r + 0.5 - d);
  if (d <= inner) return 1;
  if (d >= r) return 0;
  const t = (d - inner) / soft;
  return 1 - t * t * (3 - 2 * t);
}

/**
 * The accumulated paint of one effect: straight colour plus alpha per pixel.
 *
 * Dabs combine by MAX alpha, with colour dragged toward the newest dab by its
 * coverage. Plain source-over would build a soft brush up into a dark core
 * wherever dabs overlap — at 15 % spacing that is every pixel — and the stroke
 * would read several times more opaque than its Opacity says. AE's Stroke holds
 * its opacity along the line, which is what max gives, while a later dab of a
 * different colour (Write-on's Paint Time Properties: Color) still paints over
 * an earlier one.
 */
export class PaintBuffer {
  readonly a: Float32Array;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;

  constructor(readonly w: number, readonly h: number) {
    const n = Math.max(0, w * h);
    this.a = new Float32Array(n);
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
  }

  /** Lay `coverage` (0..1, before opacity) of colour `rgb` at `opacity01` on pixel `i`. */
  paint(i: number, coverage: number, opacity01: number, rgb: readonly [number, number, number]): void {
    if (coverage <= 0) return;
    const na = coverage * opacity01;
    const oa = this.a[i]!;
    if (oa <= 0) {
      this.r[i] = rgb[0]; this.g[i] = rgb[1]; this.b[i] = rgb[2];
    } else {
      const k = clamp01(coverage);
      this.r[i] = this.r[i]! + (rgb[0] - this.r[i]!) * k;
      this.g[i] = this.g[i]! + (rgb[1] - this.g[i]!) * k;
      this.b[i] = this.b[i]! + (rgb[2] - this.b[i]!) * k;
    }
    if (na > oa) this.a[i] = na;
  }

  /** Stamp one round dab. `diameter` in px; hardness and opacity 0..1. */
  stampDab(
    cx: number, cy: number, diameter: number, hardness01: number, opacity01: number,
    rgb: readonly [number, number, number],
  ): void {
    const rad = Math.max(0.25, diameter / 2);
    if (opacity01 <= 0) return;
    const x0 = Math.max(0, Math.floor(cx - rad - 1));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + rad + 1));
    const y0 = Math.max(0, Math.floor(cy - rad - 1));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + rad + 1));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const cov = dabCoverage(Math.hypot(x + 0.5 - cx, dy), rad, hardness01);
        if (cov > 0) this.paint(y * this.w + x, cov, opacity01, rgb);
      }
    }
  }
}

/**
 * Composite the paint onto the layer by Paint Style.
 *
 *   On Original Image      paint OVER the layer (straight-alpha source-over)
 *   On Transparent         the paint alone; the layer is discarded
 *   Reveal Original Image  the layer, visible only where painted — the paint's
 *                          alpha becomes the layer's matte and its colour is
 *                          ignored, which is how AE's write-on reveals work
 *
 * `opacity01` scales the whole paint once, AFTER accumulation, so Opacity is a
 * property of the stroke rather than of each dab.
 */
export function compositePaint(
  src: Uint8ClampedArray,
  buf: PaintBuffer,
  style: number,
  opacity01: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const op = clamp01(opacity01);
  const n = Math.min(buf.a.length, src.length >> 2);
  const mode = Math.round(style);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const pa = buf.a[i]! * op;
    if (mode === PAINT_STYLE.onTransparent) {
      out[o] = buf.r[i]!; out[o + 1] = buf.g[i]!; out[o + 2] = buf.b[i]!;
      out[o + 3] = pa * 255;
      continue;
    }
    if (mode === PAINT_STYLE.revealOriginal) {
      out[o] = src[o]!; out[o + 1] = src[o + 1]!; out[o + 2] = src[o + 2]!;
      out[o + 3] = src[o + 3]! * pa;
      continue;
    }
    const da = src[o + 3]! / 255;
    if (pa <= 0) {
      out[o] = src[o]!; out[o + 1] = src[o + 1]!; out[o + 2] = src[o + 2]!; out[o + 3] = src[o + 3]!;
      continue;
    }
    const oa = pa + da * (1 - pa);
    out[o] = (buf.r[i]! * pa + src[o]! * da * (1 - pa)) / oa;
    out[o + 1] = (buf.g[i]! * pa + src[o + 1]! * da * (1 - pa)) / oa;
    out[o + 2] = (buf.b[i]! * pa + src[o + 2]! * da * (1 - pa)) / oa;
    out[o + 3] = oa * 255;
  }
  return out;
}

// ── Walking a polyline ───────────────────────────────────────────────

/** Arc length of a polyline, including the closing edge when `closed`. */
export function polylineLength(pts: ReadonlyArray<PaintPoint>, closed: boolean): number {
  const n = pts.length;
  if (n < 2) return 0;
  let acc = 0;
  for (let i = 1; i < n; i++) acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  if (closed) acc += Math.hypot(pts[0]!.x - pts[n - 1]!.x, pts[0]!.y - pts[n - 1]!.y);
  return acc;
}

/**
 * Visit points every `step` px of arc from `s0` to `s1` along a polyline, and
 * once more at `s1` itself when the last regular visit fell short of it.
 *
 * A cursor walk over the segments rather than a `pointAtArc` per visit: that is
 * linear in the vertex count PER CALL, and a traced mask (hundreds of vertices,
 * sixteen samples each) under a 15 %-spacing brush is tens of thousands of dabs
 * — quadratic would be seconds per frame.
 *
 * The trailing visit is what puts a dab exactly on a path's end (and on Start =
 * End's single point), so the brush does not stop up to a spacing short of it.
 */
export function walkPolyline(
  pts: ReadonlyArray<PaintPoint>,
  closed: boolean,
  s0: number,
  s1: number,
  step: number,
  visit: (x: number, y: number, s: number) => void,
): void {
  const n = pts.length;
  if (n === 0 || s1 < s0) return;
  if (n === 1) { visit(pts[0]!.x, pts[0]!.y, 0); return; }
  const stride = Math.max(1e-3, step);
  const segCount = closed ? n : n - 1;
  let acc = 0;
  let next = s0;
  let last = -Infinity;
  let endX = pts[0]!.x;
  let endY = pts[0]!.y;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    while (next <= acc + len && next <= s1) {
      const f = len > 0 ? (next - acc) / len : 0;
      visit(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, next);
      last = next;
      next += stride;
    }
    if (s1 <= acc + len) {
      const f = len > 0 ? (s1 - acc) / len : 0;
      endX = a.x + (b.x - a.x) * f;
      endY = a.y + (b.y - a.y) * f;
      acc += len;
      break;
    }
    acc += len;
    endX = b.x;
    endY = b.y;
  }
  const end = Math.min(s1, acc);
  if (end >= s0 && end - last > stride * 0.25) visit(endX, endY, end);
}

// ── All the layer's masks, as one resolved param ─────────────────────

/** Mask modes in a fixed code order — the packed form stores the index. */
export const MASK_MODE_CODES: readonly MaskMode[] = ['none', 'add', 'subtract', 'intersect', 'lighten', 'darken', 'difference'];

/** Numbers per mask in `maskPathsMeta`: point count, closed, mode code, inverted. */
const META_STRIDE = 4;

export interface ResolvedMaskPath {
  /** Flattened outline in RASTER px (top-left origin). */
  points: PaintPoint[];
  closed: boolean;
  mode: MaskMode;
  inverted: boolean;
}

/**
 * Every mask path on a layer, flattened, in mask order — the hand-off from
 * `buildSnapshot` to the multi-mask effects (All Masks, Stroke Sequentially,
 * All Masks Using Modes).
 *
 * TWO arrays, deliberately. The coordinates are px and must scale with the
 * bake's raster scale (`scaleEffectLengths` multiplies a `resolved` param whose
 * unit is px, element-wise); the counts, flags and mode codes must not. One
 * interleaved array could only be scaled wrongly. Resolved params must also
 * survive JSON untouched, which rules out an array of objects.
 *
 * A path too short to flatten still gets its meta row (with zero points), so a
 * mask's INDEX in this list is its index in the layer's mask stack.
 */
export function packMaskPaths(
  paths: ReadonlyArray<MaskPath>,
  samplesPerSegment = 16,
): { meta: number[]; xy: number[] } {
  const meta: number[] = [];
  const xy: number[] = [];
  for (const p of paths) {
    const flat = maskPathPolyline(p, samplesPerSegment);
    meta.push(flat.length >> 1, p.closed ? 1 : 0, Math.max(0, MASK_MODE_CODES.indexOf(p.mode)), p.inverted ? 1 : 0);
    for (const v of flat) xy.push(v);
  }
  return { meta, xy };
}

/** The inverse of `packMaskPaths`, shifted from layer-centred to raster px. */
export function unpackMaskPaths(meta: unknown, xy: unknown, w: number, h: number): ResolvedMaskPath[] {
  if (!Array.isArray(meta) || !Array.isArray(xy)) return [];
  const out: ResolvedMaskPath[] = [];
  let o = 0;
  for (let i = 0; i + META_STRIDE <= meta.length; i += META_STRIDE) {
    const count = Math.max(0, Math.floor(Number(meta[i]) || 0));
    const points: PaintPoint[] = [];
    for (let k = 0; k < count; k++) {
      const x = xy[o + k * 2];
      const y = xy[o + k * 2 + 1];
      if (typeof x === 'number' && typeof y === 'number') points.push({ x: w / 2 + x, y: h / 2 + y });
    }
    o += count * 2;
    out.push({
      points,
      closed: meta[i + 1] === 1,
      mode: MASK_MODE_CODES[Math.floor(Number(meta[i + 2]) || 0)] ?? 'add',
      inverted: meta[i + 3] === 1,
    });
  }
  return out;
}

/**
 * Which effects need EVERY mask resolved per frame. Checked by `buildSnapshot`
 * before it pays for flattening the stack.
 *
 * Vegas only when All Masks is on: its single-path form is served by the older
 * `pathPoints` hand-off, and paying for the whole stack on every Vegas layer
 * would buy nothing.
 */
export function effectWantsAllMaskPaths(type: string, params: EffectParams): boolean {
  if (type === 'path-stroke' || type === 'scribble') return true;
  return type === 'vegas' && params.allMasks === true;
}

/**
 * The masks an effect with a Path/Mask picker and an All Masks switch draws on.
 *
 * `pathMaskIndex` is resolved beside the packed masks (−1 = the picked id is
 * not on the layer). An EMPTY pick means the first mask — AE's Stroke and
 * Scribble default their Path menu to Mask 1 the moment a mask exists, so an
 * unconfigured effect on a masked layer draws instead of doing nothing.
 */
export function pickMaskPaths(
  params: EffectParams,
  w: number,
  h: number,
  allMasks: boolean,
): ResolvedMaskPath[] {
  const masks = unpackMaskPaths(params.maskPathsMeta, params.maskPathsXY, w, h);
  if (allMasks) return masks.filter((m) => m.points.length >= 2);
  const id = typeof params.pathMaskId === 'string' ? params.pathMaskId : '';
  const idx = id === '' ? 0 : typeof params.pathMaskIndex === 'number' ? params.pathMaskIndex : -1;
  const m = idx >= 0 ? masks[idx] : undefined;
  return m && m.points.length >= 2 ? [m] : [];
}
