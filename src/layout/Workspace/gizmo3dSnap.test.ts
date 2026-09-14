import { Project3D, type Vec3 } from '@motion/scene';
import type { SnapPointTarget } from '@motion/workspace';
import {
  snapActive,
  snapScreenPointFree,
  snapScreenPointOnLine,
  snapGizmoTranslate,
  projectForView,
  type SnapView,
} from './gizmo3dSnap';

const pt = (x: number, y: number): SnapPointTarget => ({ x, y, source: 'projected-3d' });
const W = 1920;
const H = 1080;
const FRONT: SnapView = { camera: Project3D.defaultCamera(W, H), orthoView: 'front', width: W, height: H };
const PERSP: SnapView = { camera: Project3D.defaultCamera(W, H), orthoView: null, width: W, height: H };
const add = (a: Vec3, d: Vec3, s: number): Vec3 => ({ x: a.x + d.x * s, y: a.y + d.y * s, z: a.z + d.z * s });

describe('Ctrl/Cmd toggles snapping', () => {
  it('inverts the switch while held', () => {
    expect(snapActive(true, false)).toBe(true);
    expect(snapActive(true, true)).toBe(false);
    expect(snapActive(false, true)).toBe(true);
    expect(snapActive(false, false)).toBe(false);
  });
});

describe('screen-space solves', () => {
  it('free: the nearest feature within the threshold, else nothing', () => {
    const r = snapScreenPointFree({ x: 100, y: 100 }, [pt(104, 100), pt(102, 101)], 5);
    expect(r?.point).toEqual({ x: 102, y: 101 });
    expect(snapScreenPointFree({ x: 100, y: 100 }, [pt(110, 100)], 5)).toBeNull();
  });

  it('on a line: lands on the feature’s FOOT, needs both perpendicular and along-line reach', () => {
    const origin = { x: 100, y: 100 };
    const dir = { x: 1, y: 0 };
    const p = { x: 150, y: 100 };
    expect(snapScreenPointOnLine(p, origin, dir, [pt(152, 103)], 5)?.point).toEqual({ x: 152, y: 100 });
    expect(snapScreenPointOnLine(p, origin, dir, [pt(152, 110)], 5)).toBeNull(); // off the line
    expect(snapScreenPointOnLine(p, origin, dir, [pt(170, 100)], 5)).toBeNull(); // too far along it
    expect(snapScreenPointOnLine(p, origin, { x: 0, y: 0 }, [pt(150, 100)], 5)).toBeNull(); // no line
  });
});

describe('snapGizmoTranslate — back to 3D', () => {
  it('ortho X-axis drag: moves only along X, onto the feature’s foot', () => {
    const r = snapGizmoTranslate({
      kind: 'axis', start: { x: 100, y: 100, z: 0 }, moved: { x: 150, y: 100, z: 0 }, dir: { x: 1, y: 0, z: 0 },
      view: FRONT, points: [pt(152, 103)], threshold: 5,
    });
    expect(r!.pos.x).toBeCloseTo(152, 6);
    expect(r!.pos.y).toBeCloseTo(100, 6);
    expect(r!.pos.z).toBeCloseTo(0, 6);
  });

  it('ortho XY-plane drag: lands exactly on the feature', () => {
    const r = snapGizmoTranslate({
      kind: 'plane', start: { x: 100, y: 100, z: 0 }, moved: { x: 150, y: 100, z: 0 }, dir: { x: 0, y: 0, z: 1 },
      view: FRONT, points: [pt(152, 103)], threshold: 5,
    });
    expect(r!.pos.x).toBeCloseTo(152, 6);
    expect(r!.pos.y).toBeCloseTo(103, 6);
  });

  it('perspective, oblique axis: the solved point projects onto the foot on the projected axis line', () => {
    const start = { x: 700, y: 400, z: 300 };
    const dir = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
    const moved = add(start, dir, 80);
    const P = projectForView(moved, PERSP);
    const O = projectForView(start, PERSP);
    const F = projectForView(add(start, dir, 100), PERSP);
    const len = Math.hypot(F.x - O.x, F.y - O.y);
    const u = { x: (F.x - O.x) / len, y: (F.y - O.y) / len };
    const n = { x: -u.y, y: u.x };
    // 2 px off the line, 1.5 px further along it.
    const target = pt(P.x + u.x * 1.5 + n.x * 2, P.y + u.y * 1.5 + n.y * 2);
    const r = snapGizmoTranslate({ kind: 'axis', start, moved, dir, view: PERSP, points: [target], threshold: 4 });
    expect(r).not.toBeNull();
    // Still on the 3D axis …
    const t = (r!.pos.x - start.x) / dir.x;
    expect(r!.pos.z - start.z).toBeCloseTo(dir.z * t, 4);
    expect(r!.pos.y).toBeCloseTo(start.y, 4);
    // … and its projection is the foot of the target on the screen line.
    const shown = projectForView(r!.pos, PERSP);
    expect(shown.x).toBeCloseTo(P.x + u.x * 1.5, 3);
    expect(shown.y).toBeCloseTo(P.y + u.y * 1.5, 3);
  });

  it('perspective plane: the solved point projects exactly onto the feature', () => {
    const start = { x: 900, y: 500, z: 200 };
    const moved = { x: 930, y: 510, z: 200 };
    const P = projectForView(moved, PERSP);
    const target = pt(P.x + 2, P.y - 1);
    const r = snapGizmoTranslate({ kind: 'plane', start, moved, dir: { x: 0, y: 0, z: 1 }, view: PERSP, points: [target], threshold: 4 });
    expect(r!.pos.z).toBeCloseTo(200, 6);
    const shown = projectForView(r!.pos, PERSP);
    expect(shown.x).toBeCloseTo(target.x, 4);
    expect(shown.y).toBeCloseTo(target.y, 4);
  });

  it('nothing in reach (or no features) keeps the unsnapped move', () => {
    const base = { kind: 'plane' as const, start: { x: 0, y: 0, z: 0 }, moved: { x: 50, y: 50, z: 0 }, dir: { x: 0, y: 0, z: 1 }, view: FRONT, threshold: 3 };
    expect(snapGizmoTranslate({ ...base, points: [pt(60, 60)] })).toBeNull();
    expect(snapGizmoTranslate({ ...base, points: [] })).toBeNull();
  });
});
