/**
 * Grapheme clusters as the ONE per-character index space — runs, selectors,
 * animators — plus the read-time migration of legacy code-point runs.
 */

import { readRuns, reindexRuns, migrateCodePointRuns, RUNS_INDEX_PROP, RUNS_INDEX_GRAPHEME } from './richText';
import { unitPositions } from './textSelectors';
import { evaluateTextAnimators, offsetCharacter } from './textAnimators';
import type { SceneNode } from '@core/types';

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 5 code points
const red = { fill: '#ff0000' };

const textNode = (props: Record<string, unknown>): SceneNode =>
  ({ id: 'n', components: [{ id: 'c', type: 'Text', props }] }) as unknown as SceneNode;

describe('run migration (code points → graphemes)', () => {
  it('leaves ordinary text alone', () => {
    const runs = [{ start: 1, end: 3, style: red }];
    expect(migrateCodePointRuns(runs, 'hello')).toEqual(runs);
  });

  it('shifts a legacy run after an emoji so it styles the same letters', () => {
    // 'x👨‍👩‍👧ab': legacy code points put 'a' at 6; as graphemes it is 2.
    const node = textNode({ content: `x${FAMILY}ab`, __runs: [{ start: 6, end: 8, style: red }] });
    expect(readRuns(node)).toEqual([{ start: 2, end: 4, style: red }]);
  });

  it('a legacy run over PART of an emoji keeps the whole cluster', () => {
    expect(migrateCodePointRuns([{ start: 2, end: 3, style: red }], `x${FAMILY}`)).toEqual([
      { start: 1, end: 2, style: red },
    ]);
  });

  it('does not convert runs already stamped as grapheme-indexed', () => {
    const node = textNode({
      content: `x${FAMILY}ab`,
      __runs: [{ start: 2, end: 4, style: red }],
      [RUNS_INDEX_PROP]: RUNS_INDEX_GRAPHEME,
    });
    expect(readRuns(node)).toEqual([{ start: 2, end: 4, style: red }]);
  });

  it('reindexes across an edit by clusters', () => {
    // Inserting one emoji before the run shifts it by exactly ONE character.
    expect(reindexRuns([{ start: 1, end: 2, style: red }], 'ab', `${FAMILY}ab`)).toEqual([
      { start: 2, end: 3, style: red },
    ]);
  });
});

describe('selectors and animators count clusters', () => {
  it('unitPositions treats a decomposed accent as one character', () => {
    const u = unitPositions('éb c', 'characters');
    expect(u.count).toBe(4);
    expect(unitPositions(`${FAMILY}${FAMILY}`, 'charactersExcludingSpaces').count).toBe(2);
  });

  it('evaluateTextAnimators emits one transform per cluster', () => {
    const g = evaluateTextAnimators(`${FAMILY}ab`, []);
    expect(g.map((t) => t.char)).toEqual([FAMILY, 'a', 'b']);
  });

  it('Character Offset never rebuilds a multi-code-point cluster', () => {
    expect(offsetCharacter('é', 1)).toBe('é');
    expect(offsetCharacter('a', 1)).toBe('b');
  });
});
