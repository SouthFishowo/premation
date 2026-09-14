/**
 * Vertical type on a path: columns ride the path, upright glyphs stand across
 * it and rotated Latin lies along it.
 */

import { applyTextPath, type TextPathGeometry } from './textPath';
import type { TextStyle } from './textLayout';
import { isUprightInVertical, layoutVerticalText } from './verticalLayout';
import { arcTable } from '@core/scene/trimPath';

const measure = (c: string, s: TextStyle): number => (isUprightInVertical(c) ? s.fontSize : 5);
const base = { fontSize: 10 }; // leading 12
const horizontal = () => arcTable([{ x: 0, y: 0 }, { x: 100, y: 0 }], false);
const geo = (over: Partial<TextPathGeometry> = {}): TextPathGeometry => ({
  table: horizontal(), firstMargin: 0, reversed: false, perpendicular: true, align: 'left', vertical: true, ...over,
});

describe('applyTextPath — vertical', () => {
  it('advances along the path by the column advances', () => {
    const out = applyTextPath(layoutVerticalText('日本', base, measure, { boxWidth: 100 }), geo());
    [5, 15].forEach((v, i) => expect(out[i]!.x).toBeCloseTo(v, 9));
    out.forEach((g) => expect(g.y).toBeCloseTo(0, 9));
  });

  it('upright CJK turn a quarter back from the heading: their tops point back along the path', () => {
    const out = applyTextPath(layoutVerticalText('日', base, measure, { boxWidth: 100 }), geo());
    expect(out[0]!.angle).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('rotated Latin aligns with the path heading', () => {
    const out = applyTextPath(layoutVerticalText('日a', base, measure, { boxWidth: 100 }), geo());
    expect(out[1]!.angle).toBeCloseTo(0, 9);
    expect(out[1]!.x).toBeCloseTo(12.5, 9);
  });

  it('on a downward path the column looks exactly as it does unpathed', () => {
    const down = arcTable([{ x: 0, y: 0 }, { x: 0, y: 100 }], false);
    const out = applyTextPath(layoutVerticalText('日a', base, measure, { boxWidth: 100 }), geo({ table: down }));
    expect(out[0]!.angle).toBeCloseTo(0, 9);
    expect(out[1]!.angle).toBeCloseTo(Math.PI / 2, 9);
    expect(out[0]!.y).toBeCloseTo(5, 9);
  });

  it('columns ride in parallel: the first (right-hand) column on the path’s left', () => {
    const out = applyTextPath(layoutVerticalText('日\n本', base, measure, { boxWidth: 100 }), geo());
    expect(out[0]!.y).toBeCloseTo(-6, 9);
    expect(out[1]!.y).toBeCloseTo(6, 9);
    expect(out[0]!.x).toBeCloseTo(out[1]!.x, 9);
  });

  it('Perpendicular To Path off keeps each glyph’s own orientation', () => {
    const out = applyTextPath(layoutVerticalText('日a', base, measure, { boxWidth: 100 }), geo({ perpendicular: false }));
    expect(out[0]!.angle).toBe(0);
    expect(out[1]!.angle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('honours alignment and First Margin along the column axis', () => {
    const laid = layoutVerticalText('日本', { ...base, align: 'right' }, measure, { boxWidth: 100 });
    const out = applyTextPath(laid, geo({ align: 'right', firstMargin: -10 }));
    [75, 85].forEach((v, i) => expect(out[i]!.x).toBeCloseTo(v, 9));
  });

  it('a tate-chu-yoko pair sits side by side across the path', () => {
    const laid = layoutVerticalText('12', base, measure, { boxWidth: 100, tateChuYokoDigits: 2 });
    const out = applyTextPath(laid, geo());
    expect(out[0]!.x).toBeCloseTo(out[1]!.x, 9);
    expect(out[1]!.y - out[0]!.y).toBeCloseTo(-5, 9);
  });
});
