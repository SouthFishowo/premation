/**
 * Write-on, brush form — AE's Generate ▸ Write-on.
 *
 * AE's Write-on is not a reveal along a line. It RECORDS A BRUSH: a round dab
 * is laid at Brush Position every Brush Spacing seconds from the start of the
 * layer up to the current frame, so keyframing (or motion-sketching, or
 * expression-driving) the position draws its motion path on screen. Stroke
 * Length keeps only the last N seconds of dabs, which turns the drawing into a
 * travelling snake. Paint / Brush Time Properties decide whether each dab keeps
 * the colour, opacity, size and hardness it had WHEN IT WAS LAID, or every dab
 * takes the current value.
 *
 * ── Why the history is resolved in buildSnapshot ────────────────────
 *
 * Every dab depends on the value of a keyframed property at a PAST time. The
 * kernel cannot sample the animation engine (it must stay a pure function of
 * its params, which is what keeps preview and export identical), so
 * `buildSnapshot` samples the tracks at the dab times and writes the result
 * into resolved params — the same hand-off Audio Spectrum's magnitudes and the
 * mask paths use. Positions and sizes travel in px-unit params, so the bake's
 * raster scale reaches them through `scaleEffectLengths` like any other length.
 *
 * The classic form this effect shipped with — a Start→End line or a mask path
 * revealed by Completion, with Wobble and Taper — is still here as Mode ▸
 * Classic Line / Path, and is what every document saved before the brush form
 * existed reads (see `writeOnMode` in the registry).
 */

import type { Effect, EffectParams } from './effects';
import { effectNumber, effectPropPath, paramsOf } from './effects';
import { PaintBuffer, compositePaint } from './strokePaint';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** `writeOnMode` values. Stored numbers: append, never reorder. */
export const WRITE_ON_MODE = { brush: 0, classic: 1 } as const;
/** AE's Paint Time Properties menu. */
export const PAINT_TIME_PROPS = { none: 0, opacity: 1, color: 2 } as const;
/** AE's Brush Time Properties menu. */
export const BRUSH_TIME_PROPS = { none: 0, size: 1, hardness: 2, sizeAndHardness: 3 } as const;

/**
 * Most dabs resolved per frame. A 60-second stroke at AE's default 0.001 s
 * spacing would be 60 000 animation samples a frame; past this the samples are
 * spread evenly over the stroke instead, and the kernel fills the gaps between
 * them (`brushTrailFilled`) so the line stays continuous.
 */
export const WRITE_ON_MAX_TRAIL = 2048;

/** Numbers per dab in `brushTrailAttr`: hardness %, opacity %, r, g, b (0..255). */
export const TRAIL_ATTR_STRIDE = 5;

/** Is this Write-on the AE brush form? Reads params through the registry default. */
export function writeOnUsesBrush(params: EffectParams): boolean {
  return typeof params.writeOnMode === 'number' && Math.round(params.writeOnMode) === WRITE_ON_MODE.brush;
}

export interface WriteOnTrail {
  /** Dab positions, layer-centred px, flat [x0, y0, x1, y1, …]. */
  xy: number[];
  /** Dab diameters, px. */
  size: number[];
  /** Per dab: hardness %, opacity %, r, g, b. */
  attr: number[];
  /** True when the samples were thinned and the kernel should fill between them. */
  filled: boolean;
}

function hexRgb(hex: unknown): [number, number, number] {
  const m = typeof hex === 'string' ? /^#?([0-9a-f]{6})/i.exec(hex.trim()) : null;
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The dab history at `layerTimeSec`, sampled from the effect's tracks.
 *
 * Dab times sit on a FIXED grid of Brush Spacing multiples rather than being
 * counted back from the playhead: counted from the playhead, every dab would
 * move a little each frame and the drawn line would shimmer as it grows.
 *
 * `earliestSec` is where the recording starts — the node's first keyframe, so a
 * layer whose brush sits still until its first key does not spend its sample
 * budget stacking dabs on one point. An unanimated brush is one dab.
 */
export function resolveWriteOnTrail(
  effectId: string,
  params: EffectParams,
  layerTimeSec: number,
  sample: (prop: string, t: number) => number | undefined,
  isAnimated: (prop: string) => boolean,
  earliestSec: number | undefined,
): WriteOnTrail {
  const num = (k: string, fb: number): number => {
    const v = params[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : fb;
  };
  const staticRgb = hexRgb(params.brushColor);
  const track = (k: string): string | null => {
    const prop = effectPropPath(effectId, k);
    return isAnimated(prop) ? prop : null;
  };
  const px = track('brushPositionX');
  const py = track('brushPositionY');
  const ps = track('brushSize');
  const ph = track('brushHardness');
  const po = track('brushOpacity');
  const pc = [track('brushColor_r'), track('brushColor_g'), track('brushColor_b')] as const;

  const at = (t: number, out: WriteOnTrail): void => {
    const read = (prop: string | null, fb: number): number => (prop ? sample(prop, t) ?? fb : fb);
    out.xy.push(read(px, num('brushPositionX', 0)), read(py, num('brushPositionY', 0)));
    out.size.push(read(ps, num('brushSize', 8)));
    out.attr.push(
      read(ph, num('brushHardness', 75)),
      read(po, num('brushOpacity', 100)),
      pc[0] ? clamp01(sample(pc[0], t) ?? staticRgb[0] / 255) * 255 : staticRgb[0],
      pc[1] ? clamp01(sample(pc[1], t) ?? staticRgb[1] / 255) * 255 : staticRgb[1],
      pc[2] ? clamp01(sample(pc[2], t) ?? staticRgb[2] / 255) * 255 : staticRgb[2],
    );
  };

  const out: WriteOnTrail = { xy: [], size: [], attr: [], filled: false };
  if (!px && !py) {
    at(layerTimeSec, out);
    return out;
  }
  const spacing = Math.max(0.001, num('brushSpacing', 0.001));
  const length = Math.max(0, num('strokeLength', 0));
  const tEnd = layerTimeSec;
  let tStart = earliestSec !== undefined && Number.isFinite(earliestSec) ? earliestSec : tEnd;
  if (length > 0) tStart = Math.max(tStart, tEnd - length);
  tStart = Math.min(tStart, tEnd);

  const k0 = Math.ceil(tStart / spacing - 1e-9);
  const k1 = Math.floor(tEnd / spacing + 1e-9);
  const onGrid = Math.max(0, k1 - k0 + 1);
  if (onGrid + 1 > WRITE_ON_MAX_TRAIL) {
    out.filled = true;
    const n = WRITE_ON_MAX_TRAIL;
    for (let i = 0; i < n; i++) at(tStart + ((tEnd - tStart) * i) / (n - 1), out);
    return out;
  }
  for (let k = k0; k <= k1; k++) at(k * spacing, out);
  // The playhead's own dab, so the brush is drawn exactly where it is now.
  if (onGrid === 0 || tEnd - k1 * spacing > 1e-6) at(tEnd, out);
  return out;
}

export interface WriteOnBrushOptions {
  /** Current brush position, layer-centred px. */
  brushX: number;
  brushY: number;
  rgb: readonly [number, number, number];
  size: number;
  hardness: number;
  opacity: number;
  paintTimeProps: number;
  brushTimeProps: number;
  paintStyle: number;
}

/**
 * The brush on a raw RGBA buffer.
 *
 * Opacity is applied PER DAB only under Paint Time Properties ▸ Opacity; with
 * None the dabs are laid at full strength and the current Brush Opacity fades
 * the whole stroke at once, which is what makes an opacity keyframe fade a
 * finished drawing rather than leave a gradient along it.
 */
export function writeOnBrushData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  trail: WriteOnTrail,
  o: WriteOnBrushOptions,
): Uint8ClampedArray {
  const buf = new PaintBuffer(w, h);
  const perDabOpacity = Math.round(o.paintTimeProps) === PAINT_TIME_PROPS.opacity;
  const perDabColor = Math.round(o.paintTimeProps) === PAINT_TIME_PROPS.color;
  const bt = Math.round(o.brushTimeProps);
  const perDabSize = bt === BRUSH_TIME_PROPS.size || bt === BRUSH_TIME_PROPS.sizeAndHardness;
  const perDabHard = bt === BRUSH_TIME_PROPS.hardness || bt === BRUSH_TIME_PROPS.sizeAndHardness;

  interface Dab { x: number; y: number; size: number; hard: number; op: number; r: number; g: number; b: number }
  const dabs: Dab[] = [];
  const count = Math.floor(trail.xy.length / 2);
  for (let i = 0; i < count; i++) {
    const a = i * TRAIL_ATTR_STRIDE;
    dabs.push({
      x: w / 2 + trail.xy[i * 2]!,
      y: h / 2 + trail.xy[i * 2 + 1]!,
      size: perDabSize ? trail.size[i] ?? o.size : o.size,
      hard: perDabHard ? trail.attr[a] ?? o.hardness : o.hardness,
      op: perDabOpacity ? trail.attr[a + 1] ?? o.opacity : 100,
      r: perDabColor ? trail.attr[a + 2] ?? o.rgb[0] : o.rgb[0],
      g: perDabColor ? trail.attr[a + 3] ?? o.rgb[1] : o.rgb[1],
      b: perDabColor ? trail.attr[a + 4] ?? o.rgb[2] : o.rgb[2],
    });
  }
  if (dabs.length === 0) {
    dabs.push({ x: w / 2 + o.brushX, y: h / 2 + o.brushY, size: o.size, hard: o.hardness, op: 100, r: o.rgb[0], g: o.rgb[1], b: o.rgb[2] });
  }

  const stamp = (d: Dab): void => {
    if (d.size <= 0) return;
    buf.stampDab(d.x, d.y, d.size, clamp01(d.hard / 100), clamp01(d.op / 100), [d.r, d.g, d.b]);
  };
  for (let i = 0; i < dabs.length; i++) {
    const d = dabs[i]!;
    stamp(d);
    const next = dabs[i + 1];
    if (!trail.filled || !next) continue;
    // Thinned trail: fill the gap at a quarter of the brush, lerping every attribute.
    const gap = Math.hypot(next.x - d.x, next.y - d.y);
    const step = Math.max(0.5, Math.min(d.size, next.size) * 0.25);
    const n = Math.min(4096, Math.floor(gap / step));
    for (let k = 1; k < n; k++) {
      const f = k / n;
      const lerp = (p: number, q: number): number => p + (q - p) * f;
      stamp({
        x: lerp(d.x, next.x), y: lerp(d.y, next.y), size: lerp(d.size, next.size), hard: lerp(d.hard, next.hard),
        op: lerp(d.op, next.op), r: lerp(d.r, next.r), g: lerp(d.g, next.g), b: lerp(d.b, next.b),
      });
    }
  }
  return compositePaint(src, buf, o.paintStyle, perDabOpacity ? 1 : clamp01(o.opacity / 100));
}

/** The resolved trail off an effect's params. Empty when never resolved. */
function trailOf(p: EffectParams): WriteOnTrail {
  const arr = (v: unknown): number[] => (Array.isArray(v) ? (v as unknown[]).filter((x): x is number => typeof x === 'number') : []);
  return { xy: arr(p.brushTrailXY), size: arr(p.brushTrailSize), attr: arr(p.brushTrailAttr), filled: p.brushTrailFilled === 1 };
}

export function writeOnBrushEffectData(src: Uint8ClampedArray, w: number, h: number, e: Effect): Uint8ClampedArray {
  const p = paramsOf(e);
  return writeOnBrushData(src, w, h, trailOf(p), {
    brushX: effectNumber(e, 'brushPositionX'),
    brushY: effectNumber(e, 'brushPositionY'),
    rgb: hexRgb(p.brushColor),
    size: effectNumber(e, 'brushSize'),
    hardness: effectNumber(e, 'brushHardness'),
    opacity: effectNumber(e, 'brushOpacity'),
    paintTimeProps: effectNumber(e, 'paintTimeProps'),
    brushTimeProps: effectNumber(e, 'brushTimeProps'),
    paintStyle: effectNumber(e, 'paintStyle'),
  });
}
