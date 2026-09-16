/**
 * The decisions the folder tier makes.
 *
 * Three of them carry the whole feature and each has a way of being wrong that
 * no type can catch: version comparison (string order says 10 < 9, which would
 * make an update lose to the copy it replaces), the trust gate (unsigned code
 * must not load without the user having said so), and re-consent (permissions
 * were granted against a manifest whose author edits it between reloads).
 */

import {
  checkLocalSignature,
  compareVersions,
  consentNeed,
  loadVerdict,
  resolveConflicts,
  type LocalPluginCandidate,
} from './localPlugins';
import { parseManifest, type PluginManifest, type PluginPermission } from './manifest';
import type { InstalledPlugin } from '@stores/pluginStore';

function manifestOf(
  version: string,
  permissions: PluginPermission[] = [],
  extra: Record<string, unknown> = {},
): PluginManifest {
  const { manifest, errors } = parseManifest({
    id: 'com.test.local',
    name: 'Local',
    version,
    description: 'A plugin read from a folder.',
    apiVersion: 1,
    main: 'main.js',
    permissions,
    ...extra,
  });
  if (!manifest) throw new Error(errors.join(' '));
  return manifest;
}

function candidate(over: Partial<LocalPluginCandidate> = {}): LocalPluginCandidate {
  return {
    path: '/plugins/local',
    kind: 'folder',
    source: 'user',
    root: '/plugins',
    manifestText: null,
    modifiedAt: 0,
    manifest: manifestOf('1.0.0'),
    problems: [],
    signature: null,
    ...over,
  };
}

function installed(over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    manifest: manifestOf('1.0.0'),
    files: {},
    granted: [],
    enabled: true,
    installedAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    // The one string comparison gets wrong, and the reason this is not `<`.
    ['10.0.0', '9.0.0', 1],
    ['1.2', '1.2.0', 0],
    ['2.0.0', '1.99.99', 1],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });

  it('sorts a pre-release below the release it precedes', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0-beta.2', '1.2.0-beta.1')).toBeGreaterThan(0);
  });
});

describe('resolveConflicts', () => {
  it('keeps the highest version and names the copy it ignored', () => {
    const older = candidate({ path: '/machine/local', source: 'machine', manifest: manifestOf('1.0.0') });
    const newer = candidate({ path: '/user/local', source: 'user', manifest: manifestOf('2.0.0') });
    const { plugins, conflicts } = resolveConflicts([older, newer]);
    expect(plugins.map((p) => p.path)).toEqual(['/user/local']);
    expect(conflicts).toEqual([
      { id: 'com.test.local', kept: '/user/local', keptVersion: '2.0.0', ignored: ['/machine/local'] },
    ]);
  });

  it('breaks a tie towards the earlier search path', () => {
    const first = candidate({ path: '/env/local', source: 'env' });
    const second = candidate({ path: '/machine/local', source: 'machine' });
    expect(resolveConflicts([first, second]).plugins.map((p) => p.path)).toEqual(['/env/local']);
  });

  it('reports nothing when there is no collision', () => {
    const a = candidate({ path: '/a' });
    const b = candidate({ path: '/b', manifest: parseManifest({
      id: 'com.test.other', name: 'Other', version: '1.0.0', description: 'x',
      apiVersion: 1, main: 'main.js', permissions: [],
    }).manifest! });
    const { plugins, conflicts } = resolveConflicts([a, b]);
    expect(plugins).toHaveLength(2);
    expect(conflicts).toEqual([]);
  });

  it('drops candidates with no manifest', () => {
    expect(resolveConflicts([candidate({ manifest: null })]).plugins).toEqual([]);
  });
});

describe('the trust gate', () => {
  it('refuses an unsigned folder and names the switch', () => {
    const verdict = loadVerdict(candidate(), false);
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.reason).toMatch(/Developer Mode/);
  });

  it('allows an unsigned folder once developer mode is on', () => {
    expect(loadVerdict(candidate(), true)).toEqual({ allowed: true, trust: 'developer' });
  });

  it('allows a signed archive without developer mode', () => {
    const signed = candidate({ kind: 'archive', signature: { ok: true, publisherKey: 'KEY' } });
    expect(loadVerdict(signed, false)).toEqual({ allowed: true, trust: 'signed' });
  });

  /*
    A BROKEN signature is not the same as no signature. Something claimed these
    bytes were signed and they are not the bytes that were signed.
  */
  it('says a signature failed rather than calling it unsigned', () => {
    const bad = candidate({ kind: 'archive', signature: { ok: false, reason: 'the signature does not match these bytes' } });
    const verdict = loadVerdict(bad, false);
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.reason).toMatch(/Signature check failed/);
  });

  it('refuses anything with no manifest, whatever the mode', () => {
    const broken = candidate({ manifest: null, problems: ['plugin.json is not valid JSON.'] });
    expect(loadVerdict(broken, true).allowed).toBe(false);
  });
});

describe('re-consent', () => {
  it('asks for an id this machine has never seen', () => {
    expect(consentNeed(manifestOf('1.0.0'), undefined, null)).toBe('new');
  });

  it('does not ask for an unchanged reload', () => {
    const existing = installed({ granted: ['scene:read'], manifest: manifestOf('1.0.0', ['scene:read']) });
    expect(consentNeed(manifestOf('1.0.1', ['scene:read']), existing, null)).toBe('none');
  });

  /*
    The rule this file exists for. A folder plugin's manifest is a file its
    author edits between one reload and the next, so yesterday's grant cannot
    authorise today's wider ask.
  */
  it('asks when the manifest grew a permission', () => {
    const existing = installed({ granted: ['scene:read'], manifest: manifestOf('1.0.0', ['scene:read']) });
    expect(consentNeed(manifestOf('1.1.0', ['scene:read', 'scene:write']), existing, null)).toBe('permissions');
  });

  it('does not ask when the manifest asks for less', () => {
    const existing = installed({ granted: ['scene:read', 'scene:write'] });
    expect(consentNeed(manifestOf('1.1.0', ['scene:read']), existing, null)).toBe('none');
  });

  it('asks when a sandboxed plugin turns native', () => {
    const existing = installed({ manifest: manifestOf('1.0.0') });
    expect(consentNeed(manifestOf('2.0.0', [], { runtime: 'native' }), existing, null)).toBe('tier');
  });

  it('asks when a signed package arrives under a different key', () => {
    const existing = installed({ publisherKey: 'PINNED' });
    expect(consentNeed(manifestOf('1.0.1'), existing, { ok: true, publisherKey: 'OTHER' })).toBe('publisher');
  });

  it('is quiet when the same key signed it again', () => {
    const existing = installed({ publisherKey: 'PINNED' });
    expect(consentNeed(manifestOf('1.0.1'), existing, { ok: true, publisherKey: 'PINNED' })).toBe('none');
  });
});

describe('the signature sidecar', () => {
  it('is null when there is no .sig file', async () => {
    expect(await checkLocalSignature(new Uint8Array([1]), undefined)).toBeNull();
  });

  it('refuses a .sig that is not JSON', async () => {
    const out = await checkLocalSignature(new Uint8Array([1]), 'not json');
    expect(out).toEqual({ ok: false, reason: 'the .sig file is not valid JSON' });
  });

  it('refuses a .sig with no key', async () => {
    const out = await checkLocalSignature(new Uint8Array([1]), JSON.stringify({ signature: 'abc' }));
    expect(out?.ok).toBe(false);
  });

  it('refuses a signature that does not verify', async () => {
    const out = await checkLocalSignature(
      new Uint8Array([1]),
      JSON.stringify({ signature: 'AAAA', publicKey: 'AAAA' }),
    );
    expect(out).toEqual({ ok: false, reason: 'the signature does not match these bytes' });
  });
});
