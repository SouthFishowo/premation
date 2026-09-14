/**
 * Generates `src/core/text/bidiData.ts` — the Bidi_Class and
 * Bidi_Paired_Bracket(_Type) tables the Unicode Bidirectional Algorithm
 * (`src/core/text/bidi.ts`) runs on — from the Unicode Character Database.
 *
 * Sources (https://www.unicode.org/Public/UCD/latest/ucd/):
 *   extracted/DerivedBidiClass.txt  Bidi_Class for every code point, including
 *                                   the `@missing` defaults for unassigned ones
 *   BidiBrackets.txt                Bidi_Paired_Bracket + Bidi_Paired_Bracket_Type
 *   UnicodeData.txt                 canonical singleton decompositions, so
 *                                   U+2329/U+232A pair with U+3008/U+3009 (BD16)
 *
 * With `--fixtures`, it also writes the conformance subsets the jest suite
 * `bidiConformance.test.ts` reads (`src/core/text/__fixtures__/`), sampled
 * deterministically from BidiTest.txt and BidiCharacterTest.txt (together
 * ~15 MB, too big to check in):
 *   • BidiCharacterTest: EVERY line containing a paired bracket or an explicit
 *     formatting character (LRE…PDI), plus every 16th of the rest;
 *   • BidiTest: for every @Levels/@Reorder group, its first data line and its
 *     longest one, plus every data line holding four or more explicit
 *     formatting classes. The @Levels/@Reorder headers are re-emitted per line.
 * The full files can be run too: `BIDI_UCD_DIR=<dir with both files> npx jest
 * src/core/text/bidiConformance`.
 *
 * USAGE
 *   node scripts/generate-bidi-data.mjs [ucdDir] [--fixtures]
 * `ucdDir` holds the downloaded files (flat, no `extracted/` sub-folder). When
 * omitted, the files are fetched from unicode.org.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/core/text/bidiData.ts');
const FIXTURES = join(ROOT, 'src/core/text/__fixtures__');
const BASE = 'https://www.unicode.org/Public/UCD/latest/ucd/';

const args = process.argv.slice(2);
const wantFixtures = args.includes('--fixtures');
const ucdDir = args.find((a) => !a.startsWith('--'));

async function load(name, remotePath = name) {
  if (ucdDir) {
    const p = join(ucdDir, name);
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    return readFileSync(p, 'utf8');
  }
  const res = await fetch(BASE + remotePath);
  if (!res.ok) throw new Error(`${BASE + remotePath}: HTTP ${res.status}`);
  return res.text();
}

/** Class order = the numeric ids bidi.ts uses. Never reorder without regenerating. */
const CLASSES = ['L', 'R', 'AL', 'EN', 'ES', 'ET', 'AN', 'CS', 'NSM', 'BN', 'B', 'S', 'WS', 'ON', 'LRE', 'LRO', 'RLE', 'RLO', 'PDF', 'LRI', 'RLI', 'FSI', 'PDI'];
const LONG = {
  Left_To_Right: 'L', Right_To_Left: 'R', Arabic_Letter: 'AL', European_Number: 'EN', European_Separator: 'ES',
  European_Terminator: 'ET', Arabic_Number: 'AN', Common_Separator: 'CS', Nonspacing_Mark: 'NSM',
  Boundary_Neutral: 'BN', Paragraph_Separator: 'B', Segment_Separator: 'S', White_Space: 'WS', Other_Neutral: 'ON',
  Left_To_Right_Embedding: 'LRE', Left_To_Right_Override: 'LRO', Right_To_Left_Embedding: 'RLE',
  Right_To_Left_Override: 'RLO', Pop_Directional_Format: 'PDF', Left_To_Right_Isolate: 'LRI',
  Right_To_Left_Isolate: 'RLI', First_Strong_Isolate: 'FSI', Pop_Directional_Isolate: 'PDI',
};

const range = (s) => {
  const [a, b] = s.trim().split('..');
  return [parseInt(a, 16), parseInt(b ?? a, 16)];
};

const derived = await load('DerivedBidiClass.txt', 'extracted/DerivedBidiClass.txt');
const brackets = await load('BidiBrackets.txt');
const unicodeData = await load('UnicodeData.txt');
const version = /DerivedBidiClass-([\d.]+)\.txt/.exec(derived)?.[1];
if (!version) throw new Error('no version header in DerivedBidiClass.txt');

// ── Bidi_Class ──────────────────────────────────────────────────────────────
const cls = new Uint8Array(0x110000);
// @missing lines first, in file order (later, narrower ones override).
for (const m of derived.matchAll(/^#\s*@missing:\s*([0-9A-F.]+)\s*;\s*(\w+)/gim)) {
  const [a, b] = range(m[1]);
  const c = LONG[m[2]] ?? m[2];
  const id = CLASSES.indexOf(c);
  if (id < 0) throw new Error(`unknown class ${m[2]}`);
  cls.fill(id, a, b + 1);
}
for (const line of derived.split('\n')) {
  const body = line.split('#')[0].trim();
  if (!body) continue;
  const [r, c] = body.split(';').map((x) => x.trim());
  const id = CLASSES.indexOf(c);
  if (id < 0) throw new Error(`unknown class ${c}`);
  const [a, b] = range(r);
  cls.fill(id, a, b + 1);
}
// Range-compress: each entry is `<start delta, base 36><class letter A–W>`.
let table = '';
let entries = 0;
let prev = 0;
for (let cp = 0; cp < 0x110000; cp++) {
  if (cp > 0 && cls[cp] === cls[cp - 1]) continue;
  table += (cp - prev).toString(36) + String.fromCharCode(65 + cls[cp]);
  prev = cp;
  entries++;
}

// ── Brackets ────────────────────────────────────────────────────────────────
const pairs = [];
for (const line of brackets.split('\n')) {
  const body = line.split('#')[0].trim();
  if (!body) continue;
  const [cp, pair, type] = body.split(';').map((x) => x.trim());
  if (type !== 'o' && type !== 'c') throw new Error(`bad bracket type ${type}`);
  pairs.push([parseInt(cp, 16), parseInt(pair, 16), type]);
}
const bracketSet = new Set(pairs.map((p) => p[0]));
const canonical = [];
for (const line of unicodeData.split('\n')) {
  const f = line.split(';');
  if (f.length < 6 || !bracketSet.has(parseInt(f[0], 16))) continue;
  const d = f[5].trim();
  if (d && !d.startsWith('<') && !d.includes(' ')) canonical.push([parseInt(f[0], 16), parseInt(d, 16)]);
}
const hex = (n) => n.toString(16);

const out = `/**
 * GENERATED by scripts/generate-bidi-data.mjs from the Unicode Character
 * Database, version ${version} — do not edit by hand.
 *
 *   extracted/DerivedBidiClass.txt, BidiBrackets.txt, UnicodeData.txt
 *
 * Decoded by bidi.ts. \`BIDI_CLASS_TABLE\` is range-compressed: a run of
 * \`<start − previous start, base 36><class letter>\` entries (A = the first
 * name in \`BIDI_CLASS_NAMES\`) covering U+0000–U+10FFFF (${entries} ranges).
 * \`BIDI_BRACKETS\` lists \`<code point>:<paired bracket>:<o|c>\` in hex;
 * \`BIDI_BRACKET_CANONICAL\` the canonical singleton decompositions among them.
 */

export const BIDI_UNICODE_VERSION = '${version}';

export const BIDI_CLASS_NAMES = ${JSON.stringify(CLASSES).replace(/,/g, ', ').replace(/"/g, "'")} as const;

export const BIDI_CLASS_TABLE =
${(table.match(/.{1,96}/g) ?? []).map((s) => `  '${s}'`).join(' +\n')};

export const BIDI_BRACKETS =
${(pairs.map(([a, b, t]) => `${hex(a)}:${hex(b)}:${t}`).join(',').match(/.{1,96}/g) ?? []).map((s) => `  '${s}'`).join(' +\n')};

export const BIDI_BRACKET_CANONICAL = '${canonical.map(([a, b]) => `${hex(a)}:${hex(b)}`).join(',')}';
`;
writeFileSync(OUT, out);
console.log(`bidiData.ts: Unicode ${version}, ${entries} class ranges, ${pairs.length} brackets, ${canonical.length} canonical`);

// ── Conformance fixtures ────────────────────────────────────────────────────
if (wantFixtures) {
  mkdirSync(FIXTURES, { recursive: true });
  const header = (name) => `# Sampled by scripts/generate-bidi-data.mjs from ${name}, Unicode ${version}.\n`;

  const charTest = await load('BidiCharacterTest.txt');
  // Nearly every line holds an ASCII parenthesis, so "contains a bracket"
  // selects the whole file. Kept in full: the hand-written sections (every line
  // before the generated "()" permutation blocks), any line with an explicit
  // formatting character, a non-ASCII bracket or a canonical-equivalent one,
  // and the first two lines of every section; then every 24th of the rest.
  const special = (cp) => (cls[cp] >= 14 && cls[cp] <= 22) || (cp > 0x7f && bracketSet.has(cp));
  let rest = 0;
  let inSection = 0;
  let generated = false;
  const charLines = [];
  for (const line of charTest.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      if (t === '# ()') generated = true;
      inSection = 0;
      continue;
    }
    const cps = t.split(';')[0].trim().split(/\s+/).map((h) => parseInt(h, 16));
    if (!generated || cps.some(special) || inSection++ < 2 || rest++ % 24 === 0) charLines.push(t);
  }
  writeFileSync(join(FIXTURES, 'BidiCharacterTest.sample.txt'), header('BidiCharacterTest.txt') + charLines.join('\n') + '\n');

  const test = await load('BidiTest.txt');
  const EXPLICIT = new Set(['LRE', 'LRO', 'RLE', 'RLO', 'PDF', 'LRI', 'RLI', 'FSI', 'PDI']);
  let levels = '';
  let reorder = '';
  let group = [];
  const picked = [];
  const flush = () => {
    if (group.length === 0) return;
    const chosen = new Set([group[0]]);
    let longest = group[0];
    for (const g of group) {
      const classes = g.split(';')[0].trim().split(/\s+/);
      if (classes.length > longest.split(';')[0].trim().split(/\s+/).length) longest = g;
      if (classes.filter((c) => EXPLICIT.has(c)).length >= 4) chosen.add(g);
    }
    chosen.add(longest);
    for (const g of chosen) picked.push(`@Levels: ${levels}\n@Reorder: ${reorder}\n${g}`);
    group = [];
  };
  for (const line of test.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('@Levels:')) { flush(); levels = t.slice(8).trim(); continue; }
    if (t.startsWith('@Reorder:')) { flush(); reorder = t.slice(9).trim(); continue; }
    if (t.startsWith('@')) continue;
    group.push(t);
  }
  flush();
  writeFileSync(join(FIXTURES, 'BidiTest.sample.txt'), header('BidiTest.txt') + picked.join('\n') + '\n');
  console.log(`fixtures: ${charLines.length} BidiCharacterTest lines, ${picked.length} BidiTest lines`);
}
