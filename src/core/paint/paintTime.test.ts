import { resolvePaintAt, strokeLiveAt } from './paintTime';
import type { PaintConfig, PaintStroke } from './paintStrokes';

const stroke = (over: Partial<PaintStroke> = {}): PaintStroke => ({
  id: 's1',
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
  color: '#ff0000',
  size: 10,
  opacity: 1,
  hardness: 1,
  mode: 'paint',
  ...over,
});

describe('Duration: a stroke lives between its in and out points', () => {
  test('constant / single frame / hidden', () => {
    expect(strokeLiveAt({ inPoint: 1 }, 0.5)).toBe(false);
    expect(strokeLiveAt({ inPoint: 1 }, 1)).toBe(true);
    expect(strokeLiveAt({ inPoint: 1, outPoint: 1 + 1 / 30 }, 1)).toBe(true);
    expect(strokeLiveAt({ inPoint: 1, outPoint: 1 + 1 / 30 }, 1 + 1 / 30)).toBe(false);
    expect(strokeLiveAt({ visible: false }, 0)).toBe(false);
  });

  test('no live stroke → no paint (the unpainted feed)', () => {
    expect(resolvePaintAt({ strokes: [stroke({ inPoint: 2 })] }, { t: 0 })).toBeUndefined();
  });
});

describe('identity is preserved when nothing applies', () => {
  test('static config comes back as the same object', () => {
    const paint: PaintConfig = { strokes: [stroke()] };
    expect(resolvePaintAt(paint, { t: 0, values: new Map([['x', 5]]) })).toBe(paint);
  });

  test('hiding one stroke keeps the other stroke object', () => {
    const a = stroke({ id: 'a' });
    const b = stroke({ id: 'b', outPoint: 1 });
    const r = resolvePaintAt({ strokes: [a, b] }, { t: 2 })!;
    expect(r.strokes).toEqual([a]);
    expect(r.strokes[0]).toBe(a);
  });
});

describe('keyframed Stroke Options, colour, transform, path', () => {
  test('percent tracks convert to fractions; diameter is px', () => {
    const values = new Map<string, number>([
      ['paint.s1.end', 50],
      ['paint.s1.opacity', 25],
      ['paint.s1.diameter', 33],
      ['paint.s1.color_g', 1],
    ]);
    const s = resolvePaintAt({ strokes: [stroke()] }, { t: 0, values })!.strokes[0]!;
    expect(s.end).toBeCloseTo(0.5);
    expect(s.opacity).toBeCloseTo(0.25);
    expect(s.size).toBe(33);
    expect(s.color).toBe('#ffff00');
  });

  test('transform tracks build a transform anchored at the first point', () => {
    const values = new Map<string, number>([['paint.s1.rotation', 45]]);
    const s = resolvePaintAt({ strokes: [stroke({ points: [{ x: 4, y: 6 }] })] }, { t: 0, values })!.strokes[0]!;
    expect(s.transform).toEqual({ anchorX: 4, anchorY: 6, x: 4, y: 6, scale: 100, rotation: 45 });
  });

  test('an animated Path replaces the points and drops per-point input', () => {
    const live = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    const s = resolvePaintAt(
      { strokes: [stroke({ pressure: [1, 1] })] },
      { t: 0, sampleData: (p) => (p === 'paint.s1.path' ? live : undefined) },
    )!.strokes[0]!;
    expect(s.points).toBe(live);
    expect(s.pressure).toBeUndefined();
  });
});

describe('clone source time', () => {
  const clone = (over: Partial<PaintStroke> = {}): PaintStroke =>
    stroke({ mode: 'clone', cloneOffsetX: 5, cloneOffsetY: 0, ...over });

  test('plain self-clone needs no source time (the snapshot path)', () => {
    const paint: PaintConfig = { strokes: [clone()] };
    expect(resolvePaintAt(paint, { t: 3, selfId: 'L' })).toBe(paint);
  });

  test('Source Time Shift and Lock Source Time', () => {
    expect(resolvePaintAt({ strokes: [clone({ cloneTimeShift: -1 })] }, { t: 3 })!.strokes[0]!.cloneTime).toBe(2);
    expect(resolvePaintAt({ strokes: [clone({ cloneLockTime: true, cloneSourceTime: 0.5 })] }, { t: 3 })!.strokes[0]!.cloneTime).toBe(0.5);
  });

  test('another layer samples at ITS time and size; naming yourself is self', () => {
    const r = resolvePaintAt(
      { strokes: [clone({ cloneSourceId: 'B' })] },
      { t: 3, selfId: 'A', layerTimeOf: () => 7, sizeOf: () => ({ width: 40, height: 30 }) },
    )!.strokes[0]!;
    expect(r.cloneTime).toBe(7);
    expect([r.cloneSourceW, r.cloneSourceH]).toEqual([40, 30]);
    const self = resolvePaintAt({ strokes: [clone({ cloneSourceId: 'A' })] }, { t: 3, selfId: 'A' })!.strokes[0]!;
    expect(self.cloneSourceId).toBeUndefined();
    expect(self.cloneTime).toBeUndefined();
  });

  test('animated Clone Position moves the offset relative to the first point', () => {
    const values = new Map<string, number>([['paint.s1.clonePositionX', 50]]);
    const r = resolvePaintAt({ strokes: [clone()] }, { t: 0, values })!.strokes[0]!;
    expect(r.cloneOffsetX).toBe(50);
  });
});
