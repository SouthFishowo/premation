/**
 * Taper and Wave — the two stroke PROFILES, as After Effects models them.
 *
 * ## Why these are one module
 *
 * AE does not ship Taper as a feature and Wave as another. They arrived together
 * in CC 2018 as one property group on the shape-layer Stroke, and they are
 * grouped because they share machinery: both walk the path by ARC LENGTH, take
 * the local normal, and displace. The only difference is what they do with the
 * two sides — taper moves them OPPOSITELY (it varies the width), wave moves them
 * TOGETHER (it displaces the centreline).
 *
 * Building taper alone would build most of wave and then stop, which is the
 * cheap-half-first trap that produced F34 one item earlier on this board.
 *
 * ## Policy here, geometry elsewhere (DECISION D4)
 *
 * This file is the AE MODEL: what a taper ramp means, how ease bends it, what a
 * wavelength is measured in. The geometric half — offsetting a polyline along
 * its normals by a per-vertex distance — is `offsetAlongNormals` in
 * `@motion/scene`, shared with the brush and with variable-width mask feather.
 * Keeping policy out of the primitive is what lets three features use it.
 *
 * ## Units, which differ between the two and are easy to get wrong
 *
 *   • Taper lengths are a FRACTION OF PATH LENGTH (0..1) by default. "Taper the
 *     first 20%" is resolution- and scale-independent, which is what makes a
 *     tapered stroke survive a resize. AE's Length Units = Pixels reads them as
 *     arc-length px instead (`taperForLength` converts per run).
 *   • Wave's wavelength is ABSOLUTE ARC LENGTH IN PX by default. A wave whose
 *     period scaled with the path would change its look when the shape is
 *     resized, which is not what a wave is for — except on a closed outline,
 *     which is what Units = Cycles is for (`waveForLength`).
 *
 * Both are pure: no clock, no randomness, no engine access.
 */

/**
 * AE's Taper "Length Units". `percent` (absent) is the original model — the
 * lengths are fractions of the path; `pixels` makes them arc-length px, so a
 * taper keeps its size when the path grows (AE 17.1's second option).
 */
export type TaperLengthUnits = 'percent' | 'pixels';

/** AE's Taper group. Widths are FRACTIONS of the stroke's own width. */
export interface StrokeTaper {
  /** Length of the start ramp: a fraction of the path 0..1, or px when `lengthUnits` is 'pixels'. */
  startLength: number;
  /** Length of the end ramp, in the same units as `startLength`. */
  endLength: number;
  /** Width at the very start, as a fraction of stroke width (0 = a point). */
  startWidth: number;
  /** Width at the very end, as a fraction of stroke width. */
  endWidth: number;
  /**
   * −1..1, AE's sign convention: negative bends the ramp POINTY (concave — the
   * width stays thin near the tip and swells late), 0 is a straight ramp,
   * positive bends it ROUND (convex — the width swells straight out of the tip
   * and eases into full width).
   */
  startEase: number;
  /** −1..1, same convention as `startEase`. */
  endEase: number;
  /** Absent = 'percent', which every taper authored before units existed is. */
  lengthUnits?: TaperLengthUnits;
}

/**
 * AE's Wave "Units". `pixels` (absent) reads `wavelength` as arc-length px;
 * `cycles` reads it as the number of whole waves along the path — the only
 * setting under which a wave on a CLOSED path meets itself at the seam.
 */
export type WaveUnits = 'pixels' | 'cycles';

/** AE's Wave group. `phase` is the one that animates. */
export interface StrokeWave {
  /** Peak displacement from the centreline, in px. */
  amount: number;
  /** Period along the path: PX of arc length, or a cycle count when `units` is 'cycles'. */
  wavelength: number;
  /** Degrees. Advancing it travels the wave along the path; 360 is a full turn. */
  phase: number;
  /** Absent = 'pixels'. */
  units?: WaveUnits;
}

export const IDENTITY_TAPER: StrokeTaper = {
  startLength: 0, endLength: 0,
  startWidth: 1, endWidth: 1,
  startEase: 0, endEase: 0,
};

export const IDENTITY_WAVE: StrokeWave = { amount: 0, wavelength: 0, phase: 0 };

/**
 * True when the profile cannot change a single pixel.
 *
 * The renderer short-circuits on these rather than running a taper that happens
 * to compute 1 everywhere. That is what makes "uniform width is byte-identical
 * to no taper" a STRUCTURAL property instead of a numerical coincidence — the
 * tapered path is not taken at all, so there is no float arithmetic to differ
 * in the last bit (§2·0: prefer making the state unrepresentable).
 */
export function isIdentityTaper(t: StrokeTaper | undefined): boolean {
  if (!t) return true;
  // A ramp of zero length cannot ramp, whatever width it names; and full width
  // at both ends is no taper however long the ramps are.
  const noRamp = t.startLength <= 0 && t.endLength <= 0;
  const fullWidth = t.startWidth === 1 && t.endWidth === 1;
  return noRamp || fullWidth;
}

export function isIdentityWave(w: StrokeWave | undefined): boolean {
  // Wavelength 0 is not "an infinitely fast wave", it is a division by zero —
  // treated as off, which is also what a freshly-added Wave group looks like.
  return !w || w.amount === 0 || w.wavelength <= 0;
}

/**
 * Bend a 0..1 ramp by an ease amount, with AE's sign convention.
 *
 * `u` runs from the TIP (0, where the width is the taper's end width) to the
 * top of the ramp (1, full width). `ease`:
 *
 *   • 0      — the straight ramp, returned exactly (not recomputed), so an
 *              uneased taper is byte-identical to the one before eases existed;
 *   • 1      — ROUND: a quarter circle, √(1 − (1−u)²). Vertical at the tip, so
 *              the stroke swells straight out of its point, and flat at the top,
 *              so it meets full width without a crease;
 *   • −1     — POINTY: u². Flat at the tip, so the point is a long needle, and
 *              it meets full width at a FINITE slope (2). The first version was
 *              the mirror of round, 1 − √(1 − u²), whose slope is VERTICAL where
 *              the ramp meets full width — the ribbon's sampled edge drew that
 *              as a visible step in the stroke (golden stroke-taper-ease-signs);
 *   • between — a straight blend toward whichever family the sign names, so the
 *              control is monotonic in feel.
 *
 * CORRECTED 2026-09-15. This used to take 0..1 and blend toward smoothstep,
 * which is flat at BOTH ends — neither of AE's two looks, and it made positive
 * ease read pointy, the opposite of AE. Documents that stored a positive ease
 * now draw round, as AE does; see the golden note in the harness scene.
 *
 * Circles rather than powers because both limits then have the tangent AE's
 * shapes show — a power curve is never vertical at the tip.
 */
export function easeRamp(u: number, ease: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  const e = ease < -1 ? -1 : ease > 1 ? 1 : ease;
  if (e === 0 || !Number.isFinite(e)) return x;
  const target = e > 0
    ? Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)))
    : x * x;
  return x + (target - x) * Math.abs(e);
}

/**
 * The taper with its lengths as FRACTIONS of a path `totalLength` px long.
 *
 * `taperWidthFactorAt` works in fractions; a pixel taper is converted once per
 * run here rather than the factor function growing a second unit. Clamped to
 * 1, because a 300px taper on a 200px path is a taper over the whole path, not
 * one that extrapolates past its end. A percent taper is returned AS IS — the
 * same object — so nothing about the original path changes.
 */
export function taperForLength(taper: StrokeTaper, totalLength: number): StrokeTaper {
  if (taper.lengthUnits !== 'pixels') return taper;
  const total = totalLength > 0 ? totalLength : 1;
  const frac = (px: number): number => Math.max(0, Math.min(1, px / total));
  return {
    startLength: frac(taper.startLength), endLength: frac(taper.endLength),
    startWidth: taper.startWidth, endWidth: taper.endWidth,
    startEase: taper.startEase, endEase: taper.endEase,
  };
}

/**
 * The wave with its wavelength in PX for a path `totalLength` px long.
 *
 * `cycles` → `totalLength / cycles`, so N cycles lay exactly N whole periods
 * along the path and a closed outline meets itself. A pixel wave is returned as
 * is (same object), keeping the original path byte-identical.
 */
export function waveForLength(wave: StrokeWave, totalLength: number): StrokeWave {
  if (wave.units !== 'cycles') return wave;
  const cycles = wave.wavelength;
  return {
    amount: wave.amount,
    wavelength: cycles > 0 && totalLength > 0 ? totalLength / cycles : 0,
    phase: wave.phase,
  };
}

/** Degrees folded into [0, 360) — the Phase field's display, which AE wraps. */
export function wrapPhase(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/**
 * The stroke's width MULTIPLIER at arc fraction `s` (0 = path start, 1 = end).
 *
 * Shape, on paper:
 *
 *      s < startLength          ramp startWidth → 1, eased by startEase
 *      s > 1 − endLength        ramp 1 → endWidth, eased by endEase
 *      between                  1 (full width)
 *
 * The two ramps are independent, which is what lets a stroke taper at one end
 * only — AE's common case, and the reason start and end carry separate widths
 * AND separate eases rather than one shared pair.
 *
 * OVERLAPPING RAMPS are resolved by taking the MINIMUM of the two, not by
 * letting the later one win. With `startLength + endLength > 1` the two ramps
 * cover the same middle, and min() keeps the result continuous and ≤ 1 there;
 * last-one-wins would step discontinuously at the crossover and read as a nick
 * in the stroke.
 */
export function taperWidthFactorAt(taper: StrokeTaper, s: number): number {
  if (isIdentityTaper(taper)) return 1;
  const x = s < 0 ? 0 : s > 1 ? 1 : s;

  let factor = 1;
  if (taper.startLength > 0 && x < taper.startLength) {
    const u = easeRamp(x / taper.startLength, taper.startEase);
    factor = Math.min(factor, taper.startWidth + (1 - taper.startWidth) * u);
  }
  if (taper.endLength > 0 && x > 1 - taper.endLength) {
    const u = easeRamp((1 - x) / taper.endLength, taper.endEase);
    factor = Math.min(factor, taper.endWidth + (1 - taper.endWidth) * u);
  }
  return factor < 0 ? 0 : factor;
}

/**
 * The centreline's perpendicular displacement at `arcLength` px along the path.
 *
 *      offset = amount · sin( 2π · arcLength / wavelength + phase )
 *
 * `phase` is in DEGREES at the boundary because that is what the UI shows and
 * what AE animates; radians only exist inside this function.
 *
 * DIRECTION, stated because it is the thing a symmetric amplitude cannot show:
 * a crest sits where `2πs/λ + φ = π/2`, i.e. at `s = λ(π/2 − φ)/2π`. So
 * ADVANCING THE PHASE MOVES CRESTS TOWARD s = 0 — the wave travels backward
 * along the path as phase increases. That is derived from the formula, not read
 * off an implementation, and it is what the guard anchors to.
 */
export function waveOffsetAt(wave: StrokeWave, arcLength: number): number {
  if (isIdentityWave(wave)) return 0;
  const phaseRad = (wave.phase * Math.PI) / 180;
  return wave.amount * Math.sin((2 * Math.PI * arcLength) / wave.wavelength + phaseRad);
}
