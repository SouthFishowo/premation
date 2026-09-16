/**
 * Animation prop paths for paint strokes — AE's Effects ▸ Paint ▸ Brush N.
 *
 *   paint.<strokeId>.<key>        numeric Stroke Options / Transform tracks
 *   paint.<strokeId>.color_r|g|b|a  the colour, as the usual channel tracks
 *   paint.<strokeId>.path         the Path, a `points` data track
 *
 * Id-scoped like mask and effect paths, so deleting or reordering a sibling
 * stroke cannot hand a keyframe to the wrong one. Units are the ones AE shows:
 * percentages for Start/End/Hardness/Roundness/Spacing/Opacity/Flow/Scale,
 * degrees for Angle/Rotation, px for Diameter/positions, seconds for times.
 * The model stores fractions; `paintTime.ts` and `propertyValue.ts` convert.
 *
 * No imports: the property registry, the static-value seam and the snapshot
 * all read this, and none of them should drag the scene graph in through it.
 */

export const PAINT_OPTION_KEYS = [
  'start', 'end', 'diameter', 'angle', 'hardness', 'roundness', 'spacing', 'opacity', 'flow',
] as const;
export const PAINT_CLONE_KEYS = ['clonePositionX', 'clonePositionY', 'cloneTime', 'cloneTimeShift'] as const;
export const PAINT_TRANSFORM_KEYS = ['anchorX', 'anchorY', 'positionX', 'positionY', 'scale', 'rotation'] as const;

export type PaintOptionKey = (typeof PAINT_OPTION_KEYS)[number];
export type PaintCloneKey = (typeof PAINT_CLONE_KEYS)[number];
export type PaintTransformKey = (typeof PAINT_TRANSFORM_KEYS)[number];
export type PaintNumericKey = PaintOptionKey | PaintCloneKey | PaintTransformKey;

const NUMERIC: ReadonlySet<string> = new Set<string>([...PAINT_OPTION_KEYS, ...PAINT_CLONE_KEYS, ...PAINT_TRANSFORM_KEYS]);

export function paintPropPath(strokeId: string, key: PaintNumericKey): string {
  return `paint.${strokeId}.${key}`;
}

export function paintColorPath(strokeId: string): string {
  return `paint.${strokeId}.color`;
}

export function paintPathProp(strokeId: string): string {
  return `paint.${strokeId}.path`;
}

/** `paint.<id>.<numeric key>` → its parts, else null (colour channels and the
 *  path are not numeric keys of their own). */
export function parsePaintPropPath(prop: string): { strokeId: string; key: PaintNumericKey } | null {
  const m = /^paint\.([^.]+)\.([A-Za-z]+)$/.exec(prop);
  if (!m || !NUMERIC.has(m[2]!)) return null;
  return { strokeId: m[1]!, key: m[2] as PaintNumericKey };
}

/** `paint.<id>.color_<c>` → its parts, else null. */
export function parsePaintColorPath(prop: string): { strokeId: string; channel: 'r' | 'g' | 'b' | 'a' } | null {
  const m = /^paint\.([^.]+)\.color_([rgba])$/.exec(prop);
  return m ? { strokeId: m[1]!, channel: m[2] as 'r' | 'g' | 'b' | 'a' } : null;
}

/** AE labels for the numeric keys. */
export const PAINT_KEY_LABEL: Readonly<Record<PaintNumericKey, string>> = {
  start: 'Start',
  end: 'End',
  diameter: 'Diameter',
  angle: 'Angle',
  hardness: 'Hardness',
  roundness: 'Roundness',
  spacing: 'Spacing',
  opacity: 'Opacity',
  flow: 'Flow',
  clonePositionX: 'Clone Position X',
  clonePositionY: 'Clone Position Y',
  cloneTime: 'Clone Time',
  cloneTimeShift: 'Clone Time Shift',
  anchorX: 'Anchor Point X',
  anchorY: 'Anchor Point Y',
  positionX: 'Position X',
  positionY: 'Position Y',
  scale: 'Scale',
  rotation: 'Rotation',
};

export const PAINT_KEY_UNIT: Readonly<Record<PaintNumericKey, string>> = {
  start: '%', end: '%', diameter: 'px', angle: '°', hardness: '%', roundness: '%', spacing: '%',
  opacity: '%', flow: '%', clonePositionX: 'px', clonePositionY: 'px', cloneTime: 's', cloneTimeShift: 's',
  anchorX: 'px', anchorY: 'px', positionX: 'px', positionY: 'px', scale: '%', rotation: '°',
};

/** AE's per-kind stroke names: "Brush 1", "Eraser 2", "Clone 1" — numbered in
 *  document order within their kind. A stored `name` wins. Lives here (not in
 *  the model module) so the property registry can name rows without importing
 *  the scene graph's mutation layer. */
export function strokeDisplayNames(
  strokes: ReadonlyArray<{ id: string; mode: 'paint' | 'erase' | 'clone'; name?: string }>,
): Map<string, string> {
  const counts = { paint: 0, erase: 0, clone: 0 };
  const out = new Map<string, string>();
  for (const s of strokes) {
    counts[s.mode] += 1;
    const base = s.mode === 'erase' ? 'Eraser' : s.mode === 'clone' ? 'Clone' : 'Brush';
    out.set(s.id, s.name ?? `${base} ${counts[s.mode]}`);
  }
  return out;
}

/** Keys stored as 0..1 fractions and animated as 0..100. */
export const PAINT_PERCENT_KEYS: ReadonlySet<PaintNumericKey> = new Set<PaintNumericKey>([
  'start', 'end', 'hardness', 'roundness', 'spacing', 'opacity', 'flow',
]);
