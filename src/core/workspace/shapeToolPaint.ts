/**
 * AE's toolbar Fill and Stroke — the paint a NEWLY DRAWN shape takes.
 *
 * In After Effects the Fill / Stroke swatches beside the shape and pen tools do
 * not edit a layer; they are what the next rectangle, ellipse, polystar or pen
 * path is born with: None / Solid / Linear / Radial for each, plus the stroke
 * width. This module is that state and the two builders `makeNodeAt` asks.
 *
 * A plain mutable singleton, like `drawToolOptions`: the framework-free
 * creation path reads it at commit time, and the tool-options bar re-renders
 * itself. Not part of the document — a tool setting, not a layer property.
 *
 * ## The defaults ARE today's behaviour
 *
 * Before this existed every closed shape got a solid `#2b7eff` fill and no
 * stroke, and every open pen path the pencil bar's stroke. The defaults below
 * reproduce exactly that, so a user who never touches the swatches draws the
 * same layers as before — byte for byte, which the tests pin.
 */

import { linearFill, radialFill, type FillPaint } from '@core/paint/fill';
import { defaultStroke, type Stroke } from '@core/paint/stroke';

export type ToolPaintType = 'none' | 'solid' | 'linear' | 'radial';

export interface ShapeToolPaint {
  fillType: ToolPaintType;
  fillColor: string;
  strokeType: ToolPaintType;
  strokeColor: string;
  /** Layer-local px. */
  strokeWidth: number;
}

export const DEFAULT_SHAPE_TOOL_PAINT: Readonly<ShapeToolPaint> = {
  fillType: 'solid',
  fillColor: '#2b7eff',
  strokeType: 'none',
  strokeColor: '#ffffff',
  strokeWidth: 4,
};

/** The live toolbar state. Mutate through `setShapeToolPaint`. */
export const shapeToolPaint: ShapeToolPaint = { ...DEFAULT_SHAPE_TOOL_PAINT };

export function setShapeToolPaint(patch: Partial<ShapeToolPaint>): void {
  Object.assign(shapeToolPaint, patch);
  if (!(shapeToolPaint.strokeWidth >= 0)) shapeToolPaint.strokeWidth = 0;
}

/** Tools whose drawn result is a shape layer, and so show the Fill/Stroke swatches. */
export const SHAPE_PAINT_TOOLS: ReadonlySet<string> = new Set(['shape', 'ellipse', 'polygon', 'star', 'pen', 'curvature']);

/**
 * A new CLOSED shape's fill: the Style fill string every reader understands,
 * plus the `fx` gradient paint when the type is Linear/Radial (the Style string
 * is then the fallback colour, as for any gradient fill).
 */
export function newShapeFill(p: Readonly<ShapeToolPaint> = shapeToolPaint): { styleFill: string; paint?: FillPaint } {
  switch (p.fillType) {
    case 'none':
      return { styleFill: 'rgba(0,0,0,0)' };
    case 'linear':
      return { styleFill: p.fillColor, paint: linearFill(p.fillColor) };
    case 'radial':
      return { styleFill: p.fillColor, paint: radialFill(p.fillColor) };
    default:
      return { styleFill: p.fillColor };
  }
}

/**
 * A new shape's `fx` stroke, or undefined for None (or a zero width, which
 * draws nothing and would only leave a disabled-looking stroke to find later).
 * `open` gives an open path the round cap and join the pencil bar's strokes use.
 */
export function newShapeStroke(p: Readonly<ShapeToolPaint> = shapeToolPaint, open = false): Stroke | undefined {
  if (p.strokeType === 'none' || !(p.strokeWidth > 0)) return undefined;
  const base: Stroke = {
    ...defaultStroke(p.strokeColor),
    width: p.strokeWidth,
    ...(open ? { cap: 'round' as const, join: 'round' as const } : {}),
  };
  if (p.strokeType === 'solid') return base;
  return { ...base, paint: p.strokeType === 'linear' ? linearFill(p.strokeColor) : radialFill(p.strokeColor) };
}
