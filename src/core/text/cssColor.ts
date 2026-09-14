/**
 * CSS colour resolution for the text painter.
 *
 * Canvas2D silently IGNORES a `fillStyle` it cannot parse and keeps whatever
 * was set before — so an animator colour of `'var(--color-primary)'` (which the
 * Text Animator panel's "Add colour" used to write) did not error, it painted
 * each glyph in the PREVIOUS glyph's colour. Everything that hands a colour to
 * the canvas goes through here first, and gets back either a concrete colour or
 * the caller's fallback — never an unparseable string.
 *
 * Handles `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (the `#` optional, as the old
 * parser allowed), `rgb()`/`rgba()`, `var(--token[, fallback])` resolved against
 * the document root, and — where a DOM canvas exists — every other CSS colour
 * (named colours, `hsl()`) by letting the canvas normalise it.
 */

export type Rgba = [number, number, number, number];

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

const NAMED: Readonly<Record<string, Rgba>> = {
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1],
  transparent: [0, 0, 0, 0],
};

function parseHexBody(body: string): Rgba | null {
  if (!/^[0-9a-f]+$/i.test(body)) return null;
  if (body.length === 3 || body.length === 4) {
    const d = [...body].map((c) => parseInt(c + c, 16));
    return [d[0]!, d[1]!, d[2]!, body.length === 4 ? d[3]! / 255 : 1];
  }
  if (body.length === 6 || body.length === 8) {
    const n = (i: number): number => parseInt(body.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), body.length === 8 ? n(6) / 255 : 1];
  }
  return null;
}

function parseRgbFn(s: string): Rgba | null {
  const m = /^rgba?\(\s*([^)]*)\)$/i.exec(s);
  if (!m) return null;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const ch = (p: string): number =>
    p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p);
  const r = ch(parts[0]!);
  const g = ch(parts[1]!);
  const b = ch(parts[2]!);
  let a = 1;
  if (parts[3] !== undefined) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return [clamp255(r), clamp255(g), clamp255(b), clamp01(a)];
}

let normCtx: CanvasRenderingContext2D | null | undefined;
function normaliseViaCanvas(s: string): string | null {
  if (normCtx === undefined) {
    try {
      normCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      normCtx = null;
    }
  }
  if (!normCtx) return null;
  // Two different sentinels: an invalid colour leaves fillStyle at whichever
  // sentinel was set, so it cannot come back equal to both.
  normCtx.fillStyle = '#010203';
  normCtx.fillStyle = s;
  const first = String(normCtx.fillStyle);
  normCtx.fillStyle = '#040506';
  normCtx.fillStyle = s;
  const second = String(normCtx.fillStyle);
  return first === second ? first : null;
}

function resolveVar(s: string, depth: number): Rgba | null {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/i.exec(s);
  if (!m) return null;
  let value = '';
  try {
    if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
      value = getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim();
    }
  } catch {
    value = '';
  }
  if (value) {
    const hit = parse(value, depth + 1);
    if (hit) return hit;
  }
  return m[2] ? parse(m[2].trim(), depth + 1) : null;
}

function parse(input: string, depth: number): Rgba | null {
  if (depth > 4) return null;
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith('#')) return parseHexBody(s.slice(1));
  if (/^[0-9a-f]{6}$/i.test(s)) return parseHexBody(s);
  if (/^rgba?\(/i.test(s)) return parseRgbFn(s);
  if (/^var\(/i.test(s)) return resolveVar(s, depth);
  const named = NAMED[s.toLowerCase()];
  if (named) return named;
  const norm = normaliseViaCanvas(s);
  if (norm && norm !== s) return parse(norm, depth + 1);
  return null;
}

/** Parse any CSS colour this module understands, or null. */
export function parseCssColor(c: string | undefined | null): Rgba | null {
  if (typeof c !== 'string') return null;
  return parse(c, 0);
}

const hex2 = (n: number): string => clamp255(n).toString(16).padStart(2, '0');

/** Format as `#rrggbb` when opaque, `rgba()` otherwise. */
export function formatCssColor(c: Rgba): string {
  if (c[3] >= 1) return `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
  return `rgba(${clamp255(c[0])}, ${clamp255(c[1])}, ${clamp255(c[2])}, ${Math.round(clamp01(c[3]) * 1000) / 1000})`;
}

/**
 * A colour string the canvas is guaranteed to accept: `c` normalised, or
 * `fallback` when `c` is not a colour. `fallback` is trusted as-is.
 */
export function toCanvasColor(c: string | undefined | null, fallback: string): string {
  const p = parseCssColor(c);
  return p ? formatCssColor(p) : fallback;
}

/** `#rrggbb` for a colour (alpha dropped), or null — for colour pickers. */
export function toHexColor(c: string | undefined | null): string | null {
  const p = parseCssColor(c);
  return p ? `#${hex2(p[0])}${hex2(p[1])}${hex2(p[2])}` : null;
}

/**
 * Blend two colours by `mix` (0 = a, 1 = b).
 *
 * Never returns an unparseable string: an unreadable TARGET keeps the base
 * colour (the glyph simply does not tint), an unreadable BASE takes the target,
 * and when neither parses the base is returned only if the caller gave one —
 * otherwise white.
 */
export function mixCssColors(a: string | undefined, b: string | undefined, mix: number): string {
  return mixCssColorsImpl(a, b, mix);
}

/**
 * AE's Fill/Stroke Hue, Saturation and Brightness animator properties: offsets
 * applied to a colour in HSB (HSV) space. `hueDeg` rotates the hue; `satPct`
 * and `brightPct` are added to S and V on a 0–100 scale and clamped. Alpha is
 * kept. An unparseable colour comes back as-is (the caller's own fallback
 * already guaranteed it canvas-safe).
 */
export function adjustHsb(color: string, hueDeg: number, satPct: number, brightPct: number): string {
  const p = parseCssColor(color);
  if (!p || (!hueDeg && !satPct && !brightPct)) return color;
  const r = p[0] / 255;
  const g = p[1] / 255;
  const b = p[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const s0 = max === 0 ? 0 : d / max;
  h = (((h + (hueDeg || 0)) % 360) + 360) % 360;
  const s = clamp01(s0 + (satPct || 0) / 100);
  const v = clamp01(max + (brightPct || 0) / 100);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return formatCssColor([Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255), p[3]]);
}

function mixCssColorsImpl(a: string | undefined, b: string | undefined, mix: number): string {
  const pa = parseCssColor(a);
  const pb = parseCssColor(b);
  if (!pb) return pa ? formatCssColor(pa) : '#ffffff';
  if (!pa) return formatCssColor(pb);
  const m = clamp01(Number.isFinite(mix) ? mix : 1);
  const ch = (x: number, y: number): number => x + (y - x) * m;
  return formatCssColor([
    Math.round(ch(pa[0], pb[0])),
    Math.round(ch(pa[1], pb[1])),
    Math.round(ch(pa[2], pb[2])),
    ch(pa[3], pb[3]),
  ]);
}
