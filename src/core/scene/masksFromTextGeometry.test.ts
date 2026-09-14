import { flattenContour, glyphContoursToMaskPaths, polygonArea, polygonContains, type OutlinePoint } from './masksFromTextGeometry';

const corner = (x: number, y: number): OutlinePoint => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const square = (x: number, y: number, s: number) => ({
  points: [corner(x, y), corner(x + s, y), corner(x + s, y + s), corner(x, y + s)],
});
const id = (x: number, y: number) => [x, y] as const;

describe('glyphContoursToMaskPaths', () => {
  it('an "O": outer ring → Add, counter → Subtract, holes after their outers', () => {
    // Given hole FIRST, as some fonts store it.
    const paths = glyphContoursToMaskPaths([square(20, 20, 60), square(0, 0, 100)], id, (i) => `m${i}`);
    expect(paths.map((p) => [p.mode, p.points[0]!.x])).toEqual([['add', 0], ['subtract', 20]]);
    expect(paths.map((p) => p.id)).toEqual(['m0', 'm1']);
    expect(paths.every((p) => p.closed && p.feather === 0 && p.opacity === 1 && !p.inverted)).toBe(true);
  });

  it('an island inside a counter (®) is Add again; separate glyphs are all Add', () => {
    const paths = glyphContoursToMaskPaths(
      [square(0, 0, 100), square(10, 10, 80), square(40, 40, 20), square(200, 0, 50)],
      id,
      (i) => `m${i}`,
    );
    expect(paths.map((p) => p.mode)).toEqual(['add', 'add', 'subtract', 'add']);
  });

  it('maps anchors AND handles through the point map (text space → solid space)', () => {
    const curved = {
      points: [
        { x: 0, y: 0, inX: -5, inY: 0, outX: 5, outY: 0 },
        { x: 10, y: 0, inX: 10, inY: 0, outX: 10, outY: 5 },
        { x: 10, y: 10, inX: 10, inY: 10, outX: 10, outY: 10 },
      ],
    };
    const [p] = glyphContoursToMaskPaths([curved], (x, y) => [x * 2 - 960, y * 2 - 540], () => 'm');
    expect(p!.points[0]).toEqual({ x: -960, y: -540, inX: -970, inY: -540, outX: -950, outY: -540 });
  });

  it('skips degenerate contours', () => {
    const flat = { points: [corner(0, 0), corner(10, 0), corner(20, 0)] };
    const two = { points: [corner(0, 0), corner(1, 1)] };
    expect(glyphContoursToMaskPaths([flat, two], id, () => 'm')).toEqual([]);
  });
});

describe('polygon helpers', () => {
  it('flatten, contain, area', () => {
    const poly = flattenContour(square(0, 0, 10).points);
    expect(polygonArea(poly)).toBe(100);
    expect(polygonContains(poly, 5, 5)).toBe(true);
    expect(polygonContains(poly, 15, 5)).toBe(false);
  });
});
