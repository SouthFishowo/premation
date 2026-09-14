/**
 * Ruler guides as DOCUMENT data (AE 26.5 guide upgrade).
 *
 * The workspace engine keeps a guide as a world position on one axis. After
 * Effects 26.5 lets a guide carry three more facts, and they change what the
 * position MEANS when the composition is resized:
 *
 *  • `unit`  — `px` keeps an absolute distance; `%` keeps a fraction of the
 *              comp's width (vertical guide) or height (horizontal guide).
 *  • `edge`  — `start` measures from the left/top edge; `end` from the
 *              right/bottom, so a guide pinned to the end keeps its distance
 *              from that edge when the comp grows or shrinks.
 *  • `color` — a per-guide stroke colour (absent = the theme guide colour).
 *
 * Composition space is world space here: the comp occupies (0,0)–(w,h), the
 * same frame every canvas insert uses (`setNodeWorldPosition(world)`).
 *
 * A stored guide keeps `value` IN ITS OWN UNIT FROM ITS OWN EDGE — that is the
 * invariant that survives a resize. Missing fields read as px / start / default
 * colour, so documents written before this existed load unchanged.
 */

export type GuideUnit = 'px' | '%';
export type GuideEdge = 'start' | 'end';

export interface CompExtent {
  w: number;
  h: number;
}

/** A user guide as persisted in the document (see `GuidesSettings.userGuides`). */
export interface StoredGuide {
  /** 'x' = vertical line (x position), 'y' = horizontal line (y position). */
  axis: 'x' | 'y';
  /** Distance from `edge`, in `unit`. */
  value: number;
  unit: GuideUnit;
  edge: GuideEdge;
  color?: string;
  locked?: boolean;
}

/** The comp dimension a guide on `axis` measures along. */
function extentFor(axis: 'x' | 'y', comp: CompExtent): number {
  return axis === 'x' ? comp.w : comp.h;
}

/** World position → the guide's own value (unit + edge), for a comp size. */
export function guideValueFromPosition(
  position: number,
  axis: 'x' | 'y',
  unit: GuideUnit,
  edge: GuideEdge,
  comp: CompExtent,
): number {
  const size = extentFor(axis, comp);
  const fromEdge = edge === 'end' ? size - position : position;
  if (unit === '%') return size > 0 ? (fromEdge / size) * 100 : 0;
  return fromEdge;
}

/** The guide's own value → world position, for a comp size. */
export function guidePositionFromValue(
  value: number,
  axis: 'x' | 'y',
  unit: GuideUnit,
  edge: GuideEdge,
  comp: CompExtent,
): number {
  const size = extentFor(axis, comp);
  const fromEdge = unit === '%' ? (value / 100) * size : value;
  return edge === 'end' ? size - fromEdge : fromEdge;
}

/**
 * Where a guide at `position` belongs after the comp is resized from `from`
 * to `to`. A px/start guide never moves (AE's classic behaviour); everything
 * else keeps its value in its own unit from its own edge.
 */
export function resolveGuideOnResize(
  position: number,
  axis: 'x' | 'y',
  unit: GuideUnit,
  edge: GuideEdge,
  from: CompExtent,
  to: CompExtent,
): number {
  if (unit === 'px' && edge === 'start') return position;
  const value = guideValueFromPosition(position, axis, unit, edge, from);
  return guidePositionFromValue(value, axis, unit, edge, to);
}

/** The subset of the engine's Guide this module reads (kept structural). */
export interface GuideLike {
  axis: 'x' | 'y';
  position: number;
  locked?: boolean;
  unit?: GuideUnit;
  edge?: GuideEdge;
  color?: string;
}

/** Engine guide → stored form, for a comp size. Defaults are omitted. */
export function toStoredGuide(g: GuideLike, comp: CompExtent): StoredGuide {
  const unit = g.unit ?? 'px';
  const edge = g.edge ?? 'start';
  const raw = guideValueFromPosition(g.position, g.axis, unit, edge, comp);
  const out: StoredGuide = {
    axis: g.axis,
    // Rounded to 1/1000 so a float round-trip does not churn the document.
    value: Math.round(raw * 1000) / 1000,
    unit,
    edge,
  };
  if (g.color) out.color = g.color;
  if (g.locked) out.locked = true;
  return out;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Keep only well-formed guides — a document is untrusted input. */
export function sanitizeStoredGuides(raw: unknown): StoredGuide[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredGuide[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const g = item as Partial<StoredGuide> & { position?: unknown };
    if (g.axis !== 'x' && g.axis !== 'y') continue;
    // `position` is accepted as a legacy spelling of a px/start value.
    const value = typeof g.value === 'number' ? g.value : typeof g.position === 'number' ? g.position : NaN;
    if (!Number.isFinite(value)) continue;
    const guide: StoredGuide = {
      axis: g.axis,
      value,
      unit: g.unit === '%' ? '%' : 'px',
      edge: g.edge === 'end' ? 'end' : 'start',
    };
    if (typeof g.color === 'string' && HEX_COLOR.test(g.color)) guide.color = g.color;
    if (g.locked === true) guide.locked = true;
    out.push(guide);
  }
  return out;
}

/** Stable comparison key for two stored guide lists. */
export function storedGuidesKey(list: readonly StoredGuide[]): string {
  return JSON.stringify(list);
}

/** Preset swatches offered by the guide editor (null = theme default). */
export const GUIDE_COLOR_PRESETS: ReadonlyArray<{ id: string; label: string; color: string | null }> = [
  { id: 'default', label: 'Default', color: null },
  { id: 'red', label: 'Red', color: '#e5484d' },
  { id: 'orange', label: 'Orange', color: '#f76b15' },
  { id: 'yellow', label: 'Yellow', color: '#ffc53d' },
  { id: 'green', label: 'Green', color: '#46a758' },
  { id: 'blue', label: 'Blue', color: '#3e63dd' },
  { id: 'magenta', label: 'Magenta', color: '#d6409f' },
];
