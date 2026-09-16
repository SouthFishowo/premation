import { normalizeStroke, readNodeStroke, defaultStroke } from './stroke';
import type { SceneNode } from '@core/types';

const node = (fxProps: Record<string, unknown> | null): SceneNode =>
  ({ id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
     transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
     components: fxProps ? [{ id: 'fx', type: 'fx', props: fxProps }] : [] } as unknown as SceneNode);

describe('normalizeStroke', () => {
  test('fills defaults for a partial stroke', () => {
    const s = normalizeStroke({ width: 8 });
    expect(s).toEqual({ enabled: true, color: '#ffffff', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
  });

  test('clamps width ≥ 0 and opacity 0..1', () => {
    expect(normalizeStroke({ width: -5 }).width).toBe(0);
    expect(normalizeStroke({ width: 3, opacity: 2 }).opacity).toBe(1);
    expect(normalizeStroke({ width: 3, opacity: -1 }).opacity).toBe(0);
  });

  test('rejects invalid enum values, keeps valid ones', () => {
    const s = normalizeStroke({ width: 2, align: 'sideways' as never, cap: 'round', join: 'bevel' });
    expect(s.align).toBe('center');
    expect(s.cap).toBe('round');
    expect(s.join).toBe('bevel');
  });

  test('filters the dash array to finite non-negative numbers', () => {
    expect(normalizeStroke({ width: 2, dash: [8, -1, NaN, 4] as number[] }).dash).toEqual([8, 4]);
  });

  test('non-object → full default', () => {
    expect(normalizeStroke(undefined)).toEqual(defaultStroke());
  });

  test('miterLimit: omitted when absent (cache-key contract), floored at 1, kept when set', () => {
    // Absent stays ABSENT — writing a default 4 into every normalised stroke
    // would change contentHash's raster cache key for every existing layer.
    expect('miterLimit' in normalizeStroke({ width: 2 })).toBe(false);
    expect(normalizeStroke({ width: 2, miterLimit: 10 }).miterLimit).toBe(10);
    // Canvas2D ignores miterLimit < 1; the model never stores one.
    expect(normalizeStroke({ width: 2, miterLimit: 0.2 }).miterLimit).toBe(1);
    expect('miterLimit' in normalizeStroke({ width: 2, miterLimit: NaN })).toBe(false);
  });
});

describe('normalizeStroke — AE stroke options', () => {
  const linear = { type: 'linear' as const, angle: 0, stops: [{ id: 'a', offset: 0, color: '#000' }, { id: 'b', offset: 1, color: '#fff' }] };

  test('composite / blend: omitted at their defaults (cache-key contract), kept otherwise', () => {
    const plain = normalizeStroke({ width: 2, composite: 'below', blendMode: 'normal' });
    expect('composite' in plain || 'blendMode' in plain).toBe(false);
    expect(normalizeStroke({ width: 2, composite: 'above', blendMode: 'multiply' })).toMatchObject({ composite: 'above', blendMode: 'multiply' });
    // A mode Canvas2D cannot draw is not stored as if it could.
    expect('blendMode' in normalizeStroke({ width: 2, blendMode: 'linear-burn' as never })).toBe(false);
  });

  test('gradient points: kept on a GRADIENT paint with finite coordinates; highlight clamped, zeros omitted', () => {
    const g = { startX: 0, startY: 0.1, endX: 1, endY: 0.9, highlightLength: 3, highlightAngle: 0 };
    expect(normalizeStroke({ width: 2, paint: linear, gradient: g }).gradient)
      .toEqual({ startX: 0, startY: 0.1, endX: 1, endY: 0.9, highlightLength: 1 });
    expect('gradient' in normalizeStroke({ width: 2, gradient: g })).toBe(false);
    expect('gradient' in normalizeStroke({ width: 2, paint: linear, gradient: { ...g, endY: NaN } })).toBe(false);
  });

  test('taper: pixel lengths are NOT clamped to 1, eases keep AE’s −1..1, percent units are not written', () => {
    const px = normalizeStroke({ width: 2, taper: { startWidth: 0.2, endWidth: 1, startLength: 80, endLength: 0, startEase: -3, endEase: 0.5, lengthUnits: 'pixels' } });
    expect(px.taper).toEqual({ startWidth: 0.2, endWidth: 1, startLength: 80, endLength: 0, startEase: -1, endEase: 0.5, lengthUnits: 'pixels' });
    const pct = normalizeStroke({ width: 2, taper: { startWidth: 0.2, endWidth: 1, startLength: 80, endLength: 0, startEase: 0, endEase: 0, lengthUnits: 'percent' } });
    expect(pct.taper).toEqual({ startWidth: 0.2, endWidth: 1, startLength: 1, endLength: 0, startEase: 0, endEase: 0 });
  });

  test('wave: Cycles is kept, Pixels (the default) is not written', () => {
    expect(normalizeStroke({ width: 2, wave: { amount: 5, wavelength: 6, phase: 0, units: 'cycles' } }).wave).toEqual({ amount: 5, wavelength: 6, phase: 0, units: 'cycles' });
    expect(normalizeStroke({ width: 2, wave: { amount: 5, wavelength: 60, phase: 0, units: 'pixels' } }).wave).toEqual({ amount: 5, wavelength: 60, phase: 0 });
  });

  test('a stroke using none of them normalises to exactly the old shape', () => {
    expect(Object.keys(normalizeStroke({ width: 3, color: '#123456' })))
      .toEqual(['enabled', 'color', 'width', 'opacity', 'align', 'dash', 'cap', 'join']);
  });
});

describe('readNodeStroke', () => {
  test('returns a normalized stroke when enabled with width > 0', () => {
    const s = readNodeStroke(node({ stroke: { width: 6, color: '#ff0000' } }));
    expect(s?.width).toBe(6);
    expect(s?.color).toBe('#ff0000');
  });

  test('undefined when disabled', () => {
    expect(readNodeStroke(node({ stroke: { width: 6, enabled: false } }))).toBeUndefined();
  });

  test('undefined when width is 0', () => {
    expect(readNodeStroke(node({ stroke: { width: 0 } }))).toBeUndefined();
  });

  test('undefined when no fx/stroke', () => {
    expect(readNodeStroke(node(null))).toBeUndefined();
  });
});
