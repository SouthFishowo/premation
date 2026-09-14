/**
 * The painter's vertical-type draws: tate-chu-yoko runs, the Unicode
 * fallback forms and vertical text on a path.
 */

import { paintTextInBox, type TextPaintSpec } from './textPaint';

interface Draw { op: string; text: string; x: number; y: number; textAlign: string; font: string }

function recorder() {
  const draws: Draw[] = [];
  const calls: Array<{ op: string; args: number[] }> = [];
  const state: Record<string, unknown> = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '', textAlign: '', textBaseline: '',
    letterSpacing: '', globalAlpha: 1, filter: 'none',
  };
  const snap = (op: string, a: unknown[]): void => {
    draws.push({ op, text: String(a[0]), x: Number(a[1]), y: Number(a[2]), textAlign: String(state.textAlign), font: String(state.font) });
  };
  const rec = (op: string) => (...args: number[]) => { calls.push({ op, args }); };
  const ctx = Object.assign(state, {
    save: () => {}, restore: () => {}, transform: () => {},
    scale: rec('scale'), translate: rec('translate'), rotate: rec('rotate'),
    fillText: (...a: unknown[]) => snap('fillText', a),
    strokeText: (...a: unknown[]) => snap('strokeText', a),
    measureText: (t: string) => ({ width: [...t].length * 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws, calls };
}

const run = (over: Partial<TextPaintSpec>) => {
  const r = recorder();
  paintTextInBox(r.ctx, { text: '日', fontSize: 30, color: '#ffffff', width: 300, height: 200, ...over });
  return r;
};

describe('vertical type — tate-chu-yoko', () => {
  it('draws an auto digit pair as ONE horizontal string centred on the column', () => {
    const { draws, calls } = run({ text: '第12回', textExtras: { orientation: 'vertical', tateChuYokoDigits: 2 } });
    expect(draws.map((d) => [d.text, d.textAlign])).toEqual([['第', 'center'], ['12', 'center'], ['回', 'center']]);
    expect(draws[1]!.x).toBe(draws[0]!.x);
    expect(draws[1]!.y - draws[0]!.y).toBe(30);
    expect(calls.some((c) => c.op === 'rotate' || c.op === 'scale')).toBe(false);
  });

  it('squeezes a selected run wider than the column', () => {
    const { draws, calls } = run({
      text: '1234',
      runs: [{ start: 0, end: 4, style: { tateChuYoko: true } }],
      textExtras: { orientation: 'vertical' },
    });
    expect(draws.map((d) => d.text)).toEqual(['1234']);
    expect(calls.filter((c) => c.op === 'scale').map((c) => c.args)).toEqual([[0.75, 1]]);
  });

  it('without auto tate-chu-yoko the digits stay one rotated run', () => {
    const { draws, calls } = run({ text: '12', textExtras: { orientation: 'vertical' } });
    expect(draws.map((d) => d.text)).toEqual(['12']);
    expect(calls.filter((c) => c.op === 'rotate').map((c) => c.args[0])).toEqual([Math.PI / 2]);
  });
});

describe('vertical type — alternates fallback', () => {
  it('draws presentation forms where no vert face is available', () => {
    const { draws } = run({ text: '「日」、', textExtras: { orientation: 'vertical' } });
    expect(draws.map((d) => d.text)).toEqual(['﹁', '日', '﹂', '︑']);
  });
});

describe('vertical type — on a path', () => {
  it('lays the column along a horizontal path with upright glyphs turned a quarter back', () => {
    const { draws, calls } = run({
      text: '日本',
      textExtras: { orientation: 'vertical' },
      textPath: { points: [{ x: 0, y: 0 }, { x: 200, y: 0 }], closed: false, firstMargin: 0, reversed: false, perpendicular: true },
    });
    expect(draws.map((d) => d.text)).toEqual(['日', '本']);
    const rotations = calls.filter((c) => c.op === 'rotate').map((c) => c.args[0]!);
    expect(rotations).toHaveLength(2);
    rotations.forEach((r) => expect(r).toBeCloseTo(-Math.PI / 2, 9));
  });
});
