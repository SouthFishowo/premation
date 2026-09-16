/**
 * A layer's paint AT A TIME — what the raster draws for one frame.
 *
 * Stored strokes are the document; a frame needs three more things resolved
 * first, all of them AE's:
 *
 *   · Duration — each stroke lives from `inPoint` to `outPoint` in LAYER time
 *     (Constant / Single Frame / Custom), and its video switch can hide it.
 *   · Keyframes — every Stroke Option, the colour, the Transform and the Path
 *     are animatable (`paint.<id>.*`, see `paintProps.ts`). Write On is simply
 *     End keyed from 0 to 100 %.
 *   · Clone source time — Lock Source Time, Source Time Shift, and the source
 *     layer's own time when it is another layer.
 *
 * Pure: the snapshot hands in the frame's evaluated values and a data-track
 * sampler. Identity is preserved aggressively — a stroke nothing touches comes
 * back as the SAME object, and a frame where nothing is animated or hidden
 * returns the stored config itself — because the raster's cache keys are
 * memoised on stroke identity and a static painted layer must stay free.
 */

import type { PaintConfig, PaintStroke, StrokeTransform } from './paintStrokes';
import { PAINT_PERCENT_KEYS, parsePaintPropPath, parsePaintColorPath, paintPathProp, type PaintNumericKey } from './paintProps';

type Pt = { x: number; y: number };

export interface PaintTimeInput {
  /** Layer-local seconds (after the layer's remap). */
  t: number;
  /** The node's evaluated animation values for this frame. */
  values?: ReadonlyMap<string, number>;
  /** Sample a data track of this node at `t` (the Path). */
  sampleData?: (prop: string) => unknown;
  /** This layer's id — a clone "source" naming itself is the ordinary self-clone. */
  selfId?: string;
  /** A source layer's own time for this frame (its remap), for clone sources. */
  layerTimeOf?: (layerId: string) => number | undefined;
  /** A source layer's box, so its content is drawn at its own size. */
  sizeOf?: (layerId: string) => { width: number; height: number } | null;
}

const EPS = 1e-6;

/** Is the stroke on screen at layer time `t`? */
export function strokeLiveAt(s: Pick<PaintStroke, 'visible' | 'inPoint' | 'outPoint'>, t: number): boolean {
  if (s.visible === false) return false;
  if (s.inPoint !== undefined && t < s.inPoint - EPS) return false;
  if (s.outPoint !== undefined && t >= s.outPoint - EPS) return false;
  return true;
}

function hex2(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
}

function parseHex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(c);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function isPoints(v: unknown): v is Pt[] {
  return Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'x' in (v[0] as object);
}

/**
 * Bucket a frame's evaluated values by stroke id — one pass over the map, so a
 * layer with many strokes and a few tracks does not scan the map per stroke.
 */
function bucketPaintValues(values: ReadonlyMap<string, number> | undefined): Map<string, Map<string, number>> | null {
  if (!values || values.size === 0) return null;
  let out: Map<string, Map<string, number>> | null = null;
  for (const [prop, v] of values) {
    if (!prop.startsWith('paint.')) continue;
    const num = parsePaintPropPath(prop);
    const col = num ? null : parsePaintColorPath(prop);
    const id = num?.strokeId ?? col?.strokeId;
    if (!id) continue;
    out ??= new Map();
    let b = out.get(id);
    if (!b) out.set(id, (b = new Map()));
    b.set(num ? num.key : `color_${col!.channel}`, v);
  }
  return out;
}

/** One stroke at a frame. Returns the input object when nothing applies. */
export function resolveStrokeAt(s: PaintStroke, input: PaintTimeInput, tracks: Map<string, number> | undefined): PaintStroke {
  const livePath = input.sampleData?.(paintPathProp(s.id));
  const clone = s.mode === 'clone';
  const sourceOther = clone && !!s.cloneSourceId && s.cloneSourceId !== input.selfId;
  const timeWarp = clone && (s.cloneLockTime === true || (s.cloneTimeShift ?? 0) !== 0 || sourceOther
    || (tracks?.has('cloneTimeShift') ?? false) || (tracks?.has('cloneTime') ?? false));
  const selfNamed = clone && !!s.cloneSourceId && s.cloneSourceId === input.selfId;
  if (!tracks && !isPoints(livePath) && !timeWarp && !selfNamed) return s;

  const out: PaintStroke = { ...s };
  if (selfNamed) delete out.cloneSourceId;
  if (isPoints(livePath)) {
    out.points = livePath;
    // Per-point pen input belongs to the path it was recorded on.
    delete out.pressure;
    delete out.tiltX;
    delete out.tiltY;
  }

  if (tracks) {
    const get = (k: PaintNumericKey): number | undefined => {
      const v = tracks.get(k);
      if (v === undefined || !Number.isFinite(v)) return undefined;
      return PAINT_PERCENT_KEYS.has(k) ? v / 100 : v;
    };
    const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
    const v = {
      start: get('start'), end: get('end'), diameter: get('diameter'), angle: get('angle'),
      hardness: get('hardness'), roundness: get('roundness'), spacing: get('spacing'),
      opacity: get('opacity'), flow: get('flow'),
    };
    if (v.start !== undefined) out.start = clamp01(v.start);
    if (v.end !== undefined) out.end = clamp01(v.end);
    if (v.diameter !== undefined) out.size = Math.max(0, v.diameter);
    if (v.angle !== undefined) out.angle = v.angle;
    if (v.hardness !== undefined) out.hardness = clamp01(v.hardness);
    if (v.roundness !== undefined) out.roundness = Math.max(0.01, clamp01(v.roundness));
    if (v.spacing !== undefined) out.spacing = Math.max(0.01, v.spacing);
    if (v.opacity !== undefined) out.opacity = clamp01(v.opacity);
    if (v.flow !== undefined) out.flow = clamp01(v.flow);

    if (tracks.has('color_r') || tracks.has('color_g') || tracks.has('color_b')) {
      const [r, g, b] = parseHex(s.color);
      out.color = `#${hex2(tracks.get('color_r') ?? r)}${hex2(tracks.get('color_g') ?? g)}${hex2(tracks.get('color_b') ?? b)}`;
    }

    const tk = ['anchorX', 'anchorY', 'positionX', 'positionY', 'scale', 'rotation'] as const;
    if (tk.some((k) => tracks.has(k))) {
      const first = out.points[0] ?? { x: 0, y: 0 };
      const base: StrokeTransform = s.transform ?? { anchorX: first.x, anchorY: first.y, x: first.x, y: first.y, scale: 100, rotation: 0 };
      out.transform = {
        anchorX: get('anchorX') ?? base.anchorX,
        anchorY: get('anchorY') ?? base.anchorY,
        x: get('positionX') ?? base.x,
        y: get('positionY') ?? base.y,
        scale: get('scale') ?? base.scale,
        rotation: get('rotation') ?? base.rotation,
      };
    }

    if (clone && (tracks.has('clonePositionX') || tracks.has('clonePositionY'))) {
      // Clone Position is the SOURCE point; the model stores source − first dab.
      const first = out.points[0] ?? { x: 0, y: 0 };
      const sx = get('clonePositionX') ?? first.x + (s.cloneOffsetX ?? 0);
      const sy = get('clonePositionY') ?? first.y + (s.cloneOffsetY ?? 0);
      out.cloneOffsetX = sx - first.x;
      out.cloneOffsetY = sy - first.y;
    }
  }

  if (timeWarp) {
    const shift = tracks?.get('cloneTimeShift') ?? s.cloneTimeShift ?? 0;
    const src = out.cloneSourceId;
    let time: number;
    if (s.cloneLockTime) {
      time = tracks?.get('cloneTime') ?? s.cloneSourceTime ?? 0;
    } else {
      const base = src ? input.layerTimeOf?.(src) ?? input.t : input.t;
      time = base + shift;
    }
    out.cloneTime = time;
    if (src) {
      const size = input.sizeOf?.(src);
      if (size) {
        out.cloneSourceW = size.width;
        out.cloneSourceH = size.height;
      }
    }
  }
  return out;
}

/**
 * The strokes to draw at `input.t`, or undefined when none is live (the layer
 * then takes its unpainted feed for this frame — no bake, no extra work).
 */
export function resolvePaintAt(paint: PaintConfig | null | undefined, input: PaintTimeInput): PaintConfig | undefined {
  if (!paint || !Array.isArray(paint.strokes) || paint.strokes.length === 0) return undefined;
  const buckets = bucketPaintValues(input.values);
  let changed = false;
  const strokes: PaintStroke[] = [];
  for (const s of paint.strokes) {
    if (!strokeLiveAt(s, input.t)) {
      changed = true;
      continue;
    }
    const r = resolveStrokeAt(s, input, buckets?.get(s.id));
    if (r !== s) changed = true;
    strokes.push(r);
  }
  if (strokes.length === 0) return paint.onTransparent ? { strokes: [], onTransparent: true } : undefined;
  if (!changed) return paint;
  return paint.onTransparent ? { strokes, onTransparent: true } : { strokes };
}
