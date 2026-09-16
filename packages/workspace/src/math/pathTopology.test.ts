/**
 * Adding and removing vertices must not move the curve — the whole point of
 * de Casteljau insertion is that the user sees a new vertex and nothing else.
 */

import type { BezierPoint } from './BezierPoint';
import { corner } from './BezierPoint';
import {
  applyPathTopology, bendSegment, deleteVertex, deleteVertices, isSmoothVertex, nearestSegmentParam,
  reversePath, rotoBezierPoints, setFirstVertex, splitSegment, transformVertices,
} from './pathTopology';

function cubic(a: BezierPoint, b: BezierPoint, t: number): { x: number; y: number } {
  const v = 1 - t;
  return {
    x: v * v * v * a.x + 3 * v * v * t * a.outX + 3 * v * t * t * b.inX + t * t * t * b.x,
    y: v * v * v * a.y + 3 * v * v * t * a.outY + 3 * v * t * t * b.inY + t * t * t * b.y,
  };
}

const A: BezierPoint = { x: 0, y: 0, inX: 0, inY: 0, outX: 30, outY: 60 };
const B: BezierPoint = { x: 100, y: 0, inX: 70, inY: 60, outX: 100, outY: 0 };

describe('splitSegment', () => {
  it('preserves the drawn curve on both sides of the new vertex', () => {
    const u = 0.3;
    const out = splitSegment([A, B], 0, u, false)!;
    expect(out).toHaveLength(3);
    for (const s of [0.1, 0.5, 0.9]) {
      const left = cubic(out[0]!, out[1]!, s);
      const onOriginal = cubic(A, B, s * u);
      expect(left.x).toBeCloseTo(onOriginal.x, 9);
      expect(left.y).toBeCloseTo(onOriginal.y, 9);
      const right = cubic(out[1]!, out[2]!, s);
      const onOriginal2 = cubic(A, B, u + s * (1 - u));
      expect(right.x).toBeCloseTo(onOriginal2.x, 9);
      expect(right.y).toBeCloseTo(onOriginal2.y, 9);
    }
  });

  it('splits a closed outline\'s CLOSING segment by appending, fixing the first vertex\'s in-handle', () => {
    const square = [corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)];
    const out = splitSegment(square, 3, 0.5, true)!;
    expect(out).toHaveLength(5);
    expect(out[4]).toMatchObject({ x: 0, y: 5 });
    // Straight segment: the shortened handles stay on the line.
    expect(out[0]!.inX).toBeCloseTo(0);
    expect(out[3]!.outX).toBeCloseTo(0);
  });

  it('refuses a segment that does not exist, or an end parameter', () => {
    const open = [corner(0, 0), corner(10, 0)];
    expect(splitSegment(open, 1, 0.5, false)).toBeNull(); // no closing segment
    expect(splitSegment(open, 0, 0, false)).toBeNull();
    expect(splitSegment(open, 0, 1, false)).toBeNull();
  });

  it('keeps extra per-vertex data on the neighbours', () => {
    const pts = [{ ...corner(0, 0), feather: 4 }, { ...corner(10, 0), feather: 2 }] as BezierPoint[];
    const out = splitSegment(pts, 0, 0.5, false)! as Array<BezierPoint & { feather?: number }>;
    expect(out[0]!.feather).toBe(4);
    expect(out[2]!.feather).toBe(2);
  });
});

describe('deleteVertex / applyPathTopology', () => {
  it('removes one vertex and never leaves fewer than two', () => {
    const tri = [corner(0, 0), corner(10, 0), corner(5, 8)];
    expect(deleteVertex(tri, 1)!.map((p) => p.x)).toEqual([0, 5]);
    expect(deleteVertex(tri.slice(0, 2), 0)).toBeNull();
    expect(deleteVertex(tri, 7)).toBeNull();
  });

  it('replays the same edit on a differently-shaped keyframe', () => {
    const small = [corner(0, 0), corner(10, 0), corner(10, 10)];
    const big = [corner(0, 0), corner(40, 0), corner(40, 40)];
    const edit = { op: 'insert', segment: 1, u: 0.5 } as const;
    expect(applyPathTopology(small, edit, false)![2]).toMatchObject({ x: 10, y: 5 });
    expect(applyPathTopology(big, edit, false)![2]).toMatchObject({ x: 40, y: 20 });
  });
});

describe('nearestSegmentParam', () => {
  it('finds the segment and parameter under a point on the curve', () => {
    const on = cubic(A, B, 0.62);
    const hit = nearestSegmentParam([A, B], false, on)!;
    expect(hit.segment).toBe(0);
    expect(hit.u).toBeCloseTo(0.62, 4);
    expect(hit.distance).toBeLessThan(1e-4);
  });

  it('only considers the closing segment when the outline is closed', () => {
    const square = [corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)];
    expect(nearestSegmentParam(square, true, { x: 0, y: 5 })!.segment).toBe(3);
    expect(nearestSegmentParam(square, false, { x: 0, y: 5 })!.distance).toBeGreaterThan(4);
  });
});

describe('structural edits beyond insert / delete', () => {
  const square = (): BezierPoint[] => [corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)];

  it('deleteVertices drops several at once and refuses to leave < 2', () => {
    expect(deleteVertices(square(), [1, 3])!.map((p) => p.x)).toEqual([0, 10]);
    expect(deleteVertices(square(), [0, 1, 2])).toBeNull();
    expect(deleteVertices(square(), [7])).toBeNull();
  });

  it('reversePath walks the same curve backwards (handles swap)', () => {
    const r = reversePath([A, B]);
    expect(r[0]).toMatchObject({ x: 100, y: 0, inX: 100, inY: 0, outX: 70, outY: 60 });
    for (const s of [0.2, 0.5, 0.8]) {
      const fwd = cubic(A, B, s);
      const back = cubic(r[0]!, r[1]!, 1 - s);
      expect(back.x).toBeCloseTo(fwd.x, 9);
      expect(back.y).toBeCloseTo(fwd.y, 9);
    }
  });

  it('setFirstVertex rotates a closed outline and reverses an open one from its far end', () => {
    expect(setFirstVertex(square(), 2, true)!.map((p) => [p.x, p.y])).toEqual([[10, 10], [0, 10], [0, 0], [10, 0]]);
    expect(setFirstVertex(square(), 3, false)![0]).toMatchObject({ x: 0, y: 10 });
    expect(setFirstVertex(square(), 1, false)).toBeNull();
  });

  it('applyPathTopology replays every op, including extend at either end', () => {
    expect(applyPathTopology(square(), { op: 'reverse' }, true)![0]).toMatchObject({ x: 0, y: 10 });
    expect(applyPathTopology(square(), { op: 'firstVertex', index: 1 }, true)![0]).toMatchObject({ x: 10, y: 0 });
    expect(applyPathTopology(square(), { op: 'deleteMany', indices: [0] }, true)).toHaveLength(3);
    const tail = applyPathTopology(square(), { op: 'extend', points: [corner(-5, 5)], atStart: false }, false)!;
    expect(tail[4]).toMatchObject({ x: -5, y: 5 });
    const head = applyPathTopology(square(), { op: 'extend', points: [corner(-5, 5)], atStart: true }, false)!;
    expect(head[0]).toMatchObject({ x: -5, y: 5 });
    expect(head).toHaveLength(5);
  });

  it('the extra per-vertex fields survive every edit', () => {
    const pts = square().map((p, i) => ({ ...p, broken: i === 1, tension: 0.5 }));
    expect(reversePath(pts)[2]!.broken).toBe(true);
    expect(setFirstVertex(pts, 1, true)![0]!.broken).toBe(true);
  });
});

describe('bendSegment', () => {
  it('moves the curve point under the grab by exactly the drag', () => {
    const line = [corner(0, 0), corner(100, 0)];
    const u = 0.4;
    const out = bendSegment(line, 0, u, { x: 0, y: 30 }, false)!;
    const p = cubic(out[0]!, out[1]!, u);
    const before = cubic(line[0]!, line[1]!, u);
    expect(p.x).toBeCloseTo(before.x, 9);
    expect(p.y).toBeCloseTo(30, 9);
    // The end vertices stay put.
    expect(out[0]).toMatchObject({ x: 0, y: 0 });
    expect(out[1]).toMatchObject({ x: 100, y: 0 });
  });

  it('keeps a smooth neighbour smooth, and leaves a broken one alone', () => {
    const smoothA: BezierPoint = { x: 0, y: 0, inX: -20, inY: 0, outX: 20, outY: 0 };
    const out = bendSegment([smoothA, corner(100, 0)], 0, 0.5, { x: 0, y: 40 }, false)!;
    expect(isSmoothVertex(out[0]!)).toBe(true);
    expect(Math.hypot(out[0]!.inX, out[0]!.inY)).toBeCloseTo(20, 9); // length kept

    const brokenA = { ...smoothA, broken: true };
    const b = bendSegment([brokenA, corner(100, 0)], 0, 0.5, { x: 0, y: 40 }, false)!;
    expect(b[0]).toMatchObject({ inX: -20, inY: 0 });
  });
});

describe('rotoBezierPoints', () => {
  it('computes chord-aligned handles from the neighbours, scaled by tension', () => {
    const diamond = [corner(0, -10), corner(10, 0), corner(0, 10), corner(-10, 0)];
    const out = rotoBezierPoints(diamond, true);
    // Vertex 1: chord from (0,-10) to (0,10) is vertical; its segments are √200 long.
    expect(out[1]!.outX - out[1]!.x).toBeCloseTo(0, 9);
    expect(out[1]!.outY - out[1]!.y).toBeCloseTo(Math.SQRT2 * 10 / 3, 9);
    const tight = rotoBezierPoints(diamond.map((p) => ({ ...p, tension: 1 })), true);
    expect(tight[1]).toMatchObject({ inX: 10, inY: 0, outX: 10, outY: 0 });
  });

  it('leaves an open path\'s ends as corners', () => {
    const out = rotoBezierPoints([corner(0, 0), corner(50, 50), corner(100, 0)], false);
    expect(out[0]).toMatchObject({ outX: 0, outY: 0 });
    expect(out[1]!.outX).toBeGreaterThan(50);
  });
});

describe('transformVertices', () => {
  it('maps only the listed vertices, handles included', () => {
    const pts: BezierPoint[] = [{ x: 1, y: 0, inX: 0, inY: 0, outX: 2, outY: 0 }, corner(5, 5)];
    const out = transformVertices(pts, [0], { a: 2, b: 0, c: 0, d: 2, e: 10, f: 0 });
    expect(out[0]).toMatchObject({ x: 12, inX: 10, outX: 14 });
    expect(out[1]).toMatchObject({ x: 5, y: 5 });
  });
});
