/**
 * Is this font file a VARIABLE font?
 *
 * A variable font carries an `fvar` table — the axis definitions `wght`,
 * `wdth`, `slnt` that the text inspector already keyframes. Reading the table
 * DIRECTORY is enough to know the table exists, and the directory sits in the
 * first few hundred bytes of the file, so the probe only needs a short slice,
 * never the whole face.
 *
 * Pure over an ArrayBuffer, so it is testable with a hand-built header and
 * usable on whatever the Local Font Access API hands back.
 */

const TAG_FVAR = 0x66766172; // 'fvar'
const TAG_TTCF = 0x74746366; // 'ttcf'

/**
 * Read the table directory of one sfnt at `offset` and report an `fvar`.
 * Tolerant of truncated buffers: a directory that runs past the slice just
 * reports false, which is the right answer for "could not tell".
 */
function sfntHasFvar(view: DataView, offset: number): boolean {
  if (offset + 12 > view.byteLength) return false;
  const numTables = view.getUint16(offset + 4);
  const recordsStart = offset + 12;
  for (let i = 0; i < numTables; i++) {
    const rec = recordsStart + i * 16;
    if (rec + 4 > view.byteLength) return false;
    if (view.getUint32(rec) === TAG_FVAR) return true;
  }
  return false;
}

/**
 * True when the font data declares variation axes. Handles single faces
 * (TrueType `00010000`, `true`, CFF `OTTO`) and collections (`ttcf`), where
 * the first face's directory is consulted — a collection's faces share axes
 * in practice, and the picker needs one answer per family.
 */
export function hasVariableAxes(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const view = new DataView(buf);
  const tag = view.getUint32(0);
  if (tag === TAG_TTCF) {
    // TTC header: tag, version, numFonts, then offsets to each face.
    if (view.byteLength < 16) return false;
    const first = view.getUint32(12);
    return sfntHasFvar(view, first);
  }
  return sfntHasFvar(view, 0);
}

/** How much of a file the probe needs: the header plus a generous directory. */
export const VARIABLE_PROBE_BYTES = 4096;

/** One variation axis as the font's `fvar` table declares it. */
export interface FvarAxis {
  /** Four-character axis tag — `wght`, `wdth`, `GRAD`, … */
  tag: string;
  min: number;
  default: number;
  max: number;
  /** The font marks it hidden (AXIS_QUALIFIER_HIDDEN) — not for a UI. */
  hidden: boolean;
}

/** Offset of the `fvar` table in one sfnt, or -1. */
function fvarOffset(view: DataView, sfnt: number): number {
  if (sfnt + 12 > view.byteLength) return -1;
  const numTables = view.getUint16(sfnt + 4);
  for (let i = 0; i < numTables; i++) {
    const rec = sfnt + 12 + i * 16;
    if (rec + 16 > view.byteLength) return -1;
    if (view.getUint32(rec) === TAG_FVAR) return view.getUint32(rec + 8);
  }
  return -1;
}

/** 16.16 fixed point. */
const fixed = (view: DataView, at: number): number => view.getInt32(at) / 65536;

/**
 * The axes a font declares, read from its `fvar` table (OpenType spec §fvar:
 * a 16-byte header, then `axisCount` records of `axisSize` bytes at
 * `axesArrayOffset`, each tag / min / default / max as Fixed / flags /
 * nameID). Needs the WHOLE file — unlike the probe, the table itself can sit
 * anywhere. Empty for a static font or a buffer that does not reach the table.
 */
export function parseFvarAxes(buf: ArrayBuffer): FvarAxis[] {
  if (buf.byteLength < 12) return [];
  const view = new DataView(buf);
  const sfnt = view.getUint32(0) === TAG_TTCF ? (view.byteLength >= 16 ? view.getUint32(12) : -1) : 0;
  if (sfnt < 0) return [];
  const table = fvarOffset(view, sfnt);
  if (table < 0 || table + 16 > view.byteLength) return [];
  const axesAt = table + view.getUint16(table + 4);
  const count = view.getUint16(table + 8);
  const size = view.getUint16(table + 10);
  if (size < 20) return [];
  const out: FvarAxis[] = [];
  for (let i = 0; i < count; i++) {
    const at = axesAt + i * size;
    if (at + 20 > view.byteLength) break;
    const code = view.getUint32(at);
    const tag = String.fromCharCode((code >>> 24) & 0xff, (code >>> 16) & 0xff, (code >>> 8) & 0xff, code & 0xff);
    out.push({
      tag,
      min: fixed(view, at + 4),
      default: fixed(view, at + 8),
      max: fixed(view, at + 12),
      hidden: (view.getUint16(at + 16) & 0x0001) !== 0,
    });
  }
  return out;
}
