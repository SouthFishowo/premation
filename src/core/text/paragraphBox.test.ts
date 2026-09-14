/**
 * Paragraph box geometry: line placement + clipping in a fixed box, the
 * point/paragraph reading of a node's props, and handle-drag reflow math
 * holding the opposite edge still on rotated, scaled, flipped and parented
 * layers.
 */

import type { SceneNode } from '@core/types';
import {
  centredLineYs,
  lineOffsets,
  hardEndsOf,
  placeLinesInBox,
  readParagraphBox,
  textExtrasForNode,
} from './textExtras';
import {
  BOX_HANDLES,
  compDeltaToLocal,
  compensatePosition,
  handleDirection,
  lineBlockAnchorX,
  localToParentVector,
  resizeBoxFromHandle,
  type BoxPose,
} from './paragraphBox';

const textNode = (props: Record<string, unknown>): SceneNode =>
  ({
    id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'n_t', type: 'Text', props: { content: 'x', ...props } }],
  }) as unknown as SceneNode;

/** Four 30px lines centred on 0: baselines −45, −15, 15, 45. */
const ys = (n: number, lh = 30): number[] => {
  const { offsets, total } = lineOffsets(hardEndsOf(n, undefined), lh);
  return centredLineYs(offsets, total);
};

describe('placeLinesInBox', () => {
  it('top-aligns by default: the first line box touches the box top', () => {
    const p = placeLinesInBox(ys(2), 30, 100, undefined);
    // Lines span −30..30; box top is −50 → shift −20.
    expect(p.dy).toBeCloseTo(-20, 9);
    expect(p).toMatchObject({ visible: 2, overflow: false });
  });

  it('centres and bottom-aligns', () => {
    expect(placeLinesInBox(ys(2), 30, 100, 'center').dy).toBeCloseTo(0, 9);
    expect(placeLinesInBox(ys(2), 30, 100, 'bottom').dy).toBeCloseTo(20, 9);
  });

  it('clips lines that do not FULLY fit, and flags overflow', () => {
    // 4 × 30 = 120 in a 70 box: two whole lines fit, the third would be cut.
    const p = placeLinesInBox(ys(4), 30, 70, 'top');
    expect(p.overflow).toBe(true);
    expect(p.visible).toBe(2);
  });

  it('an overflowing box ignores centre/bottom so the text START stays visible', () => {
    const top = placeLinesInBox(ys(4), 30, 70, 'top');
    expect(placeLinesInBox(ys(4), 30, 70, 'bottom')).toEqual(top);
    expect(placeLinesInBox(ys(4), 30, 70, 'center')).toEqual(top);
  });

  it('an exact fit is not overflow (float slack)', () => {
    expect(placeLinesInBox(ys(3), 30, 90 - 1e-9, 'top')).toMatchObject({ overflow: false, visible: 3 });
  });
});

describe('readParagraphBox', () => {
  it('point text has no box', () => {
    expect(readParagraphBox(textNode({}))).toBeNull();
    expect(readParagraphBox(textNode({ boxWidth: 0, boxHeight: 90 }))).toBeNull();
  });

  it('a LEGACY paragraph (boxWidth only) is auto height — documents render as before', () => {
    expect(readParagraphBox(textNode({ boxWidth: 300 }))).toMatchObject({ autoSize: 'height', fixedHeight: false });
    // …and carries no box fields into the render (so its cache key is unchanged).
    expect(textExtrasForNode(textNode({ boxWidth: 300 }))).toBeUndefined();
  });

  it('a height with no mode is a fixed box; Auto Height ignores the height', () => {
    expect(readParagraphBox(textNode({ boxWidth: 300, boxHeight: 90 }))).toMatchObject({ autoSize: 'off', fixedHeight: true, boxHeight: 90 });
    expect(readParagraphBox(textNode({ boxWidth: 300, boxHeight: 90, boxAutoSize: 'height' }))).toMatchObject({ fixedHeight: false });
    expect(textExtrasForNode(textNode({ boxWidth: 300, boxHeight: 90, boxAutoSize: 'height' }))).toBeUndefined();
  });

  it('a fixed box carries its height, alignment and fit scale to the painter', () => {
    const fixed = textNode({ boxWidth: 300, boxHeight: 90, boxVerticalAlign: 'center', boxAutoSize: 'fit' });
    expect(textExtrasForNode(fixed, undefined, { fitScale: 0.5 })).toEqual({ boxHeight: 90, boxVerticalAlign: 'center', fitScale: 0.5 });
    // A scale of 1 (fits as authored) is not emitted.
    expect(textExtrasForNode(fixed, undefined, { fitScale: 1 })).toEqual({ boxHeight: 90, boxVerticalAlign: 'center' });
  });
});

// ── Reflow handles ───────────────────────────────────────────────────

const world = (pose: BoxPose, local: { x: number; y: number }) => {
  const v = localToParentVector(local, pose.rotationDeg, pose.scaleX, pose.scaleY);
  return { x: pose.x + v.x, y: pose.y + v.y };
};

/** The point on the box edge OPPOSITE the handle (the one that must not move). */
const anchorOf = (handle: (typeof BOX_HANDLES)[number], w: number, h: number) => {
  const d = handleDirection(handle);
  return { x: (-d.x * w) / 2, y: (-d.y * h) / 2 };
};

describe('resizeBoxFromHandle', () => {
  it('right handle on an unrotated layer: wider box, left edge fixed', () => {
    const pose: BoxPose = { width: 200, height: 100, x: 100, y: 50, rotationDeg: 0, scaleX: 1, scaleY: 1 };
    const r = resizeBoxFromHandle(pose, 'e', { x: 50, y: 30 });
    expect(r).toEqual({ width: 250, height: 100, x: 125, y: 50 });
    expect(r.x - r.width / 2).toBe(pose.x - pose.width / 2);
  });

  const POSES: BoxPose[] = [
    { width: 240, height: 120, x: 400, y: 300, rotationDeg: 37, scaleX: 1.5, scaleY: 1.5 },
    { width: 180, height: 90, x: -20, y: 75, rotationDeg: -110, scaleX: 0.6, scaleY: 2.2 },
    { width: 300, height: 60, x: 10, y: 10, rotationDeg: 90, scaleX: -1, scaleY: 1 },
  ];

  it.each(POSES)('every handle keeps the opposite edge still (rot $rotationDeg°, scale $scaleX×$scaleY)', (pose) => {
    for (const handle of BOX_HANDLES) {
      const r = resizeBoxFromHandle(pose, handle, { x: 33, y: -21 }, { minWidth: 1, minHeight: 1 });
      const next: BoxPose = { ...pose, width: r.width, height: r.height, x: r.x, y: r.y };
      const before = world(pose, anchorOf(handle, pose.width, pose.height));
      const after = world(next, anchorOf(handle, r.width, r.height));
      expect([handle, after.x]).toEqual([handle, expect.closeTo(before.x, 9)]);
      expect([handle, after.y]).toEqual([handle, expect.closeTo(before.y, 9)]);
    }
  });

  it('clamps to the minimum size and still pins the opposite edge', () => {
    const pose = POSES[0]!;
    const r = resizeBoxFromHandle(pose, 'w', { x: 10_000, y: 0 }, { minWidth: 16 });
    expect(r.width).toBe(16);
    const after = world({ ...pose, ...r }, anchorOf('w', r.width, r.height));
    const before = world(pose, anchorOf('w', pose.width, pose.height));
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('lockHeight ignores vertical motion; round snaps the size', () => {
    const pose = POSES[1]!;
    expect(resizeBoxFromHandle(pose, 'se', { x: 10.4, y: 50 }, { lockHeight: true }).height).toBe(pose.height);
    expect(resizeBoxFromHandle(pose, 'se', { x: 10.4, y: 5.6 }, { round: true })).toMatchObject({ width: 190, height: 96 });
  });

  it('a composition-space pointer delta maps into layer units through parent, rotation and scale', () => {
    const parent = { a: 2, b: 0, c: 0, d: 2 }; // a 200% parent
    const local = { x: 12, y: -7 };
    const inParent = localToParentVector(local, 30, 1.5, 0.5);
    const comp = { x: parent.a * inParent.x + parent.c * inParent.y, y: parent.b * inParent.x + parent.d * inParent.y };
    const back = compDeltaToLocal(comp, parent, 30, 1.5, 0.5);
    expect(back.x).toBeCloseTo(local.x, 9);
    expect(back.y).toBeCloseTo(local.y, 9);
  });
});

describe('conversion helpers', () => {
  it('line block anchor follows alignment and paragraph indents', () => {
    expect(lineBlockAnchorX('left', 200)).toBe(-100);
    expect(lineBlockAnchorX('right', 200)).toBe(100);
    expect(lineBlockAnchorX('center', 200)).toBe(0);
    expect(lineBlockAnchorX('justify-left', 200, { left: 10, right: 4 })).toBe(-90);
    expect(lineBlockAnchorX('center', 200, { left: 10, right: 4 })).toBe(3);
  });

  it('compensatePosition cancels a content shift through R·S', () => {
    const pose = { x: 50, y: 60, rotationDeg: 90, scaleX: 2, scaleY: 1 };
    const shift = { x: 10, y: 0 };
    const p = compensatePosition(pose, shift);
    // Content moved +10 local x → +20 parent along the rotated x axis (down).
    expect(p.x).toBeCloseTo(50, 9);
    expect(p.y).toBeCloseTo(40, 9);
  });
});
