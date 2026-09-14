/**
 * AE snap FEATURES — anchor points, mask/shape vertices and projected 3D
 * points — as 2-D point targets beside the 1-D edge/centre lines.
 */

import { SnapEngine, type SnapFeatureNode, type SnapPointTarget } from './SnapEngine';
import * as Mat from '../math/Mat2D';
import * as R from '../math/Rect';

const at = (x: number, y: number): Mat.Mat2D => Mat.translation(x, y);

describe('SnapEngine.featurePoints', () => {
  it('emits a 2D layer anchor through its world matrix', () => {
    const node: SnapFeatureNode = { worldMatrix: at(100, 50), anchor: { x: 10, y: -5 } };
    expect(SnapEngine.featurePoints([node])).toEqual([{ x: 110, y: 45, source: 'anchor-point' }]);
  });

  it('emits every mask and shape-path vertex in world space', () => {
    const node: SnapFeatureNode = {
      worldMatrix: Mat.multiply(at(200, 0), Mat.scaling(2, 2)),
      pathPoints: [{ x: 1, y: 1 }],
      maskPaths: [{ points: [{ x: 5, y: 0 }, { x: 0, y: 5 }] }],
    };
    const verts = SnapEngine.featurePoints([node]).filter((p) => p.source === 'mask-vertex');
    expect(verts).toEqual([
      { x: 202, y: 2, source: 'mask-vertex' },
      { x: 210, y: 0, source: 'mask-vertex' },
      { x: 200, y: 10, source: 'mask-vertex' },
    ]);
  });

  it('emits a 3D layer anchor and its projected corners as projected-3d', () => {
    const node: SnapFeatureNode = {
      worldMatrix: at(0, 0),
      is3D: true,
      worldCorners: [{ x: -10, y: -8 }, { x: 12, y: -9 }, { x: 11, y: 7 }, { x: -9, y: 6 }],
    };
    const pts = SnapEngine.featurePoints([node]);
    expect(pts).toHaveLength(5);
    expect(pts.every((p) => p.source === 'projected-3d')).toBe(true);
    expect(pts).toContainEqual({ x: 12, y: -9, source: 'projected-3d' });
  });
});

describe('SnapEngine point snapping', () => {
  const anchor: SnapPointTarget = { x: 103, y: 205, source: 'anchor-point' };

  it('snapPoint locks BOTH axes to a point feature in reach', () => {
    const e = new SnapEngine();
    const r = e.snapPoint({ x: 101, y: 203 }, [], 3, [anchor]);
    expect(r.snapped).toBe(true);
    expect(r.value).toEqual({ x: 103, y: 205 });
    // A cross through the feature: one line per axis, tagged with its source.
    expect(r.lines.map((l) => [l.axis, l.position, l.source])).toEqual([
      ['x', 103, 'anchor-point'],
      ['y', 205, 'anchor-point'],
    ]);
  });

  it('a point beats a nearer 1-D line target (the more specific magnet)', () => {
    const e = new SnapEngine();
    const r = e.snapPoint({ x: 101, y: 203 }, [{ axis: 'x', position: 101.5, source: 'guide' }], 3, [anchor]);
    expect(r.value).toEqual({ x: 103, y: 205 });
  });

  it('snapRect lands a moving corner on a mask vertex', () => {
    const e = new SnapEngine();
    const vertex: SnapPointTarget = { x: 50, y: 60, source: 'mask-vertex' };
    const r = e.snapRect(R.rect(48, 58, 20, 20), [], 3, undefined, [vertex]);
    expect(r.snapped).toBe(true);
    expect(r.delta).toEqual({ x: 2, y: 2 });
    expect(r.value).toEqual(R.rect(50, 60, 20, 20));
  });

  it('snapRect lands the moving centre on a projected 3D point', () => {
    const e = new SnapEngine();
    const p3d: SnapPointTarget = { x: 300, y: 300, source: 'projected-3d' };
    const r = e.snapRect(R.rect(289, 291, 20, 20), [], 3, undefined, [p3d]);
    expect(r.delta.x).toBeCloseTo(1);
    expect(r.delta.y).toBeCloseTo(-1);
  });

  it('each feature has its own switch, and all ride on toObjects', () => {
    const e = new SnapEngine();
    e.setSettings({ toAnchors: false });
    expect(e.snapPoint({ x: 102, y: 204 }, [], 3, [anchor]).snapped).toBe(false);
    e.setSettings({ toAnchors: true, toObjects: false });
    expect(e.snapPoint({ x: 102, y: 204 }, [], 3, [anchor]).snapped).toBe(false);
    e.setSettings({ toObjects: true, toMaskVertices: false });
    expect(e.snapPoint({ x: 1, y: 1 }, [], 3, [{ x: 2, y: 2, source: 'mask-vertex' }]).snapped).toBe(false);
    e.setSettings({ toMaskVertices: true, to3D: false });
    expect(e.snapPoint({ x: 1, y: 1 }, [], 3, [{ x: 2, y: 2, source: 'projected-3d' }]).snapped).toBe(false);
  });

  it('the master switch stops point snapping unless forced', () => {
    const e = new SnapEngine();
    e.setSettings({ enabled: false });
    expect(e.snapPoint({ x: 102, y: 204 }, [], 3, [anchor]).snapped).toBe(false);
    expect(e.snapPoint({ x: 102, y: 204 }, [], 3, [anchor], { force: true }).snapped).toBe(true);
  });

  it('out of reach leaves the point alone and falls back to lines', () => {
    const e = new SnapEngine();
    const r = e.snapPoint({ x: 90, y: 190 }, [{ axis: 'y', position: 191, source: 'guide' }], 3, [anchor]);
    expect(r.value).toEqual({ x: 90, y: 191 });
  });
});
