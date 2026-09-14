/**
 * Paragraph box layout end to end: the render box a fixed box allocates, the
 * overflow flag, Auto Height, Fit Text to Box, and the painter's clip +
 * vertical alignment on BOTH draw paths.
 */

import type { SceneNode } from '@core/types';
import { identityGlyphTransform } from './textAnimators';
import {
  measureParagraphBox,
  measureTextNodeParagraphBox,
  measureTextNodeSize,
  readMeasuredTextStyle,
} from './measureText';
import { paintTextInBox, type TextPaintSpec } from '@core/rendering/raster/textPaint';
import { readGeometry, makeHitTestLocal } from '@core/workspace/geometry';
import { hasCanvas } from '../effects/__testHelpers__/canvasFidelity';

const maybe = hasCanvas ? describe : describe.skip;

const LONG = 'the quick brown fox jumps over the lazy dog and keeps running across the whole field until dusk';

function textNode(textProps: Record<string, unknown>): SceneNode {
  return {
    id: 'p', name: 'p', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'p_tr', type: 'Transform', props: { __kind: 'text', x: 200, y: 100, rotation: 0, scaleX: 1, scaleY: 1 } },
      { id: 'p_t', type: 'Text', props: { fontSize: 20, fontFamily: 'Arial', lineHeight: 1.2, ...textProps } },
    ],
  } as unknown as SceneNode;
}

// ── Painter: clip + vertical align, both paths ──────────────────────

function recordFills(spec: TextPaintSpec): Array<{ text: string; y: number }> {
  const out: Array<{ text: string; y: number }> = [];
  const state: Record<string, unknown> = { font: '', fillStyle: '', letterSpacing: '', textAlign: '', globalAlpha: 1 };
  const ctx = Object.assign(state, {
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {}, scale: () => {}, transform: () => {},
    strokeText: () => {},
    fillText: (t: string, _x: number, y: number) => out.push({ text: t, y }),
    measureText: (t: string) => ({ width: t.length * 10 }),
  });
  paintTextInBox(ctx as unknown as CanvasRenderingContext2D, spec);
  return out;
}

const base: TextPaintSpec = {
  text: 'A\nB\nC\nD', fontSize: 30, lineHeight: 1, color: '#ffffff', width: 300, height: 116,
};

describe('painter — fixed paragraph box', () => {
  it('without a box height nothing changes (legacy paragraph / point text)', () => {
    expect(recordFills(base).map((f) => f.text)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('clips lines that do not fit and top-aligns the rest (fast path)', () => {
    // 100px box, 30px lines: three fit. cy = 58; the box top is −50.
    const fills = recordFills({ ...base, textExtras: { boxHeight: 100 } });
    expect(fills.map((f) => f.text)).toEqual(['A', 'B', 'C']);
    expect(fills[0]!.y).toBeCloseTo(58 - 50 + 15, 9);
  });

  it('the per-glyph path clips and places identically', () => {
    const glyphs = [...'A\nB\nC\nD'].map((c) => identityGlyphTransform(c, { dx: 0.001 }));
    const fast = recordFills({ ...base, textExtras: { boxHeight: 100 } });
    const slow = recordFills({ ...base, glyphs, textExtras: { boxHeight: 100 } });
    expect(slow.map((f) => f.text)).toEqual(['A', 'B', 'C']);
    // Per-glyph items are translated, so their draw y is 0 — compare via the fast
    // path's baselines instead: the same three lines survive.
    expect(slow).toHaveLength(fast.length);
  });

  it('centres and bottom-aligns lines that fit', () => {
    const two = { ...base, text: 'A\nB' };
    const top = recordFills({ ...two, textExtras: { boxHeight: 100 } });
    const mid = recordFills({ ...two, textExtras: { boxHeight: 100, boxVerticalAlign: 'center' } });
    const bot = recordFills({ ...two, textExtras: { boxHeight: 100, boxVerticalAlign: 'bottom' } });
    expect(mid[0]!.y - top[0]!.y).toBeCloseTo(20, 9);
    expect(bot[0]!.y - top[0]!.y).toBeCloseTo(40, 9);
  });
});

// ── Measurement ─────────────────────────────────────────────────────

describe('render box + geometry', () => {
  it('a FIXED box allocates its authored height (plus padding), whatever the text', () => {
    const size = measureTextNodeSize(textNode({ content: LONG, boxWidth: 200, boxHeight: 60 }));
    if (!size) return; // no canvas
    expect(size.h).toBe(60 + 16);
    expect(size.w).toBe(200 + 24);
  });

  it('an EMPTY fixed box is still its full size for hit-testing and selection', () => {
    const node = textNode({ content: '', boxWidth: 220, boxHeight: 140 });
    const g = readGeometry(node)!;
    expect([g.width, g.height, g.offsetY]).toEqual([220, 140, 0]);
    const hit = makeHitTestLocal(g);
    expect(hit({ x: 109, y: 69 })).toBe(true);
    expect(hit({ x: 0, y: 72 })).toBe(false);
  });
});

maybe('paragraph box measurement (canvas)', () => {
  it('overflow is flagged when the wrapped text is taller than the box', () => {
    const tall = measureTextNodeParagraphBox(textNode({ content: LONG, boxWidth: 160, boxHeight: 50 }))!;
    expect(tall.fixedHeight).toBe(true);
    expect(tall.overflow).toBe(true);
    expect(tall.visibleLines).toBeLessThan(tall.lineCount);
    const roomy = measureTextNodeParagraphBox(textNode({ content: LONG, boxWidth: 160, boxHeight: 2000 }))!;
    expect(roomy.overflow).toBe(false);
    expect(roomy.visibleLines).toBe(roomy.lineCount);
  });

  it('Auto Height: the box height is the text height, and it grows DOWN from its authored top edge', () => {
    const legacy = textNode({ content: LONG, boxWidth: 160 });
    const auto = textNode({ content: LONG, boxWidth: 160, boxHeight: 50, boxAutoSize: 'height' });
    const m = measureTextNodeParagraphBox(auto)!;
    expect(m.fixedHeight).toBe(false);
    expect(m.overflow).toBe(false);
    expect(m.boxHeight).toBeCloseTo(m.contentHeight, 9);
    // (2026-09-13) AE keeps the box's TOP edge: the authored 50px box's top
    // stays at −25 while the text runs on below it, so the centred texture
    // grows by twice the offset. A box with no authored height (every document
    // from before box heights) still grows about its centre, exactly as before.
    expect(-m.contentHeight / 2 + m.lineOffsetY).toBeCloseTo(-25, 9);
    const legacySize = measureTextNodeSize(legacy)!;
    const autoSize = measureTextNodeSize(auto)!;
    expect(autoSize.w).toBe(legacySize.w);
    expect(autoSize.h - legacySize.h).toBeCloseTo(2 * m.lineOffsetY, 0);
    expect(measureTextNodeParagraphBox(legacy)!.lineOffsetY).toBe(0);
  });

  it('Fit Text to Box shrinks the type until everything fits', () => {
    const node = textNode({ content: LONG, boxWidth: 160, boxHeight: 50, boxAutoSize: 'fit' });
    const m = measureTextNodeParagraphBox(node)!;
    expect(m.fitScale).toBeLessThan(1);
    expect(m.fitScale).toBeGreaterThan(0.05);
    expect(m.overflow).toBe(false);
    expect(m.contentHeight).toBeLessThanOrEqual(50 + 0.5);
    // The authored font size is untouched — the scale is render-time only.
    expect(readMeasuredTextStyle(node)!.fontSize).toBe(20);
    // A fraction more type would overflow: the search found (nearly) the largest scale.
    const style = readMeasuredTextStyle(node)!;
    const bigger = measureParagraphBox({ ...style, content: LONG, softBreakLines: undefined, fitScale: Math.min(1, m.fitScale * 1.15) })!;
    expect(bigger.overflow || bigger.contentHeight > 50).toBe(true);
  });

  it('Fit Text to Box leaves text that already fits at scale 1', () => {
    const m = measureTextNodeParagraphBox(textNode({ content: 'short', boxWidth: 300, boxHeight: 200, boxAutoSize: 'fit' }))!;
    expect(m.fitScale).toBe(1);
  });

  it('vertical alignment moves the line block inside the box', () => {
    const at = (boxVerticalAlign: string) =>
      measureTextNodeParagraphBox(textNode({ content: 'one line', boxWidth: 300, boxHeight: 200, boxVerticalAlign }))!.lineOffsetY;
    expect(at('top')).toBeLessThan(0);
    expect(at('center')).toBeCloseTo(0, 9);
    expect(at('bottom')).toBeCloseTo(-at('top'), 9);
  });
});
