/**
 * A tiny hand-built sfnt (cmap + GSUB + name) for the GSUB `vert` reader's
 * tests — no font files in the repo, every byte explained here.
 *
 * Code points → glyphs: A→4, U+3001→1, U+300C→2, U+30FC→5, U+6F22→3.
 */

export const u16 = (v: number): number[] => [(v >> 8) & 255, v & 255];
export const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const tag = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

export const CMAP: ReadonlyArray<[number, number]> = [[0x41, 4], [0x3001, 1], [0x300c, 2], [0x30fc, 5], [0x6f22, 3]];

/** cmap with one format-4 subtable (platform 3, encoding 1), one segment per code point. */
export function cmapTable(pairs: ReadonlyArray<[number, number]> = CMAP): number[] {
  const segs = [...pairs].sort((a, b) => a[0] - b[0]);
  const n = segs.length + 1;
  const ends = [...segs.map(([cp]) => cp), 0xffff];
  const starts = [...segs.map(([cp]) => cp), 0xffff];
  const deltas = [...segs.map(([cp, gid]) => (gid - cp) & 0xffff), 1];
  const sub = [
    ...u16(4), ...u16(16 + n * 8), ...u16(0), ...u16(n * 2), ...u16(0), ...u16(0), ...u16(0),
    ...ends.flatMap(u16), ...u16(0), ...starts.flatMap(u16), ...deltas.flatMap(u16), ...ends.map(() => 0).flatMap(u16),
  ];
  return [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub];
}

export const coverage1 = (glyphs: number[]): number[] => [...u16(1), ...u16(glyphs.length), ...glyphs.flatMap(u16)];
export const coverage2 = (ranges: Array<[number, number, number]>): number[] =>
  [...u16(2), ...u16(ranges.length), ...ranges.flatMap(([s, e, i]) => [...u16(s), ...u16(e), ...u16(i)])];
export const singleFmt1 = (cov: number[], delta: number): number[] => [...u16(1), ...u16(6), ...u16(delta & 0xffff), ...cov];
export const singleFmt2 = (cov: number[], subs: number[]): number[] =>
  [...u16(2), ...u16(6 + subs.length * 2), ...u16(subs.length), ...subs.flatMap(u16), ...cov];
export const extension = (type: number, sub: number[]): number[] => [...u16(1), ...u16(type), ...u32(8), ...sub];

/** An offset-list container: count, 16-bit offsets, then the items. */
function offsetList(items: number[][], header: number[] = []): number[] {
  let at = header.length + 2 + items.length * 2;
  const offs: number[] = [];
  for (const it of items) { offs.push(at); at += it.length; }
  return [...header, ...u16(items.length), ...offs.flatMap(u16), ...items.flat()];
}

export const lookup = (type: number, subtables: number[][]): number[] => offsetList(subtables, [...u16(type), ...u16(0)]);

export interface GsubSpec {
  /** Feature records in order: tag + lookup indices. */
  features: Array<{ tag: string; lookups: number[] }>;
  /** Feature indices the DFLT default LangSys references. */
  referenced: number[];
  lookups: number[][];
  version?: 0x00010000 | 0x00010001;
}

export function gsubTable(spec: GsubSpec): number[] {
  const langSys = [...u16(0), ...u16(0xffff), ...u16(spec.referenced.length), ...spec.referenced.flatMap(u16)];
  const script = [...u16(4), ...u16(0), ...langSys];
  const scriptList = [...u16(1), ...tag('DFLT'), ...u16(8), ...script];
  const feats = spec.features.map((f) => [...u16(0), ...u16(f.lookups.length), ...f.lookups.flatMap(u16)]);
  let at = 2 + feats.length * 6;
  const recs: number[] = [];
  spec.features.forEach((f, i) => { recs.push(...tag(f.tag), ...u16(at)); at += feats[i]!.length; });
  const featureList = [...u16(feats.length), ...recs, ...feats.flat()];
  const lookupList = offsetList(spec.lookups);
  const v11 = spec.version === 0x00010001;
  const head = v11 ? 14 : 10;
  return [
    ...u32(spec.version ?? 0x00010000), ...u16(head), ...u16(head + scriptList.length), ...u16(head + scriptList.length + featureList.length),
    ...(v11 ? u32(0) : []),
    ...scriptList, ...featureList, ...lookupList,
  ];
}

/** name table: family (1), full (4), PostScript (6), Windows English, UTF-16BE. */
export function nameTable(family: string, postscript: string): number[] {
  const recs: Array<[number, string]> = [[1, family], [4, `${family} Regular`], [6, postscript]];
  const strings: number[] = [];
  const records: number[] = [];
  for (const [id, s] of recs) {
    const bytes = [...s].flatMap((c) => u16(c.charCodeAt(0)));
    records.push(...u16(3), ...u16(1), ...u16(0x409), ...u16(id), ...u16(bytes.length), ...u16(strings.length));
    strings.push(...bytes);
  }
  return [...u16(0), ...u16(recs.length), ...u16(6 + records.length), ...records, ...strings];
}

const pad4 = (a: number[]): number[] => [...a, ...new Array<number>((4 - (a.length % 4)) % 4).fill(0)];

/** A plain sfnt from tables. */
export function sfnt(tables: Record<string, number[]>): ArrayBuffer {
  const entries = Object.entries(tables);
  let at = 12 + entries.length * 16;
  const dir: number[] = [];
  const data: number[] = [];
  for (const [t, bytes] of entries) {
    dir.push(...tag(t), ...u32(0), ...u32(at), ...u32(bytes.length));
    const padded = pad4(bytes);
    data.push(...padded);
    at += padded.length;
  }
  return new Uint8Array([...u32(0x00010000), ...u16(entries.length), ...u16(0), ...u16(0), ...u16(0), ...dir, ...data]).buffer;
}

/** A TrueType collection: each face gets its own directory, tables are not shared. */
export function ttc(faces: Array<Record<string, number[]>>): ArrayBuffer {
  const headerLen = 12 + faces.length * 4;
  const dirLens = faces.map((f) => 12 + Object.keys(f).length * 16);
  let at = headerLen + dirLens.reduce((s, n) => s + n, 0);
  const dirs: number[] = [];
  const data: number[] = [];
  const dirOffsets: number[] = [];
  let dirAt = headerLen;
  faces.forEach((f, i) => {
    dirOffsets.push(dirAt);
    dirAt += dirLens[i]!;
    const entries = Object.entries(f);
    dirs.push(...u32(0x00010000), ...u16(entries.length), ...u16(0), ...u16(0), ...u16(0));
    for (const [t, bytes] of entries) {
      dirs.push(...tag(t), ...u32(0), ...u32(at), ...u32(bytes.length));
      const padded = pad4(bytes);
      data.push(...padded);
      at += padded.length;
    }
  });
  return new Uint8Array([...tag('ttcf'), ...u32(0x00010000), ...u32(faces.length), ...dirOffsets.flatMap(u32), ...dirs, ...data]).buffer;
}

/**
 * The standard test GSUB:
 *   feature 0 'vert' → lookups 0, 1 (referenced)
 *   feature 1 'vrt2' → lookup 2      (referenced)
 *   feature 2 'vert' → lookup 3      (NOT referenced by any LangSys — ignored)
 *   L0 type 1 fmt 2: 1→10, 2→11
 *   L1 type 7 → type 1 fmt 1 (+100) over glyphs 5 and 10 — so 1→10→110 chains
 *   L2 type 1 fmt 2: 4→20 (pre-rotated A), 2→12
 *   L3 type 1 fmt 2: 4→30
 */
export function standardGsub(version?: 0x00010000 | 0x00010001): number[] {
  return gsubTable({
    features: [{ tag: 'vert', lookups: [0, 1] }, { tag: 'vrt2', lookups: [2] }, { tag: 'vert', lookups: [3] }],
    referenced: [0, 1],
    lookups: [
      lookup(1, [singleFmt2(coverage1([1, 2]), [10, 11])]),
      lookup(7, [extension(1, singleFmt1(coverage2([[5, 5, 0], [10, 10, 1]]), 100))]),
      lookup(1, [singleFmt2(coverage1([2, 4]), [12, 20])]),
      lookup(1, [singleFmt2(coverage1([4]), [30])]),
    ],
    ...(version ? { version } : {}),
  });
}
