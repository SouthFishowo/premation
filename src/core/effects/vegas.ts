/**
 * Vegas — runs lights ALONG the layer's own alpha contour.
 *
 * Every other member of the Generate family draws a pattern from a formula and
 * clips it to the layer. Vegas is the one whose geometry comes FROM the layer:
 * the contour is not a detail of the implementation, it is the effect. Dash
 * spacing, the direction the lights travel and what `rotation` animates are all
 * defined in ARC LENGTH around that outline.
 *
 * ── Why this is a real module and not a corner of generatePatterns ──────
 *
 * Canvas cannot stroke a raster's alpha edge. Getting the outline requires
 * marching squares over the alpha channel to extract closed contours, and
 * placing lights on it requires an arc-length walk. Both are geometry with
 * their own failure modes, so both are pure and tested here, separately from
 * the drawing.
 *
 * The tempting shortcut — stroke the layer's bounding box — renders something
 * plausible on the rectangular layers people most often reach for, which is
 * exactly what makes it dangerous: it looks correct right up until someone
 * applies it to text, and it is indistinguishable from the finished effect in a
 * screenshot. It was deleted rather than shipped, and this is the replacement.
 */

import type { Effect } from './effects';
import { effectNumber, paramsOf } from './effects';
import { unpackMaskPaths } from './strokePaint';

export interface ContourPoint {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ── Marching squares ─────────────────────────────────────────────────

/**
 * Alpha at a grid position, with everything OUTSIDE the grid reading as fully
 * transparent.
 *
 * The virtual border of zeros is what makes every contour CLOSED. Without it a
 * shape touching the canvas edge produces an open run, the stitcher below finds
 * no successor for its last segment, and the walk that follows would place
 * lights along a loop that does not exist. Cells are iterated from -1 so the
 * border is genuinely visited rather than assumed.
 */
function sampleAt(alpha: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  return alpha[y * w + x] ?? 0;
}

/**
 * Where between two corner samples the threshold is crossed, 0..1.
 *
 * Linear rather than a fixed midpoint, because an antialiased edge — which is
 * every shape and every glyph this will actually be used on — carries the
 * sub-pixel position of the true edge in its alpha ramp. Snapping to midpoints
 * would stair-step the contour and make the lights jitter as a layer moves.
 * Equal samples cannot be crossed at all and return the midpoint, which is
 * unreachable in practice (the case is only generated when the two corners
 * straddle the threshold) but keeps the function total.
 */
function crossing(a: number, b: number, threshold: number): number {
  const d = b - a;
  if (d === 0) return 0.5;
  return clamp((threshold - a) / d, 0, 1);
}

/** The four edge midpoints of one cell, named by side. */
type Side = 'T' | 'R' | 'B' | 'L';

/**
 * The marching-squares case table, DERIVED rather than copied.
 *
 * Corner bits: TL=8, TR=4, BR=2, BL=1, set when that corner's alpha is at or
 * above the threshold ("inside").
 *
 * Every segment is DIRECTED, with the convention **inside on the left**. In
 * screen coordinates (x right, y down) the left of a direction (dx, dy) is
 * (dy, -dx) — walk right and your left hand points up. Each entry below was
 * checked against that: case 8 (only TL inside) crosses the top and left edges,
 * and travelling L→T gives direction (+0.5, -0.5), whose left normal
 * (-0.5, -0.5) points up-left, at TL. Inside, as required.
 *
 * The direction is not cosmetic. It is what makes consecutive segments chain
 * end-to-start in the stitcher, and it is what fixes which way the lights
 * travel around the shape — a table with a consistent but MIRRORED convention
 * would stitch just as happily and run the lights backwards.
 */
const CASES: ReadonlyArray<ReadonlyArray<readonly [Side, Side]>> = [
  /*  0 ····                       */ [],
  /*  1 BL                         */ [['B', 'L']],
  /*  2 BR                         */ [['R', 'B']],
  /*  3 BL BR                      */ [['R', 'L']],
  /*  4 TR                         */ [['T', 'R']],
  /*  5 TR BL — saddle, see below  */ [],
  /*  6 TR BR                      */ [['T', 'B']],
  /*  7 TR BR BL                   */ [['T', 'L']],
  /*  8 TL                         */ [['L', 'T']],
  /*  9 TL BL                      */ [['B', 'T']],
  /* 10 TL BR — saddle, see below  */ [],
  /* 11 TL BL BR                   */ [['R', 'T']],
  /* 12 TL TR                      */ [['L', 'R']],
  /* 13 TL TR BL                   */ [['B', 'R']],
  /* 14 TL TR BR                   */ [['L', 'B']],
  /* 15 ▪▪▪▪                       */ [],
];

/**
 * The two ambiguous cases, resolved by the cell's CENTRE.
 *
 * In case 5 the two inside corners are diagonally opposite, and the cell is
 * consistent with either "two separate blobs touching at a point" or "one waist
 * passing through". Averaging the four corners is the standard tie-break and is
 * the one that agrees with what a finer sampling of the same image would show.
 *
 * Guessing instead — always picking one pairing — produces contours that are
 * locally valid and globally wrong: two shapes fuse, or one pinches into two,
 * and the light count changes with it.
 */
function saddle(bits: number, centreInside: boolean): ReadonlyArray<readonly [Side, Side]> {
  if (bits === 5) {
    // TR and BL inside. Connected through the centre → the OUTSIDE corners TL
    // and BR become the isolated ones.
    return centreInside ? [['T', 'L'], ['B', 'R']] : [['T', 'R'], ['B', 'L']];
  }
  // bits === 10: TL and BR inside.
  return centreInside ? [['R', 'T'], ['L', 'B']] : [['L', 'T'], ['R', 'B']];
}

/** Quantised key for endpoint matching. */
function key(p: ContourPoint): string {
  return `${Math.round(p.x * 1e6)}:${Math.round(p.y * 1e6)}`;
}

/**
 * Closed contours of the alpha channel at `threshold`, in canvas pixels.
 *
 * `alpha[y * w + x]`, 0..255. Contours are returned with a DETERMINISTIC
 * starting vertex — the lexicographically smallest point — rather than
 * wherever the raster scan happened to enter the loop. That matters because
 * `rotation` is measured from the contour's start: tying it to scan order would
 * make the lights jump to a different phase when the layer's raster is padded
 * (an effect added below it changes the padding) even though nothing about the
 * shape moved.
 */
export function extractAlphaContours(
  alpha: ArrayLike<number>,
  w: number,
  h: number,
  threshold: number,
): ContourPoint[][] {
  if (w <= 0 || h <= 0) return [];
  const s = (x: number, y: number): number => sampleAt(alpha, w, h, x, y);

  // Directed segments in a LIST, indexed by start point to a LIST of indices.
  //
  // ── Why the multiplicity is not optional ────────────────────────────
  //
  // This was a single `Map<startKey, segment>`, on the assumption that each
  // crossing point starts exactly one segment. It does not, and the case is
  // common rather than exotic: when a corner sample equals the threshold
  // EXACTLY, `crossing` returns 0 or 1 and the crossing point lands precisely on
  // a grid corner, where it coincides with the crossings of the perpendicular
  // edges. With 8-bit alpha and a default threshold of 128, a pixel of exactly
  // 128 is ordinary — a plain antialiased star produced 85 such collisions.
  //
  // Keyed by start alone, each collision silently DISCARDED one segment, the
  // walk then ran into an already-consumed point, and one closed contour came
  // apart into partial chains: the star traced as six contours instead of one,
  // four of them three-point specks. Every light was then placed on a fragment.
  //
  // Consuming per SEGMENT rather than per point fixes it, because two segments
  // legitimately leaving one point is exactly what a self-touching contour is.
  const segs: Array<{ a: ContourPoint; b: ContourPoint }> = [];
  const byStart = new Map<string, number[]>();

  for (let cy = -1; cy < h; cy++) {
    for (let cx = -1; cx < w; cx++) {
      const tl = s(cx, cy);
      const tr = s(cx + 1, cy);
      const br = s(cx + 1, cy + 1);
      const bl = s(cx, cy + 1);
      const bits =
        (tl >= threshold ? 8 : 0) | (tr >= threshold ? 4 : 0) |
        (br >= threshold ? 2 : 0) | (bl >= threshold ? 1 : 0);
      if (bits === 0 || bits === 15) continue;

      const pts: Record<Side, ContourPoint> = {
        T: { x: cx + crossing(tl, tr, threshold), y: cy },
        R: { x: cx + 1, y: cy + crossing(tr, br, threshold) },
        B: { x: cx + crossing(bl, br, threshold), y: cy + 1 },
        L: { x: cx, y: cy + crossing(tl, bl, threshold) },
      };

      const cellSegs =
        bits === 5 || bits === 10
          ? saddle(bits, (tl + tr + br + bl) / 4 >= threshold)
          : CASES[bits]!;

      for (const [a, b] of cellSegs) {
        const k = key(pts[a]);
        const list = byStart.get(k);
        if (list) list.push(segs.length);
        else byStart.set(k, [segs.length]);
        segs.push({ a: pts[a], b: pts[b] });
      }
    }
  }

  const contours: ContourPoint[][] = [];
  const consumed = new Array<boolean>(segs.length).fill(false);
  /** The first segment leaving `k` that no chain has taken yet. */
  const nextFrom = (k: string): number => {
    for (const i of byStart.get(k) ?? []) if (!consumed[i]) return i;
    return -1;
  };
  for (let start = 0; start < segs.length; start++) {
    if (consumed[start]) continue;
    const loop: ContourPoint[] = [];
    let i = start;
    while (i >= 0 && !consumed[i]) {
      consumed[i] = true;
      loop.push(segs[i]!.a);
      i = nextFrom(key(segs[i]!.b));
    }
    // A loop needs three distinct points to enclose anything; two is a
    // degenerate spur from a single stray pixel and has no arc to walk.
    if (loop.length >= 3) contours.push(rotateToCanonicalStart(loop));
  }
  return contours;
}

/** Rotate a closed loop so it begins at its lexicographically smallest point. */
function rotateToCanonicalStart(loop: ContourPoint[]): ContourPoint[] {
  let best = 0;
  for (let i = 1; i < loop.length; i++) {
    const p = loop[i]!;
    const q = loop[best]!;
    if (p.y < q.y || (p.y === q.y && p.x < q.x)) best = i;
  }
  return best === 0 ? loop : [...loop.slice(best), ...loop.slice(0, best)];
}

// ── Arc-length walk ──────────────────────────────────────────────────

export interface ArcTable {
  /** Cumulative length from vertex 0 to vertex i, length n. */
  cum: number[];
  /** Total length — for a closed contour INCLUDING the closing edge back to vertex 0. */
  total: number;
  /** False for an OPEN mask path: no closing edge, and arc positions do not wrap. */
  closed: boolean;
}

/**
 * Cumulative arc lengths along a contour — closed unless told otherwise.
 *
 * Alpha contours are always closed. A mask path need not be: an open one used to
 * be walked as a loop, so its perimeter gained the chord from its last vertex
 * back to its first, and lights ran along that chord where no path exists.
 */
export function arcTable(pts: ReadonlyArray<ContourPoint>, closed = true): ArcTable {
  const n = pts.length;
  const cum = new Array<number>(n).fill(0);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    cum[i] = acc;
  }
  // The closing edge is part of the perimeter — a loop's last vertex joins its
  // first. Omitting it would make every dash drift by that edge's length per
  // lap, which reads as the lights slowly sliding out of phase.
  const closing = closed && n > 1 ? Math.hypot(pts[0]!.x - pts[n - 1]!.x, pts[0]!.y - pts[n - 1]!.y) : 0;
  const total = n > 1 ? acc + closing : 0;
  return { cum, total, closed };
}

/** The point at arc position `s` — wrapping around a closed contour, clamped to an open one. */
export function pointAtArc(
  pts: ReadonlyArray<ContourPoint>,
  t: ArcTable,
  s: number,
): ContourPoint {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0 };
  if (t.total <= 0) return { x: pts[0]!.x, y: pts[0]!.y };
  // Open: a position AT the end must stay at the end, not wrap to vertex 0 —
  // it then falls to the last-vertex branch below with a zero-length segment.
  const u = t.closed ? ((s % t.total) + t.total) % t.total : clamp(s, 0, t.total);
  // Last vertex first: `cum` has no entry for the closing edge, so a position
  // beyond cum[n-1] belongs to it and the loop below would never find a match.
  let i = n - 1;
  for (let j = 0; j < n - 1; j++) {
    if (u < t.cum[j + 1]!) { i = j; break; }
  }
  const segLen = (i === n - 1 ? t.total : t.cum[i + 1]!) - t.cum[i]!;
  const f = segLen > 0 ? (u - t.cum[i]!) / segLen : 0;
  const a = pts[i]!;
  const b = pts[(i + 1) % n]!;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/**
 * The polyline covering `len` of arc starting at `from`, wrapping the seam.
 *
 * Emitted as ONE run rather than split at the seam: a light that straddles
 * vertex 0 is one light, and cutting it in two would put a stroke join and two
 * end caps in the middle of it — visible at any width above a hairline.
 */
export function walkArc(
  pts: ReadonlyArray<ContourPoint>,
  t: ArcTable,
  from: number,
  len: number,
): ContourPoint[] {
  const n = pts.length;
  if (n < 2 || t.total <= 0 || len <= 0) return [];
  if (!t.closed) {
    // An open path has no seam to cross: the run is clipped to [0, total], and
    // `vegasSegments` splits a light that runs off the end into two.
    const s0 = clamp(from, 0, t.total);
    const s1 = clamp(from + len, 0, t.total);
    if (s1 <= s0) return [];
    const run: ContourPoint[] = [pointAtArc(pts, t, s0)];
    for (let k = 0; k < n; k++) {
      if (t.cum[k]! > s0 && t.cum[k]! < s1) run.push({ x: pts[k]!.x, y: pts[k]!.y });
    }
    run.push(pointAtArc(pts, t, s1));
    return run;
  }
  const span = Math.min(len, t.total);
  const out: ContourPoint[] = [pointAtArc(pts, t, from)];
  const start = ((from % t.total) + t.total) % t.total;
  // Arc position of vertex k in UNWRAPPED space, so a walk that laps the seam
  // keeps increasing instead of resetting to zero.
  const arcOf = (k: number): number => t.cum[k % n]! + t.total * Math.floor(k / n);
  let k = 0;
  while (k < n && t.cum[k]! <= start) k++;
  const target = start + span;
  // BOUNDED by the vertex count, not merely by the arc test.
  //
  // `span` is clamped to one perimeter, so a run can pass at most every vertex
  // once and `k` can advance at most `n` times. Relying on `arcOf` increasing to
  // end the loop makes termination depend on an invariant held somewhere else —
  // and when that invariant was deliberately broken to check this function's
  // guard, the loop did not draw the wrong thing, it allocated until the process
  // died. A wrong picture is debuggable; a hang is a hang. The bound turns any
  // future breakage into a visibly wrong run instead.
  const last = k + n;
  while (k <= last && arcOf(k) < target) {
    out.push({ x: pts[k % n]!.x, y: pts[k % n]!.y });
    k++;
  }
  out.push(pointAtArc(pts, t, start + span));
  return out;
}

/**
 * The lit runs for one contour.
 *
 * `segments` lights are spaced evenly around the perimeter, each occupying
 * `length` percent of its own slot; `rotation` slides the whole set around the
 * contour, a full lap per 360 degrees. That mapping is the one worth stating:
 * it makes a linear keyframe on `rotation` a constant-speed chase whatever the
 * shape is, which is the thing this effect exists to do.
 *
 * On an OPEN path (`closed` false) the pattern still cycles with `rotation`, but
 * a light reaching the end leaves there and re-enters at the start as a second
 * run — it never draws the chord between the two ends.
 */
export function vegasSegments(
  contour: ReadonlyArray<ContourPoint>,
  segments: number,
  lengthPct: number,
  rotationDeg: number,
  closed = true,
): ContourPoint[][] {
  return vegasRuns(contour, segments, lengthPct, rotationDeg, closed).map((r) => r.points);
}

/**
 * One lit run, and which part of its LIGHT it is: `u0..u1` along the light,
 * 0 at its head end and 1 at its tail. A whole light is 0..1; a light split at
 * an open path's end is two runs that share the boundary between them. The
 * Start / Mid-point / End Opacity profile is a function of this `u`.
 */
export interface VegasRun {
  points: ContourPoint[];
  u0: number;
  u1: number;
}

/**
 * Gap between neighbouring lights under Segment Distribution ▸ Bunched, as a
 * fraction of one light's length. AE's Bunched packs the lights into a group
 * that travels together; Even spreads them one per slot. Capped by the slot, so
 * at Length 100 % the two distributions meet in an unbroken ring.
 */
export const VEGAS_BUNCH_GAP = 0.5;

/**
 * The lit runs for one contour — `vegasSegments` with the AE additions:
 * Bunched distribution and an extra phase in ARC px (Random Phase). With
 * neither, the runs are exactly the ones `vegasSegments` always produced.
 */
export function vegasRuns(
  contour: ReadonlyArray<ContourPoint>,
  segments: number,
  lengthPct: number,
  rotationDeg: number,
  closed = true,
  bunched = false,
  phaseArc = 0,
): VegasRun[] {
  const n = Math.max(1, Math.round(segments));
  const t = arcTable(contour, closed);
  if (t.total <= 0) return [];
  const slot = t.total / n;
  const lit = clamp(lengthPct / 100, 0, 1) * slot;
  if (lit <= 0) return [];
  const pitch = bunched ? lit + Math.min(slot - lit, lit * VEGAS_BUNCH_GAP) : slot;
  const phase = (rotationDeg / 360) * t.total + phaseArc;
  const out: VegasRun[] = [];
  const push = (run: ContourPoint[], u0: number, u1: number): void => { if (run.length >= 2) out.push({ points: run, u0, u1 }); };
  for (let k = 0; k < n; k++) {
    if (closed) {
      push(walkArc(contour, t, phase + k * pitch, lit), 0, 1);
      continue;
    }
    const s = (((phase + k * pitch) % t.total) + t.total) % t.total;
    // A small tolerance so a light ending exactly at the end is one run, not a
    // run plus a zero-length sliver at the start.
    if (s + lit <= t.total + 1e-9) {
      push(walkArc(contour, t, s, lit), 0, 1);
    } else {
      const split = (t.total - s) / lit;
      push(walkArc(contour, t, s, t.total - s), 0, split);
      push(walkArc(contour, t, 0, s + lit - t.total), split, 1);
    }
  }
  return out;
}

/**
 * Stroke Sequentially: ONE set of lights running through several paths in
 * order, as if they were one path — a light leaving the end of one mask
 * continues at the start of the next, and never draws the gap between them.
 * The sequence is cyclic, so `rotation` still laps it.
 */
export function vegasSequentialRuns(
  paths: ReadonlyArray<{ points: ReadonlyArray<ContourPoint>; closed: boolean }>,
  segments: number,
  lengthPct: number,
  rotationDeg: number,
  bunched = false,
  phaseArc = 0,
): VegasRun[] {
  // Each path as an OPEN polyline — a closed one with its first point repeated
  // — so a light is clipped to [0, length] on it rather than wrapping inside it.
  const opens = paths.map((p) => {
    const pts = p.closed && p.points.length > 1 ? [...p.points, p.points[0]!] : [...p.points];
    return { pts, table: arcTable(pts, false) };
  });
  const total = opens.reduce((s, o) => s + o.table.total, 0);
  if (total <= 0) return [];
  const n = Math.max(1, Math.round(segments));
  const slot = total / n;
  const lit = clamp(lengthPct / 100, 0, 1) * slot;
  if (lit <= 0) return [];
  const pitch = bunched ? lit + Math.min(slot - lit, lit * VEGAS_BUNCH_GAP) : slot;
  const phase = (rotationDeg / 360) * total + phaseArc;
  const out: VegasRun[] = [];
  const emit = (a: number, b: number, uBase: number): void => {
    let base = 0;
    for (const o of opens) {
      const len = o.table.total;
      const lo = Math.max(a, base);
      const hi = Math.min(b, base + len);
      if (hi > lo) {
        const run = walkArc(o.pts, o.table, lo - base, hi - lo);
        if (run.length >= 2) out.push({ points: run, u0: uBase + (lo - a) / lit, u1: uBase + (hi - a) / lit });
      }
      base += len;
    }
  };
  for (let k = 0; k < n; k++) {
    const s = (((phase + k * pitch) % total) + total) % total;
    if (s + lit <= total + 1e-9) emit(s, s + lit, 0);
    else {
      emit(s, total, 0);
      emit(0, s + lit - total, (total - s) / lit);
    }
  }
  return out;
}

/** 0..1 hash of two integers — Random Phase's per-contour offset. */
function hash01(a: number, b: number): number {
  let x = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/**
 * Opacity along a light, 0..1: Start → Mid-point at `midPosition` → End, each
 * leg linear. AE's three-point profile; all three at 100 is a flat light.
 */
export function vegasOpacityAt(u: number, start: number, mid: number, end: number, midPosition: number): number {
  const m = clamp(midPosition / 100, 0.001, 0.999);
  const uu = clamp(u, 0, 1);
  const v = uu <= m ? start + ((mid - start) * uu) / m : mid + ((end - mid) * (uu - m)) / (1 - m);
  return clamp(v / 100, 0, 1);
}

// ── The effect ───────────────────────────────────────────────────────

const str = (e: Effect, k: string, fb: string): string => {
  const v = paramsOf(e)[k];
  return typeof v === 'string' ? v : fb;
};

/** The layer's alpha plane, one byte per pixel. */
function alphaPlane(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4 + 3]!;
  return out;
}

/**
 * Draw the lights.
 *
 * NOT `source-atop`, unlike every other generator in this family. A light
 * STRADDLES the contour — half its width falls outside the layer's alpha — so
 * clipping to that alpha would shave every light in half lengthwise and the
 * effect would read as an inner glow. `bakedEffectSpread` pads the raster by
 * the width for the same reason.
 */
export function drawVegas(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const opacity = effectNumber(e, 'opacity') / 100;
  if (opacity <= 0 || w <= 0 || h <= 0) return;
  const lengthPct = effectNumber(e, 'length');
  if (lengthPct <= 0) return;
  const width = Math.max(0.1, effectNumber(e, 'width'));
  const segments = Math.max(1, Math.round(effectNumber(e, 'segments')));
  const rotation = effectNumber(e, 'rotation');
  const hardness = clamp(effectNumber(e, 'hardness'), 0, 100);
  // Clamped away from both ends: at 0 every pixel is "inside" and there is no
  // contour, at 255 only fully-opaque pixels are and an antialiased shape
  // contours along its own interior.
  const threshold = clamp(effectNumber(e, 'threshold'), 1, 254);
  const color = str(e, 'color', '#ffffff');
  const p = paramsOf(e);
  const bunched = Math.round(effectNumber(e, 'segmentDistribution')) === 0;
  const randomPhase = p.randomPhase === true;
  const seed = Math.floor(effectNumber(e, 'randomSeed'));
  const blend = Math.round(effectNumber(e, 'blendMode'));
  const startOp = effectNumber(e, 'startOpacity');
  const midOp = effectNumber(e, 'midOpacity');
  const endOp = effectNumber(e, 'endOpacity');
  const midPos = effectNumber(e, 'midPosition');
  const flatProfile = startOp === 100 && midOp === 100 && endOp === 100;

  // A resolved mask-path polyline replaces the alpha contour outright — the
  // AE "Stroke: Mask/Path" reading. It arrives in layer-local centred px
  // (buildSnapshot fills it from `pathMaskId` at this frame's time, so a
  // TRACKED mask moves the lights with the object); shift to raster space and
  // the arc-length machinery below neither knows nor cares where it came from.
  const flat = p.pathPoints;
  const contours: ContourPoint[][] = [];
  // Alpha contours are always closed; a mask path says (`pathClosed`, resolved
  // beside `pathPoints`). Absent reads closed, which is what every mask path was
  // assumed to be before the flag existed.
  let pathClosed = true;
  // All Masks: every mask, each with its OWN closed flag.
  const maskPaths = p.allMasks === true
    ? unpackMaskPaths(p.maskPathsMeta, p.maskPathsXY, w, h).filter((m) => m.points.length >= 2)
    : null;
  if (maskPaths) {
    // Nothing to read from the pixels: the masks are the geometry.
  } else if (Array.isArray(flat) && flat.length >= 6) {
    const loop: ContourPoint[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const x = flat[i];
      const y = flat[i + 1];
      if (typeof x === 'number' && typeof y === 'number') loop.push({ x: w / 2 + x, y: h / 2 + y });
    }
    if (loop.length >= 3) contours.push(loop);
    pathClosed = p.pathClosed !== false;
  } else {
    const img = oc.getImageData(0, 0, w, h);
    contours.push(...extractAlphaContours(alphaPlane(img.data, w, h), w, h, threshold));
  }

  const runs: VegasRun[] = [];
  if (maskPaths) {
    if (p.strokeSequentially === true) {
      const total = maskPaths.reduce((s, m) => s + arcTable(m.points, m.closed).total, 0);
      runs.push(...vegasSequentialRuns(maskPaths, segments, lengthPct, rotation, bunched, randomPhase ? hash01(seed, 0) * total : 0));
    } else {
      maskPaths.forEach((m, i) => {
        const phaseArc = randomPhase ? hash01(seed, i) * arcTable(m.points, m.closed).total : 0;
        runs.push(...vegasRuns(m.points, segments, lengthPct, rotation, m.closed, bunched, phaseArc));
      });
    }
  } else {
    contours.forEach((contour, i) => {
      const phaseArc = randomPhase ? hash01(seed, i) * arcTable(contour, pathClosed).total : 0;
      runs.push(...vegasRuns(contour, segments, lengthPct, rotation, pathClosed, bunched, phaseArc));
    });
  }

  // Blend Mode. Over draws straight onto the layer, exactly as Vegas always
  // did. Transparent keeps only the lights. Under and Stencil need the lights
  // as their own image first — behind the layer, or as the layer's matte.
  const needsScratch = blend === 2 || blend === 3;
  const scratchCanvas = needsScratch ? vegasScratch(w, h) : null;
  const scratchCtx = scratchCanvas?.getContext('2d') ?? null;
  // No 2D context (no DOM, or a canvas-less test environment): draw Over.
  const scratch = scratchCtx ? scratchCanvas : null;
  const dc = scratchCtx ?? oc;
  if (blend === 0) {
    oc.save();
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.clearRect(0, 0, w, h);
    oc.restore();
  }
  if (runs.length === 0) {
    // Stencil with no lights leaves nothing of the layer; the rest draw nothing.
    if (blend === 3 && scratch) {
      oc.save();
      oc.setTransform(1, 0, 0, 1, 0, 0);
      oc.clearRect(0, 0, w, h);
      oc.restore();
    }
    return;
  }
  if (dc !== oc) {
    dc.setTransform(1, 0, 0, 1, 0, 0);
    dc.clearRect(0, 0, w, h);
  }

  dc.save();
  dc.globalAlpha = Math.min(1, opacity);
  dc.strokeStyle = color;
  dc.lineWidth = width;
  dc.lineCap = 'round';
  dc.lineJoin = 'round';
  // Hardness feathers the light's edge. 100 is a hard stroke; below that the
  // blur is proportional to the stroke's own width, so softening does not
  // change how thick the lights read.
  if (hardness < 100) dc.filter = `blur(${((100 - hardness) / 100) * width * 0.5}px)`;
  const strokeRun = (pts: ReadonlyArray<ContourPoint>): void => {
    dc.beginPath();
    dc.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) dc.lineTo(pts[i]!.x, pts[i]!.y);
    dc.stroke();
  };
  for (const run of runs) {
    if (flatProfile) {
      strokeRun(run.points);
      continue;
    }
    // A varying opacity cannot be one stroke: cut the run into short pieces,
    // each at the profile's opacity at its middle. Butt-capped inside the light
    // so neighbours do not double up; round only where the light really ends.
    const table = arcTable(run.points, false);
    const pieces = Math.max(2, Math.min(96, Math.ceil(table.total / Math.max(1, width * 0.5))));
    for (let j = 0; j < pieces; j++) {
      const a = (table.total * j) / pieces;
      const piece = walkArc(run.points, table, a, table.total / pieces);
      if (piece.length < 2) continue;
      const u = run.u0 + (run.u1 - run.u0) * ((j + 0.5) / pieces);
      dc.globalAlpha = Math.min(1, opacity) * vegasOpacityAt(u, startOp, midOp, endOp, midPos);
      dc.lineCap = (j === 0 && run.u0 <= 0) || (j === pieces - 1 && run.u1 >= 1) ? 'round' : 'butt';
      strokeRun(piece);
    }
  }
  dc.restore();

  if (scratch) {
    oc.save();
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.globalAlpha = 1;
    oc.globalCompositeOperation = blend === 2 ? 'destination-over' : 'destination-in';
    oc.drawImage(scratch, 0, 0);
    oc.restore();
  }
}

let vegasCanvas: HTMLCanvasElement | null = null;
/** A same-size scratch canvas for the Under / Stencil blends; null without a DOM. */
function vegasScratch(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  vegasCanvas ??= document.createElement('canvas');
  if (vegasCanvas.width !== w) vegasCanvas.width = w;
  if (vegasCanvas.height !== h) vegasCanvas.height = h;
  return vegasCanvas;
}
