/**
 * The toolbar Fill / Stroke for new shapes.
 *
 * The load-bearing assertion is the first: with the swatches untouched, a new
 * shape gets EXACTLY what the creation path hard-coded before the toolbar
 * existed — a solid #2b7eff Style fill, no fx fill paint, no stroke.
 */

import {
  DEFAULT_SHAPE_TOOL_PAINT,
  SHAPE_PAINT_TOOLS,
  newShapeFill,
  newShapeStroke,
  setShapeToolPaint,
  shapeToolPaint,
} from './shapeToolPaint';

afterEach(() => setShapeToolPaint({ ...DEFAULT_SHAPE_TOOL_PAINT }));

describe('defaults reproduce the pre-toolbar shape', () => {
  it('solid #2b7eff fill, no gradient paint, no stroke', () => {
    expect(newShapeFill()).toEqual({ styleFill: '#2b7eff' });
    expect(newShapeStroke()).toBeUndefined();
    expect(newShapeStroke(undefined, true)).toBeUndefined();
  });

  it('the swatches show for the shape and pen tools only', () => {
    for (const tool of ['shape', 'ellipse', 'polygon', 'star', 'pen', 'curvature']) expect(SHAPE_PAINT_TOOLS.has(tool)).toBe(true);
    for (const tool of ['select', 'pencil', 'brush', 'mask-pen', 'text']) expect(SHAPE_PAINT_TOOLS.has(tool)).toBe(false);
  });
});

describe('what a chosen swatch creates', () => {
  it('fill None is transparent; Linear/Radial carry a gradient paint from the colour', () => {
    expect(newShapeFill({ ...shapeToolPaint, fillType: 'none' })).toEqual({ styleFill: 'rgba(0,0,0,0)' });
    const lin = newShapeFill({ ...shapeToolPaint, fillType: 'linear', fillColor: '#ff0000' });
    expect(lin.styleFill).toBe('#ff0000');
    expect(lin.paint?.type).toBe('linear');
    expect(newShapeFill({ ...shapeToolPaint, fillType: 'radial' }).paint?.type).toBe('radial');
  });

  it('a Solid stroke of the toolbar width; gradients as stroke paint; open paths round-capped', () => {
    setShapeToolPaint({ strokeType: 'solid', strokeColor: '#00ff00', strokeWidth: 7 });
    expect(newShapeStroke()).toMatchObject({ enabled: true, color: '#00ff00', width: 7, cap: 'butt', join: 'miter' });
    expect(newShapeStroke(undefined, true)).toMatchObject({ cap: 'round', join: 'round' });
    setShapeToolPaint({ strokeType: 'radial' });
    expect(newShapeStroke()?.paint?.type).toBe('radial');
  });

  it('a zero or negative width creates no stroke', () => {
    setShapeToolPaint({ strokeType: 'solid', strokeWidth: -4 });
    expect(shapeToolPaint.strokeWidth).toBe(0);
    expect(newShapeStroke()).toBeUndefined();
  });
});
