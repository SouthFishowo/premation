/**
 * Paint strokes — AE's Paint effect, modelled as EDITABLE VECTOR strokes stored
 * on a layer's `fx` component (like masks), not a flattened raster. Each stroke
 * is a polyline the paint raster draws over the layer's content: paint mode
 * composites colour, erase mode cuts holes, and clone mode paints a layer's
 * content (its own, or another layer's) sampled at an offset — the clone stamp,
 * for raster retouch on footage and stills.
 * Points are in layer-local space (centred at 0,0), matching masks.
 *
 * ## Model v2 (2026-09-15)
 *
 * AE's per-stroke Stroke Options and Transform, all OPTIONAL so a v1 stroke —
 * `{id, points, color, size, opacity, hardness, mode}` — loads byte-for-byte
 * unchanged and renders through the same polyline pass it always did (pinned in
 * `paintRaster.test.ts`). No migration: an absent field IS the v1 default.
 *
 *  · Start / End (0..1)      — write-on trim along the path's arc length.
 *  · Angle (deg), Roundness  — the elliptical brush tip.
 *  · Spacing (0..1 of Ø)     — dab interval. PRESENCE switches the stroke to the
 *                              dab renderer; the Brush writes AE's 25 %.
 *  · Flow (0..1)             — per-dab paint, accumulating under the Opacity cap.
 *  · Channels, blend Mode    — how the stroke composites.
 *  · eraseMode               — Layer Source & Paint / Paint Only / Last Stroke.
 *  · inPoint / outPoint      — the stroke's life in LAYER seconds (Duration).
 *  · pressure / tiltX / tiltY + dynamics — pen input, per point.
 *  · transform               — per-stroke Anchor, Position, Scale, Rotation.
 *  · clone*                  — Source layer, Time Shift, Lock Source Time.
 *
 * Every numeric option is keyframeable through `paint.<id>.<key>` tracks
 * (`paintProps.ts`) and the Path through a `points` data track; `paintTime.ts`
 * resolves a frame's strokes before the raster sees them.
 *
 * This module is the pure model + mutations; the drawing lives in `paintRaster`,
 * the capture in the Paint tool (comp viewer, Layer panel).
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { bumpScene } from '@stores/sceneStore';
import { clamp01 } from '@utils/lang';
import { paintPathProp } from './paintProps';

export type PaintMode = 'paint' | 'erase' | 'clone';
/** AE Paint panel ▸ Channels. */
export type PaintChannels = 'rgba' | 'rgb' | 'alpha';
/** AE Paint panel ▸ Erase. */
export type EraseMode = 'layerAndPaint' | 'paintOnly' | 'lastStroke';
/** AE Paint panel ▸ Mode — the stroke's blend against what is beneath it. */
export type PaintBlend =
  | 'normal' | 'darken' | 'multiply' | 'color-burn' | 'add' | 'lighten' | 'screen' | 'color-dodge'
  | 'overlay' | 'soft-light' | 'hard-light' | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';
/** Brushes panel ▸ Brush Dynamics: what drives a tip property. */
export type DynamicsSource = 'off' | 'pressure' | 'tilt';

export interface BrushDynamics {
  size?: DynamicsSource;
  angle?: DynamicsSource;
  roundness?: DynamicsSource;
  opacity?: DynamicsSource;
  flow?: DynamicsSource;
  /** 0..1 — the smallest size pressure can shrink the tip to (AE Minimum Size). */
  minSize?: number;
}

/** Per-stroke Transform. Absent = identity; `scale` is %, `rotation` degrees. */
export interface StrokeTransform {
  anchorX: number;
  anchorY: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface PaintStroke {
  id: string;
  /** Polyline points in layer-local space (0,0 = layer centre). */
  points: ReadonlyArray<{ x: number; y: number }>;
  /** Stroke colour `#rrggbb` (ignored for erase). */
  color: string;
  /** Brush diameter in px. */
  size: number;
  /** 0..1. */
  opacity: number;
  /** 0..1 — 1 = hard edge, <1 = softer (feathered) edge. */
  hardness: number;
  mode: PaintMode;
  /**
   * Clone stamp only — where the stroke SAMPLES from, as a layer-local offset
   * added to each painted point (offset = source − first dab). Colour is
   * ignored for clone; the paint IS the source's content, shifted.
   */
  cloneOffsetX?: number;
  cloneOffsetY?: number;

  // ── v2 (all optional; absent = v1 behaviour) ───────────────────────
  /** User name; absent reads "Brush 3" / "Eraser 1" / "Clone 2". */
  name?: string;
  /** 0..1 along the path (default 0). */
  start?: number;
  /** 0..1 along the path (default 1). */
  end?: number;
  /** Tip angle, degrees (default 0). */
  angle?: number;
  /** 0..1 tip roundness (default 1). */
  roundness?: number;
  /** Dab interval as a fraction of the diameter. Present ⇒ dab renderer. */
  spacing?: number;
  /** 0..1 paint per dab (default 1). */
  flow?: number;
  channels?: PaintChannels;
  blend?: PaintBlend;
  /** Eraser strokes only (default layerAndPaint). */
  eraseMode?: EraseMode;
  /** Last Stroke Only — the stroke this eraser cuts. */
  eraseTargetId?: string;
  /** Layer seconds the stroke appears at (inclusive). Absent = always. */
  inPoint?: number;
  /** Layer seconds the stroke disappears at (exclusive). Absent = to the layer's end. */
  outPoint?: number;
  /** The timeline's video switch. `false` hides the stroke. */
  visible?: boolean;
  /** Per-point pen pressure 0..1 (parallel to `points`). */
  pressure?: ReadonlyArray<number>;
  /** Per-point pen tilt in degrees (−90..90, PointerEvent.tiltX/Y). */
  tiltX?: ReadonlyArray<number>;
  tiltY?: ReadonlyArray<number>;
  dynamics?: BrushDynamics;
  transform?: StrokeTransform;
  /** Clone source layer id; absent = this layer. */
  cloneSourceId?: string;
  /** Seconds added to the source's time (AE Source Time Shift). */
  cloneTimeShift?: number;
  /** Lock Source Time: sample the source at `cloneSourceTime` on every frame. */
  cloneLockTime?: boolean;
  cloneSourceTime?: number;
  /** Aligned (recorded for the panel; the offset already encodes it). */
  cloneAligned?: boolean;
  /** Resolved per frame by `resolvePaintAt` — never stored. */
  cloneTime?: number;
  cloneSourceW?: number;
  cloneSourceH?: number;
}

export interface PaintConfig {
  strokes: PaintStroke[];
  /** AE Paint On Transparent: the layer shows ONLY its paint. */
  onTransparent?: boolean;
}

/** Read a node's paint config off its `fx` component, or null when it has none. */
export function readNodePaint(node: SceneNode): PaintConfig | null {
  const fx = node.components.find((c) => c.type === 'fx');
  const raw = fx?.props.paint as { strokes?: unknown; onTransparent?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.strokes) || raw.strokes.length === 0) return null;
  const strokes = (raw.strokes as PaintStroke[]).filter(
    (s) => s && Array.isArray(s.points) && s.points.length > 0,
  );
  if (strokes.length === 0) return null;
  return raw.onTransparent === true ? { strokes, onTransparent: true } : { strokes };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Normalise a partial stroke into a full one (fills defaults). Pure/testable.
 *  v2 keys are copied only when present, so a v1 input normalises to exactly
 *  the v1 shape. */
export function normalizeStroke(raw: Partial<PaintStroke> & { points: ReadonlyArray<{ x: number; y: number }> }, id: string): PaintStroke {
  const out: PaintStroke = {
    id: raw.id ?? id,
    points: raw.points,
    color: typeof raw.color === 'string' ? raw.color : '#ffffff',
    size: typeof raw.size === 'number' && raw.size > 0 ? raw.size : 12,
    opacity: clamp01(typeof raw.opacity === 'number' ? raw.opacity : 1),
    hardness: clamp01(typeof raw.hardness === 'number' ? raw.hardness : 1),
    mode: raw.mode === 'erase' || raw.mode === 'clone' ? raw.mode : 'paint',
    ...(raw.mode === 'clone'
      ? {
          cloneOffsetX: typeof raw.cloneOffsetX === 'number' ? raw.cloneOffsetX : 0,
          cloneOffsetY: typeof raw.cloneOffsetY === 'number' ? raw.cloneOffsetY : 0,
        }
      : {}),
  };
  if (typeof raw.name === 'string' && raw.name) out.name = raw.name;
  if (num(raw.start)) out.start = clamp01(raw.start);
  if (num(raw.end)) out.end = clamp01(raw.end);
  if (num(raw.angle)) out.angle = raw.angle;
  if (num(raw.roundness)) out.roundness = Math.max(0.01, clamp01(raw.roundness));
  if (num(raw.spacing)) out.spacing = Math.max(0.01, Math.min(10, raw.spacing));
  if (num(raw.flow)) out.flow = clamp01(raw.flow);
  if (raw.channels === 'rgb' || raw.channels === 'alpha' || raw.channels === 'rgba') out.channels = raw.channels;
  if (typeof raw.blend === 'string') out.blend = raw.blend;
  if (out.mode === 'erase') {
    if (raw.eraseMode === 'paintOnly' || raw.eraseMode === 'lastStroke' || raw.eraseMode === 'layerAndPaint') out.eraseMode = raw.eraseMode;
    if (typeof raw.eraseTargetId === 'string') out.eraseTargetId = raw.eraseTargetId;
  }
  if (num(raw.inPoint)) out.inPoint = raw.inPoint;
  if (num(raw.outPoint)) out.outPoint = raw.outPoint;
  if (raw.visible === false) out.visible = false;
  if (Array.isArray(raw.pressure) && raw.pressure.length === raw.points.length) out.pressure = raw.pressure;
  if (Array.isArray(raw.tiltX) && raw.tiltX.length === raw.points.length) out.tiltX = raw.tiltX;
  if (Array.isArray(raw.tiltY) && raw.tiltY.length === raw.points.length) out.tiltY = raw.tiltY;
  if (raw.dynamics && typeof raw.dynamics === 'object') out.dynamics = { ...raw.dynamics };
  if (raw.transform && typeof raw.transform === 'object') out.transform = { ...raw.transform };
  if (out.mode === 'clone') {
    if (typeof raw.cloneSourceId === 'string' && raw.cloneSourceId) out.cloneSourceId = raw.cloneSourceId;
    if (num(raw.cloneTimeShift) && raw.cloneTimeShift !== 0) out.cloneTimeShift = raw.cloneTimeShift;
    if (raw.cloneLockTime === true) {
      out.cloneLockTime = true;
      out.cloneSourceTime = num(raw.cloneSourceTime) ? raw.cloneSourceTime : 0;
    }
    if (typeof raw.cloneAligned === 'boolean') out.cloneAligned = raw.cloneAligned;
  }
  return out;
}

export { strokeDisplayNames } from './paintProps';

/** Axis-aligned bounds of a stroke including its brush radius (layer-local px).
 *  Pure/testable — used for dirty-region / hit-testing. Null for an empty stroke. */
export function strokeBounds(stroke: PaintStroke): { x: number; y: number; width: number; height: number } | null {
  if (stroke.points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of stroke.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const r = stroke.size / 2;
  return { x: minX - r, y: minY - r, width: maxX - minX + stroke.size, height: maxY - minY + stroke.size };
}


// ── Mutations (write to the layer's fx + notify) ──────────────────────

let strokeSeq = 0;

/** A stroke id unique in this document even across reloads (the counter alone
 *  restarts at 1 and a reopened project already holds `pstroke_1`). */
function nextStrokeId(existing: ReadonlyArray<{ id: string }>): string {
  const taken = new Set(existing.map((s) => s.id));
  let id = `pstroke_${(strokeSeq += 1)}`;
  while (taken.has(id)) id = `pstroke_${(strokeSeq += 1)}`;
  return id;
}

export function getNodePaint(nodeId: string): PaintConfig | null {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodePaint(node) : null;
}

function writePaint(nodeId: string, strokes: PaintStroke[], onTransparent: boolean | undefined): void {
  defaultSceneGraph.setPaint(nodeId, strokes.length > 0 || onTransparent
    ? { strokes, ...(onTransparent ? { onTransparent: true } : {}) }
    : { strokes: [] });
  getEventBus().emit('AnimationChanged', { nodeId });
  bumpScene();
}

/** Append a paint stroke to a layer, creating the paint config on demand.
 *  Returns the new stroke's id. */
export function addPaintStroke(
  nodeId: string,
  stroke: Partial<PaintStroke> & { points: ReadonlyArray<{ x: number; y: number }> },
): string {
  const cfg = getNodePaint(nodeId);
  const existing = cfg?.strokes ?? [];
  const next = normalizeStroke(stroke, nextStrokeId(existing));
  writePaint(nodeId, [...existing, next], cfg?.onTransparent);
  return next.id;
}

/** Remove the most recent stroke (undo the last brush pass). */
export function removeLastStroke(nodeId: string): void {
  const cfg = getNodePaint(nodeId);
  const strokes = cfg?.strokes;
  if (!strokes || strokes.length === 0) return;
  writePaint(nodeId, strokes.slice(0, -1), cfg?.onTransparent);
}

/** Remove one stroke by id, with its keyframe tracks. */
export function removePaintStroke(nodeId: string, strokeId: string): void {
  const cfg = getNodePaint(nodeId);
  if (!cfg || !cfg.strokes.some((s) => s.id === strokeId)) return;
  const prefix = `paint.${strokeId}.`;
  for (const t of defaultAnimation.tracksFor(nodeId)) {
    if (t.prop.startsWith(prefix)) defaultAnimation.removeTrack(nodeId, t.prop);
  }
  defaultAnimation.setDataTrack(nodeId, paintPathProp(strokeId), null);
  writePaint(nodeId, cfg.strokes.filter((s) => s.id !== strokeId), cfg.onTransparent);
}

/** Merge a patch into one stroke (renormalised, so a patch cannot store junk). */
export function updatePaintStroke(nodeId: string, strokeId: string, patch: Partial<PaintStroke>): void {
  const cfg = getNodePaint(nodeId);
  if (!cfg) return;
  let hit = false;
  const strokes = cfg.strokes.map((s) => {
    if (s.id !== strokeId) return s;
    hit = true;
    const merged = { ...s, ...patch } as PaintStroke;
    // `undefined` in a patch CLEARS the key (normalize copies present keys only).
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (merged as unknown as Record<string, unknown>)[k];
    return normalizeStroke(merged, s.id);
  });
  if (hit) writePaint(nodeId, strokes, cfg.onTransparent);
}

/**
 * Shift-drag: continue a stroke with more points (AE joins the previous
 * stroke's end to the new samples). Pressure/tilt arrays extend in step; a
 * side that lacks them is padded so the arrays stay parallel.
 */
export function extendPaintStroke(
  nodeId: string,
  strokeId: string,
  more: { points: ReadonlyArray<{ x: number; y: number }>; pressure?: ReadonlyArray<number>; tiltX?: ReadonlyArray<number>; tiltY?: ReadonlyArray<number> },
): void {
  const cfg = getNodePaint(nodeId);
  const s = cfg?.strokes.find((x) => x.id === strokeId);
  if (!cfg || !s || more.points.length === 0) return;
  const cat = (a: ReadonlyArray<number> | undefined, b: ReadonlyArray<number> | undefined, fill: number): number[] | undefined => {
    if (!a && !b) return undefined;
    return [...(a ?? new Array<number>(s.points.length).fill(fill)), ...(b ?? new Array<number>(more.points.length).fill(fill))];
  };
  updatePaintStroke(nodeId, strokeId, {
    points: [...s.points, ...more.points],
    pressure: cat(s.pressure, more.pressure, 1),
    tiltX: cat(s.tiltX, more.tiltX, 0),
    tiltY: cat(s.tiltY, more.tiltY, 0),
  });
}

/**
 * Drawing with a stroke selected REPLACES its Path. With the Path stopwatch on
 * (a data track exists) that is a new Path keyframe at `layerTime`; otherwise
 * the static path is replaced — AE's rule for both.
 */
export function replaceStrokePath(
  nodeId: string,
  strokeId: string,
  points: ReadonlyArray<{ x: number; y: number }>,
  layerTime: number,
): void {
  if (points.length === 0) return;
  const prop = paintPathProp(strokeId);
  if (defaultAnimation.isDataAnimated(nodeId, prop)) {
    defaultAnimation.setDataKeyframe(nodeId, prop, 'points', layerTime, points.map((p) => ({ x: p.x, y: p.y })));
    getEventBus().emit('AnimationChanged', { nodeId });
    bumpScene();
    return;
  }
  // A new static path invalidates per-point input recorded for the old one.
  updatePaintStroke(nodeId, strokeId, { points, pressure: undefined, tiltX: undefined, tiltY: undefined });
}

/** Path stopwatch: start (key the current path at `layerTime`) or stop animating. */
export function toggleStrokePathAnimation(nodeId: string, strokeId: string, layerTime: number): void {
  const prop = paintPathProp(strokeId);
  if (defaultAnimation.isDataAnimated(nodeId, prop)) {
    defaultAnimation.setDataTrack(nodeId, prop, null);
  } else {
    const s = getNodePaint(nodeId)?.strokes.find((x) => x.id === strokeId);
    if (!s) return;
    defaultAnimation.setDataKeyframe(nodeId, prop, 'points', layerTime, s.points.map((p) => ({ x: p.x, y: p.y })));
  }
  getEventBus().emit('AnimationChanged', { nodeId });
  bumpScene();
}

/** AE Paint On Transparent, for the layer's paint as a whole. */
export function setPaintOnTransparent(nodeId: string, on: boolean): void {
  const cfg = getNodePaint(nodeId);
  if (!cfg) return;
  writePaint(nodeId, cfg.strokes, on || undefined);
}
