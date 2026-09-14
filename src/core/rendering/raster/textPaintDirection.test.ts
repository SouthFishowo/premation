/**
 * The painter's right-to-left, vertical, stroke-gradient and top-anchored
 * box paths, against a context that records every draw with its state.
 */

import { identityGlyphTransform } from '@core/text/textAnimators';
import { textGradientGeometry } from './textGradient';
import { paintTextInBox, type TextPaintSpec } from './textPaint';
import type { LinearFill } from '@core/paint/fill';

interface Draw {
  op: 'fillText' | 'strokeText';
  text: string;
  x: number;
  y: number;
  fillStyle: unknown;
  strokeStyle: unknown;
  textAlign: string;
  direction: string | undefined;
}

interface FakeGradient { args: number[]; stops: Array<[number, string]>; addColorStop(o: number, c: string): void }

function recorder(): { ctx: CanvasRenderingContext2D; draws: Draw[]; calls: Array<{ op: string; args: number[] }> } {
  const draws: Draw[] = [];
  const calls: Array<{ op: string; args: number[] }> = [];
  const state: Record<string, unknown> = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '', textAlign: '', textBaseline: '',
    letterSpacing: '', globalAlpha: 1, filter: 'none',
  };
  const snap = (op: Draw['op'], a: unknown[]): void => {
    draws.push({
      op, text: String(a[0]), x: Number(a[1]), y: Number(a[2]),
      fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, textAlign: String(state.textAlign),
      direction: state.direction as string | undefined,
    });
  };
  const gradient = (op: string) => (...args: number[]): FakeGradient => {
    calls.push({ op, args });
    return { args, stops: [], addColorStop(o, c) { this.stops.push([o, c]); } };
  };
  const ctx = Object.assign(state, {
    save: () => {}, restore: () => {}, scale: () => {}, transform: () => {},
    translate: (...args: number[]) => calls.push({ op: 'translate', args }),
    rotate: (...args: number[]) => calls.push({ op: 'rotate', args }),
    fillText: (...a: unknown[]) => snap('fillText', a),
    strokeText: (...a: unknown[]) => snap('strokeText', a),
    measureText: (t: string) => ({ width: [...t].length * 10 }),
    createLinearGradient: gradient('linear'),
    createRadialGradient: gradient('radial'),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws, calls };
}

const run = (over: Partial<TextPaintSpec>) => {
  const r = recorder();
  paintTextInBox(r.ctx, { text: 'AB', fontSize: 30, color: '#ffffff', width: 300, height: 100, ...over });
  return r;
};

const RED_BLUE: LinearFill = {
  type: 'linear',
  angle: 0,
  stops: [{ id: 'a', offset: 0, color: '#ff0000' }, { id: 'b', offset: 1, color: '#0000ff' }],
};

describe('stroke gradient', () => {
  it('strokes with a layer-space gradient; the fill is untouched', () => {
    const { draws } = run({ textStroke: '#000000', textStrokeWidth: 3, strokePaint: RED_BLUE });
    const stroke = draws.find((d) => d.op === 'strokeText')!;
    const g = stroke.strokeStyle as FakeGradient;
    const geo = textGradientGeometry(RED_BLUE, 300, 100);
    if (geo.kind !== 'linear') throw new Error('expected linear');
    expect(g.args).toEqual([geo.x0, geo.y0, geo.x1, geo.y1]);
    expect(g.args).toEqual([0, 50, 300, 50]);
    expect(draws.find((d) => d.op === 'fillText')!.fillStyle).toBe('#ffffff');
  });

  it('a selection with its own stroke colour keeps it', () => {
    const { draws } = run({
      textStroke: '#000000',
      textStrokeWidth: 3,
      strokePaint: RED_BLUE,
      runs: [{ start: 0, end: 1, style: { strokeColor: '#00ff00' } }],
    });
    const strokes = draws.filter((d) => d.op === 'strokeText');
    expect(strokes.find((d) => d.text === 'A')!.strokeStyle).toBe('#00ff00');
    expect(typeof strokes.find((d) => d.text === 'B')!.strokeStyle).toBe('object');
  });

  it('no stroke width, no gradient stroke', () => {
    const { draws, calls } = run({ strokePaint: RED_BLUE });
    expect(draws.some((d) => d.op === 'strokeText')).toBe(false);
    // The gradient is built (cheap) but never painted.
    expect(calls.filter((c) => c.op === 'linear')).toHaveLength(1);
  });
});

describe('auto-height box offset', () => {
  it('draws everything boxOffsetY lower and spans a gradient over the content box', () => {
    const { calls } = run({
      fillPaint: { ...RED_BLUE, angle: 90 },
      textExtras: { boxOffsetY: 10 },
    });
    const translates = calls.filter((c) => c.op === 'translate').map((c) => c.args);
    expect(translates.slice(0, 2)).toEqual([[0, 20], [0, -10]]);
    const args = calls.find((c) => c.op === 'linear')!.args;
    [150, 0, 150, 80].forEach((v, i) => expect(args[i]).toBeCloseTo(v, 9));
  });

  it('issues no transform at all without an offset', () => {
    expect(run({}).calls.filter((c) => c.op === 'translate')).toEqual([]);
  });
});

describe('right-to-left', () => {
  it('fast path: RTL base direction, default alignment on the right edge', () => {
    const { draws } = run({ textExtras: { direction: 'rtl' } });
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ text: 'AB', x: 288, textAlign: 'right', direction: 'rtl' });
  });

  it('a uniform RTL line on the glyph path is drawn as its LOGICAL string from its leftmost pen', () => {
    const { draws } = run({
      text: 'אב c',
      runs: [{ start: 0, end: 4, style: { fill: '#ffffff' } }],
      textExtras: { direction: 'rtl' },
    });
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ text: 'אב c', x: 150 + 138 - 40, textAlign: 'left', direction: 'rtl' });
  });

  it('groups by bidi level run: Hebrew drawn rtl, Latin ltr, an animated glyph alone', () => {
    const glyphs = [...'abcאב'].map((c, i) => identityGlyphTransform(c, i === 2 ? { dy: 3 } : {}));
    const { draws } = run({ text: 'abcאב', glyphs, textExtras: { direction: 'rtl' } });
    const fills = draws.filter((d) => d.op === 'fillText').map((d) => [d.text, d.direction]);
    expect(fills).toEqual(expect.arrayContaining([['אב', 'rtl'], ['ab', 'ltr'], ['c', 'ltr']]));
    expect(fills).toHaveLength(3);
  });

  it('left-to-right layers never touch ctx.direction', () => {
    const { draws } = run({ text: 'אב', runs: [{ start: 0, end: 1, style: { fill: '#ff0000' } }] });
    expect(draws.every((d) => d.direction === undefined)).toBe(true);
  });
});

describe('vertical type', () => {
  it('draws a sideways Latin run as one string rotated 90°', () => {
    const { draws, calls } = run({ text: 'ab', textExtras: { orientation: 'vertical' } });
    expect(draws.map((d) => [d.text, d.textAlign])).toEqual([['ab', 'left']]);
    expect(calls.filter((c) => c.op === 'rotate').map((c) => c.args[0])).toEqual([Math.PI / 2]);
  });

  it('draws upright CJK glyph by glyph, centred, unrotated', () => {
    const { draws, calls } = run({ text: '日本', textExtras: { orientation: 'vertical' } });
    expect(draws.map((d) => [d.text, d.textAlign])).toEqual([['日', 'center'], ['本', 'center']]);
    expect(draws[0]!.x).toBe(draws[1]!.x);
    expect(draws[1]!.y - draws[0]!.y).toBe(30);
    expect(calls.some((c) => c.op === 'rotate')).toBe(false);
  });

  it('Standard Vertical Roman Alignment stands Latin upright', () => {
    const { draws } = run({ text: 'ab', textExtras: { orientation: 'vertical', verticalRomanAlignment: true } });
    expect(draws.map((d) => [d.text, d.textAlign])).toEqual([['a', 'center'], ['b', 'center']]);
  });

  it('a fixed vertical box drops the columns past its left edge', () => {
    // 60px-wide box (36 inside the padding): one 36px column fits, the second overflows.
    const { draws } = run({
      text: '日本語',
      fontSize: 30,
      width: 60,
      height: 76,
      lineHeight: 1.2,
      textExtras: { orientation: 'vertical', boxHeight: 60 },
    });
    expect(draws.map((d) => d.text)).toEqual(['日', '本']);
  });
});
