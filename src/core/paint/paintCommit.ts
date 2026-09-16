/**
 * Commit a finished Paint-tool drag to the document — ONE undo step.
 *
 * The comp viewer and the Layer panel map pointer samples into the layer's own
 * space differently (a full world inverse vs. the panel's fit), and then both
 * land here, so AE's stroke rules live in one place:
 *
 *  · a stroke selected in the Paint panel has its Path REPLACED (a new Path
 *    keyframe when the Path is animated);
 *  · Shift continues the layer's previous stroke of the same kind;
 *  · Duration sets the stroke's life (Write On adds End keyframes that replay
 *    the drawing speed);
 *  · Eraser honours Erase mode, Last Stroke Only targeting the previous
 *    non-eraser stroke;
 *  · Clone honours Source, Aligned, Lock Source Time and Source Time Shift.
 */

import { defaultAnimation } from '@motion/animation';
import { drawToolOptions } from '@motion/workspace';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { getRemappedTime, getTimelineController } from '@core/timeline/TimelineController';
import { usePaintStore } from '@stores/paintStore';
import {
  addPaintStroke,
  extendPaintStroke,
  getNodePaint,
  replaceStrokePath,
  type PaintMode,
  type PaintStroke,
} from './paintStrokes';
import { cloneOffsetFor, durationRange, smoothSamples, strokeOptionsFrom, writeOnEndKeys } from './paintCapture';
import { paintPropPath } from './paintProps';

type Pt = { x: number; y: number };

export interface PaintDrag {
  nodeId: string;
  /** Decided when the drag STARTED (the eraser erases whatever the store says). */
  mode: PaintMode;
  /** Layer-local samples, already thinned. */
  points: ReadonlyArray<Pt>;
  /** Pointer timestamps (ms), parallel to `points`. */
  times: ReadonlyArray<number>;
  /** Pen input per sample, null for mouse/touch samples. */
  pen: ReadonlyArray<{ pressure: number; tiltX: number; tiltY: number } | null>;
  /** Brush diameter in LAYER px. */
  size: number;
  /** Comp seconds the stroke was drawn at. */
  compTime: number;
  /** Shift: continue the previous stroke. */
  continueStroke?: boolean;
  /** Ctrl+Shift eraser: Last Stroke Only for this drag. */
  lastStrokeOnly?: boolean;
}

export type PaintCommitResult = { ok: true; strokeId: string } | { ok: false; reason: string };

const fail = (reason: string): PaintCommitResult => ({ ok: false, reason });

export function commitPaintDrag(d: PaintDrag): PaintCommitResult {
  if (d.points.length === 0) return fail('');
  const s = usePaintStore.getState();
  const layerT = getRemappedTime(d.nodeId, d.compTime);
  const fps = getTimelineController().fps || 30;
  const points = smoothSamples(d.points, s.smoothing);
  const label = d.mode === 'erase' ? 'Erase' : 'Paint Stroke';
  const existing = getNodePaint(d.nodeId)?.strokes ?? [];

  const withPen = d.pen.length === points.length && points.length > 0 && d.pen.every((p) => p !== null);
  const pen = withPen
    ? {
        pressure: d.pen.map((p) => p!.pressure),
        tiltX: d.pen.map((p) => p!.tiltX),
        tiltY: d.pen.map((p) => p!.tiltY),
      }
    : {};

  // A selected stroke: the drag is its new Path.
  const sel = s.selectedStroke;
  if (sel && sel.nodeId === d.nodeId && !d.continueStroke && existing.some((x) => x.id === sel.strokeId)) {
    runDocumentEdit('Replace Paint Path', () => replaceStrokePath(d.nodeId, sel.strokeId, points, layerT));
    return { ok: true, strokeId: sel.strokeId };
  }

  if (d.continueStroke) {
    const prev = [...existing].reverse().find((x) => x.mode === d.mode);
    if (prev) {
      runDocumentEdit(label, () => extendPaintStroke(d.nodeId, prev.id, { points, ...pen }));
      return { ok: true, strokeId: prev.id };
    }
  }

  const stroke: Partial<PaintStroke> & { points: ReadonlyArray<Pt> } = {
    points,
    ...pen,
    ...strokeOptionsFrom({
      color: drawToolOptions.brushColor,
      size: d.size,
      opacity: s.opacity,
      flow: s.flow,
      hardness: s.hardness,
      angle: s.angle,
      roundness: s.roundness,
      spacing: s.spacing,
      blend: d.mode === 'paint' ? s.blend : 'normal',
      channels: s.channels,
      dynamics: s.dynamics,
    }),
    mode: d.mode,
    ...durationRange(s.duration, layerT, fps, s.customFrames),
  };

  if (d.mode === 'erase') {
    const eraseMode = d.lastStrokeOnly ? 'lastStroke' : s.eraseMode;
    if (eraseMode !== 'layerAndPaint') stroke.eraseMode = eraseMode;
    if (eraseMode === 'lastStroke') {
      const target = [...existing].reverse().find((x) => x.mode !== 'erase');
      if (!target) return fail('There is no stroke for Last Stroke Only to erase.');
      stroke.eraseTargetId = target.id;
    }
  }

  if (d.mode === 'clone') {
    const src = s.cloneSource;
    // Another layer's point is honoured only when the Paint panel's Source
    // names that layer — otherwise it is a stale aim from a different target.
    const cross = !!src && src.nodeId !== d.nodeId && src.nodeId === s.cloneSourceLayerId;
    if (!src || (src.nodeId !== d.nodeId && !cross)) return fail('Alt-click to set the clone source first.');
    const remembered = s.alignedOffset && s.alignedOffset.nodeId === d.nodeId ? s.alignedOffset : null;
    const { offset, remember } = cloneOffsetFor(s.cloneAligned, src, points[0]!, remembered);
    Object.assign(stroke, {
      cloneOffsetX: offset.x,
      cloneOffsetY: offset.y,
      cloneAligned: s.cloneAligned,
      ...(cross ? { cloneSourceId: src.nodeId } : {}),
      ...(s.cloneLockTime ? { cloneLockTime: true, cloneSourceTime: s.cloneSourceTime } : {}),
      ...(s.cloneTimeShift ? { cloneTimeShift: s.cloneTimeShift } : {}),
    });
    usePaintStore.getState().set({ alignedOffset: remember ? { nodeId: d.nodeId, x: remember.x, y: remember.y } : null });
  }

  let strokeId = '';
  runDocumentEdit(label, () => {
    strokeId = addPaintStroke(d.nodeId, stroke);
    if (s.duration === 'writeOn') {
      for (const k of writeOnEndKeys(points, d.times, layerT, fps)) {
        defaultAnimation.setKeyframe(d.nodeId, paintPropPath(strokeId, 'end'), k.t, k.value);
      }
    }
  });
  return { ok: true, strokeId };
}
