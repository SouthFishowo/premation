import {
  arcLengths,
  hasStrokeTransform,
  identityStrokeTransform,
  pointAtLength,
  sampleAttr,
  strokeDabs,
  strokeTransformMatrix,
  tiltToTip,
  trimPolyline,
  usesDabs,
} from './paintDabs';
import type { PaintStroke } from './paintStrokes';

const line = (over: Partial<PaintStroke> = {}): PaintStroke => ({
  id: 's',
  points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
  color: '#fff',
  size: 20,
  opacity: 1,
  hardness: 1,
  mode: 'paint',
  spacing: 0.25,
  ...over,
});

describe('arc length + trim', () => {
  test('cumulative lengths and point lookup', () => {
    const pts = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }];
    const s = arcLengths(pts);
    expect(Array.from(s)).toEqual([0, 5, 15]);
    expect(pointAtLength(pts, s, 10)).toEqual({ x: 3, y: 9, u: 1.5 });
  });

  test('untrimmed returns the same array; trim cuts by arc length', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
    expect(trimPolyline(pts, 0, 1)).toBe(pts);
    expect(trimPolyline(pts, 0.25, 0.75)).toEqual([{ x: 25, y: 0 }, { x: 50, y: 0 }, { x: 75, y: 0 }]);
    expect(trimPolyline(pts, 0.6, 0.4)).toBeNull();
  });

  test('sampleAttr interpolates per-point input', () => {
    expect(sampleAttr([0, 1], 0.5, 9)).toBeCloseTo(0.5);
    expect(sampleAttr(undefined, 0.5, 9)).toBe(9);
  });
});

describe('strokeDabs', () => {
  test('one dab per spacing interval, ending exactly at the end', () => {
    const dabs = strokeDabs(line()); // step 5 over 100 px
    expect(dabs).toHaveLength(21);
    expect(dabs[0]!.x).toBe(0);
    expect(dabs[dabs.length - 1]!.x).toBe(100);
  });

  test('Start/End trim what is placed (write-on)', () => {
    const dabs = strokeDabs(line({ start: 0, end: 0.5 }));
    expect(Math.max(...dabs.map((d) => d.x))).toBe(50);
    expect(strokeDabs(line({ start: 0.5, end: 0.25 }))).toEqual([]);
  });

  test('a single point is one dab', () => {
    expect(strokeDabs(line({ points: [{ x: 3, y: 4 }] }))).toHaveLength(1);
  });

  test('pressure drives size above Minimum Size, and opacity/flow per dab', () => {
    const s = line({
      pressure: [0, 1],
      dynamics: { size: 'pressure', opacity: 'pressure', minSize: 0.2 },
      flow: 0.5,
    });
    const dabs = strokeDabs(s);
    expect(dabs[0]!.size).toBeCloseTo(20 * 0.2);
    expect(dabs[dabs.length - 1]!.size).toBeCloseTo(20);
    expect(dabs[0]!.alpha).toBeCloseTo(0);
    expect(dabs[dabs.length - 1]!.alpha).toBeCloseTo(0.5);
  });

  test('tilt drives angle and roundness', () => {
    expect(tiltToTip(0, 0)).toEqual({ angle: 0, roundness: 1 });
    const t = tiltToTip(0, 45);
    expect(t.angle).toBeCloseTo(90);
    expect(t.roundness).toBeCloseTo(0.5);
    const dabs = strokeDabs(line({ tiltX: [0, 0], tiltY: [45, 45], dynamics: { angle: 'tilt', roundness: 'tilt' }, angle: 10 }));
    expect(dabs[0]!.angle).toBeCloseTo(100);
    expect(dabs[0]!.roundness).toBeCloseTo(0.5);
  });

  test('a degenerate spacing cannot explode the dab count', () => {
    expect(strokeDabs(line({ spacing: 0.0001, size: 0.001 }), 0.25).length).toBeLessThanOrEqual(402);
  });
});

describe('stroke transform + renderer choice', () => {
  test('identity is not a transform; rotation about the anchor', () => {
    expect(hasStrokeTransform(identityStrokeTransform({ x: 5, y: 5 }))).toBe(false);
    const m = strokeTransformMatrix({ anchorX: 10, anchorY: 0, x: 10, y: 0, scale: 200, rotation: 90 });
    // (20,0) is 10 right of the anchor → rotated 90° and doubled: (10, 20).
    expect(m[0] * 20 + m[2] * 0 + m[4]).toBeCloseTo(10);
    expect(m[1] * 20 + m[3] * 0 + m[5]).toBeCloseTo(20);
  });

  test('v1 strokes stay on the continuous path; spacing/roundness/flow switch to dabs', () => {
    expect(usesDabs({})).toBe(false);
    expect(usesDabs({ spacing: 0.25 })).toBe(true);
    expect(usesDabs({ roundness: 0.5 })).toBe(true);
    expect(usesDabs({ flow: 0.3 })).toBe(true);
    // Dynamics without recorded input change nothing.
    expect(usesDabs({ dynamics: { size: 'pressure' } })).toBe(false);
    expect(usesDabs({ dynamics: { size: 'pressure' }, pressure: [1] })).toBe(true);
  });
});
