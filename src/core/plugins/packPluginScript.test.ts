/**
 * `scripts/pack-plugin.mjs`, run for real.
 *
 * The packer and the reader are two programs that have to agree about one file
 * format, and they share no code — the reader is TypeScript in the renderer's
 * module graph, the packer is a plain Node script. A unit test of either one
 * proves nothing about that agreement, so this drives the actual script over a
 * real folder and feeds what it produced to the actual `readPluginZip`.
 *
 * It also pins the refusals, because the whole point of packing through a tool
 * rather than zipping a folder by hand is finding out at pack time.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPluginZip, LOCAL_LIMITS } from './pluginPackage';

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'pack-plugin.mjs');

const MANIFEST = {
  id: 'com.test.packed',
  name: 'Packed',
  version: '1.0.0',
  description: 'A plugin packed by the tool.',
  apiVersion: 1,
  main: 'main.js',
  permissions: [],
};

/** A plugin folder on disk, with whatever files a case needs. */
function makeFolder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-plugin-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

/** Run the packer. Returns its output, or the failure it printed. */
function pack(dir: string, args: string[] = []): { ok: boolean; output: string; out: string } {
  const out = join(dir, 'packed.mplugin');
  try {
    const output = execFileSync(process.execPath, [SCRIPT, dir, '--out', out, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`, out };
  }
}

describe('packing a folder', () => {
  it('produces an archive the editor’s own reader accepts', () => {
    const dir = makeFolder({
      'plugin.json': JSON.stringify(MANIFEST),
      'main.js': "import './lib/util.js';\nexport function activate() {}",
      'lib/util.js': 'export const x = 1;',
    });
    const result = pack(dir);
    expect(result.output).toContain('Packed 1.0.0');
    expect(existsSync(result.out)).toBe(true);

    const read = readPluginZip(new Uint8Array(readFileSync(result.out)), LOCAL_LIMITS);
    expect(read.errors).toEqual([]);
    expect(read.pkg?.manifest.id).toBe('com.test.packed');
    // The whole graph, not only the entry — that is what the format is for.
    expect(Object.keys(read.pkg?.files ?? {}).sort()).toEqual(['lib/util.js', 'main.js', 'plugin.json']);
  });

  it('carries binary assets through unchanged', () => {
    const dir = makeFolder({
      'plugin.json': JSON.stringify(MANIFEST),
      'main.js': 'export function activate() {}',
      'models/weights.bin': 'BINARYISH',
    });
    const read = readPluginZip(new Uint8Array(readFileSync(pack(dir).out)), LOCAL_LIMITS);
    expect(new TextDecoder().decode(read.pkg?.binaries['models/weights.bin'])).toBe('BINARYISH');
  });

  it('says it is unsigned when no key was given', () => {
    const dir = makeFolder({ 'plugin.json': JSON.stringify(MANIFEST), 'main.js': 'export function activate() {}' });
    expect(pack(dir).output).toMatch(/Developer Mode/);
  });
});

describe('the refusals', () => {
  it('refuses a folder with no manifest', () => {
    const dir = makeFolder({ 'main.js': 'export function activate() {}' });
    const result = pack(dir);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/No plugin\.json at the root/);
  });

  it('names a "main" that is not there', () => {
    const dir = makeFolder({ 'plugin.json': JSON.stringify({ ...MANIFEST, main: 'index.js' }) });
    const result = pack(dir);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/index\.js, which is not in the folder/);
  });

  /*
    The tier boundary, enforced at the point an author would otherwise ship it.
    The editor refuses these too — this is about when they find out.
  */
  it('refuses a native module and explains the tier', () => {
    const dir = makeFolder({
      'plugin.json': JSON.stringify(MANIFEST),
      'main.js': 'export function activate() {}',
      'native/accel.node': 'MZ',
    });
    const result = pack(dir);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/native module/);
  });

  it('reports every problem at once, not the first', () => {
    const dir = makeFolder({ 'plugin.json': JSON.stringify({ id: 'x' }), 'bad.node': 'MZ' });
    const result = pack(dir);
    expect(result.output).toMatch(/native module/);
    expect(result.output).toMatch(/missing "name"/);
  });
});
