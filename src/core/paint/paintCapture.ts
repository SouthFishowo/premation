/**
 * Turning a pointer drag into a paint stroke — the pure half of the Paint tool,
 * shared by the comp viewer and the Layer panel so both commit the same stroke
 * for the same gesture.
 *
 *  · Input smoothing   — an exponential moving average over the samples, the
 *                        endpoints pinned so the stroke starts and ends where
 *                        the pen did.
 *  · Duration          — AE's Paint panel: Constant (from now to the layer's
 *                        end), Single Frame, Custom (N frames), Write On (the
 *                        stroke animates as it was drawn — End keyframes that
 *                        replay the drawing speed, one per frame).
 *  · Pen input         — pressure / tilt recorded per point, only for a pen
 *                        (a mouse reports a constant 0.5 that means nothing).
 *  · Clone aiming      — Aligned keeps ONE offset for every stroke after the
 *                        first; non-aligned re-aims each stroke at the source.
 *  · Ctrl-drag sizing  — AE's gesture: drag sets Diameter, and releasing Ctrl
 *                        mid-drag switches the drag to Hardness.
 */

import type { PaintStroke } from './paintStrokes';

type Pt = { x: number; y: number };

export type PaintDuration = 'constant' | 'writeOn' | 'single' | 'custom';

/** EMA smoothing, 0 = off, 1 = heaviest. Endpoints are kept exactly. */
export function smoothSamples(points: ReadonlyArray<Pt>, amount: number): Pt[] {
  const a = Math.max(0, Math.min(0.95, amount));
  if (a <= 0 || points.length < 3) return points.map((p) => ({ x: p.x, y: p.y }));
  const out: Pt[] = [{ x: points[0]!.x, y: points[0]!.y }];
  let sx = points[0]!.x;
  let sy = points[0]!.y;
  for (let i = 1; i < points.length - 1; i++) {
    sx = sx * a + points[i]!.x * (1 - a);
    sy = sy * a + points[i]!.y * (1 - a);
    out.push({ x: sx, y: sy });
  }
  const last = points[points.length - 1]!;
  out.push({ x: last.x, y: last.y });
  return out;
}

/** The stroke's life for a Duration mode, in layer seconds. */
export function durationRange(
  mode: PaintDuration,
  layerT: number,
  fps: number,
  customFrames = 1,
): { inPoint: number; outPoint?: number } {
  const frame = 1 / (fps > 0 ? fps : 30);
  if (mode === 'single') return { inPoint: layerT, outPoint: layerT + frame };
  if (mode === 'custom') return { inPoint: layerT, outPoint: layerT + Math.max(1, Math.round(customFrames)) * frame };
  return { inPoint: layerT };
}

/**
 * Write On: End keyframes (in %) that replay the stroke at the speed it was
 * drawn. `times` are the kept samples' timestamps in ms, parallel to `points`.
 * One key per frame of drawing time (plus the first and last), each holding
 * the arc-length fraction reached by then — so a stroke drawn slowly then fast
 * writes on slowly then fast.
 */
export function writeOnEndKeys(
  points: ReadonlyArray<Pt>,
  times: ReadonlyArray<number>,
  layerT: number,
  fps: number,
): Array<{ t: number; value: number }> {
  if (points.length === 0 || times.length !== points.length) return [];
  const frame = 1 / (fps > 0 ? fps : 30);
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  }
  const total = cum[cum.length - 1]!;
  const t0 = times[0]!;
  const duration = Math.max(0, (times[times.length - 1]! - t0) / 1000);
  // A dab or an instant flick still writes on over one frame.
  const span = Math.max(frame, duration);
  const frames = Math.max(1, Math.ceil(span / frame - 1e-9));
  const keys: Array<{ t: number; value: number }> = [];
  let j = 0;
  for (let f = 0; f <= frames; f++) {
    const elapsedMs = f === frames ? Infinity : (f * frame) * 1000;
    while (j + 1 < times.length && times[j + 1]! - t0 <= elapsedMs) j++;
    let d = cum[j]!;
    if (j + 1 < times.length && elapsedMs !== Infinity) {
      const segMs = times[j + 1]! - times[j]!;
      const u = segMs > 0 ? Math.min(1, (t0 + elapsedMs - times[j]!) / segMs) : 0;
      d += (cum[j + 1]! - cum[j]!) * u;
    }
    const value = total > 0 ? (d / total) * 100 : 100;
    keys.push({ t: layerT + Math.min(f * frame, span), value: f === frames ? 100 : f === 0 ? 0 : value });
  }
  return keys;
}

/** Pen input for a pointer sample, or null for mouse/touch. */
export function penSample(e: { pointerType?: string; pressure?: number; tiltX?: number; tiltY?: number }): { pressure: number; tiltX: number; tiltY: number } | null {
  if (e.pointerType !== 'pen') return null;
  return {
    pressure: Math.max(0, Math.min(1, e.pressure ?? 0.5)),
    tiltX: e.tiltX ?? 0,
    tiltY: e.tiltY ?? 0,
  };
}

/**
 * The clone offset for a new stroke (source − first dab, layer space) and the
 * aligned offset to remember for the next one. With Aligned on, the first
 * stroke after aiming fixes the offset and every later stroke reuses it — the
 * source travels with the brush. Off, every stroke samples from the source
 * point itself.
 */
export function cloneOffsetFor(
  aligned: boolean,
  source: Pt,
  firstDab: Pt,
  remembered: Pt | null,
): { offset: Pt; remember: Pt | null } {
  if (aligned && remembered) return { offset: remembered, remember: remembered };
  const offset = { x: source.x - firstDab.x, y: source.y - firstDab.y };
  return { offset, remember: aligned ? offset : null };
}

/** Ctrl-drag brush sizing: diameter from horizontal travel, hardness (0..1)
 *  once Ctrl is released. */
export function ctrlDragBrush(
  start: { size: number; hardness: number },
  dx: number,
  phase: 'size' | 'hardness',
): { size: number; hardness: number } {
  if (phase === 'size') return { size: Math.max(1, Math.min(2500, Math.round(start.size + dx))), hardness: start.hardness };
  return { size: start.size, hardness: Math.max(0, Math.min(1, start.hardness + dx / 200)) };
}

/** Brush-tip settings a new stroke records (the Brushes + Paint panels). */
export interface BrushCaptureSettings {
  color: string;
  size: number;
  opacity: number;
  flow: number;
  hardness: number;
  angle: number;
  roundness: number;
  spacing: number;
  blend: PaintStroke['blend'];
  channels: PaintStroke['channels'];
  dynamics: PaintStroke['dynamics'];
}

/** The stored v2 options for a new stroke — only non-defaults beyond Spacing,
 *  which is always written (it is what marks a stroke as a dab brush). */
export function strokeOptionsFrom(s: BrushCaptureSettings): Partial<PaintStroke> {
  const out: Partial<PaintStroke> = {
    color: s.color,
    size: s.size,
    opacity: s.opacity,
    hardness: s.hardness,
    spacing: s.spacing,
  };
  if (s.flow < 1) out.flow = s.flow;
  if (s.angle !== 0) out.angle = s.angle;
  if (s.roundness < 1) out.roundness = s.roundness;
  if (s.blend && s.blend !== 'normal') out.blend = s.blend;
  if (s.channels && s.channels !== 'rgba') out.channels = s.channels;
  const d = s.dynamics;
  if (d && [d.size, d.angle, d.roundness, d.opacity, d.flow].some((v) => v && v !== 'off')) out.dynamics = { ...d };
  return out;
}
