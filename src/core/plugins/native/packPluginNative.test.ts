/**
 * `scripts/pack-plugin.mjs --native`, run for real.
 *
 * The flag is the point, and it is not a convenience: packaging a program is a
 * different act from packaging a script, and everything downstream of it is
 * different — a signature AND a separate consent step naming the binary, and a
 * user told it runs outside the sandbox. None of that should be reachable by
 * dropping a `.dll` into a folder and not noticing, so the default is a refusal
 * with a sentence, and the flag is the author saying it out loud.
 *
 * The hashes are the other half. They go INSIDE the package, so the signature
 * covers them, which is what lets the editor say "this binary is not the one
 * the package was built with" instead of merely "the hash changed".
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPluginZip, LOCAL_LIMITS } from '../pluginPackage';

const SCRIPT = join(__dirname, '..', '..', '..', '..', 'scripts', 'pack-plugin.mjs');

const BINARY = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

const MANIFEST = {
  id: 'com.test.native',
  name: 'Native Test',
  version: '1.0.0',
  description: 'A plugin with a compiled module.',
  apiVersion: 7,
  main: 'main.js',
  permissions: [],
  native: {
    abi: 1,
    platforms: { 'win32-x64': 'bin/win32-x64/fx.node' },
  },
};

function makeFolder(manifest: unknown = MANIFEST): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-native-'));
  mkdirSync(join(dir, 'bin', 'win32-x64'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'main.js'), 'export function activate() {}');
  writeFileSync(join(dir, 'bin', 'win32-x64', 'fx.node'), BINARY);
  return dir;
}

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

describe('the default is still a refusal', () => {
  it('will not package a compiled module unless it is asked to', () => {
    const result = pack(makeFolder());
    expect(result.ok).toBe(false);
    expect(result.output).toContain('is a native module');
    // The refusal has to name the way forward, or the author's next move is a
    // search rather than a flag.
    expect(result.output).toContain('--native');
  });
});

describe('--native', () => {
  it('packages the binary and records a sha256 for it in the manifest', () => {
    const dir = makeFolder();
    const result = pack(dir, ['--native']);
    expect(result.ok).toBe(true);

    const read = readPluginZip(new Uint8Array(readFileSync(result.out)), LOCAL_LIMITS);
    expect(read.errors).toEqual([]);
    const manifest = read.pkg?.manifest as unknown as { native?: { hashes?: Record<string, string> } };
    expect(manifest.native?.hashes?.['bin/win32-x64/fx.node'])
      .toBe(createHash('sha256').update(BINARY).digest('hex'));
  });

  it('says out loud that the package now contains a program', () => {
    const result = pack(makeFolder(), ['--native']);
    expect(result.output).toContain('compiled module');
    expect(result.output).toContain('Developer Mode');
  });

  it('refuses a declaration pointing at a file that is not there', () => {
    const dir = makeFolder({
      ...MANIFEST,
      native: { abi: 1, platforms: { 'linux-x64': 'bin/linux-x64/fx.node' } },
    });
    const result = pack(dir, ['--native']);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('native.platforms.linux-x64');
  });

  it('refuses --native on a package that declares no native block', () => {
    const { native: _native, ...plain } = MANIFEST;
    const result = pack(makeFolder(plain), ['--native']);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('declares no "native" block');
  });

  it('does not eat the flag that follows it', () => {
    // `--native --key k` used to consume `--key` as this flag's value, which
    // produced an unsigned package and no complaint.
    const dir = makeFolder();
    const result = pack(dir, ['--native', '--key', join(dir, 'nope.json')]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('No key at');
  });
});
