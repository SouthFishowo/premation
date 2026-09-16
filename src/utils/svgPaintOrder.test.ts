/**
 * SVG `paint-order` → the fill's Composite.
 *
 * `paint-order: stroke` paints the stroke first, so the fill covers its inner
 * half — which is exactly a fill set Composite "Above Previous". Absent (or
 * `normal`, or `fill stroke`) is the default order and must not mark anything,
 * or every imported outline would change look.
 */

import { parseSvgToShapes } from './svgParser';

const svg = (attrs: string, groupAttrs = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g ${groupAttrs}><rect x="10" y="10" width="80" height="60" fill="#224488" stroke="#ffcc00" stroke-width="12" ${attrs}/></g></svg>`;

const first = (content: string) => parseSvgToShapes(content)[0]!;

describe('paint-order', () => {
  it.each([
    ['paint-order="stroke"'],
    ['paint-order="stroke fill"'],
    ['paint-order="markers stroke"'],
    ['style="paint-order: stroke"'],
  ])('%s puts the fill above the stroke', (attr) => {
    expect(first(svg(attr)).fillAboveStroke).toBe(true);
  });

  it.each([
    [''],
    ['paint-order="normal"'],
    ['paint-order="fill"'],
    ['paint-order="fill stroke markers"'],
  ])('"%s" keeps the default order', (attr) => {
    expect(first(svg(attr)).fillAboveStroke).toBeUndefined();
  });

  it('is inherited from a group', () => {
    expect(first(svg('', 'paint-order="stroke"')).fillAboveStroke).toBe(true);
  });

  it('means nothing without a stroke', () => {
    const noStroke = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="0" y="0" width="50" height="50" fill="#fff" paint-order="stroke"/></svg>';
    expect(first(noStroke).fillAboveStroke).toBeUndefined();
  });
});
