/**
 * Paragraph-box leftovers: the overflow flag reads the painter's per-line
 * metrics (a run that raises the size or leading), and text on a path is
 * point text — no box height, fit or alignment reaches it.
 */

import type { SceneNode } from '@core/types';
import { layoutText, paragraphLineMetrics, type TextStyle } from './textLayout';
import { placeLinesInBox, readParagraphBox, textExtrasForNode } from './textExtras';
import { measureParagraphBox, readMeasuredTextStyle } from './measureText';

function textNode(textProps: Record<string, unknown>, extra: SceneNode['components'] = []): SceneNode {
  return {
    id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'n_t', type: 'Text', props: { fontFamily: 'Arial', fontWeight: '400', ...textProps } },
      ...extra,
    ],
  } as unknown as SceneNode;
}

describe('placeLinesInBox with per-line line boxes', () => {
  it('a number and the same number per line agree exactly', () => {
    const ys = [-24, 0, 24];
    expect(placeLinesInBox(ys, 24, 60, 'center')).toEqual(placeLinesInBox(ys, [24, 24, 24], 60, 'center'));
  });

  it('a taller last line box is what overflows', () => {
    const ys = [-10, 10];
    expect(placeLinesInBox(ys, [20, 20], 40, undefined).overflow).toBe(false);
    const tall = placeLinesInBox(ys, [20, 40], 40, undefined);
    expect(tall.overflow).toBe(true);
    expect(tall.visible).toBe(1);
  });
});

describe('paragraphLineMetrics is layoutText’s line stack', () => {
  const measure = (): number => 10;
  const base: TextStyle & { lineHeight: number } = { fontSize: 20, lineHeight: 1.2 };

  it.each([
    ['a run raising the font size', [{ start: 4, end: 5, style: { fontSize: 40 } }]],
    ['a run with its own leading', [{ start: 2, end: 3, style: { fontSize: 30, lineHeight: 2 } }]],
    ['no runs', []],
  ])('%s', (_label, runs) => {
    const laid = layoutText('a\nb\nc', base, measure, { boxWidth: 200, runs });
    const m = paragraphLineMetrics('a\nb\nc', base, runs, undefined);
    expect(m.ys).toEqual(laid.lines.map((l) => l.y));
    expect(m.blockHeight).toBeCloseTo(laid.height, 9);
    const last = laid.lines[laid.lines.length - 1]!.y - laid.lines[0]!.y;
    expect(m.leading).toEqual(laid.lineLeading ?? laid.lines.map(() => laid.height - last));
  });
});

describe('measureParagraphBox overflow follows character runs', () => {
  const props = { content: 'a\nb\nc', fontSize: 20, lineHeight: 1.2, boxWidth: 300, boxHeight: 80, boxAutoSize: 'off' };

  it('three 24px lines fit an 80px box', () => {
    const style = readMeasuredTextStyle(textNode(props))!;
    expect(measureParagraphBox(style)!.overflow).toBe(false);
  });

  it('a run that doubles the size of one character makes the same text overflow', () => {
    const node = textNode({ ...props, __runsIndex: 'grapheme', __runs: [{ start: 4, end: 5, style: { fontSize: 40 } }] });
    const box = measureParagraphBox(readMeasuredTextStyle(node)!)!;
    expect(box.overflow).toBe(true);
    expect(box.visibleLines).toBe(1);
  });

  it('a run that only recolours changes nothing (and keeps the style key)', () => {
    const node = textNode({ ...props, __runs: [{ start: 0, end: 5, style: { fill: '#ff0000' } }] });
    const style = readMeasuredTextStyle(node)!;
    expect(style.lineRuns).toBeUndefined();
    expect(measureParagraphBox(style)!.overflow).toBe(false);
  });
});

describe('text on a path is point text', () => {
  const path = [{ id: 'n_fx', type: 'fx', props: { textPath: { pathId: '', firstMargin: 0, reversed: false, perpendicular: false } } }];
  const boxed = { content: 'On a path', fontSize: 20, boxWidth: 300, boxHeight: 40, boxVerticalAlign: 'bottom', boxAutoSize: 'fit' };

  it('has no paragraph box, so no box height, fit or alignment reaches the painter', () => {
    const node = textNode(boxed, path as unknown as SceneNode['components']);
    expect(readParagraphBox(node)).toBeNull();
    const ex = textExtrasForNode(node) ?? {};
    expect(ex.boxHeight).toBeUndefined();
    expect(ex.boxVerticalAlign).toBeUndefined();
    expect(ex.fitScale).toBeUndefined();
    expect(readMeasuredTextStyle(node)!.boxHeight).toBeUndefined();
  });

  it('the same layer without the path keeps its box', () => {
    expect(readParagraphBox(textNode(boxed))).not.toBeNull();
  });
});
