/**
 * Variable-font AXES — any axis a font declares, not only weight/width/slant.
 *
 * After Effects 26.0 made every variation axis of a variable font animatable
 * (up to eight per layer through text animators, plus the Properties panel).
 * This module is the model for that, and it is PURE: no scene graph, no
 * canvas, so the rasterizer can import it without dragging the editor along.
 *
 * ## Storage, and the three axes that already existed
 *
 * `wght`, `wdth` and `slnt` predate this — as `fontWeight`, `fontWidth` and
 * `fontSlant` on the Text component, each keyframeable under its own name.
 * Moving them into a map would have broken every document and keyframe that
 * uses them, so they STAY where they are: {@link axisPropPath} routes those
 * three tags to their legacy props, and every other tag lives in the
 * `fontAxes: Record<tag, number>` map, keyframed as `text.axis.<tag>`.
 *
 * ## The variation string
 *
 * {@link fontVariationString} produces exactly the string
 * `textFontVariationSettings` always produced for wght/wdth/slnt (same order,
 * same formatting) and only APPENDS the other tags — so a layer that uses none
 * of them keeps a byte-identical raster and cache key.
 */

import type { SceneNode } from '@core/types';

/** Axis tags the OpenType spec registers, with the ranges the UI falls back
 *  to when a font's own `fvar` cannot be read (no Local Font Access). */
export const REGISTERED_AXES: ReadonlyArray<{ tag: string; label: string; min: number; default: number; max: number }> = [
  { tag: 'wght', label: 'Weight', min: 1, default: 400, max: 1000 },
  { tag: 'wdth', label: 'Width', min: 50, default: 100, max: 200 },
  { tag: 'slnt', label: 'Slant', min: -90, default: 0, max: 90 },
  { tag: 'ital', label: 'Italic', min: 0, default: 0, max: 1 },
  { tag: 'opsz', label: 'Optical Size', min: 6, default: 12, max: 144 },
];

/** AE's limit on axes a text layer's animators may drive. */
export const MAX_ANIMATED_AXES = 8;

/**
 * A tag usable in a prop path: four ASCII letters/digits. The spec allows a
 * space-padded tag, but no shipping variable font uses one, and a space would
 * not survive the `ta.<i>.axis<TAG>` path grammar.
 */
export function isAxisTag(tag: unknown): tag is string {
  return typeof tag === 'string' && /^[A-Za-z0-9]{4}$/.test(tag);
}

/** The three tags that keep their pre-existing Text props. */
const LEGACY_AXIS_PROP: Readonly<Record<string, string>> = {
  wght: 'fontWeight',
  wdth: 'fontWidth',
  slnt: 'fontSlant',
};

/** Prop path an axis keyframes under. */
export function axisPropPath(tag: string): string {
  return LEGACY_AXIS_PROP[tag] ?? `text.axis.${tag}`;
}

/** The tag a `text.axis.<tag>` path names, or null. */
export function parseAxisPropPath(path: string): string | null {
  const m = /^text\.axis\.([A-Za-z0-9]{4})$/.exec(path);
  return m ? m[1]! : null;
}

/** Human label for an axis tag. */
export function axisLabel(tag: string): string {
  return REGISTERED_AXES.find((a) => a.tag === tag)?.label ?? tag;
}

/** A clean copy of a stored axis map: valid tags, finite numbers, legacy tags dropped. */
export function sanitizeAxes(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [tag, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAxisTag(tag) || LEGACY_AXIS_PROP[tag]) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[tag] = v;
  }
  return out;
}

/** The static `fontAxes` map on a node's Text component (legacy tags excluded). */
export function readFontAxesProp(node: SceneNode): Record<string, number> {
  for (const c of node.components) {
    if (c.type !== 'Text') continue;
    return sanitizeAxes((c.props as Record<string, unknown>).fontAxes);
  }
  return {};
}

/**
 * The frame's axis map: static values overridden by `text.axis.<tag>` tracks.
 * An axis that is keyframed but was never set statically still applies.
 * Undefined when there is nothing — the common case, and the byte-identical one.
 */
export function resolveFontAxes(
  node: SceneNode,
  av: ReadonlyMap<string, number> | undefined,
): Record<string, number> | undefined {
  const out = readFontAxesProp(node);
  if (av) {
    for (const [path, v] of av) {
      const tag = parseAxisPropPath(path);
      if (tag && !LEGACY_AXIS_PROP[tag] && Number.isFinite(v)) out[tag] = v;
    }
  }
  return Object.keys(out).length > 0 ? sortAxes(out) : undefined;
}

/** Deterministic key order — the map is folded into cache keys by JSON. */
function sortAxes(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k]!;
  return out;
}

/**
 * The user-space axis values a style DRAWS with, as a tag → value map — what
 * a variable font's outlines are instanced at (openType.ts `instance`). The
 * weight is the CSS weight (a variable face maps it to `wght`), the legacy
 * width/slant props are `wdth`/`slnt`, every other tag comes from `fontAxes`,
 * and animator `offsets` add on top exactly as {@link fontVariationString}
 * adds them. A tag the style never sets is absent: the font's default.
 */
export function axisValuesOf(
  base: VariationBase,
  offsets?: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const w = base.fontWeight !== undefined ? Number(base.fontWeight) : NaN;
  if (Number.isFinite(w)) out.wght = w;
  if (base.fontWidth !== undefined && Number.isFinite(base.fontWidth)) out.wdth = base.fontWidth;
  if (base.fontSlant !== undefined && Number.isFinite(base.fontSlant)) out.slnt = base.fontSlant;
  for (const [t, v] of Object.entries(base.fontAxes ?? {})) {
    if (isAxisTag(t) && !LEGACY_AXIS_PROP[t] && Number.isFinite(v)) out[t] = v;
  }
  for (const [t, v] of Object.entries(offsets ?? {})) {
    if (!isAxisTag(t) || !Number.isFinite(v) || !v) continue;
    out[t] = (out[t] ?? REGISTERED_AXES.find((a) => a.tag === t)?.default ?? 0) + v;
  }
  return out;
}

/**
 * A CSS `font-variation-settings` string (`"'wght' 700, 'wdth' 80"`) back to
 * a tag → value map. Malformed entries are skipped; `normal` is empty.
 */
export function parseVariationSettings(css: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!css) return out;
  const re = /["']([\x20-\x7e]{4})["']\s+(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const v = Number(m[2]);
    if (Number.isFinite(v)) out[m[1]!] = v;
  }
  return out;
}

export interface VariationBase {
  fontWeight?: string;
  fontWidth?: number;
  fontSlant?: number;
  fontAxes?: Readonly<Record<string, number>>;
}

/**
 * CSS `font-variation-settings` for a base style plus optional per-glyph
 * OFFSETS (a text animator's Font Axis properties).
 *
 * With no `fontAxes` and no offsets this is character-for-character the
 * legacy wght/wdth/slnt string. An offset on an axis the base does not set
 * starts from that axis's registered default (wght 400, wdth 100, …), which is
 * what the font renders when the axis is unset.
 */
export function fontVariationString(
  base: VariationBase,
  offsets?: Readonly<Record<string, number>>,
): string | undefined {
  const off = (tag: string): number => (offsets && Number.isFinite(offsets[tag]) ? offsets[tag]! : 0);
  const parts: string[] = [];
  const w = base.fontWeight !== undefined ? Number(base.fontWeight) : NaN;
  if (Number.isFinite(w)) parts.push(`'wght' ${w + off('wght')}`);
  else if (off('wght')) parts.push(`'wght' ${400 + off('wght')}`);
  if (base.fontWidth !== undefined && Number.isFinite(base.fontWidth)) parts.push(`'wdth' ${base.fontWidth + off('wdth')}`);
  else if (off('wdth')) parts.push(`'wdth' ${100 + off('wdth')}`);
  if (base.fontSlant !== undefined && Number.isFinite(base.fontSlant)) parts.push(`'slnt' ${base.fontSlant + off('slnt')}`);
  else if (off('slnt')) parts.push(`'slnt' ${off('slnt')}`);

  const tags = new Set<string>();
  for (const t of Object.keys(base.fontAxes ?? {})) if (isAxisTag(t) && !LEGACY_AXIS_PROP[t]) tags.add(t);
  for (const t of Object.keys(offsets ?? {})) if (isAxisTag(t) && !LEGACY_AXIS_PROP[t] && off(t)) tags.add(t);
  for (const t of [...tags].sort()) {
    const b = base.fontAxes?.[t];
    const start = typeof b === 'number' && Number.isFinite(b) ? b : REGISTERED_AXES.find((a) => a.tag === t)?.default ?? 0;
    parts.push(`'${t}' ${start + off(t)}`);
  }
  return parts.length ? parts.join(', ') : undefined;
}
