/**
 * More Options: grouping pivots (character / word / line / all + alignment),
 * All Characters As One paint order, blend-mode mapping and the extras fold.
 */

import {
  groupPivots,
  layerStrokeOrder,
  interCharacterCompositeOp,
  withTextMoreOptions,
  type GroupableGlyph,
} from './textMoreOptions';
import type { SceneNode } from '@core/types';

/** "ab cd" on line 0 and "ef" on line 1, 10px glyphs, baseline y = 0 / 30. */
const glyphs: GroupableGlyph[] = [
  ...['a', 'b', ' ', 'c', 'd'].map((char, i) => ({ char, x: 5 + i * 10, y: 0, inkWidth: 10, line: 0, style: { fontSize: 20 } })),
  ...['e', 'f'].map((char, i) => ({ char, x: 5 + i * 10, y: 30, inkWidth: 10, line: 1, style: { fontSize: 20 } })),
];

describe('groupPivots', () => {
  it('character grouping with no alignment changes nothing', () => {
    expect(groupPivots(glyphs, 'character', undefined).every((p) => p === null)).toBe(true);
    expect(groupPivots(glyphs, undefined, [0, 0]).every((p) => p === null)).toBe(true);
  });

  it('character grouping alignment offsets each glyph origin by % of its own box', () => {
    expect(groupPivots(glyphs, 'character', [50, -50])[0]).toEqual({ x: 10, y: -10 });
  });

  it('word grouping: letters of a word share the word centre; spaces keep their own', () => {
    const p = groupPivots(glyphs, 'word', undefined);
    expect(p[0]).toEqual({ x: 10, y: 0 });
    expect(p[1]).toEqual({ x: 10, y: 0 });
    expect(p[2]).toBeNull();
    expect(p[3]).toEqual({ x: 40, y: 0 });
    // A new line starts a new word even without a space.
    expect(p[5]).toEqual({ x: 10, y: 30 });
  });

  it('line grouping centres on each line; all grouping on the whole block', () => {
    const line = groupPivots(glyphs, 'line', undefined);
    expect(line[0]).toEqual({ x: 25, y: 0 });
    expect(line[6]).toEqual({ x: 10, y: 30 });
    const all = groupPivots(glyphs, 'all', undefined);
    expect(new Set(all.map((p) => JSON.stringify(p))).size).toBe(1);
    expect(all[0]).toEqual({ x: 25, y: 15 });
  });

  it('grouping alignment is a % of the GROUP box', () => {
    // Word "ab": box x 0..20, y −10..10.
    expect(groupPivots(glyphs, 'word', [50, 50])[0]).toEqual({ x: 20, y: 10 });
  });
});

describe('Fill & Stroke / Inter-Character Blending', () => {
  it('All Characters As One lifts the per-character order to the layer', () => {
    expect(layerStrokeOrder('fill-over-stroke', 'allAsOne')).toBe('all-fills-over-all-strokes');
    expect(layerStrokeOrder('stroke-over-fill', 'allAsOne')).toBe('all-strokes-over-all-fills');
    expect(layerStrokeOrder('stroke-over-fill', 'perCharacter')).toBe('stroke-over-fill');
  });

  it('maps AE blend names onto canvas composite operations', () => {
    expect(interCharacterCompositeOp('normal')).toBeNull();
    expect(interCharacterCompositeOp('multiply')).toBe('multiply');
    expect(interCharacterCompositeOp('add')).toBe('lighter');
    expect(interCharacterCompositeOp('bogus')).toBeNull();
  });
});

describe('withTextMoreOptions', () => {
  const node = (props: Record<string, unknown>): SceneNode =>
    ({ id: 'n', components: [{ id: 'c', type: 'Text', props: { content: 'x', ...props } }] }) as unknown as SceneNode;

  it('leaves the extras untouched (even undefined) at every default', () => {
    expect(withTextMoreOptions(undefined, node({}), undefined, undefined)).toBeUndefined();
    const ex = { fauxBold: true };
    expect(withTextMoreOptions(ex, node({ anchorGrouping: 'character', groupingAlignX: 0 }), undefined, undefined)).toBe(ex);
  });

  it('folds non-default options, with animated alignment winning', () => {
    const n = node({ anchorGrouping: 'word', groupingAlignX: 10, fillStrokeMode: 'allAsOne', interCharacterBlending: 'screen', ligatures: false, stylisticSets: [2, 2, 30] });
    expect(withTextMoreOptions(undefined, n, 25, undefined)).toEqual({
      anchorGrouping: 'word', groupingAlign: [25, 0], fillStrokeMode: 'allAsOne', interCharacterBlending: 'screen', ligatures: false, stylisticSets: [2],
    });
  });
});
