/**
 * The version contract, and the four files that have to agree about it.
 *
 * The check itself is small and the consequence of getting it wrong is not: a
 * host that calls into a binary built against a different struct layout does
 * not get a wrong answer, it gets a crash — and, on the wrong day, a corrupted
 * project. So both directions are refused, and both messages have to name both
 * numbers, because "incompatible" leaves the user and the author each guessing
 * which of them has to act.
 *
 * The drift test is the other half. The ABI number lives in four files that the
 * build cannot make import one another — a C header for addon authors, the
 * SDK's TypeScript, the renderer's copy and the main process's, which compiles
 * alone. Four copies of a number is exactly the arrangement that silently
 * decays, so it is read back out of the files here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NATIVE_ABI_MAJOR,
  NATIVE_ABI_MINOR,
  NATIVE_ABI_VERSION,
  NATIVE_EXPORTS,
  checkNativeAbi,
} from './nativeAbi';
import {
  KNOWN_NATIVE_PLATFORMS,
  nativePlatformKey,
  nativePlatformLabel,
  selectNativeBinary,
} from './nativePlatforms';
import type { PluginNative } from '../manifest';

const REPO = join(__dirname, '..', '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), 'utf8');

describe('the packed version', () => {
  it('is major * 1000 + minor', () => {
    expect(NATIVE_ABI_VERSION).toBe(NATIVE_ABI_MAJOR * 1000 + NATIVE_ABI_MINOR);
  });

  it('names the five exports an addon has to provide', () => {
    expect([...NATIVE_EXPORTS]).toEqual([
      'motion_plugin_abi_version',
      'motion_plugin_register',
      'motion_plugin_describe',
      'motion_plugin_render',
      'motion_plugin_dispose',
    ]);
  });
});

describe('refusing a module this build cannot call', () => {
  it('accepts its own version', () => {
    expect(checkNativeAbi(NATIVE_ABI_VERSION)).toEqual({ ok: true });
  });

  it('accepts an OLDER minor — the fields it knows about are all still sent', () => {
    expect(checkNativeAbi(3000, { major: 3, minor: 4 })).toEqual({ ok: true });
  });

  it('refuses a NEWER minor, because it expects fields this host does not send', () => {
    const result = checkNativeAbi(3005, { major: 3, minor: 4 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('abi-mismatch');
    expect(result.error).toContain('3.5');
    expect(result.error).toContain('3.4');
    expect(result.error).toContain('Update the app');
  });

  it('tells the USER to update when the module is newer', () => {
    expect(checkNativeAbi(2000, { major: 1, minor: 0 }).error).toContain('Update the app');
  });

  it('tells the AUTHOR to rebuild when the module is older', () => {
    expect(checkNativeAbi(1000, { major: 2, minor: 0 }).error).toContain('Ask the author');
  });

  it('refuses anything that is not a whole number, including nothing at all', () => {
    for (const bad of [undefined, null, 'v1', 1.5, -1, NaN]) {
      expect(checkNativeAbi(bad).ok).toBe(false);
    }
  });
});

describe('the four copies of the number', () => {
  const majorOf = (src: string, name: string): number =>
    Number(new RegExp(`${name}\\s*=?\\s*(\\d+)`).exec(src)?.[1]);

  it('matches the C header addon authors compile against', () => {
    const header = read('packages', 'plugin-native-sdk', 'include', 'motion_plugin_abi.h');
    expect(majorOf(header, 'MOTION_PLUGIN_ABI_MAJOR')).toBe(NATIVE_ABI_MAJOR);
    expect(majorOf(header, 'MOTION_PLUGIN_ABI_MINOR')).toBe(NATIVE_ABI_MINOR);
  });

  it('matches the SDK types', () => {
    const sdk = read('packages', 'plugin-native-sdk', 'src', 'abi.ts');
    expect(majorOf(sdk, 'MOTION_PLUGIN_ABI_MAJOR')).toBe(NATIVE_ABI_MAJOR);
    expect(majorOf(sdk, 'MOTION_PLUGIN_ABI_MINOR')).toBe(NATIVE_ABI_MINOR);
  });

  it('matches the main process, which compiles alone and cannot import this', () => {
    const main = read('electron', 'pluginNativeAbi.ts');
    expect(majorOf(main, 'NATIVE_ABI_MAJOR')).toBe(NATIVE_ABI_MAJOR);
    expect(majorOf(main, 'NATIVE_ABI_MINOR')).toBe(NATIVE_ABI_MINOR);
  });

  it('spells the five exports identically in the header and here', () => {
    const header = read('packages', 'plugin-native-sdk', 'include', 'motion_plugin_abi.h');
    for (const name of NATIVE_EXPORTS) expect(header).toContain(`"${name}"`);
  });
});

describe('picking a binary for this machine', () => {
  const native: PluginNative = {
    abi: 1,
    platforms: {
      'win32-x64': 'bin/win32-x64/fx.node',
      'darwin-arm64': 'bin/darwin-arm64/fx.node',
    },
    hashes: { 'bin/win32-x64/fx.node': 'a'.repeat(64) },
  };

  it('looks up platform-arch and nothing cleverer', () => {
    expect(nativePlatformKey('win32', 'x64')).toBe('win32-x64');
    const picked = selectNativeBinary(native, 'win32', 'x64');
    expect(picked).toMatchObject({ ok: true, path: 'bin/win32-x64/fx.node', sha256: 'a'.repeat(64) });
  });

  it('does not fall back to another architecture', () => {
    // An x64 binary in an arm64 utility process does not run under Rosetta, and
    // a silent fallback would work on the author's machine and not the user's.
    const picked = selectNativeBinary(native, 'darwin', 'x64');
    expect(picked).toMatchObject({ ok: false, code: 'unsupported-platform' });
  });

  it('says what the package DOES support, so the message is actionable', () => {
    const picked = selectNativeBinary(native, 'linux', 'x64');
    expect(picked.ok).toBe(false);
    if (picked.ok) return;
    expect(picked.error).toContain('Windows');
    expect(picked.error).toContain('macOS');
    expect(picked.available).toEqual(['win32-x64', 'darwin-arm64']);
  });

  it('distinguishes "no binary here" from "no native module at all"', () => {
    expect(selectNativeBinary(undefined, 'win32', 'x64')).toMatchObject({ code: 'not-declared' });
  });

  it('carries a platform key this build has never heard of', () => {
    // A package built for a platform the app grows support for next year must
    // stay readable today.
    const future = { abi: 1, platforms: { 'freebsd-riscv64': 'bin/fx.node' } };
    expect(selectNativeBinary(future, 'freebsd', 'riscv64')).toMatchObject({ ok: true });
    expect(KNOWN_NATIVE_PLATFORMS).not.toContain('freebsd-riscv64');
  });

  it('labels a key for a person rather than for a lookup', () => {
    expect(nativePlatformLabel('darwin-arm64')).toBe('macOS (arm64)');
  });
});
