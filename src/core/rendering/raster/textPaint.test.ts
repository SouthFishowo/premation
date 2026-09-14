/**
 * The painter's AE options, and the parity that keeps its two draw paths on
 * the same pixels.
 *
 * ## Parity
 * Static single-style text draws a line (or a justified word) per `fillText`,
 * planned by `planWholeStringLines`; anything with per-character work draws
 * from `layoutText`. The two must agree about where every glyph starts, or a
 * frame that composites both shows the string twice. The measurer here MODELS
 * kerning (the "AV" pair tucks), so a path that ignored the kerned prefix
 * measurement would fail.
 *
 * ## Painting
 * jsdom has no rasterizer, so the painter runs against a context that records
 * every draw call together with the state it was drawn under.
 */

import { layoutText, planWholeStringLines, type TextStyle } from '@core/text/textLayout';
import { identityGlyphTransform } from '@core/text/textAnimators';
import { FAUX_ITALIC_SKEW } from '@core/text/textExtras';
import { paintTextInBox, type TextPaintSpec } from './textPaint';

// ── Parity ───────────────────────────────────────────────────────────

const GLYPH = 10;
const measureRun = (s: string, style: TextStyle): number => {
  const chars = [...s];
  let w = chars.length * GLYPH + chars.length * (style.letterSpacing ?? 0);
  for (let i = 0; i + 1 < chars.length; i++) if (chars[i] === 'A' && chars[i + 1] === 'V') w -= 3;
  return w;
};
const measureGlyph = (): number => GLYPH;

const CASES: Array<{ name: string; text: string; align: string; soft?: number[]; extra?: Record<string, number> }> = [
  { name: 'left point', text: 'AVA TO\nVAV', align: 'left' },
  { name: 'center point', text: 'AVA TO\nVAV', align: 'center' },
  { name: 'right point', text: 'AVA TO\nVAV', align: 'right' },
  { name: 'justify-left box', text: 'AV AV AV\nAV A\nTAIL', align: 'justify-left', soft: [0, 1] },
  { name: 'justify-center box', text: 'AV AV AV\nAV A\nTAIL', align: 'justify-center', soft: [0] },
  { name: 'justify-right box', text: 'AV  AV\nAV A', align: 'justify-right', soft: [0] },
  { name: 'justify-all box', text: 'AV AV AV\nAV A', align: 'justify-all', soft: [0] },
  { name: 'indented box', text: 'AV AV\nAV A\nX', align: 'justify-left', soft: [0], extra: { leftIndent: 7, rightIndent: 11, firstLineIndent: -3, spaceBefore: 4, spaceAfter: 2 } },
];

describe('whole-string plan ≡ per-glyph layout', () => {
  it.each(CASES)('$name', ({ text, align, soft, extra }) => {
    const style = { fontSize: 20, letterSpacing: 1.5, align, lineHeight: 1.3, paragraphSpacing: 2, ...extra };
    const boxWidth = 240;
    const opts = { boxWidth, padX: 12, softBreakLines: soft };
    const plans = planWholeStringLines(text, style, (s) => measureRun(s, style), opts);
    const laid = layoutText(text, style, measureGlyph, { ...opts, measureRun });

    plans.forEach((plan, line) => {
      const glyphs = laid.glyphs.filter((g) => g.line === line);
      expect(plan.y).toBeCloseTo(laid.lines[line]!.y, 9);
      // Each segment starts at the pen of the first glyph of its text.
      let cursor = 0;
      for (const seg of plan.segments) {
        while (glyphs[cursor] && glyphs[cursor]!.char !== [...seg.text][0]) cursor++;
        const g = glyphs[cursor]!;
        expect(seg.left).toBeCloseTo(g.x - g.inkWidth / 2, 9);
        cursor += [...seg.text].length;
      }
    });
  });
});

// ── Painting ─────────────────────────────────────────────────────────

interface Draw {
  op: 'fillText' | 'strokeText' | 'transform';
  args: unknown[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: string;
  textAlign: string;
  filter: string;
}

function recorder(): { ctx: CanvasRenderingContext2D; draws: Draw[] } {
  const draws: Draw[] = [];
  const state: Record<string, unknown> = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '', textAlign: '', textBaseline: '',
    letterSpacing: '', globalAlpha: 1, filter: 'none',
  };
  const snap = (op: Draw['op'], args: unknown[]): void => {
    draws.push({
      op, args,
      fillStyle: String(state.fillStyle), strokeStyle: String(state.strokeStyle),
      lineWidth: Number(state.lineWidth), lineJoin: String(state.lineJoin), textAlign: String(state.textAlign),
      filter: String(state.filter),
    });
  };
  const ctx = Object.assign(state, {
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {}, scale: () => {},
    transform: (...a: unknown[]) => snap('transform', a),
    fillText: (...a: unknown[]) => snap('fillText', a),
    strokeText: (...a: unknown[]) => snap('strokeText', a),
    measureText: (t: string) => ({ width: t.length * 10 }),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws };
}

const paint = (over: Partial<TextPaintSpec>): Draw[] => {
  const { ctx, draws } = recorder();
  paintTextInBox(ctx, { text: 'AB', fontSize: 30, color: '#ffffff', width: 300, height: 100, ...over });
  return draws;
};
const texts = (d: Draw[], op: Draw['op']) => d.filter((x) => x.op === op).map((x) => String(x.args[0]));
const moved = (ch: string) => identityGlyphTransform(ch, { dx: 1 });

describe('paintTextInBox — AE options', () => {
  it('honours the stroke line join (default round)', () => {
    expect(paint({ textStrokeWidth: 4 }).find((d) => d.op === 'strokeText')!.lineJoin).toBe('round');
    expect(paint({ textStrokeWidth: 4, textExtras: { strokeLineJoin: 'miter' } }).find((d) => d.op === 'strokeText')!.lineJoin).toBe('miter');
    expect(
      paint({ textStrokeWidth: 4, glyphs: [moved('A'), moved('B')], textExtras: { strokeLineJoin: 'bevel' } })
        .filter((d) => d.op === 'strokeText').every((d) => d.lineJoin === 'bevel'),
    ).toBe(true);
  });

  it('per-character orders interleave; "All" orders paint every stroke first or last', () => {
    const seq = (order: NonNullable<TextPaintSpec['textExtras']>['strokeOrder']) =>
      paint({ textStrokeWidth: 3, glyphs: [moved('A'), moved('B')], textExtras: { strokeOrder: order } })
        .filter((d) => d.op !== 'transform').map((d) => `${d.op === 'fillText' ? 'F' : 'S'}${String(d.args[0])}`);
    expect(seq('fill-over-stroke')).toEqual(['SA', 'FA', 'SB', 'FB']);
    expect(seq('stroke-over-fill')).toEqual(['FA', 'SA', 'FB', 'SB']);
    expect(seq('all-fills-over-all-strokes')).toEqual(['SA', 'SB', 'FA', 'FB']);
    expect(seq('all-strokes-over-all-fills')).toEqual(['FA', 'FB', 'SA', 'SB']);
  });

  it('the legacy strokeOverFill boolean still means Stroke Over Fill', () => {
    const d = paint({ textStrokeWidth: 3, strokeOverFill: true }).filter((x) => x.op !== 'transform');
    expect(d.map((x) => x.op)).toEqual(['fillText', 'strokeText']);
  });

  it('"none" swatches switch the fill or the stroke off', () => {
    expect(texts(paint({ textExtras: { noFill: true } }), 'fillText')).toEqual([]);
    expect(texts(paint({ textStrokeWidth: 5, textExtras: { noStroke: true } }), 'strokeText')).toEqual([]);
  });

  it('faux bold strokes the glyph in its FILL colour under the fill', () => {
    const d = paint({ color: '#00ff00', textExtras: { fauxBold: true } });
    const stroke = d.find((x) => x.op === 'strokeText')!;
    expect(stroke.strokeStyle).toBe('#00ff00');
    expect(stroke.lineWidth).toBeCloseTo(30 / 30);
    expect(d.findIndex((x) => x.op === 'strokeText')).toBeLessThan(d.findIndex((x) => x.op === 'fillText'));
  });

  it('faux italic shears, independent of the font style', () => {
    const t = paint({ textExtras: { fauxItalic: true } }).find((x) => x.op === 'transform')!;
    expect(t.args).toEqual([1, 0, -FAUX_ITALIC_SKEW, 1, 0, 0]);
  });

  it('an animator stroke colour applies to the LAYER stroke too', () => {
    const d = paint({
      textStroke: '#000000',
      textStrokeWidth: 3,
      glyphs: [identityGlyphTransform('A', { dx: 1, strokeColor: '#ff0000', strokeColorMix: 1 }), moved('B')],
    });
    const strokes = d.filter((x) => x.op === 'strokeText');
    expect(strokes[0]!.strokeStyle).toBe('#ff0000');
    expect(strokes[1]!.strokeStyle).toBe('#000000');
  });

  it('never hands the canvas an unparseable animator colour', () => {
    const d = paint({ glyphs: [identityGlyphTransform('A', { dx: 1, color: 'var(--color-primary-unset)', colorMix: 1 }), moved('B')] });
    expect(d.filter((x) => x.op === 'fillText').every((x) => !x.fillStyle.includes('var('))).toBe(true);
    expect(d.find((x) => x.op === 'fillText')!.fillStyle).toBe('#ffffff');
  });

  it('justified box text draws one fillText per word on the fast path', () => {
    const d = paint({ text: 'aa bb\ncc', align: 'justify-left', textExtras: { softBreakLines: [0] } });
    expect(texts(d, 'fillText')).toEqual(['aa', 'bb', 'cc']);
    expect(d.filter((x) => x.op === 'fillText').every((x) => x.textAlign === 'left')).toBe(true);
  });
});

describe('paintTextInBox — 2-D animator blur', () => {
  // The recorder has no backing canvas, so the anisotropic composite cannot
  // stage — these pin the FILTER the two paths issue. The pixel behaviour of
  // the composite is pinned by textPaintAnisoBlur.test.ts on a real canvas.
  it('uniform blur keeps the exact single-filter call it always issued', () => {
    const d = paint({ text: 'A', glyphs: [identityGlyphTransform('A', { blur: 5 })] });
    expect(d.find((x) => x.op === 'fillText')!.filter).toBe('blur(5px)');
  });

  it('a blurY equal to blur is LINKED — same single filter, same path', () => {
    const d = paint({ text: 'A', glyphs: [identityGlyphTransform('A', { blur: 5, blurY: 5 })] });
    expect(d.find((x) => x.op === 'fillText')!.filter).toBe('blur(5px)');
  });

  it('unlinked X/Y without a canvas degrades to an isotropic mean, never a silent drop', () => {
    const d = paint({ text: 'A', glyphs: [identityGlyphTransform('A', { blur: 1, blurY: 5 })] });
    expect(d.find((x) => x.op === 'fillText')!.filter).toBe('blur(3px)');
  });
});

describe('paintTextInBox — contextual shaping', () => {
  const ARABIC = 'مرحبا';

  it('a line with no per-character variation draws as ONE string (joins intact)', () => {
    const d = paint({ text: ARABIC, runs: [{ start: 0, end: 5, style: { fill: '#ff0000' } }] });
    expect(texts(d, 'fillText')).toEqual([ARABIC]);
  });

  it('keeps a complex-script span whole beside a styled Latin letter', () => {
    const d = paint({ text: `ab ${ARABIC}`, runs: [{ start: 0, end: 1, style: { fill: '#ff0000' } }] });
    expect(texts(d, 'fillText')).toEqual(['a', `b ${ARABIC}`]);
  });

  it('Latin in a mixed-style line draws each same-style span whole (ligatures on)', () => {
    // Changed deliberately (2026-09-13): a ligature only forms when its letters
    // are drawn in one string, and standard ligatures are on by default in AE.
    const d = paint({ text: 'abc', runs: [{ start: 0, end: 1, style: { fill: '#ff0000' } }] });
    expect(texts(d, 'fillText')).toEqual(['a', 'bc']);
  });

  it('with standard ligatures OFF, Latin keeps its per-glyph draw', () => {
    const d = paint({ text: 'abc', runs: [{ start: 0, end: 1, style: { fill: '#ff0000' } }], textExtras: { ligatures: false } });
    expect(texts(d, 'fillText')).toEqual(['a', 'b', 'c']);
    // …even on a single-style line, which would otherwise be one fillText.
    expect(texts(paint({ text: 'fi', textExtras: { ligatures: false } }), 'fillText')).toEqual(['f', 'i']);
  });

  it('a glyph an animator moves is drawn on its own', () => {
    const d = paint({ text: ARABIC, glyphs: [...ARABIC].map((c, i) => identityGlyphTransform(c, i === 2 ? { dy: 4 } : {})) });
    expect(texts(d, 'fillText')).toContain('ح');
  });
});
