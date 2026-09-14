/**
 * Variable-font outlines: fvar/avar normalisation, gvar (+ IUP, phantom
 * points, composites), HVAR and CFF2 blend.
 *
 * Three layers of evidence.
 *   1. A hand-built gvar face pins the byte-level contract with hand-computed
 *      answers: shared vs embedded peaks, an intermediate region, private and
 *      shared point numbers, zero / byte / word / long delta runs, IUP, the
 *      advance from phantom points and a composite's offset delta.
 *   2. Two REAL variable fonts committed under __fixtures__/variable (both
 *      SIL OFL 1.1, licences beside them): Oswald[wght].ttf (gvar + avar + HVAR,
 *      composites) and SourceSans3VF-Upright.otf (CFF2 + HVAR). Their outlines
 *      are compared with fontTools 4.63 — `varLib.instancer` masters and
 *      intermediates (integer-rounded), and `getGlyphSet(location=…)`
 *      (unrounded) — recorded in variableFontReference.json.
 *   3. When the scratch copies exist (VF_REFERENCE_DIR), more fonts and
 *      multi-axis locations (Roboto Flex's 13 axes) and the instancer's static
 *      instances parsed through the static glyf / CFF paths.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseFont, type GlyphOutline, type ParsedFont } from './openType';
import { iupContour } from './openTypeVariations';

// ── byte helpers ─────────────────────────────────────────────────────

const u16 = (v: number): number[] => [(v >> 8) & 255, v & 255];
const i16 = (v: number): number[] => u16(v & 0xffff);
const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const i32 = (v: number): number[] => u32(v >>> 0);
const f2 = (v: number): number[] => i16(Math.round(v * 16384));
const fixed = (v: number): number[] => i32(Math.round(v * 65536));
const tag = (t: string): number[] => t.split('').map((c) => c.charCodeAt(0));
const pad = (b: number[]): number[] => (b.length % 2 ? [...b, 0] : b);

function sfnt(tables: Array<[string, number[]]>): ArrayBuffer {
  const sorted = [...tables].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const dirLen = 12 + sorted.length * 16;
  const dir: number[] = [...u32(0x00010000), ...u16(sorted.length), 0, 0, 0, 0, 0, 0];
  const body: number[] = [];
  let offset = dirLen;
  for (const [t, data] of sorted) {
    dir.push(...tag(t), ...u32(0), ...u32(offset), ...u32(data.length));
    const padded = [...data];
    while (padded.length % 4) padded.push(0);
    body.push(...padded);
    offset += padded.length;
  }
  return new Uint8Array([...dir, ...body]).buffer;
}

// ── the hand-built variable face ─────────────────────────────────────

/**
 * 'A' (gid 1): a square (0,0)(100,0)(100,100)(0,100) and a triangle
 * (200,0)(300,0)(250,100), advance 500. 'B' (gid 2): 'A' placed at (10, 0),
 * advance 600. One axis, wght 100 / 400 / 900, avar maps 0.5 → 0.8.
 *
 * gvar, 'A':
 *   tuple 1 — shared peak +1, private points {0, 2, 8 (pp2)}: x WORDS 10 20 30,
 *             y BYTES 0 5 0. Points 1 and 3 are inferred (IUP); the triangle
 *             is untouched; the advance grows by 30.
 *   tuple 2 — embedded peak −0.5 in the intermediate region [−1, 0], all
 *             points: x ZERO×4, LONG −100×3, ZERO×4; y ZERO×11. Moves the
 *             triangle left by 100 at −0.5.
 * gvar, 'B': shared point numbers {0}; one tuple at the shared peak moving the
 *            component offset by (5, 7).
 */
function buildVariableTtf(variable = true): ArrayBuffer {
  const glyphA = pad([
    ...i16(2), ...i16(0), ...i16(0), ...i16(300), ...i16(100),
    ...u16(3), ...u16(6), ...u16(0),
    1, 1, 1, 1, 1, 1, 1,
    ...i16(0), ...i16(100), ...i16(0), ...i16(-100), ...i16(200), ...i16(100), ...i16(-50),
    ...i16(0), ...i16(0), ...i16(100), ...i16(0), ...i16(-100), ...i16(0), ...i16(100),
  ]);
  const glyphB = pad([...i16(-1), ...i16(10), ...i16(0), ...i16(310), ...i16(100), ...u16(0x0003), ...u16(1), ...i16(10), ...i16(0)]);
  const BBOX = [...i16(0), ...i16(0), ...i16(0), ...i16(0)];
  // 'C' (gid 3): 'A' scaled 1.5 with offset (10, 20) and SCALED_COMPONENT_OFFSET.
  const glyphC = pad([...i16(-1), ...BBOX, ...u16(0x0002 | 0x0008 | 0x0800), ...u16(1), 10, 20, ...f2(1.5)]);
  // 'D' (gid 4): 'A' at (0, 0), then 'A' POINT-MATCHED — its point 0 onto
  // compound point 1 — with USE_MY_METRICS (hmtx says 999; 'A' says 500).
  const glyphD = pad([...i16(-1), ...BBOX, ...u16(0x0002 | 0x0020), ...u16(1), 0, 0, ...u16(0x0200), ...u16(1), 1, 0]);
  // 'E' (gid 5): as 'C' without the flag — the offset is not scaled (the default).
  const glyphE = pad([...i16(-1), ...BBOX, ...u16(0x0002 | 0x0008), ...u16(1), 10, 20, ...f2(1.5)]);
  const glyf = [...glyphA, ...glyphB, ...glyphC, ...glyphD, ...glyphE];
  const ends = [glyphA, glyphB, glyphC, glyphD, glyphE].reduce<number[]>((acc, g) => [...acc, (acc[acc.length - 1] ?? 0) + g.length], []);
  const loca = [...u16(0), ...u16(0), ...ends.flatMap((e) => u16(e / 2))];
  const head = new Array(54).fill(0);
  head.splice(18, 2, ...u16(1000));
  const hhea = new Array(36).fill(0);
  hhea.splice(4, 2, ...i16(800));
  hhea.splice(6, 2, ...i16(-200));
  hhea.splice(34, 2, ...u16(6));
  const hmtx = [...u16(500), ...i16(0), ...u16(500), ...i16(0), ...u16(600), ...i16(10), ...u16(700), ...i16(0), ...u16(999), ...i16(0), ...u16(800), ...i16(0)];
  const maxp = [...u32(0x00010000), ...u16(6)];
  const sub4 = [
    ...u16(4), ...u16(32), ...u16(0), ...u16(4), ...u16(4), ...u16(1), ...u16(0),
    ...u16(69), ...u16(0xffff), ...u16(0), ...u16(65), ...u16(0xffff), ...i16(-64), ...i16(1), ...u16(0), ...u16(0),
  ];
  const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub4];
  const fvar = [
    ...u16(1), ...u16(0), ...u16(16), ...u16(2), ...u16(1), ...u16(20), ...u16(0), ...u16(8),
    ...tag('wght'), ...fixed(100), ...fixed(400), ...fixed(900), ...u16(0), ...u16(256),
  ];
  const avar = [...u16(1), ...u16(0), ...u16(0), ...u16(1), ...u16(4), ...f2(-1), ...f2(-1), ...f2(0), ...f2(0), ...f2(0.5), ...f2(0.8), ...f2(1), ...f2(1)];

  // 'A' variation data.
  const serialA = [0x03, 0x02, 0, 2, 6, 0x42, ...i16(10), ...i16(20), ...i16(30), 0x02, 0, 5, 0];
  const serialB = [0x00, 0x83, 0xc2, ...i32(-100), ...i32(-100), ...i32(-100), 0x83, 0x8a];
  const headersA = [...u16(serialA.length), ...u16(0x2000), ...u16(serialB.length), ...u16(0xe000), ...f2(-0.5), ...f2(-1), ...f2(0)];
  const dataA = pad([...u16(2), ...u16(4 + headersA.length), ...headersA, ...serialA, ...serialB]);
  // 'B' variation data (shared point numbers).
  const sharedPts = [0x01, 0x00, 0x00];
  const serialC = [0x00, 5, 0x00, 7];
  const dataB = pad([...u16(0x8001), ...u16(8), ...u16(serialC.length), ...u16(0), ...sharedPts, ...serialC]);
  const gvarHeaderLen = 20 + 7 * 2;
  const shared = f2(1);
  const endAB = u16((dataA.length + dataB.length) / 2);
  const gvar = [
    ...u16(1), ...u16(0), ...u16(1), ...u16(1), ...u32(gvarHeaderLen), ...u16(6), ...u16(0), ...u32(gvarHeaderLen + shared.length),
    ...u16(0), ...u16(0), ...u16(dataA.length / 2), ...endAB, ...endAB, ...endAB, ...endAB,
    ...shared, ...dataA, ...dataB,
  ];
  const base: Array<[string, number[]]> = [['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea], ['hmtx', hmtx], ['loca', loca], ['maxp', maxp]];
  return sfnt(variable ? [...base, ['avar', avar], ['fvar', fvar], ['gvar', gvar]] : base);
}

const anchors = (g: GlyphOutline | null): Array<Array<[number, number]>> =>
  (g?.contours ?? []).map((c) => c.points.map((p) => [p.x, p.y] as [number, number]));

function expectAnchors(g: GlyphOutline | null, want: Array<Array<[number, number]>>): void {
  const got = anchors(g);
  expect(got).toHaveLength(want.length);
  want.forEach((contour, ci) => {
    expect(got[ci]).toHaveLength(contour.length);
    contour.forEach(([x, y], pi) => {
      expect(got[ci]![pi]![0]).toBeCloseTo(x, 6);
      expect(got[ci]![pi]![1]).toBeCloseTo(y, 6);
    });
  });
}

describe('hand-built gvar face', () => {
  const font = parseFont(buildVariableTtf())!;
  const A = 65, B = 66;
  const S = 13107 / 16384; // avar(0.5) = 0.8 as F2Dot14

  it('parses the axes and keeps the default instance on the static path', () => {
    expect(font.kind).toBe('glyf');
    expect(font.axes).toEqual([{ tag: 'wght', min: 100, default: 400, max: 900 }]);
    expectAnchors(font.glyphFor(A), [[[0, 0], [100, 0], [100, 100], [0, 100]], [[200, 0], [300, 0], [250, 100]]]);
    // The variation path at the default coordinates is the static outline, exactly.
    const def = font.instance!({ wght: 400 });
    expect(def).not.toBe(font);
    expect(def.glyphFor(A)).toEqual(font.glyphFor(A));
    expect(def.glyphFor(B)).toEqual(font.glyphFor(B));
  });

  it('normalises user values through fvar and avar, clamped, as F2Dot14', () => {
    expect(font.instance!({ wght: 650 }).coords).toEqual([S]);
    expect(font.instance!({ wght: 250 }).coords).toEqual([-0.5]);
    expect(font.instance!({ wght: 5000 }).coords).toEqual([1]);
    expect(font.instance!({ wght: 0 }).coords).toEqual([-1]);
    expect(font.instance!({ wdth: 50 }).coords).toEqual([0]);
    // One instance per coordinate set.
    expect(font.instance!({ wght: 900 })).toBe(font.instance!({ wght: 900.00001 }));
  });

  it('infers untouched points (IUP) and moves the advance by the phantom points', () => {
    const at900 = font.instance!({ wght: 900 }).glyphFor(A)!;
    expectAnchors(at900, [[[10, 0], [120, 0], [120, 105], [10, 105]], [[200, 0], [300, 0], [250, 100]]]);
    expect(at900.advance).toBeCloseTo(530, 9);
    const at650 = font.instance!({ wght: 650 }).glyphFor(A)!;
    expectAnchors(at650, [
      [[10 * S, 0], [100 + 20 * S, 0], [100 + 20 * S, 100 + 5 * S], [10 * S, 100 + 5 * S]],
      [[200, 0], [300, 0], [250, 100]],
    ]);
    expect(at650.advance).toBeCloseTo(500 + 30 * S, 9);
  });

  it('applies an intermediate-region tuple with all-point zero / long delta runs', () => {
    const tri = (dx: number): Array<[number, number]> => [[200 + dx, 0], [300 + dx, 0], [250 + dx, 100]];
    const square: Array<[number, number]> = [[0, 0], [100, 0], [100, 100], [0, 100]];
    expectAnchors(font.instance!({ wght: 250 }).glyphFor(A), [square, tri(-100)]); // peak −0.5
    expectAnchors(font.instance!({ wght: 175 }).glyphFor(A), [square, tri(-50)]); // −0.75: halfway down to −1
    expectAnchors(font.instance!({ wght: 100 }).glyphFor(A), [square, tri(0)]); // −1: the region's edge
    expect(font.instance!({ wght: 250 }).glyphFor(A)!.advance).toBe(500);
  });

  it('moves a composite component by its offset delta on top of the component glyph\'s own deltas', () => {
    expectAnchors(font.glyphFor(B), [[[10, 0], [110, 0], [110, 100], [10, 100]], [[210, 0], [310, 0], [260, 100]]]);
    const b = font.instance!({ wght: 900 }).glyphFor(B)!;
    expectAnchors(b, [[[25, 7], [135, 7], [135, 112], [25, 112]], [[215, 7], [315, 7], [265, 107]]]);
    expect(b.advance).toBe(600); // sparse composite points: the phantoms stay put
  });

  it('scales a component offset only under SCALED_COMPONENT_OFFSET (static and varied)', () => {
    const C = 67, E = 69;
    const sq = (pts: Array<[number, number]>, f: (x: number, y: number) => [number, number]): Array<[number, number]> => pts.map(([x, y]) => f(x, y));
    const square: Array<[number, number]> = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const tri: Array<[number, number]> = [[200, 0], [300, 0], [250, 100]];
    const apple = (x: number, y: number): [number, number] => [1.5 * (x + 10), 1.5 * (y + 20)];
    const ms = (x: number, y: number): [number, number] => [1.5 * x + 10, 1.5 * y + 20];
    expectAnchors(font.glyphFor(C), [sq(square, apple), sq(tri, apple)]);
    expectAnchors(font.glyphFor(E), [sq(square, ms), sq(tri, ms)]);
    const heavy: Array<[number, number]> = [[10, 0], [120, 0], [120, 105], [10, 105]];
    expectAnchors(font.instance!({ wght: 900 }).glyphFor(C), [sq(heavy, apple), sq(tri, apple)]);
    expect(font.glyphFor(C)!.advance).toBe(700);
  });

  it('point-matches a component after its own variation, and advances by its USE_MY_METRICS component', () => {
    const D = 68;
    const square: Array<[number, number]> = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const tri: Array<[number, number]> = [[200, 0], [300, 0], [250, 100]];
    const at = (pts: Array<[number, number]>, dx: number): Array<[number, number]> => pts.map(([x, y]) => [x + dx, y]);
    // Static: compound point 1 is (100, 0); component point 0 is (0, 0).
    const d = font.glyphFor(D)!;
    expectAnchors(d, [square, tri, at(square, 100), at(tri, 100)]);
    // Static: the composite's own hmtx, as Chromium draws it.
    expect(d.advance).toBe(999);
    // wght 900: compound point 1 is (120, 0) and the component's point 0 is
    // (10, 0), so the second 'A' moves by 110 — and with no HVAR the advance is
    // the USE_MY_METRICS component's phantom points: A's 530.
    const heavy: Array<[number, number]> = [[10, 0], [120, 0], [120, 105], [10, 105]];
    const d900 = font.instance!({ wght: 900 }).glyphFor(D)!;
    expectAnchors(d900, [heavy, tri, at(heavy, 110), at(tri, 110)]);
    expect(d900.advance).toBeCloseTo(530, 9);
  });

  it('a static face instances to itself and ignores axes', () => {
    const u = parseFont(buildVariableTtf(false))!;
    expect(u.axes).toBeUndefined();
    expect(u.instance!({ wght: 900 })).toBe(u);
    expect(u.glyphFor(A)).toEqual(font.glyphFor(A));
  });
});

describe('iupContour', () => {
  it('interpolates between touched neighbours, clamps outside them, and copies a lone reference', () => {
    const orig = [0, 50, 100, 150, 50];
    const d = new Float64Array([10, 0, 30, 0, 0]);
    iupContour(orig, d, new Uint8Array([1, 0, 1, 0, 0]), 0, 4);
    expect([...d]).toEqual([10, 20, 30, 30, 20]);
    const one = new Float64Array([0, 7, 0]);
    iupContour([1, 2, 3], one, new Uint8Array([0, 1, 0]), 0, 2);
    expect([...one]).toEqual([7, 7, 7]);
    // Touched references at the same coordinate with different deltas → 0.
    const same = new Float64Array([4, 0, 9]);
    iupContour([5, 1, 5], same, new Uint8Array([1, 0, 1]), 0, 2);
    expect([...same]).toEqual([4, 0, 9]);
  });
});

// ── real fonts vs fontTools ──────────────────────────────────────────

type RefSeg = ['M' | 'L', number, number] | ['C', number, number, number, number, number, number];
interface RefGlyph { advance: number; contours: RefSeg[][] }
type RefSet = Record<string, Record<string, RefGlyph>>;

const FIXTURES = join(__dirname, '__fixtures__', 'variable');

function loadFont(file: string): ParsedFont {
  const b = readFileSync(file);
  return parseFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)!;
}

const STEPS = 8;
function sampleOutline(g: GlyphOutline): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const c of g.contours) {
    const p = c.points;
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!, b = p[(i + 1) % p.length]!;
      for (let k = 0; k <= STEPS; k++) {
        const t = k / STEPS, u = 1 - t;
        out.push([
          u * u * u * a.x + 3 * u * u * t * a.outX + 3 * u * t * t * b.inX + t * t * t * b.x,
          u * u * u * a.y + 3 * u * u * t * a.outY + 3 * u * t * t * b.inY + t * t * t * b.y,
        ]);
      }
    }
  }
  return out;
}

function sampleRef(g: RefGlyph): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const seg = (p0: number[], c1: number[], c2: number[], p3: number[]): void => {
    for (let k = 0; k <= STEPS; k++) {
      const t = k / STEPS, u = 1 - t;
      out.push([
        u * u * u * p0[0]! + 3 * u * u * t * c1[0]! + 3 * u * t * t * c2[0]! + t * t * t * p3[0]!,
        u * u * u * p0[1]! + 3 * u * u * t * c1[1]! + 3 * u * t * t * c2[1]! + t * t * t * p3[1]!,
      ]);
    }
  };
  for (const c of g.contours) {
    let cur: number[] = [0, 0], start: number[] = [0, 0];
    for (const s of c) {
      if (s[0] === 'M') { cur = [s[1], s[2]]; start = cur; }
      else if (s[0] === 'L') { const n = [s[1], s[2]]; seg(cur, cur, n, n); cur = n; }
      else { const c6 = s as ['C', number, number, number, number, number, number]; const n = [c6[5], c6[6]]; seg(cur, [c6[1], c6[2]], [c6[3], c6[4]], n); cur = n; }
    }
    seg(cur, cur, start, start);
  }
  return out;
}

/** Symmetric Hausdorff distance between two sampled outlines, font units. */
function hausdorff(a: Array<[number, number]>, b: Array<[number, number]>): number {
  const one = (p: Array<[number, number]>, q: Array<[number, number]>): number => {
    let worst = 0;
    for (const [x, y] of p) {
      let best = Infinity;
      for (const [u, v] of q) best = Math.min(best, (x - u) ** 2 + (y - v) ** 2);
      worst = Math.max(worst, best);
    }
    return Math.sqrt(worst);
  };
  return Math.max(one(a, b), one(b, a));
}

/** Ink area of an outline (sum of contour signed areas; holes subtract). */
function inkArea(g: GlyphOutline): number {
  const pts = (c: { points: ReadonlyArray<{ x: number; y: number }> }): number => {
    let s = 0;
    for (let i = 0; i < c.points.length; i++) {
      const p = c.points[i]!, q = c.points[(i + 1) % c.points.length]!;
      s += p.x * q.y - q.x * p.y;
    }
    return s / 2;
  };
  return Math.abs(g.contours.reduce((s, c) => s + pts(c), 0));
}

const REFERENCE = JSON.parse(readFileSync(join(FIXTURES, 'variableFontReference.json'), 'utf8')) as Record<string, { instancer: RefSet; location: RefSet }>;

describe.each([
  ['Oswald', 'Oswald[wght].ttf', 'glyf', 400, 700],
  ['SourceSans3VF', 'SourceSans3VF-Upright.otf', 'cff2', 200, 900],
] as const)('real variable face %s', (name, file, kind, defaultWght, maxWght) => {
  const font = loadFont(join(FIXTURES, file));
  const ref = REFERENCE[name]!;

  it('parses as a variable face of the expected format', () => {
    expect(font.kind).toBe(kind);
    expect(font.axes!.map((a) => a.tag)).toEqual(['wght']);
  });

  it('matches fontTools at the masters (instancer) to 0.02 units, advances exactly', () => {
    for (const w of Object.keys(ref.instancer).filter((k) => Number(k) === font.axes![0]!.min || Number(k) === font.axes![0]!.max || Number(k) === defaultWght)) {
      const inst = font.instance!({ wght: Number(w) });
      for (const [ch, g] of Object.entries(ref.instancer[w]!)) {
        const ours = inst.glyphFor(ch.codePointAt(0)!)!;
        expect([name, w, ch, hausdorff(sampleOutline(ours), sampleRef(g)) <= 0.02]).toEqual([name, w, ch, true]);
        expect([name, w, ch, Math.round(ours.advance)]).toEqual([name, w, ch, g.advance]);
      }
    }
  });

  it('matches fontTools between masters: unrounded to 0.02 units, and the rounded instancer within its rounding', () => {
    for (const [w, glyphs] of Object.entries(ref.location)) {
      const inst = font.instance!({ wght: Number(w) });
      for (const [ch, g] of Object.entries(glyphs)) {
        const ours = inst.glyphFor(ch.codePointAt(0)!)!;
        expect([w, ch, hausdorff(sampleOutline(ours), sampleRef(g)) <= 0.02]).toEqual([w, ch, true]);
        expect(Math.abs(ours.advance - g.advance)).toBeLessThan(0.02);
      }
    }
    if (kind === 'glyf') {
      // gvar instancing rounds each point once, so a point is within ½ unit
      // (a composite's rounded offset plus its rounded points: 1 unit).
      for (const [w, glyphs] of Object.entries(ref.instancer)) {
        const inst = font.instance!({ wght: Number(w) });
        for (const [ch, g] of Object.entries(glyphs)) {
          const ours = inst.glyphFor(ch.codePointAt(0)!)!;
          expect([w, ch, hausdorff(sampleOutline(ours), sampleRef(g)) <= 1.2]).toEqual([w, ch, true]);
          expect(Math.abs(ours.advance - g.advance)).toBeLessThanOrEqual(0.5);
        }
      }
    }
  });

  it('every on-curve point of the fontTools instance is an anchor of ours', () => {
    const w = String(maxWght);
    const inst = font.instance!({ wght: maxWght });
    for (const [ch, g] of Object.entries(ref.instancer[w]!)) {
      const ours = anchors(inst.glyphFor(ch.codePointAt(0)!));
      for (const contour of g.contours) {
        for (const s of contour) {
          const [x, y] = s[0] === 'C' ? [s[5], s[6]] : [s[1], s[2]];
          const near = ours.some((c) => c.some(([u, v]) => Math.abs(u - x) < 0.02 && Math.abs(v - y) < 0.02));
          expect([ch, x, y, near]).toEqual([ch, x, y, true]);
        }
      }
    }
  });

  it('the heaviest instance is bolder and wider than the default', () => {
    const def = font.instance!({ wght: defaultWght });
    const heavy = font.instance!({ wght: maxWght });
    for (const ch of ['n', 'o', 'A']) {
      const d = def.glyphFor(ch.codePointAt(0)!)!, h = heavy.glyphFor(ch.codePointAt(0)!)!;
      expect(inkArea(h)).toBeGreaterThan(inkArea(d) * 1.2);
      expect(h.advance).toBeGreaterThan(d.advance);
    }
  });
});

describe('Oswald avar and HVAR', () => {
  const font = loadFont(join(FIXTURES, 'Oswald[wght].ttf'));
  it('maps wght 550 (0.5 before avar) through the segment map', () => {
    // avar: 0.33331 → 0.51611, 0.66669 → 0.78711.
    expect(font.instance!({ wght: 550 }).coords![0]).toBeCloseTo(0.51611 + ((0.5 - 0.333313) * (0.787109 - 0.516113)) / (0.666687 - 0.333313), 4);
    expect(font.instance!({ wght: 300 }).coords![0]).toBeCloseTo(-0.625, 4);
  });
});

describe('composite component flags on real glyph data vs fontTools', () => {
  // OswaldCompositeTest.ttf: Oswald[wght] (OFL) subset and renamed, its
  // composites rewritten — accents point-matched, components scaled with and
  // without SCALED_COMPONENT_OFFSET (uniform and 2×2), USE_MY_METRICS on 'É'
  // with its hmtx advance pushed off by 123. No font installed on the dev box
  // uses the first two. The reference is fontTools' Glyph.getCoordinates (the
  // path that resolves point matching and scaled offsets) for the default
  // instance and varLib.instancer instances at wght 200 / 700.
  const font = loadFont(join(FIXTURES, 'OswaldCompositeTest.ttf'));
  const ref = JSON.parse(readFileSync(join(FIXTURES, 'compositeReference.json'), 'utf8')) as
    { changed: Record<string, string> } & Record<string, Record<string, RefGlyph & { kind: string }>>;

  it('covers every flag it claims to', () => {
    expect(new Set(Object.values(ref.changed))).toEqual(new Set(['pointMatched', 'apple', 'ms', 'apple2x2', 'ms2x2', 'useMyMetrics']));
  });

  it.each(['default', '200', '700'])('outlines match at %s (unrounded default to 0.01; instancer within its rounding)', (at) => {
    const face = at === 'default' ? font : font.instance!({ wght: Number(at) });
    const tol = at === 'default' ? 0.01 : 1.2;
    for (const [ch, g] of Object.entries(ref[at]!)) {
      const ours = face.glyphFor(ch.codePointAt(0)!)!;
      expect([at, ch, g.kind, ours.contours.length]).toEqual([at, ch, g.kind, g.contours.length]);
      expect([at, ch, g.kind, hausdorff(sampleOutline(ours), sampleRef(g)) <= tol]).toEqual([at, ch, g.kind, true]);
      // USE_MY_METRICS on 'É': static hmtx (and HVAR, which this font has) keep
      // the composite's own advance — Chromium's, and fontTools'.
      expect([at, ch, Math.abs(ours.advance - g.advance) <= (at === 'default' ? 0 : 0.5)]).toEqual([at, ch, true]);
    }
    if (at === 'default') expect(ref.default!['É']!.advance).toBe(ref.default!.E!.advance + 123);
  });
});

// ── scratch references (skipped where absent) ────────────────────────

const SCRATCH = process.env.VF_REFERENCE_DIR
  ?? 'C:/Users/isroi/AppData/Local/Temp/claude/C--Users-isroi-dev-motion-editor/1b0d8216-d3dc-4fbd-8004-a601dbe54e6d/scratchpad/vf';

describe('more variable fonts vs fontTools (scratch copies)', () => {
  const multi = join(SCRATCH, 'multiReference.json');
  const present = existsSync(multi);
  (present ? it : it.skip)('Roboto Flex (13 axes, avar), Quicksand, Lexend, Jost, Source Sans 3 Italic at arbitrary locations', () => {
    const data = JSON.parse(readFileSync(multi, 'utf8')) as Record<string, Array<{ loc: Record<string, number>; glyphs: Record<string, RefGlyph> }>>;
    for (const [file, locs] of Object.entries(data)) {
      const font = loadFont(join(SCRATCH, file));
      for (const { loc, glyphs } of locs) {
        const inst = font.instance!(loc);
        for (const [ch, g] of Object.entries(glyphs)) {
          const ours = inst.glyphFor(ch.codePointAt(0)!)!;
          expect([file, loc, ch, hausdorff(sampleOutline(ours), sampleRef(g)) <= 0.02]).toEqual([file, loc, ch, true]);
          expect([file, ch, Math.abs(ours.advance - g.advance) < 0.02]).toEqual([file, ch, true]);
        }
      }
    }
  });

  const inst = join(SCRATCH, 'inst');
  (existsSync(inst) ? it : it.skip)('instanced outlines equal the instancer\'s static fonts read through the static glyf / CFF paths', () => {
    const cases: Array<[string, string, number, number]> = [
      ['Oswald[wght].ttf', 'Oswald-wght700.ttf', 700, 0.01],
      ['Oswald[wght].ttf', 'Oswald-wght400.ttf', 400, 0.01],
      ['Oswald[wght].ttf', 'Oswald-wght550.ttf', 550, 1.2],
      ['SourceSans3VF-Upright.otf', 'SS3-wght200.otf', 200, 0.01],
      ['SourceSans3VF-Upright.otf', 'SS3-wght900.otf', 900, 0.01],
    ];
    for (const [vf, stat, wght, tol] of cases) {
      const v = loadFont(join(FIXTURES, vf)).instance!({ wght });
      const s = loadFont(join(inst, stat));
      expect(s.axes ?? []).toHaveLength(0);
      for (const ch of 'AVTonxHOg.W\u00c1') {
        const a = v.glyphFor(ch.codePointAt(0)!)!, b = s.glyphFor(ch.codePointAt(0)!)!;
        expect([stat, ch, a.contours.length]).toEqual([stat, ch, b.contours.length]);
        expect([stat, ch, hausdorff(sampleOutline(a), sampleOutline(b)) <= tol]).toEqual([stat, ch, true]);
      }
    }
  });
});
