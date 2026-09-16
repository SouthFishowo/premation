/**
 * Stroke — AE's Generate ▸ Stroke: a brush dragged along one mask path, or all
 * of them.
 *
 * Not the `stroke` effect beside it in the registry. That one outlines the
 * layer's ALPHA (a Photoshop-style outline, labelled "Alpha Stroke"); this one
 * never looks at the pixels at all — its geometry is the mask, and its look is
 * a row of round dabs (Brush Size, Brush Hardness, Spacing as a percentage of
 * the brush), revealed by Start/End in percent of the path's arc length. With
 * a tracked or keyframed mask the stroke follows it per frame for free, because
 * `buildSnapshot` resolves the masks into the effect's params at each frame.
 *
 * Stroke Sequentially changes what Start/End measure when All Masks is on: off,
 * every mask is revealed over the same percentage at once; on, the masks are
 * one long path in mask order and the reveal travels from each into the next.
 */

import type { Effect } from './effects';
import { effectNumber, paramsOf } from './effects';
import {
  PaintBuffer, compositePaint, pickMaskPaths, polylineLength, walkPolyline, PAINT_STYLE,
  type PaintPoint,
} from './strokePaint';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Upper bound on dabs per frame. A full-frame traced mask at 0 % spacing would
 * otherwise ask for hundreds of thousands; past this the step is widened, which
 * a soft brush hides completely and a hard one shows only at 0-1 % spacing.
 */
export const PATH_STROKE_MAX_DABS = 200_000;

export interface PathStrokeOptions {
  rgb: readonly [number, number, number];
  /** Brush diameter, px. */
  brushSize: number;
  /** 0..100. */
  hardness: number;
  /** 0..100. */
  opacity: number;
  /** Percent of arc length, 0..100. */
  start: number;
  end: number;
  /** Dab step as a percentage of the brush size, 0..100. */
  spacing: number;
  paintStyle: number;
  /** Measure Start/End over all paths as one (true) or over each path (false). */
  sequential: boolean;
}

/** The step between dabs, px. Floored so 0 % spacing is dense, not infinite. */
export function dabStep(brushSize: number, spacingPct: number): number {
  return Math.max(0.5, (Math.max(0, spacingPct) / 100) * Math.max(0, brushSize));
}

/**
 * The stroke on a raw RGBA buffer. `paths` are in raster px.
 *
 * With nothing to draw the layer still goes through the Paint Style, as in AE:
 * On Transparent with Start = End is an empty frame, not the untouched layer.
 */
export function pathStrokeData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  paths: ReadonlyArray<{ points: ReadonlyArray<PaintPoint>; closed: boolean }>,
  o: PathStrokeOptions,
): Uint8ClampedArray {
  const style = Math.round(o.paintStyle);
  const opacity = clamp01(o.opacity / 100);
  const size = Math.max(0, o.brushSize);
  if (style === PAINT_STYLE.onOriginal && (opacity <= 0 || size <= 0 || paths.length === 0)) {
    return Uint8ClampedArray.from(src);
  }
  const buf = new PaintBuffer(w, h);
  const lo = clamp01(Math.min(o.start, o.end) / 100);
  const hi = clamp01(Math.max(o.start, o.end) / 100);
  const lengths = paths.map((p) => polylineLength(p.points, p.closed));
  const total = lengths.reduce((s, l) => s + l, 0);

  // Each path's drawn range in its OWN arc coordinates.
  const ranges: Array<[number, number]> = [];
  let base = 0;
  for (let i = 0; i < paths.length; i++) {
    const len = lengths[i]!;
    if (o.sequential) {
      ranges.push([Math.max(0, lo * total - base), Math.min(len, hi * total - base)]);
    } else {
      ranges.push([lo * len, hi * len]);
    }
    base += len;
  }
  let drawn = 0;
  for (const [a, b] of ranges) if (b >= a) drawn += b - a;
  const step = Math.max(dabStep(size, o.spacing), drawn / PATH_STROKE_MAX_DABS);
  const hardness = clamp01(o.hardness / 100);

  if (size > 0) {
    for (let i = 0; i < paths.length; i++) {
      const [a, b] = ranges[i]!;
      // An empty range draws nothing — including the zero-width one a mask gets
      // when a sequential reveal ends exactly where it begins.
      if (b <= a || lengths[i]! <= 0) continue;
      walkPolyline(paths[i]!.points, paths[i]!.closed, a, b, step, (x, y) => {
        buf.stampDab(x, y, size, hardness, 1, o.rgb);
      });
    }
  }
  return compositePaint(src, buf, style, opacity);
}

const str = (e: Effect, k: string, fb: string): string => {
  const v = paramsOf(e)[k];
  return typeof v === 'string' ? v : fb;
};

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The effect's settings off its params — shared by the kernel and its tests. */
export function pathStrokeOptions(e: Effect): PathStrokeOptions {
  return {
    rgb: hexRgb(str(e, 'color', '#ffffff')),
    brushSize: effectNumber(e, 'brushSize'),
    hardness: effectNumber(e, 'brushHardness'),
    opacity: effectNumber(e, 'opacity'),
    start: effectNumber(e, 'start'),
    end: effectNumber(e, 'end'),
    spacing: effectNumber(e, 'spacing'),
    paintStyle: effectNumber(e, 'paintStyle'),
    sequential: paramsOf(e).strokeSequentially === true,
  };
}

/** The whole effect on a buffer: pick the masks, then stroke them. */
export function pathStrokeEffectData(src: Uint8ClampedArray, w: number, h: number, e: Effect): Uint8ClampedArray {
  const p = paramsOf(e);
  const paths = pickMaskPaths(p, w, h, p.allMasks === true);
  return pathStrokeData(src, w, h, paths, pathStrokeOptions(e));
}
