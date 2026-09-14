/**
 * AE's Distribute buttons as pure maths: edges, centres and equal spacing,
 * against the selection (≥3, extremes fixed) and the composition (≥2, extremes
 * flush with the frame).
 */

import { distributeBoxes, distributeMinimum, isDistributeMode, type Bounds } from './alignNodes';

const box = (x: number, y: number, w: number, h: number): Bounds => ({ x, y, w, h, cx: x + w / 2, cy: y + h / 2 });

// Deliberately out of order: the maths must sort along the axis, and return in INPUT order.
const A = box(200, 0, 20, 20); // right-most
const B = box(0, 10, 10, 10);  // left-most
const C = box(50, 30, 30, 30); // middle

describe('distributeBoxes — relative to the selection', () => {
  it('needs three layers', () => {
    expect(distributeBoxes([A, B], 'distribute-left')).toBeNull();
    expect(distributeMinimum('selection')).toBe(3);
    expect(distributeMinimum('composition')).toBe(2);
  });

  it('left edges: evenly spaced from the first left edge to the last', () => {
    const out = distributeBoxes([A, B, C], 'distribute-left')!;
    // lefts 0 · 100 · 200 — C (w 30) lands centred at 115; the extremes stay.
    expect(out[0]).toEqual({ cx: A.cx, cy: A.cy });
    expect(out[1]).toEqual({ cx: B.cx, cy: B.cy });
    expect(out[2]!.cx).toBeCloseTo(115);
    expect(out[2]!.cy).toBe(C.cy); // only the distribute axis moves
  });

  it('right edges', () => {
    const out = distributeBoxes([A, B, C], 'distribute-right')!;
    // rights 10 · 115 · 220 → C's right edge at 115, centre 100.
    expect(out[2]!.cx).toBeCloseTo(100);
    expect(out[0]!.cx).toBeCloseTo(A.cx);
  });

  it('horizontal centres', () => {
    const out = distributeBoxes([A, B, C], 'distribute-h')!;
    // centres 5 · 107.5 · 210
    expect(out[2]!.cx).toBeCloseTo(107.5);
  });

  it('horizontal spacing: equal gaps between the boxes', () => {
    const out = distributeBoxes([A, B, C], 'distribute-space-h')!;
    // span 0…220, widths 60 → two gaps of 80: C's left at 90, centre 105.
    expect(out[2]!.cx).toBeCloseTo(105);
    expect(out[1]!.cx).toBeCloseTo(B.cx);
    expect(out[0]!.cx).toBeCloseTo(A.cx);
    const lefts = [B, C, A].map((b, i) => [out[1]!, out[2]!, out[0]!][i]!.cx - b.w / 2);
    expect(lefts[1]! - (lefts[0]! + B.w)).toBeCloseTo(lefts[2]! - (lefts[1]! + C.w));
  });

  it('top / bottom edges and vertical centres move y only', () => {
    const top = distributeBoxes([A, B, C], 'distribute-top')!;
    // tops 0 (A) · 10 (B) · 30 (C) → sorted A, B, C; B lands at 15 → cy 20.
    expect(top[1]!.cy).toBeCloseTo(20);
    expect(top[1]!.cx).toBe(B.cx);
    const bottom = distributeBoxes([A, B, C], 'distribute-bottom')!;
    // bottoms 20 (A) · 20 (B) · 60 (C) → A first, C last; B's bottom at 40 → cy 35.
    expect(bottom[1]!.cy).toBeCloseTo(35);
    const mid = distributeBoxes([A, B, C], 'distribute-v')!;
    // centres 10 (A) · 15 (B) · 45 (C) → B at 27.5.
    expect(mid[1]!.cy).toBeCloseTo(27.5);
  });
});

describe('distributeBoxes — relative to the composition', () => {
  const frame = { width: 1000, height: 500 };
  const L = box(300, 0, 100, 50);
  const R = box(400, 0, 200, 50);

  it('two layers are enough, and the extremes sit flush with the frame', () => {
    const lefts = distributeBoxes([L, R], 'distribute-left', frame)!;
    expect(lefts[0]!.cx).toBeCloseTo(50);
    expect(lefts[1]!.cx).toBeCloseTo(900);
  });

  it('spacing spreads the boxes edge to edge across the frame', () => {
    const out = distributeBoxes([L, R], 'distribute-space-h', frame)!;
    expect(out[0]!.cx).toBeCloseTo(50);   // lo 0
    expect(out[1]!.cx).toBeCloseTo(900);  // lo 800, gap 700
  });
});

it('isDistributeMode separates distribute from align', () => {
  expect(isDistributeMode('distribute-space-v')).toBe(true);
  expect(isDistributeMode('left')).toBe(false);
});
