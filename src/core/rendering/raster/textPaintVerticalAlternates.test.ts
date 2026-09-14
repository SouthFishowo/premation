/**
 * With a working 'vert' alias face, upright vertical glyphs are drawn with it
 * and keep their own characters (no presentation-form substitution).
 */

import { paintTextInBox } from './textPaint';

jest.mock('@core/text/fontFaceVariants', () => {
  const actual = jest.requireActual('@core/text/fontFaceVariants');
  return {
    ...actual,
    verticalAlternatesFamily: () => '__pv_vert',
    verticalAlternatesFor: () => ({ family: '__pv_vert', has: () => true, source: 'probe' }),
  };
});

describe('vertical type — vert alternates face', () => {
  it('draws 「 and 日 with the alias; rotated Latin keeps the plain family', () => {
    const draws: Array<{ text: string; font: string }> = [];
    const state: Record<string, unknown> = { font: '', textAlign: '', letterSpacing: '', globalAlpha: 1 };
    const ctx = Object.assign(state, {
      save: () => {}, restore: () => {}, transform: () => {}, scale: () => {}, translate: () => {}, rotate: () => {},
      fillText: (t: string) => draws.push({ text: t, font: String(state.font) }),
      strokeText: () => {},
      measureText: (t: string) => ({ width: [...t].length * 10 }),
    }) as unknown as CanvasRenderingContext2D;
    paintTextInBox(ctx, {
      text: '「日ab', fontSize: 30, color: '#ffffff', width: 300, height: 200, fontFamily: 'Yu Gothic',
      textExtras: { orientation: 'vertical' },
    });
    expect(draws.map((d) => d.text)).toEqual(['「', '日', 'ab']);
    expect(draws[0]!.font).toContain('__pv_vert');
    expect(draws[1]!.font).toContain('__pv_vert');
    expect(draws[2]!.font).not.toContain('__pv_vert');
  });
});
