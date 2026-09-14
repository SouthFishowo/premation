/**
 * GSUB 'vert' / 'vrt2' reading on hand-built fonts (__fixtures__/syntheticVertFont.ts).
 */

import {
  collectionFaceIndex,
  extractCollectionFace,
  parseVerticalSubstitutions,
  sfntFaceCount,
  sfntFromFontBytes,
  sfntNames,
  sfntTables,
  unicodeRangeTest,
} from './openTypeGsub';
import {
  cmapTable, coverage1, gsubTable, lookup, nameTable, sfnt, singleFmt2, standardGsub, ttc, u16, u32,
} from './__fixtures__/syntheticVertFont';

describe('parseVerticalSubstitutions', () => {
  it('reads vert: single substitution formats 1 and 2, extension lookups, chained lookups', () => {
    const subs = parseVerticalSubstitutions(sfnt({ cmap: cmapTable(), GSUB: standardGsub() }))!;
    expect(subs.feature).toBe('vert');
    expect([...subs.glyphs]).toEqual(expect.arrayContaining([[1, 110], [2, 11], [5, 105], [10, 110]]));
    expect(new Map(subs.codePoints)).toEqual(new Map([[0x3001, 110], [0x300c, 11], [0x30fc, 105]]));
  });

  it('ignores a feature no LangSys references, and never uses vrt2 when vert exists', () => {
    const subs = parseVerticalSubstitutions(sfnt({ cmap: cmapTable(), GSUB: standardGsub() }))!;
    // Unreferenced feature 2 would map A (glyph 4); vrt2 would map it to a pre-rotated 20.
    expect(subs.codePoints.has(0x41)).toBe(false);
    expect(subs.codePoints.has(0x6f22)).toBe(false);
  });

  it('reads GSUB 1.1 headers', () => {
    const subs = parseVerticalSubstitutions(sfnt({ cmap: cmapTable(), GSUB: standardGsub(0x00010001) }))!;
    expect(subs.codePoints.get(0x300c)).toBe(11);
  });

  it('falls back to vrt2 only without vert — and then skips Vertical_Orientation R (Latin)', () => {
    const gsub = gsubTable({
      features: [{ tag: 'vrt2', lookups: [0] }],
      referenced: [0],
      lookups: [lookup(1, [singleFmt2(coverage1([2, 4]), [12, 20])])],
    });
    const subs = parseVerticalSubstitutions(sfnt({ cmap: cmapTable(), GSUB: gsub }))!;
    expect(subs.feature).toBe('vrt2');
    expect(new Map(subs.codePoints)).toEqual(new Map([[0x300c, 12]]));
  });

  it('empty for a font without GSUB; null for bytes that are not a font', () => {
    const subs = parseVerticalSubstitutions(sfnt({ cmap: cmapTable() }))!;
    expect(subs).toMatchObject({ feature: null });
    expect(subs.codePoints.size).toBe(0);
    expect(parseVerticalSubstitutions(new Uint8Array(40).buffer)).toBeNull();
  });

  it('does not throw on a truncated GSUB', () => {
    const gsub = standardGsub().slice(0, 30);
    expect(() => parseVerticalSubstitutions(sfnt({ cmap: cmapTable(), GSUB: gsub }))).not.toThrow();
  });

  it('reads a format-12 cmap', () => {
    const f12 = [...u16(12), ...u16(0), ...u32(28), ...u32(0), ...u32(1), ...u32(0x3001), ...u32(0x3002), ...u32(1)];
    const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(10), ...u32(12), ...f12];
    const subs = parseVerticalSubstitutions(sfnt({ cmap, GSUB: standardGsub() }))!;
    // U+3001 → glyph 1 (→110), U+3002 → glyph 2 (→11).
    expect(new Map(subs.codePoints)).toEqual(new Map([[0x3001, 110], [0x3002, 11]]));
  });
});

describe('collections', () => {
  const plain = { cmap: cmapTable(), name: nameTable('Synth A', 'SynthA-Regular') };
  const vert = { cmap: cmapTable(), GSUB: standardGsub(), name: nameTable('Synth B', 'SynthB-Regular') };
  const collection = ttc([plain, vert]);

  it('counts faces and reads each face’s names', () => {
    expect(sfntFaceCount(collection)).toBe(2);
    expect(sfntFaceCount(sfnt(plain))).toBe(1);
    expect(sfntNames(collection, 1)).toEqual({ family: 'Synth B', fullName: 'Synth B Regular', postscriptName: 'SynthB-Regular' });
  });

  it('finds a face by PostScript or full name (first face otherwise)', () => {
    expect(collectionFaceIndex(collection, 'SynthB-Regular')).toBe(1);
    expect(collectionFaceIndex(collection, 'Synth B Regular')).toBe(1);
    expect(collectionFaceIndex(collection, 'Nope')).toBe(0);
  });

  it('parses GSUB per face', () => {
    expect(parseVerticalSubstitutions(collection, 0)!.codePoints.size).toBe(0);
    expect(parseVerticalSubstitutions(collection, 1)!.codePoints.get(0x3001)).toBe(110);
  });

  it('slices one face out into a standalone sfnt', () => {
    const one = extractCollectionFace(collection, 1)!;
    expect(new DataView(one).getUint32(0)).toBe(0x00010000);
    expect([...sfntTables(one)!.keys()].sort()).toEqual(['GSUB', 'cmap', 'name']);
    expect(sfntNames(one).postscriptName).toBe('SynthB-Regular');
    expect(parseVerticalSubstitutions(one)!.codePoints.get(0x300c)).toBe(11);
    // Offsets are 4-byte aligned.
    for (const t of sfntTables(one)!.values()) expect(t.offset % 4).toBe(0);
    expect(extractCollectionFace(collection, 2)).toBeNull();
  });
});

describe('sfntFromFontBytes', () => {
  it('passes sfnt through, rejects WOFF2 (no Brotli) and junk', async () => {
    const font = sfnt({ cmap: cmapTable() });
    await expect(sfntFromFontBytes(font)).resolves.toBe(font);
    const woff2 = new Uint8Array([...u32(0x774f4632), ...new Array<number>(60).fill(0)]).buffer;
    await expect(sfntFromFontBytes(woff2)).resolves.toBeNull();
    await expect(sfntFromFontBytes(new Uint8Array(8).buffer)).resolves.toBeNull();
  });

  it('rebuilds an uncompressed WOFF 1.0', async () => {
    const tables: Array<[string, number[]]> = [['cmap', cmapTable()], ['GSUB', standardGsub()]];
    let at = 44 + tables.length * 20;
    const dir: number[] = [];
    const data: number[] = [];
    for (const [t, b] of tables) {
      const padded = [...b, ...new Array<number>((4 - (b.length % 4)) % 4).fill(0)];
      dir.push(...[...t].map((c) => c.charCodeAt(0)), ...u32(at), ...u32(b.length), ...u32(b.length), ...u32(0));
      data.push(...padded);
      at += padded.length;
    }
    const header = [...u32(0x774f4646), ...u32(0x00010000), ...u32(at), ...u16(tables.length), ...u16(0), ...new Array<number>(28).fill(0)];
    const rebuilt = await sfntFromFontBytes(new Uint8Array([...header, ...dir, ...data]).buffer);
    expect(rebuilt).not.toBeNull();
    expect(parseVerticalSubstitutions(rebuilt!)!.codePoints.get(0x300c)).toBe(11);
  });
});

describe('unicodeRangeTest', () => {
  it('ranges, single points, wildcards; empty = everything', () => {
    const t = unicodeRangeTest('U+3000-303F, U+FF01, U+4E??');
    expect([0x3001, 0xff01, 0x4e2d].map(t)).toEqual([true, true, true]);
    expect([0x30fc, 0x41].map(t)).toEqual([false, false]);
    expect(unicodeRangeTest(undefined)(0x41)).toBe(true);
  });
});
