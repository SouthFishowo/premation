import { shapeOutline, zigzag, roundCorners, puckerBloat, twist, applyPathOp, type PathOp } from './pathOps';
import type { Pt } from './trimPath';

const square: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

describe('shapeOutline', () => {
  it('rect → 4 centred corners', () => {
    expect(shapeOutline('rect', 100, 60)).toEqual([
      { x: -50, y: -30 },
      { x: 50, y: -30 },
      { x: 50, y: 30 },
      { x: -50, y: 30 },
    ]);
  });
  it('ellipse → N points on the ellipse', () => {
    const pts = shapeOutline('ellipse', 100, 100, 4);
    expect(pts).toHaveLength(4);
    expect(pts[0]!.x).toBeCloseTo(50);
    expect(pts[1]!.y).toBeCloseTo(50);
  });

  it('all-zero cornerRadii is byte-identical to no radii at all', () => {
    expect(shapeOutline('rect', 100, 60, 48, 0, [0, 0, 0, 0])).toEqual(shapeOutline('rect', 100, 60));
    expect(shapeOutline('rect', 100, 60, 48, 2, [0, 0, 0, 0])).toEqual(shapeOutline('rect', 100, 60, 48, 2));
  });

  it('cornerRadii round the outline: arc points sit at radius r from each corner centre', () => {
    const r = 20;
    const pts = shapeOutline('rect', 100, 60, 48, 0, [r, r, r, r]);
    // Many more points than 4 (flattened arcs)…
    expect(pts.length).toBeGreaterThan(20);
    // …every point on the outline is either on a straight edge (|x| = 50 or
    // |y| = 30) or exactly r from its corner's arc centre.
    const centres = [
      { x: -50 + r, y: -30 + r }, { x: 50 - r, y: -30 + r },
      { x: 50 - r, y: 30 - r }, { x: -50 + r, y: 30 - r },
    ];
    for (const p of pts) {
      const onEdge =
        (Math.abs(Math.abs(p.x) - 50) < 1e-6 && Math.abs(p.y) <= 30 - r + 1e-6)
        || (Math.abs(Math.abs(p.y) - 30) < 1e-6 && Math.abs(p.x) <= 50 - r + 1e-6);
      const onArc = centres.some((c) => Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - r) < 1e-6);
      expect(onEdge || onArc).toBe(true);
    }
    // The sharp corner itself is GONE.
    expect(pts.some((p) => Math.abs(p.x) > 50 - 1e-6 && Math.abs(p.y) > 30 - 1e-6)).toBe(false);
    // Adaptive density on the arcs: consecutive ARC points are within the
    // chain's own ~2.5px chord budget.
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const bothOnOneArc = centres.some(
        (c) =>
          Math.abs(Math.hypot(a.x - c.x, a.y - c.y) - r) < 1e-6
          && Math.abs(Math.hypot(b.x - c.x, b.y - c.y) - r) < 1e-6,
      );
      if (bothOnOneArc) expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(2.6);
    }
  });

  it('independent radii round only the corners that ask for it', () => {
    const pts = shapeOutline('rect', 100, 60, 48, 0, [20, 0, 0, 0]);
    // TL is rounded away; the other three sharp corners survive.
    expect(pts.some((p) => Math.abs(p.x + 50) < 1e-6 && Math.abs(p.y + 30) < 1e-6)).toBe(false);
    expect(pts.some((p) => Math.abs(p.x - 50) < 1e-6 && Math.abs(p.y + 30) < 1e-6)).toBe(true);
    expect(pts.some((p) => Math.abs(p.x - 50) < 1e-6 && Math.abs(p.y - 30) < 1e-6)).toBe(true);
    expect(pts.some((p) => Math.abs(p.x + 50) < 1e-6 && Math.abs(p.y - 30) < 1e-6)).toBe(true);
  });
});

describe('zigzag', () => {
  it('offsets interior points perpendicular, alternating sign', () => {
    // one horizontal edge (0,0)→(4,0), 2 segments, amplitude 1
    const out = zigzag([{ x: 0, y: 0 }, { x: 4, y: 0 }], false, 1, 2);
    // vertex (0,0), interior at t=0.5 → (2,0) + perp(0,1)*+1 = (2,1), then end vertex (4,0)
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 1 },
      { x: 4, y: 0 },
    ]);
  });
  it('adds ridges to every edge of a closed shape', () => {
    const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const out = zigzag(sq, true, 2, 3);
    // 4 edges × 3 points each = 12
    expect(out).toHaveLength(12);
  });
});

describe('roundCorners', () => {
  it('cuts each corner back along both edges', () => {
    const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const out = roundCorners(sq, true, 3, 1); // steps 1 → just the two cut points per corner
    // corner (0,0): neighbours (0,10) and (10,0) → cut points (0,3) and (3,0)
    expect(out).toContainEqual({ x: 0, y: 3 });
    expect(out).toContainEqual({ x: 3, y: 0 });
    expect(out.length).toBe(8); // 2 points × 4 corners
  });
  it('clamps the radius to half the shortest edge', () => {
    const sq: Pt[] = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const out = roundCorners(sq, true, 100, 1); // radius clamps to 2
    expect(out).toContainEqual({ x: 2, y: 0 });
  });
  it('leaves too-small paths untouched', () => {
    expect(roundCorners([{ x: 0, y: 0 }, { x: 1, y: 1 }], true, 5)).toHaveLength(2);
  });
});

describe('puckerBloat', () => {
  it('bloat (amount > 0) pushes points out from the centroid', () => {
    // centroid (5,5); +100% → f=2; (0,0) → (5,5) + (-5,-5)*2 = (-5,-5)
    const out = puckerBloat(square, 100);
    expect(out[0]).toEqual({ x: -5, y: -5 });
    expect(out[2]).toEqual({ x: 15, y: 15 });
  });
  it('pucker (amount < 0) pulls points in toward the centroid', () => {
    const out = puckerBloat(square, -50); // f=0.5
    expect(out[0]).toEqual({ x: 2.5, y: 2.5 });
  });
});

describe('twist', () => {
  it('rotates outer points around the centroid (90° → quarter turn)', () => {
    // all corners at max radius → full 90° rotation about (5,5)
    const out = twist(square, 90);
    expect(out[0]!.x).toBeCloseTo(10);
    expect(out[0]!.y).toBeCloseTo(0);
    expect(out[1]!.x).toBeCloseTo(10);
    expect(out[1]!.y).toBeCloseTo(10);
  });
  it('a zero angle is identity', () => {
    expect(twist(square, 0)).toEqual(square);
  });
});

describe('applyPathOp', () => {
  it('routes to the configured operator, none is identity', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(applyPathOp(pts, true, { id: 'o1', type: 'none', amount: 5, detail: 2 } as PathOp)).toEqual(pts);
    expect(applyPathOp(pts, true, { id: 'o1', type: 'zigzag', amount: 2, detail: 2 }).length).toBeGreaterThan(pts.length);
    expect(applyPathOp(square, true, { id: 'o1', type: 'pucker', amount: 100, detail: 0 })[0]).toEqual({ x: -5, y: -5 });
    expect(applyPathOp(square, true, { id: 'o1', type: 'twist', amount: 0, detail: 0 })).toEqual(square);
  });
});

describe('offsetPath', () => {
  const { offsetPath } = require('./pathOps');
  const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it('amount 0 is a no-op', () => {
    expect(offsetPath(sq, true, 0)).toEqual(sq);
  });

  it('moves every corner diagonally by the same distance', () => {
    const out = offsetPath(sq, true, 2);
    // Uniform offset: every point moves the same distance.
    const dists = out.map((p: Pt, i: number) => Math.hypot(p.x - sq[i]!.x, p.y - sq[i]!.y));
    for (const d of dists) expect(d).toBeCloseTo(dists[0]!, 6);
    expect(dists[0]).toBeGreaterThan(0);
  });

  it('negative amount moves points the opposite way', () => {
    const grow = offsetPath(sq, true, 2);
    const shrink = offsetPath(sq, true, -2);
    expect(shrink[0]!.x).toBeCloseTo(2 * sq[0]!.x - grow[0]!.x, 6);
    expect(shrink[0]!.y).toBeCloseTo(2 * sq[0]!.y - grow[0]!.y, 6);
  });

  it('open paths offset endpoints along their single edge normal', () => {
    const line: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const out = offsetPath(line, false, 3);
    expect(out[0]!.y).toBeCloseTo(3);
    expect(out[1]!.y).toBeCloseTo(3);
    expect(out[0]!.x).toBeCloseTo(0);
  });
});

describe('offsetPath joins', () => {
  const { offsetPath, offsetPathRuns } = require('./pathOps');
  const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  // A right-angle open elbow: the outer corner shows the join.
  const elbow: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];

  it('miter (the default) extends outer corners to the true edge intersection', () => {
    // Offsetting the square OUTWARD (this winding: negative amount) puts each
    // corner's miter apex diagonally at amount·√2 — the two offset edges meet
    // exactly there, unlike the old averaged-normal point at amount·1.
    const out = offsetPath(sq, true, -2);
    expect(out).toHaveLength(4);
    expect(out[0]!.x).toBeCloseTo(-2, 6);
    expect(out[0]!.y).toBeCloseTo(-2, 6);
  });

  it('a corner past the miter limit falls back to a bevel', () => {
    // 90° corner: miter ratio = √2 ≈ 1.414. Limit 1 forces the bevel — the
    // apex is replaced by the two offset-edge endpoints.
    const out = offsetPath(elbow, false, -2, 'miter', 1) as Pt[];
    expect(out).toHaveLength(4); // start, two bevel points, end
    expect(out[1]).toEqual({ x: 10, y: -2 });
    expect(out[2]).toEqual({ x: 12, y: 0 });
    // …and a generous limit keeps the apex.
    const kept = offsetPath(elbow, false, -2, 'miter', 4) as Pt[];
    expect(kept).toHaveLength(3);
    expect(kept[1]!.x).toBeCloseTo(12, 6);
    expect(kept[1]!.y).toBeCloseTo(-2, 6);
  });

  it('round joins sweep an arc of radius |amount| about the vertex', () => {
    const out = offsetPath(elbow, false, -2, 'round') as Pt[];
    expect(out.length).toBeGreaterThan(4);
    for (const p of out.slice(1, -1)) {
      expect(Math.hypot(p.x - 10, p.y - 0)).toBeCloseTo(2, 6);
    }
  });

  it('bevel joins cut straight across', () => {
    const out = offsetPath(elbow, false, -2, 'bevel') as Pt[];
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual({ x: 10, y: -2 });
    expect(out[2]).toEqual({ x: 12, y: 0 });
  });

  it('a convex shape offset past its inradius collapses to nothing (AE behaviour)', () => {
    expect(offsetPathRuns(sq, true, 6)).toEqual([]);
  });

  it('concave corners no longer self-intersect: the crossed loop is removed', () => {
    // An L: offsetting INWARD (positive amount on this winding) pinches the
    // reflex corner. The naive offset left a bow-tie; the cleanup must return
    // simple ring(s) only.
    const L: Pt[] = [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 8 },
      { x: 8, y: 8 }, { x: 8, y: 20 }, { x: 0, y: 20 },
    ];
    const runs = offsetPathRuns(L, true, 3) as Pt[][];
    expect(runs.length).toBeGreaterThan(0);
    for (const ring of runs) {
      expect(hasSelfIntersection(ring)).toBe(false);
    }
    // Total surviving area is smaller than the source's (it shrank).
    const area = (ring: Pt[]): number => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % ring.length]!;
        a += p.x * q.y - q.x * p.y;
      }
      return Math.abs(a / 2);
    };
    const total = runs.reduce((s, r) => s + area(r), 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(20 * 20 - 12 * 12); // the L's own area
  });

  it('a leg thinner than the offset vanishes; the thicker one survives, un-crossed', () => {
    // Horizontal leg 4 thick (vanishes at ±3), vertical leg 8 thick (survives
    // as a 2-wide strip). The naive offset left the vanished leg as an
    // inverted bow-tie loop; the cleanup must drop it.
    const L: Pt[] = [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 4 },
      { x: 8, y: 4 }, { x: 8, y: 20 }, { x: 0, y: 20 },
    ];
    const runs = offsetPathRuns(L, true, 3) as Pt[][];
    expect(runs.length).toBeGreaterThan(0);
    for (const ring of runs) expect(hasSelfIntersection(ring)).toBe(false);
    // Nothing survives inside the vanished horizontal leg (x beyond the
    // vertical strip).
    for (const ring of runs) for (const p of ring) expect(p.x).toBeLessThan(10);
  });

  it('offsetting an L OUTWARD stays a single simple ring with a joined reflex corner', () => {
    const L: Pt[] = [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 8 },
      { x: 8, y: 8 }, { x: 8, y: 20 }, { x: 0, y: 20 },
    ];
    const runs = offsetPathRuns(L, true, -2) as Pt[][];
    expect(runs).toHaveLength(1);
    expect(hasSelfIntersection(runs[0]!)).toBe(false);
  });
});

/** Brute-force segment-pair test (fine for test-sized rings). */
function hasSelfIntersection(ring: Pt[]): boolean {
  const n = ring.length;
  const seg = (i: number): [Pt, Pt] => [ring[i]!, ring[(i + 1) % n]!];
  const crosses = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
    const o = (p: Pt, q: Pt, r: Pt): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const eps = 1e-9;
    const o1 = o(a, b, c);
    const o2 = o(a, b, d);
    const o3 = o(c, d, a);
    const o4 = o(c, d, b);
    return ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps))
      && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent around the wrap
      const [a, b] = seg(i);
      const [c, d] = seg(j);
      if (crosses(a, b, c, d)) return true;
    }
  }
  return false;
}

describe('roughen', () => {
  const { roughen } = require('./pathOps');
  const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it('amount 0 is a no-op', () => {
    expect(roughen(sq, true, 0, 4)).toEqual(sq);
  });

  it('subdivides: closed shape gains detail× points', () => {
    const out = roughen(sq, true, 1, 3);
    expect(out).toHaveLength(4 * 3);
  });

  it('is deterministic (same input → identical output)', () => {
    expect(roughen(sq, true, 2, 4)).toEqual(roughen(sq, true, 2, 4));
  });

  it('displacement scales with amount', () => {
    const small = roughen(sq, true, 1, 4);
    const big = roughen(sq, true, 5, 4);
    // Different amounts must land the same subdivided point differently.
    const dSmall = Math.hypot(small[1]!.x - big[1]!.x, small[1]!.y - big[1]!.y);
    expect(dSmall).toBeGreaterThan(0);
  });

  it('applyPathOp routes offset and roughen', () => {
    const off: PathOp = { id: 'o1', type: 'offset', amount: 2, detail: 0 };
    const rough: PathOp = { id: 'o1', type: 'roughen', amount: 2, detail: 3 };
    expect(applyPathOp(sq, true, off)).toHaveLength(4);
    expect(applyPathOp(sq, true, rough)).toHaveLength(12);
  });
});

// ── Wiggle Paths: the temporal half of roughen ──────────────────────
//
// These assert INVARIANTS rather than pinning coordinates. A frozen golden
// here would pass just as happily on a wiggle that jumps discontinuously or
// runs at the wrong rate — both of which look like plausible noise in a still.
describe('roughen over time (Wiggle Paths)', () => {
  const { roughen } = require('./pathOps');
  const sq: Pt[] = [
    { x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 },
  ];
  const maxDelta = (a: readonly Pt[], b: readonly Pt[]): number => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y));
    return d;
  };

  it('phase 0 is byte-identical to the pre-temporal output', () => {
    // The back-compat contract: an old project has no wigglesPerSecond, reads
    // as 0, and must render exactly what it always did.
    expect(roughen(sq, true, 3, 4, 0, 0)).toEqual(roughen(sq, true, 3, 4));
  });

  it('a zero wiggle rate makes the outline independent of time', () => {
    const op: PathOp = { id: 'o1', type: 'roughen', amount: 3, detail: 4, wigglesPerSecond: 0 };
    expect(applyPathOp(sq, true, op, 9.75)).toEqual(applyPathOp(sq, true, op, 0));
  });

  it('a non-zero wiggle rate makes the outline move', () => {
    const op: PathOp = { id: 'o1', type: 'roughen', amount: 3, detail: 4, wigglesPerSecond: 2 };
    expect(maxDelta(applyPathOp(sq, true, op, 0), applyPathOp(sq, true, op, 0.25))).toBeGreaterThan(0);
  });

  it('is deterministic across calls at the same time (preview ≡ export)', () => {
    const op: PathOp = { id: 'o1', type: 'roughen', amount: 4, detail: 3, wigglesPerSecond: 3, seed: 7 };
    expect(applyPathOp(sq, true, op, 1.37)).toEqual(applyPathOp(sq, true, op, 1.37));
  });

  it('is continuous — no snap between noise fields', () => {
    // Straddle a whole-numbered phase boundary, where a naive implementation
    // would swap noise fields outright. The step across it must be no larger
    // than a comparable step just inside one field.
    const op: PathOp = { id: 'o1', type: 'roughen', amount: 5, detail: 4, wigglesPerSecond: 1 };
    const eps = 1e-3;
    const across = maxDelta(applyPathOp(sq, true, op, 1 - eps), applyPathOp(sq, true, op, 1 + eps));
    const within = maxDelta(applyPathOp(sq, true, op, 1.4), applyPathOp(sq, true, op, 1.4 + 2 * eps));
    expect(across).toBeLessThanOrEqual(Math.max(within, eps) * 10);
  });

  it('never displaces further than Size, at any phase', () => {
    // The amplitude bound is what stops an animated wiggle from tearing a
    // shape apart at some phase the eye never checks.
    const amount = 6;
    const base = roughen(sq, true, 0.0000001, 4, 0, 0); // same subdivision, ~undisplaced
    for (const phase of [0, 0.3, 0.5, 1.7, 12.25]) {
      const out = roughen(sq, true, amount, 4, phase, 0);
      expect(maxDelta(base, out)).toBeLessThanOrEqual(amount + 1e-6);
    }
  });

  it('different seeds decorrelate two otherwise identical layers', () => {
    const a = roughen(sq, true, 4, 4, 0.5, 0);
    const b = roughen(sq, true, 4, 4, 0.5, 99);
    expect(maxDelta(a, b)).toBeGreaterThan(0);
  });
});
