/**
 * A stroke option's STATIC value in timeline units, and the patch that writes
 * one back — the seam `propertyValue.ts` uses for `paint.<id>.<key>`, so the
 * timeline's value fields and the first keyframe a stopwatch lays both see the
 * number the stroke is really drawn with (a stopwatch on "Brush 1 Opacity"
 * must key 60, not 0, for a 60 % stroke).
 *
 * Pure; absent v2 fields read as their defaults (Start 0 %, End 100 %,
 * Spacing 25 %, Transform = identity anchored at the first point).
 */

import type { PaintStroke, StrokeTransform } from './paintStrokes';
import type { PaintNumericKey } from './paintProps';

function first(s: Pick<PaintStroke, 'points'>): { x: number; y: number } {
  return s.points[0] ?? { x: 0, y: 0 };
}

function transformOf(s: PaintStroke): StrokeTransform {
  const p = first(s);
  return s.transform ?? { anchorX: p.x, anchorY: p.y, x: p.x, y: p.y, scale: 100, rotation: 0 };
}

export function readPaintStrokeValue(s: PaintStroke, key: PaintNumericKey): number {
  const t = transformOf(s);
  switch (key) {
    case 'start': return (s.start ?? 0) * 100;
    case 'end': return (s.end ?? 1) * 100;
    case 'diameter': return s.size;
    case 'angle': return s.angle ?? 0;
    case 'hardness': return s.hardness * 100;
    case 'roundness': return (s.roundness ?? 1) * 100;
    case 'spacing': return (s.spacing ?? 0.25) * 100;
    case 'opacity': return s.opacity * 100;
    case 'flow': return (s.flow ?? 1) * 100;
    case 'clonePositionX': return first(s).x + (s.cloneOffsetX ?? 0);
    case 'clonePositionY': return first(s).y + (s.cloneOffsetY ?? 0);
    case 'cloneTime': return s.cloneSourceTime ?? 0;
    case 'cloneTimeShift': return s.cloneTimeShift ?? 0;
    case 'anchorX': return t.anchorX;
    case 'anchorY': return t.anchorY;
    case 'positionX': return t.x;
    case 'positionY': return t.y;
    case 'scale': return t.scale;
    case 'rotation': return t.rotation;
  }
}

/** The model patch that stores `value` (timeline units) for `key`. */
export function paintStrokePatch(s: PaintStroke, key: PaintNumericKey, value: number): Partial<PaintStroke> {
  const pct = value / 100;
  const t = transformOf(s);
  switch (key) {
    case 'start': return { start: pct };
    case 'end': return { end: pct };
    case 'diameter': return { size: Math.max(0.1, value) };
    case 'angle': return { angle: value };
    case 'hardness': return { hardness: pct };
    case 'roundness': return { roundness: pct };
    case 'spacing': return { spacing: pct };
    case 'opacity': return { opacity: pct };
    case 'flow': return { flow: pct };
    case 'clonePositionX': return { cloneOffsetX: value - first(s).x };
    case 'clonePositionY': return { cloneOffsetY: value - first(s).y };
    case 'cloneTime': return { cloneLockTime: true, cloneSourceTime: value };
    case 'cloneTimeShift': return { cloneTimeShift: value };
    case 'anchorX': return { transform: { ...t, anchorX: value } };
    case 'anchorY': return { transform: { ...t, anchorY: value } };
    case 'positionX': return { transform: { ...t, x: value } };
    case 'positionY': return { transform: { ...t, y: value } };
    case 'scale': return { transform: { ...t, scale: value } };
    case 'rotation': return { transform: { ...t, rotation: value } };
  }
}
