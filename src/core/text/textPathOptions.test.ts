/**
 * Path Options: Force Alignment and Last Margin placement, the keyframeable
 * switches, and that a config without the new options places glyphs exactly
 * as before.
 */

import { applyTextPath, resolveTextPath, readTextPathConfig, parseTextPathPropPath, textPathParamValue } from './textPath';
import { arcTable } from '@core/scene/trimPath';
import type { TextLayout, PlacedGlyph } from './textLayout';
import type { SceneNode } from '@core/types';

/** A straight 200px path along +x. */
const table = arcTable([{ x: 0, y: 0 }, { x: 200, y: 0 }], false);

/** One line of `n` 10px glyphs starting at x = 0 (centres at 5, 15, …). */
function line(n: number): TextLayout {
  const glyphs: PlacedGlyph[] = Array.from({ length: n }, (_, i) => ({
    char: 'x', index: i, x: 5 + i * 10, y: 0, advance: 10, inkWidth: 10, style: { fontSize: 10 }, line: 0,
  }));
  return { glyphs, lines: [{ width: n * 10, y: 0, left: 0 }], width: n * 10, height: 12 };
}

const xs = (g: PlacedGlyph[]): number[] => g.map((p) => Math.round(p.x * 1000) / 1000);

describe('applyTextPath options', () => {
  it('without the new options, placement is the original maths', () => {
    expect(xs(applyTextPath(line(3), { table, firstMargin: 7, reversed: false, perpendicular: true }))).toEqual([12, 22, 32]);
    expect(xs(applyTextPath(line(3), { table, firstMargin: 0, reversed: false, perpendicular: true, align: 'right' }))).toEqual([175, 185, 195]);
  });

  it('Last Margin moves right-aligned text from the path end', () => {
    const g = applyTextPath(line(3), { table, firstMargin: 0, reversed: false, perpendicular: true, align: 'right', lastMargin: -20 });
    expect(xs(g)).toEqual([155, 165, 175]);
  });

  it('Force Alignment spreads the first glyph at First Margin to the last at the end + Last Margin', () => {
    const g = applyTextPath(line(3), { table, firstMargin: 10, reversed: false, perpendicular: true, forceAlignment: true, lastMargin: -10 });
    // Span 10..190 = 180; natural width 30; slack 150 shared over 2 gaps = 75.
    expect(xs(g)).toEqual([15, 100, 185]);
    // The first pen sits on First Margin and the last advance ends on the far margin.
    expect(g[0]!.x - 5).toBeCloseTo(10);
    expect(g[2]!.x + 5).toBeCloseTo(190);
  });

  it('Force Alignment centres a single character in the span', () => {
    expect(xs(applyTextPath(line(1), { table, firstMargin: 0, reversed: false, perpendicular: true, forceAlignment: true }))).toEqual([100]);
  });
});

describe('Path Options keyframes', () => {
  const node = {
    id: 'n',
    components: [{ id: 'fx', type: 'fx', props: { textPath: { pathId: '', firstMargin: 4, reversed: false, perpendicular: true, lastMargin: -8 } } }],
  } as unknown as SceneNode;

  it('reads the new options and omits them at their defaults', () => {
    expect(readTextPathConfig(node)).toEqual({ pathId: '', firstMargin: 4, reversed: false, perpendicular: true, lastMargin: -8 });
  });

  it('switches animate as 0/1 tracks with a 0.5 threshold; margins as numbers', () => {
    const tp = resolveTextPath(node, new Map([
      ['textPath.reversed', 0.7], ['textPath.perpendicular', 0.2], ['textPath.forceAlignment', 1], ['textPath.lastMargin', 12],
    ]))!;
    expect({ r: tp.reversed, p: tp.perpendicular, f: tp.forceAlignment, l: tp.lastMargin }).toEqual({ r: true, p: false, f: true, l: 12 });
  });

  it('param paths parse and read back as track values', () => {
    expect(parseTextPathPropPath('textPath.forceAlignment')).toBe('forceAlignment');
    expect(parseTextPathPropPath('textPath.nope')).toBeNull();
    const cfg = readTextPathConfig(node)!;
    expect(['firstMargin', 'lastMargin', 'reversed', 'perpendicular', 'forceAlignment'].map((p) => textPathParamValue(cfg, p as never)))
      .toEqual([4, -8, 0, 1, 0]);
  });
});
