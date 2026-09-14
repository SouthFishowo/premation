/**
 * OpenType font VARIATIONS — the tables that turn a variable font's default
 * outlines into any instance on its design axes (OpenType 1.9).
 *
 *   • `fvar` axes and the `avar` axis maps (v1 segment maps, v2 variation
 *     store) → NORMALISED coordinates, one per axis in [-1, 1].
 *   • The ItemVariationStore (with its DeltaSetIndexMap) shared by `HVAR`,
 *     `avar` v2 and `CFF2`: region scalars and per-item deltas.
 *   • `gvar`: per-glyph tuple variations — shared / embedded peaks,
 *     intermediate regions, shared and private packed point numbers, packed
 *     deltas (zero / byte / word / long runs), and Interpolate Untouched
 *     Points for sparse deltas on simple glyphs. A composite's "points" are its
 *     component offsets; the four phantom points carry the metrics deltas.
 *
 * Pure readers over a DataView, in the style of openType.ts: nothing is
 * decoded until a glyph asks for it, and nothing here knows about outlines —
 * openType.ts applies the deltas. Hinting variation (`cvar`) is not read: the
 * outlines serve shapes and ink profiles, never a hinted raster.
 */

export interface TableRec { offset: number; length: number }

/** One design axis as `fvar` declares it (user-space values). */
export interface VariationAxis { tag: string; min: number; default: number; max: number }

const F2DOT14 = 16384;
const toF2Dot14 = (v: number): number => Math.round(v * F2DOT14) / F2DOT14;

// ── fvar ─────────────────────────────────────────────────────────────

export function readFvarAxes(view: DataView, fvar: TableRec): VariationAxis[] {
  const base = fvar.offset;
  if (base + 16 > view.byteLength) return [];
  const axesAt = base + view.getUint16(base + 4);
  const count = view.getUint16(base + 8);
  const size = view.getUint16(base + 10);
  if (size < 20) return [];
  const out: VariationAxis[] = [];
  for (let i = 0; i < count; i++) {
    const at = axesAt + i * size;
    if (at + 20 > view.byteLength) break;
    const tag = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    out.push({
      tag,
      min: view.getInt32(at + 4) / 65536,
      default: view.getInt32(at + 8) / 65536,
      max: view.getInt32(at + 12) / 65536,
    });
  }
  return out;
}

// ── ItemVariationStore ───────────────────────────────────────────────

export interface ItemVariationStore {
  /** Regions an ItemVariationData subtable references (CFF2 `blend`'s k). */
  regionCount(dataIndex: number): number;
  /** Scalars of those regions at `coords`, in the subtable's region order. */
  scalars(dataIndex: number, coords: ReadonlyArray<number>): Float64Array;
  /** The interpolated delta of item (outer, inner) at `coords`. */
  delta(outer: number, inner: number, coords: ReadonlyArray<number>): number;
}

interface VarData {
  itemCount: number;
  wordCount: number;
  longWords: boolean;
  regionIndexes: number[];
  rowsAt: number;
  rowSize: number;
}

export function readItemVariationStore(view: DataView, at: number): ItemVariationStore | null {
  if (at + 8 > view.byteLength || view.getUint16(at) !== 1) return null;
  const regionList = at + view.getUint32(at + 2);
  const dataCount = view.getUint16(at + 6);
  const axisCount = view.getUint16(regionList);
  const regionCountAll = view.getUint16(regionList + 2);
  const data: Array<VarData | null> = [];
  for (let i = 0; i < dataCount; i++) {
    const off = view.getUint32(at + 8 + i * 4);
    if (!off) { data.push(null); continue; }
    const d = at + off;
    const itemCount = view.getUint16(d);
    const wdc = view.getUint16(d + 2);
    const regionIndexCount = view.getUint16(d + 4);
    const regionIndexes: number[] = [];
    for (let r = 0; r < regionIndexCount; r++) regionIndexes.push(view.getUint16(d + 6 + r * 2));
    const longWords = (wdc & 0x8000) !== 0;
    const wordCount = wdc & 0x7fff;
    const rowSize = longWords
      ? wordCount * 4 + (regionIndexCount - wordCount) * 2
      : wordCount * 2 + (regionIndexCount - wordCount);
    data.push({ itemCount, wordCount, longWords, regionIndexes, rowsAt: d + 6 + regionIndexCount * 2, rowSize });
  }

  /** Scalar of one region (VariationRegionList) at the coordinates. */
  const regionScalar = (r: number, coords: ReadonlyArray<number>): number => {
    if (r >= regionCountAll) return 0;
    let scalar = 1;
    for (let a = 0; a < axisCount; a++) {
      const rec = regionList + 4 + (r * axisCount + a) * 6;
      const start = view.getInt16(rec) / F2DOT14;
      const peak = view.getInt16(rec + 2) / F2DOT14;
      const end = view.getInt16(rec + 4) / F2DOT14;
      const f = axisScalar(coords[a] ?? 0, start, peak, end);
      if (f === 0) return 0;
      scalar *= f;
    }
    return scalar;
  };

  // One coordinate set is live at a time (an instance); remember its scalars.
  let lastKey = '';
  let lastRegion: Float64Array = new Float64Array(0);
  const perData = new Map<number, Float64Array>();
  const regionScalars = (coords: ReadonlyArray<number>): Float64Array => {
    const key = coords.join(',');
    if (key !== lastKey || lastRegion.length !== regionCountAll) {
      lastKey = key;
      lastRegion = new Float64Array(regionCountAll);
      for (let r = 0; r < regionCountAll; r++) lastRegion[r] = regionScalar(r, coords);
      perData.clear();
    }
    return lastRegion;
  };

  const scalars = (dataIndex: number, coords: ReadonlyArray<number>): Float64Array => {
    const all = regionScalars(coords);
    const hit = perData.get(dataIndex);
    if (hit) return hit;
    const d = data[dataIndex];
    const out = new Float64Array(d ? d.regionIndexes.length : 0);
    if (d) for (let j = 0; j < d.regionIndexes.length; j++) out[j] = all[d.regionIndexes[j]!] ?? 0;
    perData.set(dataIndex, out);
    return out;
  };

  return {
    regionCount: (i) => data[i]?.regionIndexes.length ?? 0,
    scalars,
    delta(outer, inner, coords) {
      const d = data[outer];
      if (!d || inner >= d.itemCount) return 0;
      const sc = scalars(outer, coords);
      let p = d.rowsAt + inner * d.rowSize;
      let sum = 0;
      const n = d.regionIndexes.length;
      for (let j = 0; j < n; j++) {
        let v: number;
        if (j < d.wordCount) {
          if (d.longWords) { v = view.getInt32(p); p += 4; } else { v = view.getInt16(p); p += 2; }
        } else if (d.longWords) { v = view.getInt16(p); p += 2; }
        else { v = view.getInt8(p); p += 1; }
        const s = sc[j]!;
        if (s !== 0) sum += v * s;
      }
      return sum;
    },
  };
}

/** One axis's contribution to a region / tuple scalar (OpenType "Algorithm for interpolation"). */
function axisScalar(v: number, start: number, peak: number, end: number): number {
  if (start > peak || peak > end) return 1;
  if (start < 0 && end > 0 && peak !== 0) return 1;
  if (peak === 0) return 1;
  if (v < start || v > end) return 0;
  if (v === peak) return 1;
  return v < peak ? (v - start) / (peak - start) : (end - v) / (end - peak);
}

// ── DeltaSetIndexMap ─────────────────────────────────────────────────

export type DeltaSetIndexMap = (index: number) => [outer: number, inner: number];

export function readDeltaSetIndexMap(view: DataView, at: number): DeltaSetIndexMap {
  const format = view.getUint8(at);
  const entryFormat = view.getUint8(at + 1);
  const mapCount = format === 0 ? view.getUint16(at + 2) : view.getUint32(at + 2);
  const dataAt = at + (format === 0 ? 4 : 6);
  const entrySize = ((entryFormat & 0x30) >> 4) + 1;
  const innerBits = (entryFormat & 0x0f) + 1;
  return (index) => {
    if (mapCount === 0) return [0, index];
    const i = Math.min(index, mapCount - 1);
    let entry = 0;
    for (let k = 0; k < entrySize; k++) entry = entry * 256 + view.getUint8(dataAt + i * entrySize + k);
    return [Math.floor(entry / 2 ** innerBits), entry % 2 ** innerBits];
  };
}

// ── avar + normalisation ─────────────────────────────────────────────

/** User-space axis values → normalised coordinates, one per `fvar` axis. */
export type AxisNormalizer = (values: Readonly<Record<string, number>>) => number[];

export function makeAxisNormalizer(view: DataView, axes: ReadonlyArray<VariationAxis>, avar: TableRec | undefined): AxisNormalizer {
  let segments: Array<Array<[number, number]>> = [];
  let v2: { store: ItemVariationStore; map: DeltaSetIndexMap | null } | null = null;
  if (avar && avar.offset + 8 <= view.byteLength) {
    const major = view.getUint16(avar.offset);
    const count = view.getUint16(avar.offset + 6);
    let p = avar.offset + 8;
    for (let i = 0; i < count; i++) {
      const n = view.getUint16(p);
      p += 2;
      const map: Array<[number, number]> = [];
      for (let k = 0; k < n; k++) map.push([view.getInt16(p + k * 4) / F2DOT14, view.getInt16(p + k * 4 + 2) / F2DOT14]);
      p += n * 4;
      segments.push(map);
    }
    if (major === 2 && p + 8 <= avar.offset + avar.length) {
      const mapOff = view.getUint32(p);
      const storeOff = view.getUint32(p + 4);
      const store = storeOff ? readItemVariationStore(view, avar.offset + storeOff) : null;
      if (store) v2 = { store, map: mapOff ? readDeltaSetIndexMap(view, avar.offset + mapOff) : null };
    }
    if (segments.length !== axes.length) segments = segments.slice(0, axes.length);
  }
  return (values) => {
    const coords = axes.map((a, i) => {
      const raw = values[a.tag];
      const v = Math.max(a.min, Math.min(a.max, typeof raw === 'number' && Number.isFinite(raw) ? raw : a.default));
      let n = 0;
      if (v < a.default) n = a.default === a.min ? 0 : -(a.default - v) / (a.default - a.min);
      else if (v > a.default) n = a.max === a.default ? 0 : (v - a.default) / (a.max - a.default);
      n = toF2Dot14(n);
      const seg = segments[i];
      if (seg && seg.length > 0) n = toF2Dot14(segmentMap(seg, n));
      return n;
    });
    if (!v2) return coords;
    const base = coords.slice();
    return coords.map((c, i) => {
      const [outer, inner] = v2!.map ? v2!.map(i) : [0, i];
      const d = v2!.store.delta(outer, inner, base) / F2DOT14;
      return toF2Dot14(Math.max(-1, Math.min(1, c + d)));
    });
  };
}

/** avar v1 piecewise-linear segment map. */
function segmentMap(map: ReadonlyArray<[number, number]>, v: number): number {
  const first = map[0]!;
  if (v <= first[0]) return first[1] + (v - first[0]);
  for (let k = 1; k < map.length; k++) {
    const [fromB, toB] = map[k]!;
    if (v === fromB) return toB;
    if (v < fromB) {
      const [fromA, toA] = map[k - 1]!;
      return fromB === fromA ? toA : toA + ((v - fromA) * (toB - toA)) / (fromB - fromA);
    }
  }
  const last = map[map.length - 1]!;
  return last[1] + (v - last[0]);
}

// ── HVAR ─────────────────────────────────────────────────────────────

/** Advance-width delta of a glyph at normalised coordinates, font units. */
export type AdvanceDelta = (gid: number, coords: ReadonlyArray<number>) => number;

export function readHvar(view: DataView, hvar: TableRec): AdvanceDelta | null {
  const base = hvar.offset;
  if (base + 20 > view.byteLength) return null;
  const store = readItemVariationStore(view, base + view.getUint32(base + 4));
  if (!store) return null;
  const mapOff = view.getUint32(base + 8);
  const map = mapOff ? readDeltaSetIndexMap(view, base + mapOff) : null;
  return (gid, coords) => {
    const [outer, inner] = map ? map(gid) : [0, gid];
    return store.delta(outer, inner, coords);
  };
}

// ── gvar ─────────────────────────────────────────────────────────────

export interface PointDeltas { dx: Float64Array; dy: Float64Array }

export interface GvarReader {
  /**
   * Summed deltas for a glyph's `pointCount` points — its outline points (or,
   * for a composite, one per component) followed by the four phantom points —
   * at normalised `coords`. `endPts` are a simple glyph's contour ends, which
   * enable IUP for sparse tuples; null for a composite (no inference). Null
   * when the glyph has no variation data or no tuple applies.
   */
  deltas(
    gid: number,
    coords: ReadonlyArray<number>,
    pointCount: number,
    origX: ArrayLike<number>,
    origY: ArrayLike<number>,
    endPts: ReadonlyArray<number> | null,
  ): PointDeltas | null;
}

export function readGvar(view: DataView, gvar: TableRec): GvarReader | null {
  const base = gvar.offset;
  if (base + 20 > view.byteLength) return null;
  const axisCount = view.getUint16(base + 4);
  const sharedTupleCount = view.getUint16(base + 6);
  const sharedAt = base + view.getUint32(base + 8);
  const glyphCount = view.getUint16(base + 12);
  const longOffsets = (view.getUint16(base + 14) & 1) !== 0;
  const dataArray = base + view.getUint32(base + 16);
  const offsetAt = (g: number): number => longOffsets ? view.getUint32(base + 20 + g * 4) : view.getUint16(base + 20 + g * 2) * 2;

  /** Packed point numbers → sorted-as-stored list, or null for "all points". */
  const readPoints = (p: number): { points: Uint16Array | null; end: number } => {
    let count = view.getUint8(p++);
    if (count === 0) return { points: null, end: p };
    if (count & 0x80) count = ((count & 0x7f) << 8) | view.getUint8(p++);
    const points = new Uint16Array(count);
    let i = 0;
    let last = 0;
    while (i < count) {
      const control = view.getUint8(p++);
      const words = (control & 0x80) !== 0;
      const run = (control & 0x7f) + 1;
      for (let k = 0; k < run && i < count; k++) {
        if (words) { last += view.getUint16(p); p += 2; } else { last += view.getUint8(p); p += 1; }
        points[i++] = last & 0xffff;
      }
    }
    return { points, end: p };
  };

  /** Packed deltas, `n` of them. */
  const readDeltas = (p: number, n: number): { values: Float64Array; end: number } => {
    const values = new Float64Array(n);
    let i = 0;
    while (i < n) {
      const control = view.getUint8(p++);
      const run = (control & 0x3f) + 1;
      const kind = control & 0xc0;
      for (let k = 0; k < run && i < n; k++) {
        if (kind === 0x80) values[i++] = 0;
        else if (kind === 0xc0) { values[i++] = view.getInt32(p); p += 4; }
        else if (kind === 0x40) { values[i++] = view.getInt16(p); p += 2; }
        else { values[i++] = view.getInt8(p); p += 1; }
      }
    }
    return { values, end: p };
  };

  return {
    deltas(gid, coords, pointCount, origX, origY, endPts) {
      if (gid < 0 || gid >= glyphCount) return null;
      const start = dataArray + offsetAt(gid);
      const end = dataArray + offsetAt(gid + 1);
      if (end <= start) return null;
      const tvc = view.getUint16(start);
      const tupleCount = tvc & 0x0fff;
      let serial = start + view.getUint16(start + 2);
      let shared: Uint16Array | null = null;
      if (tvc & 0x8000) {
        const r = readPoints(serial);
        shared = r.points;
        serial = r.end;
      }
      const dx = new Float64Array(pointCount);
      const dy = new Float64Array(pointCount);
      let applied = false;
      let hdr = start + 4;
      const peak = new Float64Array(axisCount);
      const lo = new Float64Array(axisCount);
      const hi = new Float64Array(axisCount);
      for (let t = 0; t < tupleCount; t++) {
        const dataSize = view.getUint16(hdr);
        const tupleIndex = view.getUint16(hdr + 2);
        hdr += 4;
        if (tupleIndex & 0x8000) {
          for (let a = 0; a < axisCount; a++) peak[a] = view.getInt16(hdr + a * 2) / F2DOT14;
          hdr += axisCount * 2;
        } else {
          const si = tupleIndex & 0x0fff;
          if (si >= sharedTupleCount) { serial += dataSize; continue; }
          for (let a = 0; a < axisCount; a++) peak[a] = view.getInt16(sharedAt + (si * axisCount + a) * 2) / F2DOT14;
        }
        const intermediate = (tupleIndex & 0x4000) !== 0;
        if (intermediate) {
          for (let a = 0; a < axisCount; a++) {
            lo[a] = view.getInt16(hdr + a * 2) / F2DOT14;
            hi[a] = view.getInt16(hdr + (axisCount + a) * 2) / F2DOT14;
          }
          hdr += axisCount * 4;
        }
        const dataAt = serial;
        serial += dataSize;

        let scalar = 1;
        for (let a = 0; a < axisCount && scalar !== 0; a++) {
          const pk = peak[a]!;
          if (pk === 0) continue;
          const v = coords[a] ?? 0;
          if (v === pk) continue;
          if (intermediate) {
            const s = lo[a]!, e = hi[a]!;
            if (s > pk || pk > e || (s < 0 && e > 0)) continue;
            if (v < s || v > e) { scalar = 0; break; }
            scalar *= v < pk ? (v - s) / (pk - s) : (e - v) / (e - pk);
          } else {
            if (v === 0 || v < Math.min(0, pk) || v > Math.max(0, pk)) { scalar = 0; break; }
            scalar *= v / pk;
          }
        }
        if (scalar === 0) continue;

        let p = dataAt;
        let points = shared;
        if (tupleIndex & 0x2000) {
          const r = readPoints(p);
          points = r.points;
          p = r.end;
        }
        const n = points ? points.length : pointCount;
        const xs = readDeltas(p, n);
        const ys = readDeltas(xs.end, n);
        applied = true;
        if (!points) {
          for (let i = 0; i < Math.min(n, pointCount); i++) {
            dx[i] = dx[i]! + xs.values[i]! * scalar;
            dy[i] = dy[i]! + ys.values[i]! * scalar;
          }
          continue;
        }
        if (!endPts) {
          for (let k = 0; k < n; k++) {
            const idx = points[k]!;
            if (idx >= pointCount) continue;
            dx[idx] = dx[idx]! + xs.values[k]! * scalar;
            dy[idx] = dy[idx]! + ys.values[k]! * scalar;
          }
          continue;
        }
        // Sparse deltas on a simple glyph: infer the untouched points.
        const tx = new Float64Array(pointCount);
        const ty = new Float64Array(pointCount);
        const touched = new Uint8Array(pointCount);
        for (let k = 0; k < n; k++) {
          const idx = points[k]!;
          if (idx >= pointCount) continue;
          tx[idx] = xs.values[k]!;
          ty[idx] = ys.values[k]!;
          touched[idx] = 1;
        }
        let s = 0;
        for (const e of endPts) {
          iupContour(origX, tx, touched, s, e);
          iupContour(origY, ty, touched, s, e);
          s = e + 1;
        }
        for (let i = 0; i < pointCount; i++) {
          dx[i] = dx[i]! + tx[i]! * scalar;
          dy[i] = dy[i]! + ty[i]! * scalar;
        }
      }
      return applied ? { dx, dy } : null;
    },
  };
}

/**
 * Interpolate Untouched Points along one axis of one contour (points
 * `start..end` inclusive): each untouched run takes the deltas of the touched
 * points either side of it, linearly by original coordinate between them and
 * clamped outside.
 */
export function iupContour(orig: ArrayLike<number>, deltas: Float64Array, touched: Uint8Array, start: number, end: number): void {
  const ref: number[] = [];
  for (let i = start; i <= end; i++) if (touched[i]) ref.push(i);
  if (ref.length === 0) return;
  if (ref.length === 1) {
    const d = deltas[ref[0]!]!;
    for (let i = start; i <= end; i++) if (!touched[i]) deltas[i] = d;
    return;
  }
  const len = end - start + 1;
  for (let r = 0; r < ref.length; r++) {
    const p1 = ref[r]!;
    const p2 = ref[(r + 1) % ref.length]!;
    let i = p1 + 1 > end ? start : p1 + 1;
    let a = orig[p1]!, b = orig[p2]!;
    let da = deltas[p1]!, db = deltas[p2]!;
    if (a > b) { [a, b] = [b, a]; [da, db] = [db, da]; }
    for (let guard = 0; i !== p2 && guard < len; guard++) {
      const v = orig[i]!;
      let d: number;
      if (a === b) d = da === db ? da : 0;
      else if (v <= a) d = da;
      else if (v >= b) d = db;
      else d = da + ((v - a) * (db - da)) / (b - a);
      deltas[i] = d;
      i = i + 1 > end ? start : i + 1;
    }
  }
}
