/**
 * The `native` block in a manifest.
 *
 * This validator refuses rather than repairs, which is not the house style for
 * optional manifest fields and is the right style for this one: every field
 * here decides which FILE compiled code is loaded from. A validator that
 * quietly dropped a malformed platform key would turn "my arm64 build did not
 * load" into a silent fallback onto the x64 one.
 *
 * The other thing pinned here is what the field is NOT. `native` is not
 * `runtime: "native"` — that is the renderer-realm tier, a different thing with
 * a different failure mode — and declaring one must never imply the other,
 * because each has a consent question of its own.
 */

import { parseManifest } from '../manifest';

const BASE = {
  id: 'studio.acme.fx',
  name: 'Acme FX',
  version: '1.0.0',
  description: 'Compiled things.',
  apiVersion: 7,
  main: 'index.js',
  permissions: [],
};

const parse = (native: unknown) => parseManifest({ ...BASE, native });

describe('what it accepts', () => {
  it('reads a binary per platform, an ABI, and the optional knobs', () => {
    const { manifest, errors } = parse({
      abi: 1,
      platforms: { 'win32-x64': 'bin/win32-x64/fx.node', 'darwin-arm64': 'bin/darwin-arm64/fx.node' },
      hashes: { 'bin/win32-x64/fx.node': 'A'.repeat(64) },
      threadSafety: 'full',
      timeoutMs: 4000,
      idleTimeoutMs: 30000,
    });
    expect(errors).toEqual([]);
    expect(manifest?.native).toEqual({
      abi: 1,
      platforms: { 'win32-x64': 'bin/win32-x64/fx.node', 'darwin-arm64': 'bin/darwin-arm64/fx.node' },
      // Lowercased, so a comparison against a hash this app computed cannot
      // fail on case alone.
      hashes: { 'bin/win32-x64/fx.node': 'a'.repeat(64) },
      threadSafety: 'full',
      timeoutMs: 4000,
      idleTimeoutMs: 30000,
    });
  });

  it('leaves the field absent for every package that ships no binary', () => {
    const { manifest } = parseManifest(BASE);
    // Absent, not an empty block: no consumer may read "present but empty" as a
    // tier it should ask the user about.
    expect(manifest && 'native' in manifest).toBe(false);
  });

  it('does not make a package native in the renderer-realm sense', () => {
    const { manifest } = parse({ abi: 1, platforms: { 'win32-x64': 'fx.node' } });
    expect(manifest?.runtime).toBe('sandboxed');
  });

  it('carries a platform key this build has never heard of', () => {
    const { manifest, errors } = parse({ abi: 1, platforms: { 'freebsd-riscv64': 'fx.node' } });
    expect(errors).toEqual([]);
    expect(manifest?.native?.platforms).toEqual({ 'freebsd-riscv64': 'fx.node' });
  });
});

describe('what it refuses', () => {
  it('refuses a missing or bogus ABI', () => {
    expect(parse({ platforms: { 'win32-x64': 'fx.node' } }).errors.join(' ')).toContain('native.abi');
    expect(parse({ abi: '1', platforms: { 'win32-x64': 'fx.node' } }).errors.join(' ')).toContain('native.abi');
  });

  it('refuses a key that is merely close to a platform-arch pair', () => {
    // The key is looked up by string equality against `process.platform`-
    // `process.arch`, so "win32_x64" is a binary that is never found and never
    // reported.
    const { errors } = parse({ abi: 1, platforms: { win32_x64: 'fx.node' } });
    expect(errors.join(' ')).toContain('win32_x64');
    expect(errors.join(' ')).toContain('<platform>-<arch>');
  });

  it('refuses a path that escapes the package', () => {
    const { errors } = parse({ abi: 1, platforms: { 'win32-x64': '../../../Windows/System32/evil.dll' } });
    expect(errors.join(' ')).toContain('package-relative');
  });

  it('refuses an absolute path', () => {
    expect(parse({ abi: 1, platforms: { 'win32-x64': 'C:/evil.dll' } }).errors.length).toBeGreaterThan(0);
  });

  it('refuses a block that names no usable binary', () => {
    expect(parse({ abi: 1, platforms: {} }).errors.join(' ')).toContain('no usable binary');
  });

  it('refuses a thread-safety word it does not know', () => {
    const { errors } = parse({ abi: 1, platforms: { 'win32-x64': 'fx.node' }, threadSafety: 'mostly' });
    expect(errors.join(' ')).toContain('native.threadSafety');
  });

  it('refuses a timeout that is not a positive number of milliseconds', () => {
    expect(parse({ abi: 1, platforms: { 'win32-x64': 'fx.node' }, timeoutMs: 0 }).errors.join(' '))
      .toContain('native.timeoutMs');
  });

  it('refuses a native block that is not an object at all', () => {
    expect(parse('bin/fx.node').errors.join(' ')).toContain('"native" must be an object');
  });
});

describe('hashes are advisory here, and only here', () => {
  it('drops a malformed hash rather than refusing the package', () => {
    // The hash that decides anything is the one the main process measures off
    // disk. A malformed one in the manifest is an author's packaging mistake,
    // not a reason the plugin cannot load.
    const { manifest, errors } = parse({
      abi: 1,
      platforms: { 'win32-x64': 'fx.node' },
      hashes: { 'fx.node': 'not-a-hash' },
    });
    expect(errors).toEqual([]);
    expect(manifest?.native?.hashes).toBeUndefined();
  });
});
