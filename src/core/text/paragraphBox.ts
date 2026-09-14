/**
 * Paragraph (box) text geometry that is not about glyphs: how a box handle
 * drag resizes the box while its opposite edge stays put, and where a text
 * layer's line block sits relative to its origin — what a Point ↔ Paragraph
 * conversion has to hold still.
 *
 * Pure: no scene graph, no stores. The host (layout/Workspace/textBoxReflow,
 * layout/Inspector/paragraphTextCommands) reads the pose and writes the result.
 *
 * ── The convention everything here respects ─────────────────────────
 * A text layer's content is CENTRED on its local origin: the render box
 * spans ±w/2 × ±h/2 around it, and the layer's Position (with its anchor
 * point) places that origin. So growing a box to the right by d moves the box
 * centre — the local origin — right by d/2, and Position has to follow it by
 * R·S·(d/2, 0) in parent space for the left edge to stay where it was.
 */

import { resolveAlignForDirection } from './textExtras';

export interface Vec2 {
  x: number;
  y: number;
}

/** The eight AE box handles, named by the edges they move (local space). */
export type BoxHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const BOX_HANDLES: ReadonlyArray<BoxHandle> = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The layer pose a box drag starts from. `x`/`y` are Position, in parent space. */
export interface BoxPose {
  width: number;
  height: number;
  x: number;
  y: number;
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
}

export interface BoxResize {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** Local unit direction of a handle: x ∈ {-1, 0, 1} (w/e), y ∈ {-1, 0, 1} (n/s). */
export function handleDirection(handle: BoxHandle): Vec2 {
  return {
    x: handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0,
    y: handle.startsWith('n') ? -1 : handle.startsWith('s') ? 1 : 0,
  };
}

/** A handle's position on a box centred on the origin, offset `dy` vertically. */
export function handleLocalPosition(handle: BoxHandle, width: number, height: number, dy = 0): Vec2 {
  const d = handleDirection(handle);
  return { x: (d.x * width) / 2, y: (d.y * height) / 2 + dy };
}

/** Rotate then scale a LOCAL vector into parent space (the layer's own R·S). */
export function localToParentVector(v: Vec2, rotationDeg: number, scaleX: number, scaleY: number): Vec2 {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = v.x * scaleX;
  const sy = v.y * scaleY;
  return { x: cos * sx - sin * sy, y: sin * sx + cos * sy };
}

/**
 * A COMPOSITION-space delta expressed in the layer's own unrotated, unscaled
 * units. `parent` is the parent's world affine (`{a,b,c,d}` in canvas order:
 * x' = a·x + c·y); pass identity for an unparented layer.
 */
export function compDeltaToLocal(
  delta: Vec2,
  parent: { a: number; b: number; c: number; d: number },
  rotationDeg: number,
  scaleX: number,
  scaleY: number,
): Vec2 {
  const det = parent.a * parent.d - parent.b * parent.c;
  const px = Math.abs(det) > 1e-12 ? (parent.d * delta.x - parent.c * delta.y) / det : delta.x;
  const py = Math.abs(det) > 1e-12 ? (-parent.b * delta.x + parent.a * delta.y) / det : delta.y;
  const rad = (-rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = cos * px - sin * py;
  const ly = sin * px + cos * py;
  return {
    x: lx / (Math.abs(scaleX) > 1e-9 ? scaleX : 1),
    y: ly / (Math.abs(scaleY) > 1e-9 ? scaleY : 1),
  };
}

export interface BoxResizeOptions {
  minWidth?: number;
  minHeight?: number;
  /** Auto-height boxes: vertical handle motion is ignored. */
  lockHeight?: boolean;
  /** Snap the new size to whole pixels (the Position shift follows the snapped size). */
  round?: boolean;
}

/**
 * Resize a paragraph box by dragging `handle` by `local` (layer units), holding
 * the OPPOSITE edge fixed — dragging the right handle keeps the left edge in
 * place, on a rotated or scaled layer too. Returns the new box and Position.
 */
export function resizeBoxFromHandle(pose: BoxPose, handle: BoxHandle, local: Vec2, opts: BoxResizeOptions = {}): BoxResize {
  const minW = opts.minWidth ?? 16;
  const minH = opts.minHeight ?? 16;
  const d = handleDirection(handle);
  let width = pose.width;
  let height = pose.height;
  let shiftX = 0;
  let shiftY = 0;
  const snap = (v: number): number => (opts.round ? Math.round(v) : v);
  if (d.x !== 0) {
    width = snap(Math.max(minW, pose.width + d.x * local.x));
    shiftX = (d.x * (width - pose.width)) / 2;
  }
  if (d.y !== 0 && !opts.lockHeight) {
    height = snap(Math.max(minH, pose.height + d.y * local.y));
    shiftY = (d.y * (height - pose.height)) / 2;
  }
  const shift = localToParentVector({ x: shiftX, y: shiftY }, pose.rotationDeg, pose.scaleX, pose.scaleY);
  return { width, height, x: pose.x + shift.x, y: pose.y + shift.y };
}

/**
 * Where a text layer's lines START horizontally, relative to its origin, in
 * local units before the Character panel's horizontal scale `sx`.
 *
 * Left-aligned lines start at the render box's left inset, right-aligned ones
 * end at its right inset, centred ones centre on the frame between indents.
 * The shared render padding is left out: it is the same before and after a
 * conversion, so it cancels in the only thing this is used for — a difference.
 * Indents apply to paragraph text only (textExtras.placeLine).
 */
export function lineBlockAnchorX(
  align: string | undefined,
  renderWidth: number,
  indents?: { left?: number; right?: number },
  /** Right-to-left paragraphs mirror the alignment and the indent sides. */
  direction?: 'ltr' | 'rtl',
): number {
  const rtl = direction === 'rtl';
  const line = resolveAlignForDirection(align, direction).line;
  const l = (rtl ? indents?.right : indents?.left) ?? 0;
  const r = (rtl ? indents?.left : indents?.right) ?? 0;
  if (line === 'left') return -renderWidth / 2 + l;
  if (line === 'right') return renderWidth / 2 - r;
  return (l - r) / 2;
}

/**
 * The Position that keeps content visually still when the content moves by
 * `contentShift` (local units) inside its layer: Position − R·S·shift.
 */
export function compensatePosition(pose: Pick<BoxPose, 'x' | 'y' | 'rotationDeg' | 'scaleX' | 'scaleY'>, contentShift: Vec2): Vec2 {
  const v = localToParentVector(contentShift, pose.rotationDeg, pose.scaleX, pose.scaleY);
  return { x: pose.x - v.x, y: pose.y - v.y };
}
