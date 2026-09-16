/**
 * The on-canvas gizmo's geometry for a SHAPE stroke's gradient — AE's free
 * Start / End points. Unlike the fill's angle model nothing is derived: a grip
 * drag moves exactly the point it holds, and the other end stays put.
 */

import { strokeGradientAxisLocal, strokeGradientFromGripDrag } from './gradientHandles';

const G = { startX: 0.25, startY: 0.5, endX: 1, endY: 0, highlightLength: 0.3, highlightAngle: 20 };

describe('strokeGradientAxisLocal', () => {
  it('maps relative box points into the centred local px the renderer draws in', () => {
    // 200×100 box: x ∈ [−100, 100], y ∈ [−50, 50].
    expect(strokeGradientAxisLocal(G, 200, 100)).toEqual({ start: { x: -50, y: 0 }, end: { x: 100, y: -50 } });
  });
});

describe('strokeGradientFromGripDrag', () => {
  it('the END grip moves the end point only, keeping start and highlight', () => {
    expect(strokeGradientFromGripDrag(G, 'end', { x: 50, y: 25 }, 200, 100))
      .toEqual({ ...G, endX: 0.75, endY: 0.75 });
  });

  it('the START grip moves the start point only', () => {
    expect(strokeGradientFromGripDrag(G, 'start', { x: -100, y: -50 }, 200, 100))
      .toEqual({ ...G, startX: 0, startY: 0 });
  });

  it('is the inverse of the axis mapping, off the box included', () => {
    const moved = strokeGradientFromGripDrag(G, 'end', { x: 260, y: -90 }, 200, 100);
    expect(strokeGradientAxisLocal(moved, 200, 100).end).toEqual({ x: 260, y: -90 });
  });

  it('a zero-sized box leaves the points untouched instead of dividing by zero', () => {
    expect(strokeGradientFromGripDrag(G, 'end', { x: 5, y: 5 }, 0, 100)).toBe(G);
  });
});
