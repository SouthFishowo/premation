/**
 * Scribble — AE's Generate ▸ Scribble: a mask filled (or edged) with a single
 * continuous zig-zag pen line.
 *
 * ── The model ────────────────────────────────────────────────────────
 *
 * 1. A REGION is rasterised from the masks: the inside of one mask, of each
 *    mask, or of all of them combined by their modes (All Masks Using Modes);
 *    for the edge Fill Types, a band around the outline instead — centred,
 *    inside, outside, or on the left/right of the path's direction, with End
 *    Cap / Join / Miter Limit shaping the band exactly as they shape a stroke.
 * 2. Parallel scan lines at `angle`, `spacing` apart (± Spacing Variation),
 *    are cut by the region into spans. Spans on neighbouring lines that overlap
 *    are linked into STRANDS, and each strand is one boustrophedon pen line:
 *    across, turn, back — the turn rounded by Curviness, each end pushed past
 *    or short of the region's edge by Path Overlap.
 * 3. The strands are revealed by Start/End in percent of their arc length
 *    (across every mask as one, when Fill Paths Sequentially is on) and drawn
 *    as an antialiased round-capped line of Stroke Width.
 *
 * ── Why the randomness is a function of (seed, element, state) ──────
 *
 * Every variation — each line's spacing, each turn's curviness, each end's
 * overlap — is a hash of the Random Seed, the element's index and the WIGGLE
 * STATE. `buildSnapshot` resolves the state from the layer's time: always 0 for
 * Static, `floor(t · wiggles/s)` for Jumpy, and `t · wiggles/s` for Smooth,
 * where the kernel eases between the two neighbouring integer states. So export
 * and preview draw the same scribble on the same frame, scrubbing back returns
 * it exactly, and a Static or Jumpy scribble holds its raster-cache entry for as
 * long as its state does rather than re-baking every frame.
 */

import type { Effect, EffectParams } from './effects';
import { effectNumber, paramsOf } from './effects';
import {
  PaintBuffer, compositePaint, pickMaskPaths, unpackMaskPaths, polylineLength, PAINT_STYLE,
  type PaintPoint, type ResolvedMaskPath,
} from './strokePaint';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const SCRIBBLE_MODE = { singleMask: 0, allMasks: 1, allMasksUsingModes: 2 } as const;
export const SCRIBBLE_FILL = {
  inside: 0, centeredEdge: 1, insideEdge: 2, outsideEdge: 3, leftEdge: 4, rightEdge: 5,
} as const;
/** AE's End Cap menu order. */
export const LINE_CAP = { butt: 0, round: 1, projecting: 2 } as const;
/** AE's Join menu order. */
export const LINE_JOIN = { miter: 0, round: 1, bevel: 2 } as const;
export const WIGGLE_TYPE = { static: 0, jumpy: 1, smooth: 2 } as const;

// ── Deterministic randomness ─────────────────────────────────────────

/** 0..1 hash of three integers. */
export function hash3(a: number, b: number, c: number): number {
  let n = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

/**
 * A −1..1 random for element `key`, at wiggle `state`.
 *
 * `smooth` eases between the integer states on either side of a fractional one,
 * which is AE's Smooth wiggle: the same random values Jumpy snaps between, met
 * with a smoothstep instead of a cut.
 */
export function wiggleRandom(key: number, seed: number, state: number, smooth: boolean): number {
  const s0 = Math.floor(state);
  const v0 = hash3(key, seed, s0) * 2 - 1;
  const f = state - s0;
  if (!smooth || f <= 0) return v0;
  const v1 = hash3(key, seed, s0 + 1) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return v0 + (v1 - v0) * u;
}

/**
 * The wiggle state for a layer time — resolved by `buildSnapshot` into the
 * `wiggleState` param. See the module note for why the clock is quantised HERE.
 */
export function scribbleWiggleState(params: EffectParams, layerTimeSec: number | undefined): number {
  const type = typeof params.wiggleType === 'number' ? Math.round(params.wiggleType) : WIGGLE_TYPE.smooth;
  const wps = typeof params.wigglesPerSecond === 'number' ? params.wigglesPerSecond : 0;
  if (layerTimeSec === undefined || !(wps > 0) || type === WIGGLE_TYPE.static) return 0;
  const state = layerTimeSec * wps;
  return type === WIGGLE_TYPE.jumpy ? Math.floor(state + 1e-9) : state;
}

// ── Region rasterisation ─────────────────────────────────────────────

/**
 * Nonzero-winding scanline fill of a polygon at pixel centres — the rule
 * Canvas2D's `fill()` uses, so a self-overlapping mask fills as it clips.
 * Writes `value` (1 to set, 0 to clear).
 */
export function fillPolygon(
  mask: Uint8Array, w: number, h: number, pts: ReadonlyArray<PaintPoint>, value = 1,
): void {
  const n = pts.length;
  if (n < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.ceil(minY - 0.5));
  const y1 = Math.min(h - 1, Math.floor(maxY - 0.5));
  const xs: number[] = [];
  const dirs: number[] = [];
  const order: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    dirs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
        xs.push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
        dirs.push(b.y > a.y ? 1 : -1);
      }
    }
    if (xs.length < 2) continue;
    order.length = 0;
    for (let i = 0; i < xs.length; i++) order.push(i);
    order.sort((p, q) => xs[p]! - xs[q]!);
    let winding = 0;
    let start = 0;
    for (const k of order) {
      const prev = winding;
      winding += dirs[k]!;
      if (prev === 0 && winding !== 0) start = xs[k]!;
      else if (prev !== 0 && winding === 0) {
        const xa = Math.max(0, Math.ceil(start - 0.5));
        const xb = Math.min(w - 1, Math.ceil(xs[k]! - 0.5) - 1);
        for (let x = xa; x <= xb; x++) mask[y * w + x] = value;
      }
    }
  }
}

/** A filled disc at pixel centres. */
export function fillDisc(mask: Uint8Array, w: number, h: number, cx: number, cy: number, r: number): void {
  if (r <= 0) return;
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const span = r * r - dy * dy;
    if (span < 0) continue;
    const half = Math.sqrt(span);
    const xa = Math.max(0, Math.ceil(cx - half - 0.5));
    const xb = Math.min(w - 1, Math.floor(cx + half - 0.5));
    for (let x = xa; x <= xb; x++) mask[y * w + x] = 1;
  }
}

/** Polygon fan from direction angle `a1` to `a2` (the short way) around `c`. */
function fan(c: PaintPoint, r: number, a1: number, a2: number): PaintPoint[] {
  let delta = a2 - a1;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  const steps = Math.max(2, Math.min(48, Math.ceil((Math.abs(delta) * r) / 2)));
  const out: PaintPoint[] = [c];
  for (let k = 0; k <= steps; k++) {
    const a = a1 + (delta * k) / steps;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return out;
}

/** Consecutive duplicates removed — a zero-length segment has no direction. */
function dedupe(pts: ReadonlyArray<PaintPoint>, closed: boolean): PaintPoint[] {
  const out: PaintPoint[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) out.push(p);
  }
  if (closed && out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-6) out.pop();
  }
  return out;
}

/**
 * Rasterise the band a stroke of this path would cover: `hl` px to its LEFT
 * and `hr` px to its right (left of a direction (dx, dy) in screen space is
 * (dy, −dx), the convention `vegas.ts` documents). Centred Edge is hl = hr;
 * Left/Right Edge put the whole width on one side.
 *
 * Built from convex pieces — a quad per segment, a join piece on the OUTER
 * side of each turn, a cap at each open end — OR-ed into the mask, so End Cap,
 * Join and Miter Limit mean what they mean on any stroke: a miter longer than
 * `miterLimit` × half-width falls back to a bevel (Canvas2D's rule).
 */
export function strokeBand(
  mask: Uint8Array, w: number, h: number,
  raw: ReadonlyArray<PaintPoint>, closed: boolean,
  hl: number, hr: number, cap: number, join: number, miterLimit: number,
): void {
  if (hl <= 0 && hr <= 0) return;
  const pts = dedupe(raw, closed);
  const n = pts.length;
  if (n === 1) {
    if (cap === LINE_CAP.round) fillDisc(mask, w, h, pts[0]!.x, pts[0]!.y, Math.max(hl, hr));
    return;
  }
  if (n < 2) return;
  const segCount = closed ? n : n - 1;
  const segs: Array<{ a: PaintPoint; b: PaintPoint; tx: number; ty: number; nx: number; ny: number }> = [];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const tx = (b.x - a.x) / len;
    const ty = (b.y - a.y) / len;
    segs.push({ a, b, tx, ty, nx: ty, ny: -tx });
  }
  for (const s of segs) {
    fillPolygon(mask, w, h, [
      { x: s.a.x + s.nx * hl, y: s.a.y + s.ny * hl },
      { x: s.b.x + s.nx * hl, y: s.b.y + s.ny * hl },
      { x: s.b.x - s.nx * hr, y: s.b.y - s.ny * hr },
      { x: s.a.x - s.nx * hr, y: s.a.y - s.ny * hr },
    ]);
  }
  // Joins: between segment i−1 and i at vertex i.
  const limit = Math.max(1, miterLimit);
  const first = closed ? 0 : 1;
  const lastVertex = closed ? n - 1 : n - 2;
  for (let i = first; i <= lastVertex; i++) {
    const s1 = segs[(i - 1 + segCount) % segCount]!;
    const s2 = segs[i % segCount]!;
    const v = pts[i]!;
    for (const [side, hw] of [[1, hl], [-1, hr]] as const) {
      if (hw <= 0) continue;
      const n1x = s1.nx * side; const n1y = s1.ny * side;
      const n2x = s2.nx * side; const n2y = s2.ny * side;
      // Outer side of the turn only: the inner side is already inside the quads.
      if (n1x * s2.tx + n1y * s2.ty >= -1e-9) continue;
      const p1 = { x: v.x + n1x * hw, y: v.y + n1y * hw };
      const p2 = { x: v.x + n2x * hw, y: v.y + n2y * hw };
      if (join === LINE_JOIN.round) {
        fillPolygon(mask, w, h, fan(v, hw, Math.atan2(n1y, n1x), Math.atan2(n2y, n2x)));
        continue;
      }
      if (join === LINE_JOIN.miter) {
        const mx = n1x + n2x;
        const my = n1y + n2y;
        const ml = Math.hypot(mx, my);
        const cosHalf = ml > 1e-9 ? (mx / ml) * n1x + (my / ml) * n1y : 0;
        if (cosHalf > 1e-6 && 1 / cosHalf <= limit) {
          const reach = hw / cosHalf;
          fillPolygon(mask, w, h, [v, p1, { x: v.x + (mx / ml) * reach, y: v.y + (my / ml) * reach }, p2]);
          continue;
        }
      }
      fillPolygon(mask, w, h, [v, p1, p2]);
    }
  }
  if (closed || cap === LINE_CAP.butt) return;
  // Caps: `u` is the outward tangent at each end.
  const ends = [
    { p: pts[0]!, s: segs[0]!, ux: -segs[0]!.tx, uy: -segs[0]!.ty },
    { p: pts[n - 1]!, s: segs[segCount - 1]!, ux: segs[segCount - 1]!.tx, uy: segs[segCount - 1]!.ty },
  ];
  for (const { p, s, ux, uy } of ends) {
    if (cap === LINE_CAP.projecting) {
      const ext = (hl + hr) / 2;
      fillPolygon(mask, w, h, [
        { x: p.x + s.nx * hl, y: p.y + s.ny * hl },
        { x: p.x + s.nx * hl + ux * ext, y: p.y + s.ny * hl + uy * ext },
        { x: p.x - s.nx * hr + ux * ext, y: p.y - s.ny * hr + uy * ext },
        { x: p.x - s.nx * hr, y: p.y - s.ny * hr },
      ]);
    } else {
      const ua = Math.atan2(uy, ux);
      if (hl > 0) fillPolygon(mask, w, h, fan(p, hl, Math.atan2(s.ny, s.nx), ua));
      if (hr > 0) fillPolygon(mask, w, h, fan(p, hr, Math.atan2(-s.ny, -s.nx), ua));
    }
  }
}

/** A mask's fill, honouring Inverted. Open masks fill as if closed, like a clip. */
function maskFill(m: ResolvedMaskPath, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  fillPolygon(out, w, h, m.points);
  if (m.inverted) for (let i = 0; i < out.length; i++) out[i] = out[i] ? 0 : 1;
  return out;
}

/**
 * The masks combined by their modes — the region All Masks Using Modes fills.
 *
 * Mirrors AE's mask stack: `none` contributes nothing, Add/Lighten union,
 * Subtract removes, Intersect/Darken intersect, Difference toggles. A stack
 * whose first active mask is Subtract or Intersect starts from the FULL layer,
 * as AE's does — otherwise a lone Subtract mask would have nothing to cut from.
 */
export function combineMasksByMode(masks: ReadonlyArray<ResolvedMaskPath>, w: number, h: number): Uint8Array {
  const acc = new Uint8Array(w * h);
  const active = masks.filter((m) => m.mode !== 'none' && m.points.length >= 3);
  const firstMode = active[0]?.mode;
  if (firstMode === 'subtract' || firstMode === 'intersect' || firstMode === 'darken') acc.fill(1);
  for (const m of active) {
    const cov = maskFill(m, w, h);
    for (let i = 0; i < acc.length; i++) {
      const c = cov[i]!;
      switch (m.mode) {
        case 'subtract': if (c) acc[i] = 0; break;
        case 'intersect':
        case 'darken': if (!c) acc[i] = 0; break;
        case 'difference': if (c) acc[i] = acc[i] ? 0 : 1; break;
        default: if (c) acc[i] = 1;
      }
    }
  }
  return acc;
}

export interface ScribbleEdgeOptions {
  fillType: number;
  edgeWidth: number;
  endCap: number;
  join: number;
  miterLimit: number;
}

/**
 * One scribble REGION from a group of masks: `inside` is what the masks cover
 * (one mask's fill, or the mode-combined stack), `outlines` the paths whose
 * edges the edge fill types band.
 */
export function scribbleRegion(
  outlines: ReadonlyArray<ResolvedMaskPath>,
  inside: Uint8Array,
  w: number,
  h: number,
  o: ScribbleEdgeOptions,
): Uint8Array {
  const ft = Math.round(o.fillType);
  if (ft === SCRIBBLE_FILL.inside) return inside;
  const ew = Math.max(0, o.edgeWidth);
  const band = new Uint8Array(w * h);
  for (const m of outlines) {
    if (m.points.length < 2) continue;
    const [hl, hr] =
      ft === SCRIBBLE_FILL.leftEdge ? [ew, 0]
        : ft === SCRIBBLE_FILL.rightEdge ? [0, ew]
          : ft === SCRIBBLE_FILL.centeredEdge ? [ew / 2, ew / 2]
            : [ew, ew]; // inside / outside edge: a band of the full width either way, then cut
    strokeBand(band, w, h, m.points, m.closed, hl, hr, o.endCap, o.join, o.miterLimit);
  }
  if (ft === SCRIBBLE_FILL.insideEdge || ft === SCRIBBLE_FILL.outsideEdge) {
    const want = ft === SCRIBBLE_FILL.insideEdge ? 1 : 0;
    for (let i = 0; i < band.length; i++) if (band[i] && (inside[i] ? 1 : 0) !== want) band[i] = 0;
  }
  return band;
}

// ── The pen line ─────────────────────────────────────────────────────

export interface ScribbleLineOptions {
  /** Degrees; 0 = horizontal lines, counter-clockwise on screen. */
  angle: number;
  /** px between scan lines. */
  spacing: number;
  spacingVariation: number;
  /** 0..100. */
  curviness: number;
  curvinessVariation: number;
  /** −100..100 percent of the spacing past (+) or short of (−) the region edge. */
  pathOverlap: number;
  pathOverlapVariation: number;
  seed: number;
  wiggleState: number;
  smoothWiggle: boolean;
}

/** Upper bound on scan lines per region — a 0.1 px spacing on 4K would be 40 000. */
const MAX_SCAN_LINES = 8000;

/**
 * The strands of one region, each a continuous polyline in raster px, in scan
 * order. See the module note for the construction.
 */
export function scribbleStrands(
  region: Uint8Array, w: number, h: number, o: ScribbleLineOptions,
): PaintPoint[][] {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!region[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX > maxX) return [];
  const rad = (o.angle * Math.PI) / 180;
  // `0 -` rather than unary minus: at 0° the sine is 0 and a negated zero is
  // −0, which then leaks into every coordinate as a signed zero.
  const dx = Math.cos(rad);
  const dy = 0 - Math.sin(rad);
  // Perpendicular to the lines.
  const px = 0 - dy;
  const py = dx;
  const corners: PaintPoint[] = [
    { x: minX, y: minY }, { x: maxX + 1, y: minY }, { x: minX, y: maxY + 1 }, { x: maxX + 1, y: maxY + 1 },
  ];
  let cmin = Infinity; let cmax = -Infinity; let smin = Infinity; let smax = -Infinity;
  for (const c of corners) {
    const cp = c.x * px + c.y * py;
    const sp = c.x * dx + c.y * dy;
    if (cp < cmin) cmin = cp;
    if (cp > cmax) cmax = cp;
    if (sp < smin) smin = sp;
    if (sp > smax) smax = sp;
  }
  const spacing = Math.max(0.5, o.spacing, (cmax - cmin) / MAX_SCAN_LINES);
  const rnd = (key: number): number => wiggleRandom(key, Math.floor(o.seed), o.wiggleState, o.smoothWiggle);
  const inside = (x: number, y: number): boolean => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    return ix >= 0 && iy >= 0 && ix < w && iy < h && region[iy * w + ix] === 1;
  };

  interface Pass { c: number; sa: number; sb: number; key: number }
  const strands: Pass[][] = [];
  let active: Array<{ strand: number; sa: number; sb: number }> = [];
  const lines = Math.ceil((cmax - cmin) / spacing);
  const jitterCap = Math.min(Math.max(0, o.spacingVariation), spacing * 0.45);
  for (let k = 0; k < lines; k++) {
    const c = cmin + spacing * (k + 0.5) + rnd(k * 7919 + 5) * jitterCap;
    const spans: Array<[number, number]> = [];
    let open = NaN;
    for (let s = smin; s <= smax + 1; s += 1) {
      const hit = inside(px * c + dx * s, py * c + dy * s);
      if (hit && Number.isNaN(open)) open = s;
      else if (!hit && !Number.isNaN(open)) { spans.push([open, s]); open = NaN; }
    }
    if (!Number.isNaN(open)) spans.push([open, smax + 1]);
    const next: typeof active = [];
    const used = new Set<number>();
    spans.forEach(([sa, sb], j) => {
      const key = k * 7919 + j * 31;
      const link = active.find((a) => !used.has(a.strand) && sa < a.sb && sb > a.sa);
      if (link) {
        used.add(link.strand);
        strands[link.strand]!.push({ c, sa, sb, key });
        next.push({ strand: link.strand, sa, sb });
      } else {
        strands.push([{ c, sa, sb, key }]);
        next.push({ strand: strands.length - 1, sa, sb });
      }
    });
    active = next;
  }

  const at = (c: number, s: number): PaintPoint => ({ x: px * c + dx * s, y: py * c + dy * s });
  const out: PaintPoint[][] = [];
  for (const passes of strands) {
    const line: PaintPoint[] = [];
    let prevEnd: { p: PaintPoint; ux: number; uy: number } | null = null;
    passes.forEach((ps, j) => {
      const forward = j % 2 === 0;
      const over = (ch: number): number => ((o.pathOverlap + rnd(ps.key + ch) * Math.max(0, o.pathOverlapVariation)) / 100) * spacing;
      let s0 = forward ? ps.sa - over(2) : ps.sb + over(2);
      let s1 = forward ? ps.sb + over(3) : ps.sa - over(3);
      // A negative overlap can cross a short span over itself; meet in the middle.
      if (forward ? s1 < s0 : s1 > s0) { const mid = (ps.sa + ps.sb) / 2; s0 = mid; s1 = mid; }
      const start = at(ps.c, s0);
      const end = at(ps.c, s1);
      if (prevEnd) {
        const curv = clamp01((o.curviness + rnd(ps.key + 1) * Math.max(0, o.curvinessVariation)) / 100);
        if (curv > 0) {
          const reach = curv * Math.max(spacing, Math.hypot(start.x - prevEnd.p.x, start.y - prevEnd.p.y)) * 1.2;
          const c1 = { x: prevEnd.p.x + prevEnd.ux * reach, y: prevEnd.p.y + prevEnd.uy * reach };
          const c2 = { x: start.x + prevEnd.ux * reach, y: start.y + prevEnd.uy * reach };
          for (let q = 1; q < 8; q++) {
            const t = q / 8;
            const u = 1 - t;
            line.push({
              x: u * u * u * prevEnd.p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * start.x,
              y: u * u * u * prevEnd.p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * start.y,
            });
          }
        }
      }
      line.push(start, end);
      const sign = forward ? 1 : -1;
      prevEnd = { p: end, ux: dx * sign, uy: dy * sign };
    });
    if (line.length >= 2) out.push(line);
  }
  return out;
}

/**
 * Stroke a polyline into the paint buffer as an antialiased round-capped line,
 * one capsule per segment. Each row only visits the x-range the capsule can
 * reach, so a long diagonal pass costs its length, not its bounding box.
 */
export function strokePolyline(
  buf: PaintBuffer, pts: ReadonlyArray<PaintPoint>, width: number, rgb: readonly [number, number, number],
): void {
  const half = Math.max(0.05, width / 2);
  const R = half + 0.5;
  const { w, h } = buf;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i]!.x; const ay = pts[i]!.y;
    const bx = pts[i + 1]!.x; const by = pts[i + 1]!.y;
    const sx = bx - ax; const sy = by - ay;
    const len2 = sx * sx + sy * sy;
    const len = Math.sqrt(len2);
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + R));
    const xlo = Math.min(ax, bx) - R;
    const xhi = Math.max(ax, bx) + R;
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      let xa = xlo;
      let xb = xhi;
      if (Math.abs(sy) > 1e-6) {
        const xAt = ax + ((yc - ay) * sx) / sy;
        const reach = (R * len) / Math.abs(sy);
        xa = Math.max(xa, xAt - reach);
        xb = Math.min(xb, xAt + reach);
      }
      const xs = Math.max(0, Math.floor(xa));
      const xe = Math.min(w - 1, Math.ceil(xb));
      for (let x = xs; x <= xe; x++) {
        const pxc = x + 0.5;
        const t = len2 > 0 ? clamp01(((pxc - ax) * sx + (yc - ay) * sy) / len2) : 0;
        const d = Math.hypot(pxc - (ax + t * sx), yc - (ay + t * sy));
        const cov = clamp01(half + 0.5 - d);
        if (cov > 0) buf.paint(y * w + x, cov, 1, rgb);
      }
    }
  }
}

/** The sub-polyline covering arc [s0, s1] of an open polyline. */
export function trimPolyline(pts: ReadonlyArray<PaintPoint>, s0: number, s1: number): PaintPoint[] {
  const out: PaintPoint[] = [];
  if (pts.length < 2 || s1 <= s0) return out;
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const lo = Math.max(s0, acc);
    const hi = Math.min(s1, acc + len);
    if (hi >= lo && len > 0) {
      const pa = { x: a.x + ((b.x - a.x) * (lo - acc)) / len, y: a.y + ((b.y - a.y) * (lo - acc)) / len };
      const pb = { x: a.x + ((b.x - a.x) * (hi - acc)) / len, y: a.y + ((b.y - a.y) * (hi - acc)) / len };
      if (out.length === 0) out.push(pa);
      out.push(pb);
    }
    acc += len;
    if (acc >= s1) break;
  }
  return out;
}

// ── The effect ───────────────────────────────────────────────────────

export interface ScribbleOptions extends ScribbleLineOptions, ScribbleEdgeOptions {
  mode: number;
  rgb: readonly [number, number, number];
  opacity: number;
  strokeWidth: number;
  start: number;
  end: number;
  sequential: boolean;
  composite: number;
}

/**
 * The scribble on a raw RGBA buffer. `masks` are every mask on the layer in
 * raster px; `picked` the Single Mask selection (ignored by the All modes).
 */
export function scribbleData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  masks: ReadonlyArray<ResolvedMaskPath>,
  picked: ReadonlyArray<ResolvedMaskPath>,
  o: ScribbleOptions,
): Uint8ClampedArray {
  const style = Math.round(o.composite);
  const opacity = clamp01(o.opacity / 100);
  if (style === PAINT_STYLE.onOriginal && opacity <= 0) return Uint8ClampedArray.from(src);
  const buf = new PaintBuffer(w, h);
  const mode = Math.round(o.mode);
  const usable = masks.filter((m) => m.points.length >= 2);

  // Regions: one per mask for Single / All Masks, one combined for Using Modes.
  const regions: Uint8Array[] = [];
  if (mode === SCRIBBLE_MODE.allMasksUsingModes) {
    if (usable.length > 0) {
      const outlines = usable.filter((m) => m.mode !== 'none');
      regions.push(scribbleRegion(outlines, combineMasksByMode(usable, w, h), w, h, o));
    }
  } else {
    const group = mode === SCRIBBLE_MODE.allMasks ? usable : picked.filter((m) => m.points.length >= 2);
    for (const m of group) regions.push(scribbleRegion([m], maskFill(m, w, h), w, h, o));
  }

  const strandsPerRegion = regions.map((r) => scribbleStrands(r, w, h, o));
  const lensPerRegion = strandsPerRegion.map((ss) => ss.map((s) => polylineLength(s, false)));
  const regionTotals = lensPerRegion.map((ls) => ls.reduce((a, b) => a + b, 0));
  const grand = regionTotals.reduce((a, b) => a + b, 0);
  const lo = clamp01(Math.min(o.start, o.end) / 100);
  const hi = clamp01(Math.max(o.start, o.end) / 100);

  let base = 0;
  strandsPerRegion.forEach((strands, ri) => {
    const total = regionTotals[ri]!;
    const [from, to] = o.sequential ? [lo * grand - base, hi * grand - base] : [lo * total, hi * total];
    let acc = 0;
    strands.forEach((s, si) => {
      const len = lensPerRegion[ri]![si]!;
      const a = Math.max(0, from - acc);
      const b = Math.min(len, to - acc);
      if (b > a) strokePolyline(buf, trimPolyline(s, a, b), o.strokeWidth, o.rgb);
      acc += len;
    });
    base += total;
  });
  return compositePaint(src, buf, style, opacity);
}

const str = (e: Effect, k: string, fb: string): string => {
  const v = paramsOf(e)[k];
  return typeof v === 'string' ? v : fb;
};

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function scribbleOptions(e: Effect): ScribbleOptions {
  const p = paramsOf(e);
  return {
    mode: effectNumber(e, 'scribbleMode'),
    fillType: effectNumber(e, 'fillType'),
    edgeWidth: effectNumber(e, 'edgeWidth'),
    endCap: effectNumber(e, 'endCap'),
    join: effectNumber(e, 'join'),
    miterLimit: effectNumber(e, 'miterLimit'),
    rgb: hexRgb(str(e, 'color', '#ffffff')),
    opacity: effectNumber(e, 'opacity'),
    angle: effectNumber(e, 'angle'),
    strokeWidth: effectNumber(e, 'strokeWidth'),
    curviness: effectNumber(e, 'curviness'),
    curvinessVariation: effectNumber(e, 'curvinessVariation'),
    spacing: effectNumber(e, 'spacing'),
    spacingVariation: effectNumber(e, 'spacingVariation'),
    pathOverlap: effectNumber(e, 'pathOverlap'),
    pathOverlapVariation: effectNumber(e, 'pathOverlapVariation'),
    start: effectNumber(e, 'start'),
    end: effectNumber(e, 'end'),
    sequential: p.fillPathsSequentially !== false,
    seed: effectNumber(e, 'randomSeed'),
    wiggleState: effectNumber(e, 'wiggleState'),
    smoothWiggle: Math.round(effectNumber(e, 'wiggleType')) === WIGGLE_TYPE.smooth,
    composite: effectNumber(e, 'composite'),
  };
}

export function scribbleEffectData(src: Uint8ClampedArray, w: number, h: number, e: Effect): Uint8ClampedArray {
  const p = paramsOf(e);
  const masks = unpackMaskPaths(p.maskPathsMeta, p.maskPathsXY, w, h);
  const picked = pickMaskPaths(p, w, h, false);
  return scribbleData(src, w, h, masks, picked, scribbleOptions(e));
}
