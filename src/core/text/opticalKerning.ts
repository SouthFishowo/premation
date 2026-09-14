/**
 * Optical kerning — pair spacing from the glyphs' SHAPES, as InDesign / AE's
 * "Optical" kerning does, instead of from the font's kern table.
 *
 * ## The model
 *
 * Every glyph is reduced to an INK PROFILE: the space between its baseline
 * −0.25 em and 0.95 em is cut into `BAND_COUNT` horizontal bands and, per band,
 * the leftmost and rightmost ink x (em, pen at 0) is recorded — or NaN where
 * the band holds no ink. Two glyphs set side by side without kerning then face
 * each other band by band:
 *
 *     d[i] = advance(L) + left(R)[i] − right(L)[i]        (both have ink)
 *
 * The OPTICAL white between them is the weighted mean of those distances with
 * two corrections that stop open shapes from collapsing:
 *   • every distance is capped at `dmin + OPEN_CAP_EM` — the deep concavity of
 *     an "L", the space under a "T" bar or beside a round "o" counts only as
 *     far as the eye reads it as gap, not all the way into the counter;
 *   • a band where only ONE glyph has ink (the "T" bar above a ".") is open
 *     space and counts at that same cap.
 * Bands are weighted toward the x-height (where the eye judges spacing), less
 * above it and least in the descenders.
 *
 * The pair is then moved `OPTICAL_STRENGTH` of the way toward the TARGET — the
 * optical white of the font's own "nn"/"oo" (lower case) or "HH"/"OO"
 * (capitals), so the designer's colour is kept and only irregular pairs change
 * — clamped to `MAX_*_EM`, and never tightened past `MIN_INK_GAP_EM` of real
 * ink contact (checked on neighbouring bands too, so diagonals do not touch).
 * Tuned on Arial's outlines: AV −0.074 em (its kern table: −0.074), To −0.12,
 * Ly −0.08, while HH / nn / oo move under 0.01 em.
 *
 * ## Where profiles come from
 *
 * 1. OUTLINES, when the face's bytes have been parsed (openType.ts — the Local
 *    Font Access path Create Shapes From Text already uses registers them here
 *    via `registerOpticalOutlineFace`). Exact, resolution-free. A VARIABLE face
 *    is profiled at the instance it is drawn at: its CSS weight as `wght`, plus
 *    the alias face's `font-variation-settings` (`OpticalFace.variation`) —
 *    gvar / CFF2 deltas applied by openType.ts. A variable file registered for
 *    one weight serves every weight of its family.
 * 2. RASTER, for every other font the canvas can draw (web fonts, bundled
 *    fonts): the glyph is drawn alone at `REF_EM_PX` on a scratch canvas and
 *    the profile is read from alpha, with sub-pixel edges from coverage.
 * A face keeps the source it was FIRST profiled with for the session, so a face
 * registering later can never make already-rendered text and its measured box
 * disagree.
 *
 * Results are cached per face (its CSS font at the reference size — so size
 * independent), per glyph, and per pair in em.
 *
 * Pure math at the top (unit-testable on synthetic outlines); the canvas is
 * reached only through an injectable rasterizer.
 */

import type { GlyphContour, GlyphOutline, ParsedFont } from './openType';
import { parseVariationSettings } from './fontAxes';

/** Reference em size, px, for rasterised profiles. */
export const REF_EM_PX = 128;
export const BAND_COUNT = 30;
export const BAND_BOTTOM_EM = -0.25;
export const BAND_TOP_EM = 0.95;
const BAND_H = (BAND_TOP_EM - BAND_BOTTOM_EM) / BAND_COUNT;

/** How far past the closest approach a band's distance still counts, em. */
export const OPEN_CAP_EM = 0.08;
/**
 * Share of the difference from the target that is corrected. Closing it fully
 * over-kerns diagonals (Arial "AV" would move −0.136 em against the font's own
 * −0.074 em pair); 0.6 lands optical pairs in the range the kern tables of
 * well-spaced faces use, while regular pairs barely move.
 */
export const OPTICAL_STRENGTH = 0.6;
/** Clamp on the adjustment, em. */
export const MAX_TIGHTEN_EM = 0.15;
export const MAX_LOOSEN_EM = 0.05;
/** Tightening never brings facing ink closer than this, em. */
export const MIN_INK_GAP_EM = 0.02;
/** x-height assumed when a face has no measurable "x". */
const DEFAULT_X_HEIGHT_EM = 0.52;
/** Optical white assumed when a face has none of the calibration glyphs. */
const DEFAULT_TARGET_EM = 0.1;

/** A glyph's horizontal ink extent per band, em (pen at x = 0, y up). */
export interface InkProfile {
  advance: number;
  /** Leftmost ink per band, NaN where the band is empty. */
  left: number[];
  /** Rightmost ink per band, NaN where the band is empty. */
  right: number[];
  /** Highest ink, em (NaN for a blank glyph). */
  top: number;
}

function emptyProfile(advance: number): InkProfile {
  return {
    advance,
    left: new Array<number>(BAND_COUNT).fill(NaN),
    right: new Array<number>(BAND_COUNT).fill(NaN),
    top: NaN,
  };
}

const bandOf = (yEm: number): number => Math.floor((yEm - BAND_BOTTOM_EM) / BAND_H);
const bandCentre = (i: number): number => BAND_BOTTOM_EM + (i + 0.5) * BAND_H;

function widen(p: InkProfile, band: number, x: number): void {
  if (band < 0 || band >= BAND_COUNT) return;
  const l = p.left[band]!;
  const r = p.right[band]!;
  if (Number.isNaN(l) || x < l) p.left[band] = x;
  if (Number.isNaN(r) || x > r) p.right[band] = x;
}

/** Add one straight edge (em) to a profile: its x extent within every band it crosses. */
function addEdge(p: InkProfile, x0: number, y0: number, x1: number, y1: number): void {
  const yLo = Math.min(y0, y1);
  const yHi = Math.max(y0, y1);
  if (yHi < BAND_BOTTOM_EM || yLo >= BAND_TOP_EM) return;
  const first = Math.max(0, bandOf(yLo));
  const last = Math.min(BAND_COUNT - 1, bandOf(yHi));
  for (let b = first; b <= last; b++) {
    const bLo = BAND_BOTTOM_EM + b * BAND_H;
    const bHi = bLo + BAND_H;
    if (y1 === y0) {
      widen(p, b, x0);
      widen(p, b, x1);
      continue;
    }
    // The edge clipped to the band: x at its two clipped ends.
    const ta = (Math.max(yLo, bLo) - y0) / (y1 - y0);
    const tb = (Math.min(yHi, bHi) - y0) / (y1 - y0);
    widen(p, b, x0 + (x1 - x0) * ta);
    widen(p, b, x0 + (x1 - x0) * tb);
  }
}

const CURVE_STEPS = 12;

/**
 * Profile of contours in font units (y up). The ink's extreme x inside a band
 * lies on its outline clipped to the band, so the flattened edges suffice.
 */
export function profileFromContours(contours: ReadonlyArray<GlyphContour>, advanceUnits: number, unitsPerEm: number): InkProfile {
  const s = 1 / (unitsPerEm || 1000);
  const p = emptyProfile(advanceUnits * s);
  for (const c of contours) {
    const pts = c.points;
    const n = pts.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      let px = a.x * s;
      let py = a.y * s;
      for (let k = 1; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS;
        const u = 1 - t;
        const x = (u * u * u * a.x + 3 * u * u * t * a.outX + 3 * u * t * t * b.inX + t * t * t * b.x) * s;
        const y = (u * u * u * a.y + 3 * u * u * t * a.outY + 3 * u * t * t * b.inY + t * t * t * b.y) * s;
        addEdge(p, px, py, x, y);
        if (Number.isNaN(p.top) || y > p.top) p.top = y;
        px = x;
        py = y;
      }
      if (Number.isNaN(p.top) || a.y * s > p.top) p.top = a.y * s;
    }
  }
  return p;
}

export function profileFromOutline(glyph: GlyphOutline, unitsPerEm: number): InkProfile {
  return profileFromContours(glyph.contours, glyph.advance, unitsPerEm);
}

/** Alpha below this (of 255) is treated as no ink — anti-aliasing noise. */
const ALPHA_FLOOR = 8;

/**
 * Profile from an RGBA raster of one glyph drawn with its pen at (`penX`,
 * `baselineY`) px and `emPx` px to the em. Edges are placed with sub-pixel
 * precision from the coverage of the outermost inked pixel.
 */
export function profileFromAlpha(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  penX: number,
  baselineY: number,
  emPx: number,
  advancePx: number,
): InkProfile {
  const p = emptyProfile(advancePx / emPx);
  for (let row = 0; row < height; row++) {
    const yEm = (baselineY - (row + 0.5)) / emPx;
    const band = bandOf(yEm);
    if (band < 0 || band >= BAND_COUNT) continue;
    const base = row * width;
    let first = -1;
    for (let col = 0; col < width; col++) {
      if ((rgba[(base + col) * 4 + 3] ?? 0) >= ALPHA_FLOOR) { first = col; break; }
    }
    if (first < 0) continue;
    let last = first;
    for (let col = width - 1; col > first; col--) {
      if ((rgba[(base + col) * 4 + 3] ?? 0) >= ALPHA_FLOOR) { last = col; break; }
    }
    const aL = (rgba[(base + first) * 4 + 3] ?? 0) / 255;
    const aR = (rgba[(base + last) * 4 + 3] ?? 0) / 255;
    widen(p, band, (first + 1 - aL - penX) / emPx);
    widen(p, band, (last + aR - penX) / emPx);
    const top = (baselineY - row) / emPx;
    if (Number.isNaN(p.top) || top > p.top) p.top = top;
  }
  return p;
}

// ── Pair math ────────────────────────────────────────────────────────

export interface PairGap {
  /** Weighted optical white between the two, px. */
  area: number;
  /** Closest facing ink, px (same band or a neighbouring one). */
  dmin: number;
}

function bandWeight(yEm: number, xHeight: number): number {
  if (yEm < 0) return 0.3;
  if (yEm <= xHeight) return 1;
  if (yEm <= xHeight + 0.25) return 0.5;
  return 0.25;
}

/**
 * The optical white between `a` set at `sizeA` px/em and `b` at `sizeB`, with
 * b's pen at a's (unkerned) advance. Null when one glyph has no ink at all.
 */
export function measurePairGap(
  a: InkProfile, sizeA: number,
  b: InkProfile, sizeB: number,
  xHeightEm = DEFAULT_X_HEIGHT_EM,
): PairGap | null {
  const penB = a.advance * sizeA;
  const cap = OPEN_CAP_EM * Math.min(sizeA, sizeB);
  // b's band facing a's band i (the same band when the sizes match).
  const facing = (i: number): number => (sizeA === sizeB ? i : bandOf((bandCentre(i) * sizeA) / sizeB));
  const leftB = (j: number): number => (j >= 0 && j < BAND_COUNT ? b.left[j]! : NaN);

  let dmin = Infinity;
  let anyA = false;
  let anyB = false;
  const both: Array<{ d: number; w: number }> = [];
  let openW = 0;
  for (let i = 0; i < BAND_COUNT; i++) {
    const ra = a.right[i]!;
    const j = facing(i);
    const lb = leftB(j);
    const hasA = !Number.isNaN(ra);
    const hasB = !Number.isNaN(lb);
    anyA ||= hasA;
    anyB ||= hasB;
    if (!hasA && !hasB) continue;
    const w = bandWeight(bandCentre(i), xHeightEm);
    if (hasA && hasB) {
      const d = penB + lb * sizeB - ra * sizeA;
      both.push({ d, w });
      dmin = Math.min(dmin, d);
    } else {
      openW += w;
    }
    // Diagonals: ink in neighbouring bands can meet even where the same band
    // is clear, so contact is judged across ±1 band as well.
    if (hasA) {
      for (const jj of [j - 1, j + 1]) {
        const n = leftB(jj);
        if (!Number.isNaN(n)) dmin = Math.min(dmin, penB + n * sizeB - ra * sizeA);
      }
    }
  }
  if (!anyA || !anyB) return null;
  if (both.length === 0) {
    // Ink that never shares a band height with the other (an apostrophe before
    // a period): the gap is their horizontal clearance.
    const maxRA = Math.max(...a.right.filter((v) => !Number.isNaN(v)));
    const minLB = Math.min(...b.left.filter((v) => !Number.isNaN(v)));
    const clear = penB + minLB * sizeB - maxRA * sizeA;
    const d = Number.isFinite(dmin) ? Math.min(dmin, clear) : clear;
    return { area: d + cap, dmin: d };
  }
  let sum = 0;
  let wsum = 0;
  for (const { d, w } of both) {
    sum += Math.min(d, dmin + cap) * w;
    wsum += w;
  }
  sum += (dmin + cap) * openW;
  wsum += openW;
  return { area: sum / wsum, dmin };
}

/**
 * The adjustment, px, that brings a pair's optical white to `targetPx`:
 * clamped, and never tightening facing ink below the minimum gap. `sizePx` is
 * the size the clamps are proportional to.
 */
export function pairAdjustment(gap: PairGap, targetPx: number, sizePx: number): number {
  let k = (targetPx - gap.area) * OPTICAL_STRENGTH;
  k = Math.max(-MAX_TIGHTEN_EM * sizePx, Math.min(MAX_LOOSEN_EM * sizePx, k));
  // Only ever LIMITS tightening — a script face whose letters are designed to
  // touch is not pushed apart.
  if (k < 0) k = Math.max(k, Math.min(0, MIN_INK_GAP_EM * sizePx - gap.dmin));
  return k;
}

// ── Faces, sources and caches ────────────────────────────────────────

/** A face as the painter and the measurer both describe it. */
export interface OpticalFace {
  /** The CSS font shorthand at `REF_EM_PX` — the cache identity. */
  css: string;
  family?: string;
  weight?: string | number;
  italic?: boolean;
  /**
   * Drawn through a variable-axis alias / feature face (fontFaceVariants.ts).
   * With outlines, its `variation` settings pick the instance; a feature-only
   * alias draws the base outlines (cmap glyphs — a substitution such as ss01
   * is not followed).
   */
  variable?: boolean;
  /** The alias face's CSS `font-variation-settings`, when `variable`. */
  variation?: string;
}

/** Draws one cluster in `css` and profiles it; null when it cannot. */
export type GlyphRasterizer = (css: string, cluster: string) => InkProfile | null;

const outlineFaces = new Map<string, ParsedFont>();
/** Variable faces by family + slant: one file draws every weight. */
const variableOutlineFaces = new Map<string, ParsedFont>();
const faceSource = new Map<string, 'outline' | 'raster'>();
const profileCache = new Map<string, InkProfile | null>();
const pairCache = new Map<string, number>();
const faceMetrics = new Map<string, { xHeight: number; lower: number; upper: number }>();
const MAX_CACHE = 20000;
let rasterizer: GlyphRasterizer | null | undefined;

const outlineKey = (family: string | undefined, weight: string | number | undefined, italic: boolean | undefined): string =>
  `${String(family ?? '').trim().toLowerCase()}|${Number(weight) || 400}|${italic ? 'i' : ''}`;

/**
 * Make a parsed face's outlines available to optical kerning. A face already
 * profiled from raster keeps that source for the session (see file docblock).
 */
export function registerOpticalOutlineFace(family: string, weight: number, italic: boolean, font: ParsedFont): void {
  outlineFaces.set(outlineKey(family, weight, italic), font);
  if (font.axes && font.axes.length > 0) variableOutlineFaces.set(outlineKey(family, 0, italic), font);
}

/** The parsed face that serves `face`, at the instance `face` is drawn at. */
function outlineFontFor(face: OpticalFace): ParsedFont | undefined {
  const font = outlineFaces.get(outlineKey(face.family, face.weight, face.italic))
    ?? variableOutlineFaces.get(outlineKey(face.family, 0, face.italic));
  if (!font || !font.axes || font.axes.length === 0 || !font.instance) return font;
  const values: Record<string, number> = { wght: Number(face.weight) || 400 };
  if (face.variable) Object.assign(values, parseVariationSettings(face.variation));
  return font.instance(values);
}

/** Replace the rasterizer (tests; a worker with its own canvas). `null` = none. */
export function setOpticalRasterizer(r: GlyphRasterizer | null): void {
  rasterizer = r;
  resetOpticalKerningCaches();
}

/** Forget every cached profile, pair and face source. */
export function resetOpticalKerningCaches(): void {
  faceSource.clear();
  dropOpticalProfiles();
}

/** Forget measured profiles (a face finished loading), keeping each face's source. */
function dropOpticalProfiles(): void {
  profileCache.clear();
  pairCache.clear();
  faceMetrics.clear();
  verticalTargets.clear();
}

// A web font that arrives after first use was rasterised as its FALLBACK: drop
// those profiles, as measureText drops its boxes and the textures re-rasterise.
if (typeof document !== 'undefined' && typeof document.fonts !== 'undefined') {
  document.fonts.addEventListener?.('loadingdone', dropOpticalProfiles);
}

/** Test seam: drop registered outline faces too. */
export function resetOpticalKerningForTest(): void {
  outlineFaces.clear();
  variableOutlineFaces.clear();
  rasterizer = undefined;
  verticalRasterizer = undefined;
  resetOpticalKerningCaches();
}

// ── Vertical type: upright CJK pairs ─────────────────────────────────

/**
 * Upright glyphs in a vertical column face each other TOP to BOTTOM, so their
 * profile is the horizontal one turned a quarter: bands run ACROSS the column
 * (the em box's x from 0 to 1 mapped onto the band range, all at full weight),
 * `left` holds the topmost ink measured DOWN from the em box's top, `right` the
 * bottommost, and `advance` is the one em an upright glyph steps. The pair math
 * (`measurePairGap`, `pairAdjustment`) is then shared unchanged.
 */
export const VERTICAL_BAND_SPAN_EM = BAND_TOP_EM;

/** Band coordinate for an x across the em box (0..1 em). */
const verticalBandOf = (xEm: number): number => bandOf(xEm * VERTICAL_BAND_SPAN_EM);

/**
 * Vertical profile from an RGBA raster of one upright glyph whose em box's
 * top-left corner is at (`emLeft`, `emTop`) px, `emPx` px to the em.
 */
export function verticalProfileFromAlpha(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  emLeft: number,
  emTop: number,
  emPx: number,
): InkProfile {
  const p = emptyProfile(1);
  for (let col = 0; col < width; col++) {
    const xEm = (col + 0.5 - emLeft) / emPx;
    if (xEm < 0 || xEm > 1) continue;
    const band = verticalBandOf(xEm);
    if (band < 0 || band >= BAND_COUNT) continue;
    let first = -1;
    for (let row = 0; row < height; row++) {
      if ((rgba[(row * width + col) * 4 + 3] ?? 0) >= ALPHA_FLOOR) { first = row; break; }
    }
    if (first < 0) continue;
    let last = first;
    for (let row = height - 1; row > first; row--) {
      if ((rgba[(row * width + col) * 4 + 3] ?? 0) >= ALPHA_FLOOR) { last = row; break; }
    }
    const aT = (rgba[(first * width + col) * 4 + 3] ?? 0) / 255;
    const aB = (rgba[(last * width + col) * 4 + 3] ?? 0) / 255;
    widen(p, band, (first + 1 - aT - emTop) / emPx);
    widen(p, band, (last + aB - emTop) / emPx);
    const bottom = (last + aB - emTop) / emPx;
    if (Number.isNaN(p.top) || bottom > p.top) p.top = bottom;
  }
  return p;
}

let verticalRasterizer: GlyphRasterizer | null | undefined;

/** Replace the vertical-profile rasterizer (tests). `null` = none. */
export function setOpticalVerticalRasterizer(r: GlyphRasterizer | null): void {
  verticalRasterizer = r;
  resetOpticalKerningCaches();
}

function defaultVerticalRasterizer(): GlyphRasterizer | null {
  if (verticalRasterizer !== undefined) return verticalRasterizer;
  verticalRasterizer = null;
  if (typeof document === 'undefined') return null;
  const W = REF_EM_PX * 2;
  const H = REF_EM_PX * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  } catch {
    ctx = null;
  }
  if (!ctx || typeof ctx.getImageData !== 'function') return null;
  const g = ctx;
  // Drawn as the vertical painter draws an upright glyph: centred in its em,
  // on a 'middle' baseline.
  const cx = W / 2;
  const cy = H / 2;
  verticalRasterizer = (css, cluster) => {
    try {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      g.font = css;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#000';
      g.fillText(cluster, cx, cy);
      const data = g.getImageData(0, 0, W, H).data;
      return verticalProfileFromAlpha(data, W, H, cx - REF_EM_PX / 2, cy - REF_EM_PX / 2, REF_EM_PX);
    } catch {
      return null;
    }
  };
  return verticalRasterizer;
}

/** The vertical ink profile of one upright cluster in a face, or null. */
export function glyphVerticalInkProfile(face: OpticalFace, cluster: string): InkProfile | null {
  const key = `v ${face.css} ${cluster}`;
  const hit = profileCache.get(key);
  if (hit !== undefined) return hit;
  return bounded(profileCache, key, defaultVerticalRasterizer()?.(face.css, cluster) ?? null);
}

/**
 * The PROPORTIONAL CJK units vertical optical kerning may tighten: kana
 * (small kana included), the prolonged sound mark, CJK and fullwidth
 * punctuation and their vertical presentation forms. Ideographs are designed
 * on the full em and keep their fixed pitch.
 */
export function isProportionalCjk(cluster: string): boolean {
  const cp = cluster.codePointAt(0) ?? 0;
  return (cp >= 0x3001 && cp <= 0x303f) || // CJK symbols & punctuation (not U+3000 IDEOGRAPHIC SPACE)
    (cp >= 0x3041 && cp <= 0x30ff) || // hiragana, katakana, ー
    (cp >= 0x31f0 && cp <= 0x31ff) || // katakana phonetic extensions (small kana)
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe4f) || // vertical forms
    (cp >= 0xff01 && cp <= 0xff0f) || (cp >= 0xff1a && cp <= 0xff20) || (cp >= 0xff3b && cp <= 0xff40) ||
    (cp >= 0xff5b && cp <= 0xff65); // fullwidth / halfwidth punctuation
}

const verticalTargets = new Map<string, number>();

/** The face's own vertical white between two full-em ideographs — the colour pairs move toward. */
function verticalTargetOf(face: OpticalFace): number {
  const hit = verticalTargets.get(face.css);
  if (hit !== undefined) return hit;
  const areas: number[] = [];
  for (const c of ['国', '口']) {
    const p = glyphVerticalInkProfile(face, c);
    const gap = p ? measurePairGap(p, 1, p, 1, VERTICAL_BAND_SPAN_EM) : null;
    if (gap) areas.push(gap.area);
  }
  return bounded(verticalTargets, face.css, areas.length > 0 ? areas.reduce((s, v) => s + v, 0) / areas.length : DEFAULT_TARGET_EM);
}

/**
 * Optical kerning for two UPRIGHT glyphs stacked in a vertical column: px to
 * add to the UPPER glyph's advance. Only ever tightens, only a pair with at
 * least one proportional unit (`isProportionalCjk`), and clamped exactly as a
 * horizontal pair (`pairAdjustment`). Cached per face pair and size ratio.
 */
export function opticalKernVerticalPx(
  faceA: OpticalFace, a: string, sizeA: number,
  faceB: OpticalFace, b: string, sizeB: number,
): number {
  if (!(sizeA > 0) || !(sizeB > 0) || a.trim() === '' || b.trim() === '') return 0;
  if (!isProportionalCjk(a) && !isProportionalCjk(b)) return 0;
  const ratio = sizeB / sizeA;
  const key = `v ${faceA.css} ${a} ${faceB.css} ${b} r${ratio}`;
  const hit = pairCache.get(key);
  if (hit !== undefined) return hit * sizeA;
  const pa = glyphVerticalInkProfile(faceA, a);
  const pb = glyphVerticalInkProfile(faceB, b);
  let em = 0;
  if (pa && pb) {
    const gap = measurePairGap(pa, 1, pb, ratio, VERTICAL_BAND_SPAN_EM);
    if (gap) em = Math.min(0, pairAdjustment(gap, verticalTargetOf(faceA), Math.min(1, ratio)));
  }
  bounded(pairCache, key, em);
  return em * sizeA;
}

function defaultRasterizer(): GlyphRasterizer | null {
  if (rasterizer !== undefined) return rasterizer;
  rasterizer = null;
  if (typeof document === 'undefined') return null;
  const W = REF_EM_PX * 4;
  const H = REF_EM_PX * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  } catch {
    ctx = null;
  }
  if (!ctx || typeof ctx.getImageData !== 'function') return null;
  const g = ctx;
  const penX = REF_EM_PX * 1.5;
  const baselineY = REF_EM_PX * 1.3;
  rasterizer = (css, cluster) => {
    try {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      g.font = css;
      const k = g as CanvasRenderingContext2D & { fontKerning?: string; letterSpacing?: string };
      if ('fontKerning' in k) k.fontKerning = 'none';
      if ('letterSpacing' in k) k.letterSpacing = '0px';
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#000';
      g.fillText(cluster, penX, baselineY);
      const advance = g.measureText(cluster).width;
      const data = g.getImageData(0, 0, W, H).data;
      return profileFromAlpha(data, W, H, penX, baselineY, REF_EM_PX, advance);
    } catch {
      return null;
    }
  };
  return rasterizer;
}

function bounded<K, V>(m: Map<K, V>, k: K, v: V): V {
  if (m.size >= MAX_CACHE) m.clear();
  m.set(k, v);
  return v;
}

/** The ink profile of one cluster in a face (em units), or null. */
export function glyphInkProfile(face: OpticalFace, cluster: string): InkProfile | null {
  const key = `${face.css}\u0000${cluster}`;
  const hit = profileCache.get(key);
  if (hit !== undefined) return hit;
  let source = faceSource.get(face.css);
  const font = outlineFontFor(face);
  if (!source) {
    source = font ? 'outline' : 'raster';
    faceSource.set(face.css, source);
  }
  let profile: InkProfile | null = null;
  const cps = [...cluster];
  if (source === 'outline' && font && cps.length === 1) {
    const glyph = font.glyphFor(cps[0]!.codePointAt(0)!);
    if (glyph) profile = profileFromOutline(glyph, font.unitsPerEm);
  }
  if (!profile) profile = defaultRasterizer()?.(face.css, cluster) ?? null;
  return bounded(profileCache, key, profile);
}

function metricsOf(face: OpticalFace): { xHeight: number; lower: number; upper: number } {
  const hit = faceMetrics.get(face.css);
  if (hit) return hit;
  const x = glyphInkProfile(face, 'x');
  const xHeight = x && Number.isFinite(x.top) ? Math.max(0.3, Math.min(0.8, x.top)) : DEFAULT_X_HEIGHT_EM;
  const selfWhite = (chars: string[]): number => {
    const areas: number[] = [];
    for (const c of chars) {
      const p = glyphInkProfile(face, c);
      const gap = p ? measurePairGap(p, 1, p, 1, xHeight) : null;
      if (gap) areas.push(gap.area);
    }
    return areas.length > 0 ? areas.reduce((s, v) => s + v, 0) / areas.length : DEFAULT_TARGET_EM;
  };
  return bounded(faceMetrics, face.css, { xHeight, lower: selfWhite(['n', 'o']), upper: selfWhite(['H', 'O']) });
}

const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase();

/**
 * Optical kerning for one adjacent pair, px to add to the LEFT glyph's advance
 * (which must be its unkerned advance). 0 for whitespace or glyphs with no ink.
 */
export function opticalKernPx(
  faceA: OpticalFace, a: string, sizeA: number,
  faceB: OpticalFace, b: string, sizeB: number,
): number {
  if (!(sizeA > 0) || !(sizeB > 0) || a.trim() === '' || b.trim() === '') return 0;
  // Everything in the pair math scales with the two sizes together (the band
  // each glyph faces depends only on their RATIO; the open cap, the clamps and
  // the target are proportional to a size), so the pair is computed once in
  // units of the LEFT glyph's em — the right glyph's em profile scaled by the
  // ratio — and cached per face pair and ratio. A mixed-size run then reuses
  // every pair it has met at any absolute size; same-size pairs keep ratio 1,
  // exactly the arithmetic (and cache entry) they always had.
  const ratio = sizeB / sizeA;
  const key = ratio === 1
    ? `${faceA.css}\u0000${a}\u0000${faceB.css}\u0000${b}`
    : `${faceA.css}\u0000${a}\u0000${faceB.css}\u0000${b}\u0000r${ratio}`;
  const hit = pairCache.get(key);
  if (hit !== undefined) return hit * sizeA;
  const upper = isUpper(a) && isUpper(b);
  const pa = glyphInkProfile(faceA, a);
  const pb = glyphInkProfile(faceB, b);
  let em = 0;
  if (pa && pb) {
    const m = metricsOf(faceA);
    const gap = measurePairGap(pa, 1, pb, ratio, m.xHeight);
    if (gap) em = pairAdjustment(gap, upper ? m.upper : m.lower, Math.min(1, ratio));
  }
  bounded(pairCache, key, em);
  return em * sizeA;
}
