/**
 * AE's Text ▸ More Options, per layer: Anchor Point Grouping, Grouping
 * Alignment, Fill & Stroke, Inter-Character Blending.
 *
 * Stored as flat props on the Text component (`anchorGrouping`,
 * `groupingAlignX`/`groupingAlignY` — both keyframeable — `fillStrokeMode`,
 * `interCharacterBlending`) and carried to the painter inside `TextExtras`,
 * emitted only when non-default, so a layer that uses none of them keeps its
 * exact cache key and pixels.
 *
 * Pure: the grouping maths ({@link groupPivots}) takes placed glyphs and
 * returns each glyph's transform ORIGIN, which is what grouping changes —
 * every character still takes its own selector amount (AE's behaviour), but a
 * word rotates about the word's centre instead of each letter about its own.
 */

import type { SceneNode } from '@core/types';
import type { StrokeOrder, TextExtras } from './textExtras';

export type AnchorGrouping = 'character' | 'word' | 'line' | 'all';
export type FillStrokeMode = 'perCharacter' | 'allAsOne';

export const ANCHOR_GROUPINGS: ReadonlyArray<{ value: AnchorGrouping; label: string }> = [
  { value: 'character', label: 'Character' },
  { value: 'word', label: 'Word' },
  { value: 'line', label: 'Line' },
  { value: 'all', label: 'All' },
];

export const FILL_STROKE_MODES: ReadonlyArray<{ value: FillStrokeMode; label: string }> = [
  { value: 'perCharacter', label: 'Per Character Palette' },
  { value: 'allAsOne', label: 'All Characters As One' },
];

/** AE's blend-mode names → the canvas composite operation that implements each. */
export const INTER_CHARACTER_BLEND_MODES: ReadonlyArray<{ value: string; label: string; op: GlobalCompositeOperation }> = [
  { value: 'normal', label: 'Normal', op: 'source-over' },
  { value: 'darken', label: 'Darken', op: 'darken' },
  { value: 'multiply', label: 'Multiply', op: 'multiply' },
  { value: 'color-burn', label: 'Color Burn', op: 'color-burn' },
  { value: 'add', label: 'Add', op: 'lighter' },
  { value: 'lighten', label: 'Lighten', op: 'lighten' },
  { value: 'screen', label: 'Screen', op: 'screen' },
  { value: 'color-dodge', label: 'Color Dodge', op: 'color-dodge' },
  { value: 'overlay', label: 'Overlay', op: 'overlay' },
  { value: 'soft-light', label: 'Soft Light', op: 'soft-light' },
  { value: 'hard-light', label: 'Hard Light', op: 'hard-light' },
  { value: 'difference', label: 'Difference', op: 'difference' },
  { value: 'exclusion', label: 'Exclusion', op: 'exclusion' },
  { value: 'hue', label: 'Hue', op: 'hue' },
  { value: 'saturation', label: 'Saturation', op: 'saturation' },
  { value: 'color', label: 'Color', op: 'color' },
  { value: 'luminosity', label: 'Luminosity', op: 'luminosity' },
];

/** The composite op for a stored blend value, or null for Normal / unknown. */
export function interCharacterCompositeOp(value: string | undefined): GlobalCompositeOperation | null {
  if (!value || value === 'normal') return null;
  return INTER_CHARACTER_BLEND_MODES.find((m) => m.value === value)?.op ?? null;
}

const GROUPINGS: ReadonlySet<string> = new Set(ANCHOR_GROUPINGS.map((g) => g.value));

/** The static More Options props on a node's Text component. */
export function readTextMoreOptions(node: SceneNode): {
  anchorGrouping: AnchorGrouping;
  groupingAlignX: number;
  groupingAlignY: number;
  fillStrokeMode: FillStrokeMode;
  interCharacterBlending: string;
} {
  const out = {
    anchorGrouping: 'character' as AnchorGrouping,
    groupingAlignX: 0,
    groupingAlignY: 0,
    fillStrokeMode: 'perCharacter' as FillStrokeMode,
    interCharacterBlending: 'normal',
  };
  for (const c of node.components) {
    if (c.type !== 'Text') continue;
    const p = c.props as Record<string, unknown>;
    if (typeof p.anchorGrouping === 'string' && GROUPINGS.has(p.anchorGrouping)) out.anchorGrouping = p.anchorGrouping as AnchorGrouping;
    if (typeof p.groupingAlignX === 'number' && Number.isFinite(p.groupingAlignX)) out.groupingAlignX = p.groupingAlignX;
    if (typeof p.groupingAlignY === 'number' && Number.isFinite(p.groupingAlignY)) out.groupingAlignY = p.groupingAlignY;
    if (p.fillStrokeMode === 'allAsOne') out.fillStrokeMode = 'allAsOne';
    if (typeof p.interCharacterBlending === 'string' && interCharacterCompositeOp(p.interCharacterBlending)) {
      out.interCharacterBlending = p.interCharacterBlending;
    }
  }
  return out;
}

/**
 * Fold a node's More Options into its extras for a frame. `alignX`/`alignY`
 * are the sampled Grouping Alignment tracks (undefined = static value).
 * Returns the input untouched (possibly undefined) when every option is at
 * its default.
 */
export function withTextMoreOptions(
  extras: TextExtras | undefined,
  node: SceneNode,
  alignX: number | undefined,
  alignY: number | undefined,
): TextExtras | undefined {
  const o = readTextMoreOptions(node);
  const ax = alignX ?? o.groupingAlignX;
  const ay = alignY ?? o.groupingAlignY;
  const patch: TextExtras = {};
  if (o.anchorGrouping !== 'character') patch.anchorGrouping = o.anchorGrouping;
  if (ax !== 0 || ay !== 0) patch.groupingAlign = [ax, ay];
  if (o.fillStrokeMode === 'allAsOne') patch.fillStrokeMode = 'allAsOne';
  if (o.interCharacterBlending !== 'normal') patch.interCharacterBlending = o.interCharacterBlending;
  // Character panel ▸ OpenType (fontFaceVariants.ts applies them).
  for (const c of node.components) {
    if (c.type !== 'Text') continue;
    const p = c.props as Record<string, unknown>;
    if (p.ligatures === false) patch.ligatures = false;
    if (p.discretionaryLigatures === true) patch.discretionaryLigatures = true;
    if (p.contextualAlternates === false) patch.contextualAlternates = false;
    if (Array.isArray(p.stylisticSets)) {
      const sets = [...new Set(p.stylisticSets.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 20))].sort((a, b) => a - b);
      if (sets.length > 0) patch.stylisticSets = sets;
    }
  }
  if (Object.keys(patch).length === 0) return extras;
  return { ...(extras ?? {}), ...patch };
}

/**
 * Fill & Stroke "All Characters As One": the per-character paint order is
 * lifted to the whole layer — every stroke under every fill (or over).
 */
export function layerStrokeOrder(order: StrokeOrder, mode: FillStrokeMode | undefined): StrokeOrder {
  if (mode !== 'allAsOne') return order;
  if (order === 'fill-over-stroke') return 'all-fills-over-all-strokes';
  if (order === 'stroke-over-fill') return 'all-strokes-over-all-fills';
  return order;
}

/** The fields of a placed glyph grouping reads. */
export interface GroupableGlyph {
  char: string;
  x: number;
  y: number;
  inkWidth: number;
  line: number;
  style: { fontSize: number };
}

/**
 * Each glyph's transform origin under Anchor Point Grouping, box-centre
 * relative. `null` entries mean "the glyph's own centre" — Character grouping
 * with zero alignment, the default, so nothing downstream changes.
 *
 * A group's box spans its glyphs' ink boxes horizontally; vertically it is the
 * line (its baseline centre ± half the font size) or, for All, the whole block.
 * Grouping Alignment offsets the origin by that percentage of the group's
 * width and height (0 % = centre). Words split at whitespace and line breaks.
 */
export function groupPivots(
  glyphs: ReadonlyArray<GroupableGlyph>,
  grouping: AnchorGrouping | undefined,
  align: readonly [number, number] | undefined,
): Array<{ x: number; y: number } | null> {
  const ax = (align?.[0] ?? 0) / 100;
  const ay = (align?.[1] ?? 0) / 100;
  const mode = grouping ?? 'character';
  if (mode === 'character') {
    if (ax === 0 && ay === 0) return glyphs.map(() => null);
    return glyphs.map((g) => ({ x: g.x + ax * g.inkWidth, y: g.y + ay * g.style.fontSize }));
  }

  // Assign group ids.
  const ids = new Array<number>(glyphs.length);
  let id = -1;
  let prevLine = -1;
  let inWord = false;
  glyphs.forEach((g, i) => {
    if (mode === 'all') {
      ids[i] = 0;
      return;
    }
    if (mode === 'line') {
      ids[i] = g.line;
      return;
    }
    const space = g.char.trim() === '';
    if (g.line !== prevLine) inWord = false;
    prevLine = g.line;
    if (space) {
      ids[i] = -1;
      inWord = false;
      return;
    }
    if (!inWord) id++;
    inWord = true;
    ids[i] = id;
  });

  const boxes = new Map<number, { l: number; r: number; t: number; b: number }>();
  glyphs.forEach((g, i) => {
    const gid = ids[i]!;
    if (gid < 0) return;
    const half = g.style.fontSize / 2;
    const b = boxes.get(gid);
    const l = g.x - g.inkWidth / 2;
    const r = g.x + g.inkWidth / 2;
    if (!b) boxes.set(gid, { l, r, t: g.y - half, b: g.y + half });
    else {
      b.l = Math.min(b.l, l);
      b.r = Math.max(b.r, r);
      b.t = Math.min(b.t, g.y - half);
      b.b = Math.max(b.b, g.y + half);
    }
  });

  return glyphs.map((_g, i) => {
    const b = boxes.get(ids[i]!);
    if (!b) return null; // a space between words keeps its own origin
    return { x: (b.l + b.r) / 2 + ax * (b.r - b.l), y: (b.t + b.b) / 2 + ay * (b.b - b.t) };
  });
}
