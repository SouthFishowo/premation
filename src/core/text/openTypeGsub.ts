/**
 * Which characters a font draws differently under OpenType `vert` — read from
 * the font's own GSUB table, so vertical type knows EXACTLY which glyphs have a
 * vertical alternate instead of guessing from an ink probe.
 *
 * ## Coverage
 *
 *   • sfnt (TrueType / CFF) and TrueType COLLECTIONS (`ttcf`, any face index —
 *     Yu Gothic and MS Gothic ship as .ttc); WOFF 1.0 through
 *     {@link sfntFromFontBytes} (zlib via DecompressionStream). WOFF 2.0 needs
 *     Brotli, which Electron 32's Chromium has no stream for: callers get null
 *     and fall back to an ink probe.
 *   • GSUB 1.0 and 1.1 (FeatureVariations ignored — the default substitution
 *     is what a static face draws).
 *   • Only features some script's LangSys actually references (a feature record
 *     nothing points at is never applied by the shaper), unioned over scripts —
 *     a lone CJK punctuation mark is script Common, and which script record the
 *     shaper settles on is the browser's business.
 *   • Lookup type 1 (single substitution, formats 1 and 2) and type 7
 *     (extension) wrapping type 1. Lookups of a feature apply in order, so
 *     chained single substitutions compose. Other types (alternate, ligature)
 *     are not what `vert` is made of and are skipped.
 *
 * ## vert, not vrt2
 *
 * `vrt2` also swaps proportional Latin for PRE-ROTATED glyphs, and the layout
 * already rotates Latin, so a font with `vert` is read (and drawn) through
 * `vert`. Only a font with `vrt2` and no `vert` is read through `vrt2`, and
 * then just for characters that are not Vertical_Orientation R.
 *
 * The cmap / table-directory readers here duplicate a few lines of
 * openType.ts on purpose: that module keeps them private and is owned by the
 * outline reader; this one also needs collection face indices and a name table.
 */

import { verticalOrientationOf } from './verticalForms';

export interface SfntTable { offset: number; length: number }

const TAG_TTCF = 0x74746366;
const TAG_WOFF = 0x774f4646;
const TAG_WOF2 = 0x774f4632;

const tagAt = (view: DataView, p: number): string =>
  String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));

/** Faces in the file: numFonts for a collection, 1 for a plain sfnt, 0 for anything else. */
export function sfntFaceCount(buf: ArrayBuffer): number {
  if (buf.byteLength < 12) return 0;
  const view = new DataView(buf);
  const tag = view.getUint32(0);
  if (tag === TAG_TTCF) return view.getUint32(8);
  if (tag === 0x00010000 || tag === 0x4f54544f /* OTTO */ || tag === 0x74727565 /* true */) return 1;
  return 0;
}

/** Table offset of face `faceIndex`'s directory (0 for a plain sfnt), or -1. */
function directoryOffset(view: DataView, faceIndex: number): number {
  if (view.getUint32(0) !== TAG_TTCF) return faceIndex === 0 ? 0 : -1;
  const n = view.getUint32(8);
  if (!(faceIndex >= 0 && faceIndex < n) || 12 + (faceIndex + 1) * 4 > view.byteLength) return -1;
  return view.getUint32(12 + faceIndex * 4);
}

/** The table directory of one face (absolute offsets into the file), or null when malformed. */
export function sfntTables(buf: ArrayBuffer, faceIndex = 0): Map<string, SfntTable> | null {
  if (sfntFaceCount(buf) === 0) return null;
  const view = new DataView(buf);
  const base = directoryOffset(view, faceIndex);
  if (base < 0 || base + 12 > buf.byteLength) return null;
  const numTables = view.getUint16(base + 4);
  if (base + 12 + numTables * 16 > buf.byteLength) return null;
  const tables = new Map<string, SfntTable>();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    const offset = view.getUint32(rec + 8), length = view.getUint32(rec + 12);
    if (offset + length > buf.byteLength) continue;
    tables.set(tagAt(view, rec), { offset, length });
  }
  return tables;
}

// ── name ────────────────────────────────────────────────────────────

export interface SfntNames { family?: string; fullName?: string; postscriptName?: string }

/** Family (typographic first), full and PostScript names of one face. */
export function sfntNames(buf: ArrayBuffer, faceIndex = 0): SfntNames {
  const t = sfntTables(buf, faceIndex)?.get('name');
  if (!t) return {};
  const view = new DataView(buf);
  const count = view.getUint16(t.offset + 2);
  const strings = t.offset + view.getUint16(t.offset + 4);
  const found = new Map<number, { score: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const r = t.offset + 6 + i * 12;
    if (r + 12 > t.offset + t.length) break;
    const platform = view.getUint16(r), encoding = view.getUint16(r + 2), language = view.getUint16(r + 4);
    const id = view.getUint16(r + 6), len = view.getUint16(r + 8), off = strings + view.getUint16(r + 10);
    if (id !== 1 && id !== 4 && id !== 6 && id !== 16) continue;
    if (off + len > buf.byteLength) continue;
    let value = '';
    let score: number;
    if (platform === 3 || platform === 0) {
      for (let k = 0; k + 1 < len; k += 2) value += String.fromCharCode(view.getUint16(off + k));
      // English (US) Windows records first: Japanese fonts carry localized names too.
      score = platform === 3 && (encoding === 1 || encoding === 10) ? (language === 0x409 ? 3 : 2) : 1;
    } else if (platform === 1 && encoding === 0) {
      for (let k = 0; k < len; k++) value += String.fromCharCode(view.getUint8(off + k));
      score = language === 0 ? 2.5 : 0.5;
    } else continue;
    const prev = found.get(id);
    if (value && (!prev || score > prev.score)) found.set(id, { score, value });
  }
  const family = found.get(16)?.value ?? found.get(1)?.value;
  const fullName = found.get(4)?.value;
  const postscriptName = found.get(6)?.value;
  return { ...(family ? { family } : {}), ...(fullName ? { fullName } : {}), ...(postscriptName ? { postscriptName } : {}) };
}

/** The face of a collection whose PostScript (or full) name is `name`; 0 when none matches. */
export function collectionFaceIndex(buf: ArrayBuffer, name: string | undefined): number {
  const n = sfntFaceCount(buf);
  if (n <= 1 || !name) return 0;
  for (let i = 0; i < n; i++) {
    const names = sfntNames(buf, i);
    if (names.postscriptName === name || names.fullName === name) return i;
  }
  return 0;
}

/**
 * One face of a TrueType collection as a standalone sfnt — what `new FontFace`
 * needs to draw a face other than the first. A plain sfnt comes back as is.
 */
export function extractCollectionFace(buf: ArrayBuffer, faceIndex: number): ArrayBuffer | null {
  const view = new DataView(buf);
  if (sfntFaceCount(buf) === 0) return null;
  if (view.getUint32(0) !== TAG_TTCF) return faceIndex === 0 ? buf : null;
  const base = directoryOffset(view, faceIndex);
  if (base < 0 || base + 12 > buf.byteLength) return null;
  const numTables = view.getUint16(base + 4);
  const recs: Array<{ rec: number; offset: number; length: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > buf.byteLength) return null;
    const offset = view.getUint32(rec + 8), length = view.getUint32(rec + 12);
    if (offset + length > buf.byteLength) return null;
    recs.push({ rec, offset, length });
  }
  const pad4 = (n: number): number => (n + 3) & ~3;
  const headerLen = 12 + numTables * 16;
  const total = recs.reduce((s, r) => s + pad4(r.length), headerLen);
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  const src = new Uint8Array(buf);
  out.set(src.subarray(base, base + 12), 0); // sfntVersion, numTables, searchRange…
  let at = headerLen;
  recs.forEach((r, i) => {
    const dst = 12 + i * 16;
    out.set(src.subarray(r.rec, r.rec + 8), dst); // tag + checksum
    outView.setUint32(dst + 8, at);
    outView.setUint32(dst + 12, r.length);
    out.set(src.subarray(r.offset, r.offset + r.length), at);
    at += pad4(r.length);
  });
  return out.buffer;
}

// ── WOFF ────────────────────────────────────────────────────────────

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  const DS = (globalThis as { DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (typeof DS !== 'function') return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Font file bytes → something {@link sfntTables} reads: sfnt and collections
 * as they are, WOFF 1.0 rebuilt into an sfnt, WOFF 2.0 (Brotli) → null.
 */
export async function sfntFromFontBytes(buf: ArrayBuffer): Promise<ArrayBuffer | null> {
  if (buf.byteLength < 12) return null;
  if (sfntFaceCount(buf) > 0) return buf;
  const view = new DataView(buf);
  const sig = view.getUint32(0);
  if (sig === TAG_WOF2) return null;
  if (sig !== TAG_WOFF || buf.byteLength < 44) return null;
  const numTables = view.getUint16(12);
  const headerLen = 12 + numTables * 16;
  const parts: Array<{ tag: number; checksum: number; data: Uint8Array }> = [];
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    if (e + 20 > buf.byteLength) return null;
    const offset = view.getUint32(e + 4), compLength = view.getUint32(e + 8), origLength = view.getUint32(e + 12);
    if (offset + compLength > buf.byteLength) return null;
    const raw = new Uint8Array(buf, offset, compLength);
    const data = compLength < origLength ? await inflate(raw) : raw;
    if (!data || data.byteLength !== origLength) return null;
    parts.push({ tag: view.getUint32(e), checksum: view.getUint32(e + 16), data });
  }
  const pad4 = (n: number): number => (n + 3) & ~3;
  const out = new Uint8Array(parts.reduce((s, p) => s + pad4(p.data.byteLength), headerLen));
  const ov = new DataView(out.buffer);
  ov.setUint32(0, view.getUint32(4));
  ov.setUint16(4, numTables);
  let at = headerLen;
  parts.forEach((p, i) => {
    const r = 12 + i * 16;
    ov.setUint32(r, p.tag);
    ov.setUint32(r + 4, p.checksum);
    ov.setUint32(r + 8, at);
    ov.setUint32(r + 12, p.data.byteLength);
    out.set(p.data, at);
    at += pad4(p.data.byteLength);
  });
  return out.buffer;
}

// ── cmap ────────────────────────────────────────────────────────────

/** Every (code point, glyph) pair of the face's best Unicode cmap subtable. */
function forEachCmapEntry(view: DataView, cmap: SfntTable, cb: (cp: number, gid: number) => void): void {
  const end = cmap.offset + cmap.length;
  const n = view.getUint16(cmap.offset + 2);
  let best: { off: number; format: number; score: number } | null = null;
  for (let i = 0; i < n; i++) {
    const rec = cmap.offset + 4 + i * 8;
    if (rec + 8 > end) break;
    const platform = view.getUint16(rec), encoding = view.getUint16(rec + 2);
    const off = cmap.offset + view.getUint32(rec + 4);
    if (off + 4 > end) continue;
    const format = view.getUint16(off);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    const score = format === 12 ? 3 : platform === 3 ? 2 : 1;
    if (!best || score > best.score) best = { off, format, score };
  }
  if (!best) return;
  const { off, format } = best;
  if (format === 12) {
    const groups = view.getUint32(off + 12);
    for (let g = 0; g < groups; g++) {
      const p = off + 16 + g * 12;
      if (p + 12 > end) break;
      const start = view.getUint32(p), stop = view.getUint32(p + 4), gid = view.getUint32(p + 8);
      for (let cp = start; cp <= stop && cp - start < 0x110000; cp++) cb(cp, gid + (cp - start));
    }
    return;
  }
  const segX2 = view.getUint16(off + 6);
  const endBase = off + 14, startBase = endBase + segX2 + 2, deltaBase = startBase + segX2, rangeBase = deltaBase + segX2;
  if (rangeBase + segX2 > end) return;
  for (let i = 0; i < segX2 / 2; i++) {
    const stop = view.getUint16(endBase + i * 2), start = view.getUint16(startBase + i * 2);
    const delta = view.getInt16(deltaBase + i * 2), rangeOff = view.getUint16(rangeBase + i * 2);
    if (start === 0xffff) continue;
    for (let cp = start; cp <= stop; cp++) {
      let gid: number;
      if (rangeOff === 0) gid = (cp + delta) & 0xffff;
      else {
        const addr = rangeBase + i * 2 + rangeOff + (cp - start) * 2;
        if (addr + 2 > view.byteLength) continue;
        const g = view.getUint16(addr);
        gid = g === 0 ? 0 : (g + delta) & 0xffff;
      }
      if (gid !== 0) cb(cp, gid);
    }
  }
}

// ── GSUB ────────────────────────────────────────────────────────────

/** Coverage table → glyph ids in coverage-index order. */
function coverageGlyphs(view: DataView, off: number): number[] {
  const format = view.getUint16(off);
  const out: number[] = [];
  if (format === 1) {
    const count = view.getUint16(off + 2);
    for (let i = 0; i < count; i++) out.push(view.getUint16(off + 4 + i * 2));
  } else if (format === 2) {
    const ranges = view.getUint16(off + 2);
    for (let i = 0; i < ranges; i++) {
      const r = off + 4 + i * 6;
      const start = view.getUint16(r), end = view.getUint16(r + 2), startIndex = view.getUint16(r + 4);
      for (let g = start; g <= end; g++) out[startIndex + (g - start)] = g;
    }
  }
  return out;
}

/** One single-substitution subtable into `map`. */
function readSingleSubst(view: DataView, off: number, map: Map<number, number>): void {
  const format = view.getUint16(off);
  const glyphs = coverageGlyphs(view, off + view.getUint16(off + 2));
  if (format === 1) {
    const delta = view.getInt16(off + 4);
    for (const g of glyphs) if (g !== undefined && !map.has(g)) map.set(g, (g + delta) & 0xffff);
  } else if (format === 2) {
    const count = view.getUint16(off + 4);
    glyphs.forEach((g, i) => {
      if (g !== undefined && i < count && !map.has(g)) map.set(g, view.getUint16(off + 6 + i * 2));
    });
  }
}

function lookupMap(view: DataView, lookup: number): Map<number, number> {
  const map = new Map<number, number>();
  const type = view.getUint16(lookup);
  const subCount = view.getUint16(lookup + 4);
  for (let s = 0; s < subCount; s++) {
    let sub = lookup + view.getUint16(lookup + 6 + s * 2);
    let subType = type;
    if (type === 7) {
      if (view.getUint16(sub) !== 1) continue;
      subType = view.getUint16(sub + 2);
      sub += view.getUint32(sub + 4);
    }
    if (subType === 1) readSingleSubst(view, sub, map);
  }
  return map;
}

/** GSUB feature tag → lookup indices, for features some LangSys references. */
function featureLookups(view: DataView, gsub: SfntTable, tags: ReadonlyArray<string>): Map<string, number[]> {
  const g = gsub.offset;
  const major = view.getUint16(g);
  const out = new Map<string, number[]>();
  if (major !== 1) return out;
  const scriptList = g + view.getUint16(g + 4);
  const featureList = g + view.getUint16(g + 6);
  const referenced = new Set<number>();
  const addLangSys = (ls: number): void => {
    const required = view.getUint16(ls + 2);
    if (required !== 0xffff) referenced.add(required);
    const count = view.getUint16(ls + 4);
    for (let i = 0; i < count; i++) referenced.add(view.getUint16(ls + 6 + i * 2));
  };
  const scripts = view.getUint16(scriptList);
  for (let i = 0; i < scripts; i++) {
    const script = scriptList + view.getUint16(scriptList + 2 + i * 6 + 4);
    const def = view.getUint16(script);
    if (def) addLangSys(script + def);
    const langs = view.getUint16(script + 2);
    for (let k = 0; k < langs; k++) addLangSys(script + view.getUint16(script + 4 + k * 6 + 4));
  }
  const features = view.getUint16(featureList);
  for (let i = 0; i < features; i++) {
    const rec = featureList + 2 + i * 6;
    const tag = tagAt(view, rec);
    if (!referenced.has(i) || !tags.includes(tag)) continue;
    const feature = featureList + view.getUint16(rec + 4);
    const n = view.getUint16(feature + 2);
    const list = out.get(tag) ?? [];
    for (let k = 0; k < n; k++) {
      const li = view.getUint16(feature + 4 + k * 2);
      if (!list.includes(li)) list.push(li);
    }
    out.set(tag, list);
  }
  return out;
}

export interface VerticalSubstitutions {
  /** The feature the face is read (and should be drawn) through; null = neither exists. */
  feature: 'vert' | 'vrt2' | null;
  /** Glyph id → vertical glyph id, only where the glyph changes. */
  glyphs: ReadonlyMap<number, number>;
  /** Code point → vertical glyph id, for every mapped code point whose glyph has one. */
  codePoints: ReadonlyMap<number, number>;
}

/**
 * The `vert` (else `vrt2`) substitutions of one face, keyed by glyph and by
 * code point. A face with no GSUB (or no such feature) yields empty maps; null
 * only for bytes that are not a readable sfnt / collection face.
 */
export function parseVerticalSubstitutions(buf: ArrayBuffer, faceIndex = 0): VerticalSubstitutions | null {
  const tables = sfntTables(buf, faceIndex);
  if (!tables) return null;
  const cmap = tables.get('cmap');
  if (!cmap) return null;
  const empty: VerticalSubstitutions = { feature: null, glyphs: new Map(), codePoints: new Map() };
  const gsub = tables.get('GSUB');
  if (!gsub) return empty;
  const view = new DataView(buf);
  try {
    const byTag = featureLookups(view, gsub, ['vert', 'vrt2']);
    const feature = byTag.has('vert') ? 'vert' : byTag.has('vrt2') ? 'vrt2' : null;
    if (!feature) return empty;
    const lookupList = gsub.offset + view.getUint16(gsub.offset + 8);
    const lookupCount = view.getUint16(lookupList);
    const maps = (byTag.get(feature) ?? [])
      .sort((a, b) => a - b) // the shaper applies a feature's lookups in LookupList order
      .filter((li) => li < lookupCount)
      .map((li) => lookupMap(view, lookupList + view.getUint16(lookupList + 2 + li * 2)));
    const glyphs = new Map<number, number>();
    const firstKeys = new Set<number>();
    for (const m of maps) for (const k of m.keys()) firstKeys.add(k);
    for (const gid of firstKeys) {
      let to = gid;
      for (const m of maps) to = m.get(to) ?? to;
      if (to !== gid) glyphs.set(gid, to);
    }
    const codePoints = new Map<number, number>();
    if (glyphs.size > 0) {
      forEachCmapEntry(view, cmap, (cp, gid) => {
        const to = glyphs.get(gid);
        if (to === undefined) return;
        // vrt2 pre-rotates proportional Latin; the layout rotates R characters itself.
        if (feature === 'vrt2' && verticalOrientationOf(cp) === 'R') return;
        codePoints.set(cp, to);
      });
    }
    return { feature, glyphs, codePoints };
  } catch {
    // A truncated or hostile table: say nothing rather than something wrong.
    return null;
  }
}

/** Parse a CSS `unicode-range` descriptor into a membership test (undefined = everything). */
export function unicodeRangeTest(range: string | undefined): (cp: number) => boolean {
  if (!range?.trim()) return () => true;
  const spans: Array<[number, number]> = [];
  for (const part of range.split(',')) {
    const m = /^\s*U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!m) continue;
    const a = m[1]!;
    if (a.includes('?')) spans.push([parseInt(a.replace(/\?/g, '0'), 16), parseInt(a.replace(/\?/g, 'F'), 16)]);
    else spans.push([parseInt(a, 16), m[2] ? parseInt(m[2], 16) : parseInt(a, 16)]);
  }
  return (cp) => spans.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Exposed for tests. */
export const SFNT_SIGNATURES = { TAG_TTCF, TAG_WOFF, TAG_WOF2 } as const;
