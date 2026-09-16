import { Matrix, Matrix4Math, Project3D } from '@motion/scene';
import { local2D, local3D, localBrushSizeVia, thinSamples } from './paintSpace';

const compose2D = (x: number, y: number, rotDeg: number, sx: number, sy: number) =>
  Matrix.compose({
    position: { x, y },
    rotation: (rotDeg * Math.PI) / 180,
    scale: { x: sx, y: sy },
    skew: { x: 0, y: 0 },
    anchor: { x: 0, y: 0 },
  });

/** Forward placement the renderer applies to a paint point: world · (p − anchor). */
const forward2D = (world: ReturnType<typeof compose2D>, anchor: { x: number; y: number }, p: { x: number; y: number }) =>
  Matrix.transformPoint(world, { x: p.x - anchor.x, y: p.y - anchor.y });

describe('local2D — the world affine, not the static props', () => {
  test('round-trips a rotated, scaled, anchored layer', () => {
    const world = compose2D(400, 300, 35, 2, 0.5);
    const anchor = { x: 12, y: -8 };
    const p = { x: 30, y: -20 };
    const q = local2D(world, anchor, forward2D(world, anchor, p))!;
    expect(q.x).toBeCloseTo(p.x);
    expect(q.y).toBeCloseTo(p.y);
  });

  test('a parent chain composes into the inversion', () => {
    // The static-props inversion ignored the parent entirely — this point
    // would have landed (parent offset + rotation) away from the pointer.
    const parent = compose2D(200, 100, 90, 1.5, 1.5);
    const child = compose2D(50, 0, -20, 1, 1);
    const world = Matrix.multiply(parent, child);
    const p = { x: -15, y: 40 };
    const q = local2D(world, { x: 0, y: 0 }, forward2D(world, { x: 0, y: 0 }, p))!;
    expect(q.x).toBeCloseTo(p.x);
    expect(q.y).toBeCloseTo(p.y);
  });

  test('a zero-scale layer has no surface', () => {
    expect(local2D(compose2D(0, 0, 0, 0, 1), { x: 0, y: 0 }, { x: 5, y: 5 })).toBeNull();
  });
});

describe('local3D — ray onto the layer plane', () => {
  const world = Matrix4Math.compose({
    position: { x: 960, y: 540, z: 200 },
    rotation: { x: 0.2, y: 0.6, z: 0 },
    scale: { x: 1.5, y: 1.5, z: 1 },
    anchor: { x: 10, y: -5, z: 0 },
  });
  const eye = { x: 960, y: 540, z: -1500 };
  const rayTo = (target: { x: number; y: number; z: number }): Project3D.Ray3D => {
    const d = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
    const n = Math.hypot(d.x, d.y, d.z);
    return { origin: eye, direction: { x: d.x / n, y: d.y / n, z: d.z / n } };
  };

  test('recovers the paint point a camera ray passes through', () => {
    const p = { x: 30, y: -20 };
    const onPlane = Matrix4Math.transformPoint(world, { x: p.x, y: p.y, z: 0 });
    const q = local3D(world, rayTo(onPlane))!;
    expect(q.x).toBeCloseTo(p.x, 3);
    expect(q.y).toBeCloseTo(p.y, 3);
  });

  test('an edge-on layer refuses instead of painting at its origin', () => {
    const edgeOn = Matrix4Math.compose({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: Math.PI / 2, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    expect(local3D(edgeOn, { origin: { x: 0, y: 0, z: -100 }, direction: { x: 0, y: 0, z: 1 } })).toBeNull();
  });

  test('a plane behind the eye is not hit', () => {
    const p = Matrix4Math.transformPoint(world, { x: 0, y: 0, z: 0 });
    const ray = rayTo(p);
    const away = { origin: ray.origin, direction: { x: -ray.direction.x, y: -ray.direction.y, z: -ray.direction.z } };
    expect(local3D(world, away)).toBeNull();
  });
});

describe('localBrushSizeVia', () => {
  test('divides out the scale the mapping actually applies', () => {
    // A layer shown at 2× (parent or animated scale alike): 20 comp px = 10 local.
    expect(localBrushSizeVia((p) => ({ x: p.x / 2, y: p.y / 2 }), { x: 5, y: 5 }, 20)).toBeCloseTo(10);
  });
  test('null when the mapping has no answer', () => {
    expect(localBrushSizeVia(() => null, { x: 0, y: 0 }, 20)).toBeNull();
  });
});

describe('thinSamples', () => {
  test('drops sub-threshold jitter but always keeps the last sample', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.3, y: 0 }, { x: 1, y: 0 }, { x: 1.2, y: 0 }];
    expect(thinSamples(pts, 0.5)).toEqual([0, 3, 4]);
  });
  test('a single dab and an empty drag', () => {
    expect(thinSamples([{ x: 3, y: 3 }])).toEqual([0]);
    expect(thinSamples([])).toEqual([]);
  });
});
