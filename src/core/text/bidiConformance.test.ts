/**
 * UAX #9 conformance: BidiTest.txt (class sequences × paragraph directions) and
 * BidiCharacterTest.txt (code points, incl. paired brackets and explicit
 * formatting characters), checking resolved levels and visual order.
 *
 * By default this runs the deterministic subsets checked into `__fixtures__`
 * (see `scripts/generate-bidi-data.mjs --fixtures` for how they are sampled).
 * To run the complete Unicode files, point `BIDI_UCD_DIR` at a folder holding
 * BidiTest.txt and BidiCharacterTest.txt:
 *
 *   BIDI_UCD_DIR=/path/to/ucd npx jest src/core/text/bidiConformance
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCodePoints, resolveLevels, visualOrder, type BidiClass, type BidiDirection } from './bidi';

const dir = process.env.BIDI_UCD_DIR;
const read = (full: string, sample: string): string =>
  readFileSync(dir ? join(dir, full) : join(__dirname, '__fixtures__', sample), 'utf8');

/** Levels as the test files print them: 'x' for characters removed by X9. */
const REMOVED = new Set(['LRE', 'RLE', 'LRO', 'RLO', 'PDF', 'BN']);

function check(
  levels: number[],
  removed: boolean[],
  wantLevels: string[],
  wantOrder: string,
): string | null {
  const got = levels.map((l, i) => (removed[i] ? 'x' : String(l)));
  if (got.join(' ') !== wantLevels.join(' ')) return `levels ${got.join(' ')} ≠ ${wantLevels.join(' ')}`;
  const order = visualOrder(levels).filter((i) => !removed[i]).join(' ');
  if (order !== wantOrder) return `order ${order} ≠ ${wantOrder}`;
  return null;
}

describe('UAX #9 conformance', () => {
  it('BidiTest.txt', () => {
    let levels: string[] = [];
    let reorder = '';
    let run = 0;
    let passed = 0;
    const failures: string[] = [];
    for (const raw of read('BidiTest.txt', 'BidiTest.sample.txt').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('@Levels:')) { levels = line.slice(8).trim().split(/\s+/).filter(Boolean); continue; }
      if (line.startsWith('@Reorder:')) { reorder = line.slice(9).trim().split(/\s+/).filter(Boolean).join(' '); continue; }
      if (line.startsWith('@')) continue;
      const [input, bits] = line.split(';');
      const classes = input!.trim().split(/\s+/) as BidiClass[];
      const removed = classes.map((c) => REMOVED.has(c));
      const mask = parseInt(bits!.trim(), 16);
      const dirs: Array<[number, BidiDirection]> = [[1, 'auto'], [2, 0], [4, 1]];
      for (const [bit, d] of dirs) {
        if (!(mask & bit)) continue;
        run++;
        const err = check(resolveLevels(classes, d), removed, levels, reorder);
        if (err) {
          if (failures.length < 20) failures.push(`${line} [dir ${d}]: ${err}`);
        } else passed++;
      }
    }
    // eslint-disable-next-line no-console
    if (dir) console.log(`BidiTest: ${passed}/${run}`);
    expect(failures).toEqual([]);
    expect(run).toBeGreaterThan(1000);
    expect(passed).toBe(run);
  });

  it('BidiCharacterTest.txt', () => {
    let run = 0;
    let passed = 0;
    const failures: string[] = [];
    for (const raw of read('BidiCharacterTest.txt', 'BidiCharacterTest.sample.txt').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [cpsField, dirField, paraField, levelsField, orderField] = line.split(';');
      const cps = cpsField!.trim().split(/\s+/).map((h) => parseInt(h, 16));
      const d: BidiDirection = dirField!.trim() === '2' ? 'auto' : dirField!.trim() === '1' ? 1 : 0;
      const wantLevels = levelsField!.trim().split(/\s+/);
      const removed = wantLevels.map((l) => l === 'x');
      run++;
      const res = resolveCodePoints(cps, d);
      let err = check(res.levels, removed, wantLevels, orderField!.trim().split(/\s+/).filter(Boolean).join(' '));
      if (!err && String(res.paragraphLevel) !== paraField!.trim()) err = `paragraph level ${res.paragraphLevel} ≠ ${paraField!.trim()}`;
      if (err) {
        if (failures.length < 20) failures.push(`${line}: ${err}`);
      } else passed++;
    }
    // eslint-disable-next-line no-console
    if (dir) console.log(`BidiCharacterTest: ${passed}/${run}`);
    expect(failures).toEqual([]);
    expect(run).toBeGreaterThan(1000);
    expect(passed).toBe(run);
  });
});
