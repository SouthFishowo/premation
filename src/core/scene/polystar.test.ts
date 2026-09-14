import {
  defaultPolystar,
  polystarOutline,
  polystarParamSpecs,
  polystarPropPath,
  readNodePolystar,
  resolvePolystar,
  type Polystar,
} from './polystar';
import type { SceneNode } from '@core/types';

const star = (over: Partial<Polystar> = {}): Polystar => ({
  starType: 'star', points: 5, rotation: 0,
  outerRadius: 100, innerRadius: 50,
  outerRoundness: 0, innerRoundness: 0,
  ...over,
});

describe('polystarOutline', () => {
  it('a star has 2·points vertices alternating outer / inner radius', () => {
    const pts = polystarOutline(star());
    expect(pts.length).toBe(10);
    pts.forEach((p, i) => {
      const r = Math.hypot(p.x, p.y);
      expect(r).toBeCloseTo(i % 2 === 0 ? 100 : 50, 6);
    });
  });

  it('a polygon has exactly `points` vertices on the outer radius', () => {
    const pts = polystarOutline(star({ starType: 'polygon', points: 6 }));
    expect(pts.length).toBe(6);
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(100, 6);
  });

  it('the first vertex points straight up, and rotation turns it', () => {
    const up = polystarOutline(star());
    expect(up[0]!.x).toBeCloseTo(0, 6);
    expect(up[0]!.y).toBeCloseTo(-100, 6);
    const turned = polystarOutline(star({ rotation: 90 }));
    expect(turned[0]!.x).toBeCloseTo(100, 6);
    expect(turned[0]!.y).toBeCloseTo(0, 6);
  });

  it('roundness 0 emits pure corners (handles ON the vertex), so the chain sees a plain polygon', () => {
    for (const p of polystarOutline(star())) {
      expect(p.inX).toBeCloseTo(p.x, 9);
      expect(p.inY).toBeCloseTo(p.y, 9);
      expect(p.outX).toBeCloseTo(p.x, 9);
      expect(p.outY).toBeCloseTo(p.y, 9);
    }
  });

  it('roundness converts vertices to bezier: tangent handles proportional to segment length', () => {
    // AE / Lottie constant: handle length = π·r·pct / (2·points).
    const pts = polystarOutline(star({ outerRoundness: 60 }));
    const outer = pts[0]!;
    const expected = (Math.PI * 100 * 0.6) / (2 * 5);
    expect(Math.hypot(outer.outX - outer.x, outer.outY - outer.y)).toBeCloseTo(expected, 6);
    expect(Math.hypot(outer.inX - outer.x, outer.inY - outer.y)).toBeCloseTo(expected, 6);
    // Handles are TANGENT — perpendicular to the radius at the vertex.
    const dot = (outer.outX - outer.x) * outer.x + (outer.outY - outer.y) * outer.y;
    expect(Math.abs(dot)).toBeLessThan(1e-6);
    // Inner vertices stay corners: only outerRoundness was set.
    const inner = pts[1]!;
    expect(inner.inX).toBeCloseTo(inner.x, 9);
    expect(inner.outX).toBeCloseTo(inner.x, 9);
  });

  it('inner roundness scales with the INNER radius', () => {
    const pts = polystarOutline(star({ innerRoundness: 100 }));
    const inner = pts[1]!;
    const expected = (Math.PI * 50 * 1) / (2 * 5);
    expect(Math.hypot(inner.outX - inner.x, inner.outY - inner.y)).toBeCloseTo(expected, 6);
  });
});

describe('resolvePolystar', () => {
  it('animated values win over the base, and points round to a whole count ≥ 3', () => {
    const av = new Map<string, number>([
      [polystarPropPath('points'), 7.4],
      [polystarPropPath('outerRadius'), 140],
    ]);
    const r = resolvePolystar(star(), av);
    expect(r.points).toBe(7);
    expect(r.outerRadius).toBe(140);
    expect(r.innerRadius).toBe(50); // untracked → base
    const low = resolvePolystar(star(), new Map([[polystarPropPath('points'), 1]]));
    expect(low.points).toBe(3);
  });
});

describe('readNodePolystar', () => {
  const node = (fxProps: Record<string, unknown> | null): SceneNode =>
    ({ id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
       transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
       components: fxProps ? [{ id: 'fx', type: 'fx', props: fxProps }] : [] } as unknown as SceneNode);

  it('null without a config — old baked polygons never enter the parametric path', () => {
    expect(readNodePolystar(node(null))).toBeNull();
    expect(readNodePolystar(node({ pathOps: [] }))).toBeNull();
  });

  it('coerces a stored config, repairing malformed numbers', () => {
    const r = readNodePolystar(node({ polystar: { starType: 'polygon', points: 2, outerRadius: -5, rotation: 'x' } }));
    expect(r).toEqual({
      starType: 'polygon', points: 3, rotation: 0,
      outerRadius: 0, innerRadius: 50, outerRoundness: 0, innerRoundness: 0,
    });
  });
});

describe('polystarParamSpecs', () => {
  it('a polygon hides the inner pair; a star shows all six', () => {
    expect(polystarParamSpecs('polygon').map((s) => s.param)).toEqual([
      'points', 'rotation', 'outerRadius', 'outerRoundness',
    ]);
    expect(polystarParamSpecs('star').map((s) => s.param)).toEqual([
      'points', 'rotation', 'outerRadius', 'innerRadius', 'outerRoundness', 'innerRoundness',
    ]);
  });
});

describe('defaultPolystar', () => {
  it('seeds from the drawn radius and the tool options', () => {
    const d = defaultPolystar('star', 200, 8, 0.4);
    expect(d).toEqual({
      starType: 'star', points: 8, rotation: 0,
      outerRadius: 200, innerRadius: 80, outerRoundness: 0, innerRoundness: 0,
    });
  });
});
