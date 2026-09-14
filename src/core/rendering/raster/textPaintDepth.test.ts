/**
 * The painter's new AE depth: grouping pivots (the transform ORIGIN a grouped
 * word turns about), inter-character blending order, All Characters As One,
 * per-range stroke and scale, animator HSB / stroke opacity / anchor / skew
 * axis, Force Alignment forwarding, and the block-gradient geometry.
 *
 * jsdom has no rasterizer, so the painter runs against a context that records
 * every call together with the state it was made under.
 */

import { identityGlyphTransform, type GlyphTransform } from '@core/text/textAnimators';
import { paintTextInBox, type TextPaintSpec } from './textPaint';
import { textGradientGeometry, isGradientPaint } from './textGradient';
import type { LinearFill, RadialFill } from '@core/paint/fill';

interface Call {
  op: string;
  args: unknown[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  gco: string;
  alpha: number;
  font: string;
}

function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const stack: Array<Record<string, unknown>> = [];
  const state: Record<string, unknown> = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '', textAlign: '', textBaseline: '',
    letterSpacing: '0px', globalAlpha: 1, filter: 'none', globalCompositeOperation: 'source-over',
  };
  const rec = (op: string) => (...args: unknown[]): void => {
    calls.push({
      op, args,
      fillStyle: String(state.fillStyle), strokeStyle: String(state.strokeStyle), lineWidth: Number(state.lineWidth),
      gco: String(state.globalCompositeOperation), alpha: Number(state.globalAlpha), font: String(state.font),
    });
  };
  const ctx = Object.assign(state, {
    save: () => { stack.push({ ...state }); calls.push({ op: 'save', args: [], fillStyle: '', strokeStyle: '', lineWidth: 0, gco: String(state.globalCompositeOperation), alpha: 1, font: '' }); },
    restore: () => { const s = stack.pop(); if (s) Object.assign(state, s); rec('restore')(); },
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'), transform: rec('transform'),
    fillText: rec('fillText'), strokeText: rec('strokeText'),
    measureText: (t: string) => ({ width: [...t].length * 10 }),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const paint = (over: Partial<TextPaintSpec>): Call[] => {
  const { ctx, calls } = recorder();
  paintTextInBox(ctx, { text: 'AB', fontSize: 20, color: '#ffffff', width: 200, height: 100, ...over });
  return calls;
};
const draws = (c: Call[]): Call[] => c.filter((x) => x.op === 'fillText' || x.op === 'strokeText');
const tr = (ch: string, p: Partial<GlyphTransform>): GlyphTransform => identityGlyphTransform(ch, p);

describe('Anchor Point Grouping', () => {
  // "AB CD", 10px glyphs, point text centred in a 200px box: glyph centres at
  // box-centre x −20, −10, 0, 10, 20.
  const text = 'AB CD';
  const rotated = [...text].map((c) => tr(c, { rotation: 90 }));

  /** The first translate of each glyph's save/restore block. */
  const origins = (c: Call[]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    c.forEach((x, i) => { if (x.op === 'save') { const t = c[i + 1]; if (t?.op === 'translate') out.push([t.args[0] as number, t.args[1] as number]); } });
    return out;
  };

  it('character grouping: every glyph turns about its own centre (unchanged)', () => {
    const o = origins(paint({ text, glyphs: rotated, align: 'center' }));
    expect(o.map(([x]) => x - 100)).toEqual([-20, -10, 10, 20]);
  });

  it('word grouping: letters of a word share the word centre as origin, then offset inside it', () => {
    const c = paint({ text, glyphs: rotated, align: 'center', textExtras: { anchorGrouping: 'word' } });
    expect(origins(c).map(([x]) => x - 100)).toEqual([-15, -15, 15, 15]);
    // Inside the rotated frame, 'A' sits 5px left of its word's centre.
    const afterRotate = c.findIndex((x) => x.op === 'rotate');
    expect(c[afterRotate + 1]).toMatchObject({ op: 'translate', args: [-5, 0] });
  });

  it('all grouping: one origin for the whole block', () => {
    const o = origins(paint({ text, glyphs: rotated, align: 'center', textExtras: { anchorGrouping: 'all' } }));
    expect(new Set(o.map(([x, y]) => `${x},${y}`)).size).toBe(1);
  });

  it('an untransformed glyph is never re-originated', () => {
    const glyphs = [...text].map((c, i) => (i === 0 ? tr(c, { rotation: 45 }) : tr(c, {})));
    const c = paint({ text, glyphs, align: 'center', textExtras: { anchorGrouping: 'word' } });
    expect(c.filter((x) => x.op === 'save')).toHaveLength(1);
  });
});

describe('Inter-Character Blending', () => {
  it('draws glyph by glyph under the blend op, restoring source-over after each', () => {
    const c = paint({ text: 'ABC', textExtras: { interCharacterBlending: 'multiply' } });
    const fills = c.filter((x) => x.op === 'fillText');
    expect(fills.map((x) => x.args[0])).toEqual(['A', 'B', 'C']);
    expect(fills.every((x) => x.gco === 'multiply')).toBe(true);
    // Order is left to right, so a later glyph composites over an earlier one.
    expect((fills[0]!.args[1] as number) < (fills[2]!.args[1] as number)).toBe(true);
  });

  it('normal blending keeps the whole-line draw', () => {
    expect(paint({ text: 'ABC', textExtras: { interCharacterBlending: 'normal' } }).filter((x) => x.op === 'fillText').map((x) => x.args[0])).toEqual(['ABC']);
  });
});

describe('Fill & Stroke: All Characters As One', () => {
  it('lifts Fill Over Stroke to every stroke before every fill', () => {
    const seq = paint({ textStrokeWidth: 2, glyphs: [tr('A', { dx: 1 }), tr('B', { dx: 1 })], textExtras: { fillStrokeMode: 'allAsOne' } })
      .filter((x) => x.op === 'fillText' || x.op === 'strokeText').map((x) => `${x.op === 'fillText' ? 'F' : 'S'}${x.args[0]}`);
    expect(seq).toEqual(['SA', 'SB', 'FA', 'FB']);
  });
});

describe('animator paint properties', () => {
  it('Fill Hue shifts the fill; Stroke Opacity fades only the stroke', () => {
    const c = draws(paint({
      color: '#ff0000', textStroke: '#000000', textStrokeWidth: 2,
      glyphs: [tr('A', { fillHue: 120, strokeOpacity: 0.25 }), tr('B', { dx: 0.5 })],
    }));
    const fillA = c.find((x) => x.op === 'fillText' && x.args[0] === 'A')!;
    const strokeA = c.find((x) => x.op === 'strokeText' && x.args[0] === 'A')!;
    expect(fillA.fillStyle).toBe('#00ff00');
    expect(fillA.alpha).toBe(1);
    expect(strokeA.alpha).toBeCloseTo(0.25);
  });

  it('Anchor Point draws the glyph at −anchor after its transform', () => {
    const c = paint({ glyphs: [tr('A', { rotation: 10, anchorX: 4, anchorY: -2 }), tr('B', {})] });
    const i = c.findIndex((x) => x.op === 'rotate');
    expect(c[i + 1]).toMatchObject({ op: 'translate', args: [-4, 2] });
  });

  it('Skew Axis rotates the shear direction about the skew', () => {
    const c = paint({ glyphs: [tr('A', { skew: 20, skewAxis: 90 }), tr('B', {})] });
    const i = c.findIndex((x) => x.op === 'transform');
    expect(c[i - 1]).toMatchObject({ op: 'rotate', args: [Math.PI / 2] });
    expect(c[i + 1]).toMatchObject({ op: 'rotate', args: [-Math.PI / 2] });
  });
});

describe('per-range character styles', () => {
  it('a range stroke colour / width overrides the layer stroke for those characters', () => {
    const c = draws(paint({
      text: 'ABC', textStroke: '#000000', textStrokeWidth: 1,
      runs: [{ start: 1, end: 2, style: { strokeColor: '#ff0000', strokeWidth: 6 } }],
    }));
    const b = c.find((x) => x.op === 'strokeText' && x.args[0] === 'B')!;
    const a = c.find((x) => x.op === 'strokeText' && String(x.args[0]).startsWith('A'))!;
    expect([b.strokeStyle, b.lineWidth]).toEqual(['#ff0000', 6]);
    expect([a.strokeStyle, a.lineWidth]).toEqual(['#000000', 1]);
  });

  it('a range vertical scale draws that glyph scaled on its own', () => {
    const c = paint({ text: 'ABC', runs: [{ start: 0, end: 1, style: { verticalScale: 150 } }] });
    expect(c.some((x) => x.op === 'scale' && x.args[0] === 1 && x.args[1] === 1.5)).toBe(true);
    expect(c.filter((x) => x.op === 'fillText').map((x) => x.args[0])).toEqual(['A', 'BC']);
  });

  it('small caps reaches the font shorthand of that range only', () => {
    const c = paint({ text: 'AB', runs: [{ start: 0, end: 1, style: { smallCaps: true } }] }).filter((x) => x.op === 'fillText');
    expect(c[0]!.font).toMatch(/^small-caps /);
    expect(c[1]!.font).not.toMatch(/small-caps/);
  });

  it('a run drawn whole carries its letter spacing', () => {
    const { ctx, calls } = recorder();
    const spacing: string[] = [];
    const orig = ctx.fillText.bind(ctx);
    (ctx as unknown as { fillText: (...a: unknown[]) => void }).fillText = (...a: unknown[]) => {
      spacing.push(String((ctx as unknown as { letterSpacing: string }).letterSpacing));
      (orig as (...a: unknown[]) => void)(...a);
    };
    paintTextInBox(ctx, { text: 'ABCD', fontSize: 20, color: '#fff', width: 200, height: 100, letterSpacing: 3, runs: [{ start: 0, end: 1, style: { fill: '#f00' } }] });
    expect(calls.filter((x) => x.op === 'fillText').map((x) => x.args[0])).toEqual(['A', 'BCD']);
    expect(spacing).toEqual(['0px', '3px']);
  });
});

describe('block gradient geometry', () => {
  const stops = [{ id: 'a', offset: 0, color: '#000000' }, { id: 'b', offset: 1, color: '#ffffff' }];

  it('a horizontal linear gradient spans the box width through its centre', () => {
    expect(textGradientGeometry({ type: 'linear', angle: 0, stops } as LinearFill, 200, 100))
      .toEqual({ kind: 'linear', x0: 0, y0: 50, x1: 200, y1: 50 });
  });

  it('a 45° gradient spans the box projected onto its axis', () => {
    const g = textGradientGeometry({ type: 'linear', angle: 45, stops } as LinearFill, 200, 100);
    if (g.kind !== 'linear') throw new Error('linear');
    expect(g.x0 + g.x1).toBeCloseTo(200);
    // Length = |cos|·w + |sin|·h — the box's extent along the axis.
    expect(Math.hypot(g.x1 - g.x0, g.y1 - g.y0)).toBeCloseTo(300 * Math.SQRT1_2);
  });

  it('a radial gradient sits at its relative centre with a half-diagonal radius', () => {
    expect(textGradientGeometry({ type: 'radial', cx: 0.25, cy: 0.5, radius: 1, stops } as RadialFill, 200, 100))
      .toEqual({ kind: 'radial', cx: 50, cy: 50, r: Math.hypot(200, 100) / 2 });
  });

  it('only linear / radial paints with stops count as gradients', () => {
    expect(isGradientPaint({ type: 'solid', color: '#fff' })).toBe(false);
    expect(isGradientPaint({ type: 'linear', angle: 0, stops: [] })).toBe(false);
    expect(isGradientPaint({ type: 'linear', angle: 0, stops })).toBe(true);
  });

  it('a solid-coloured run is not painted with the gradient (no DOM: falls back to the first stop)', () => {
    const c = paint({ text: 'AB', fillPaint: { type: 'linear', angle: 0, stops }, runs: [{ start: 1, end: 2, style: { fill: '#ff0000' } }] })
      .filter((x) => x.op === 'fillText');
    expect(c.map((x) => [x.args[0], x.fillStyle])).toEqual([['A', '#000000'], ['B', '#ff0000']]);
  });
});
