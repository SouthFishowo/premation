/**
 * Gradient FILL on a text layer — one gradient across the whole text block.
 *
 * The gradient model is the shape layer's (`@core/paint/fill`): linear by
 * angle across the box, radial by relative centre and half-diagonal radius.
 * What is different about text is that the painter draws glyph by glyph under
 * per-glyph transforms, and a `CanvasGradient` lives in the user space of the
 * CURRENT transform at fill time — so a gradient built once would ride each
 * rotating, scaling glyph instead of staying put in layer space, which is the
 * difference between "a gradient over the title" and "every letter carries its
 * own copy of it".
 *
 * So the gradient is rendered once into an offscreen canvas covering the box
 * (plus a margin, so an animator can push a glyph past the edge and keep
 * sampling the pad colour), wrapped in a `CanvasPattern`, and before every
 * draw the pattern is given the matrix that maps its pixels back to box space
 * through whatever transform the glyph is under:
 *
 *     patternToUser = inverse(currentCTM) · boxCTM · translate(−margin) · scale(1/k)
 *
 * which is exact for any affine glyph transform (rotation, skew, non-uniform
 * scale — a linear gradient's perpendicular iso-lines survive all of them).
 *
 * Without a DOM (unit tests, a headless rasterizer) a plain gradient in box
 * coordinates is returned — correct for untransformed draws.
 */

import { makeCanvasGradient, type FillPaint, type LinearFill, type RadialFill } from '@core/paint/fill';

export function isGradientPaint(p: FillPaint | undefined | null): p is LinearFill | RadialFill {
  return !!p && (p.type === 'linear' || p.type === 'radial') && Array.isArray(p.stops) && p.stops.length > 0;
}

export type TextGradientGeometry =
  | { kind: 'linear'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'radial'; cx: number; cy: number; r: number };

/**
 * The gradient's geometry in the unpadded box (top-left origin, `w`×`h`) —
 * the same maths `makeCanvasGradient` uses with the origin at the box centre.
 */
export function textGradientGeometry(paint: LinearFill | RadialFill, w: number, h: number): TextGradientGeometry {
  if (paint.type === 'linear') {
    const a = (paint.angle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    return { kind: 'linear', x0: w / 2 - dx * half, y0: h / 2 - dy * half, x1: w / 2 + dx * half, y1: h / 2 + dy * half };
  }
  return { kind: 'radial', cx: paint.cx * w, cy: paint.cy * h, r: (Math.max(0.01, paint.radius) * Math.hypot(w, h)) / 2 };
}

/** A fill style valid under the context's transform at the moment it is asked for. */
export interface TextGradientFill {
  styleFor(ctx: CanvasRenderingContext2D): string | CanvasGradient | CanvasPattern;
}

/** Largest offscreen side, px — a 4K title's gradient does not need more. */
const MAX_SIDE = 4096;

/**
 * Build the block gradient. Call with the context in BOX space (the transform
 * the painter was handed, before any character-panel or fit scaling), and
 * `w`/`h` the unpadded box. Null when `paint` is not a gradient.
 */
export function createTextGradientFill(
  ctx: CanvasRenderingContext2D,
  paint: FillPaint | undefined,
  w: number,
  h: number,
): TextGradientFill | null {
  if (!isGradientPaint(paint) || !(w > 0) || !(h > 0)) return null;
  const base = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const canPattern =
    base && typeof document !== 'undefined' && typeof ctx.createPattern === 'function' && typeof DOMMatrix !== 'undefined';
  if (canPattern) {
    const margin = Math.max(w, h) / 2;
    const fullW = w + 2 * margin;
    const fullH = h + 2 * margin;
    // Device px per box px, so the ramp is as smooth as the glyphs it fills.
    const density = Math.max(1, Math.hypot(base.a, base.b), Math.hypot(base.c, base.d));
    const k = Math.min(density, MAX_SIDE / fullW, MAX_SIDE / fullH);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(fullW * k));
    canvas.height = Math.max(1, Math.round(fullH * k));
    const g = canvas.getContext('2d');
    if (g) {
      g.scale(canvas.width / fullW, canvas.height / fullH);
      g.translate(margin, margin);
      // Geometry is box-relative; the fill covers the margin too, where a
      // canvas gradient pads with its end colours.
      g.fillStyle = makeCanvasGradient(g, paint, w, h, w / 2, h / 2);
      g.fillRect(-margin, -margin, fullW, fullH);
    }
    // AFTER painting: Chromium snapshots the source canvas when the pattern is
    // CREATED, so a pattern made first is transparent forever (the first
    // golden of this feature rendered no text at all for exactly that reason).
    const pattern = g ? ctx.createPattern(canvas, 'no-repeat') : null;
    if (g && pattern && typeof pattern.setTransform === 'function') {
      const toBox = base.translate(-margin, -margin).scale(fullW / canvas.width, fullH / canvas.height);
      return {
        styleFor(cur) {
          pattern.setTransform(cur.getTransform().invertSelf().multiplySelf(toBox));
          return pattern;
        },
      };
    }
  }
  const grad = typeof ctx.createLinearGradient === 'function' ? makeCanvasGradient(ctx, paint, w, h, w / 2, h / 2) : null;
  const fallback = paint.stops[0]?.color ?? '#ffffff';
  return { styleFor: () => grad ?? fallback };
}
