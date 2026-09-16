/**
 * The gate in front of compiled code.
 *
 * Every case here is a way someone could end up running a binary they did not
 * agree to, and each one is closed separately:
 *
 *   • unsigned, no Developer Mode        → refused, not asked about
 *   • signed but never consented to      → asked
 *   • consented to, then the file CHANGED → asked again
 *   • consented to, same version, same bytes → not asked (an author's loop)
 *   • revoked                            → refused before anything else, and
 *                                          the record is destroyed
 *
 * The one worth stating out loud is the third. Version numbers are written by
 * the author; a hash is written by the bytes. Pinning the hash is what makes
 * "you agreed to THIS code" survive a swap that keeps the version string, which
 * is the only shape of this attack worth writing.
 */

import {
  getNativeConsent,
  killNativeConsent,
  nativeConsentSummary,
  nativeTrustVerdict,
  needsNativeConsent,
  recordNativeConsent,
  resetNativeConsentForTests,
  shortHash,
  type NativeConsent,
} from './nativeTrust';
import type { NativeSelection } from './nativePlatforms';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const SELECTION: NativeSelection = {
  ok: true,
  key: 'win32-x64',
  path: 'bin/win32-x64/fx.node',
  sha256: HASH_A,
};

const CONSENT: NativeConsent = {
  at: 1,
  version: '1.0.0',
  platformKey: 'win32-x64',
  binaryPath: 'bin/win32-x64/fx.node',
  sha256: HASH_A,
  basis: 'signed',
};

function verdict(overrides: Partial<Parameters<typeof nativeTrustVerdict>[0]> = {}) {
  return nativeTrustVerdict({
    pluginId: 'studio.acme.fx',
    pluginName: 'Acme FX',
    version: '1.0.0',
    selection: SELECTION,
    sha256: HASH_A,
    signature: { ok: true, publisherKey: 'KEY' },
    developerMode: false,
    revoked: false,
    ...overrides,
  });
}

beforeEach(() => { resetNativeConsentForTests(); });

describe('provenance', () => {
  it('refuses an unsigned package outright when Developer Mode is off', () => {
    const result = verdict({ signature: null });
    expect(result).toMatchObject({ allowed: false, code: 'not-signed' });
    // Not askable: a prompt here would be asking the user to vouch for bytes
    // nobody can say anything about.
    expect(result.allowed === false && result.askable).toBe(false);
    expect(result.allowed === false && result.error).toContain('Developer Mode');
  });

  it('refuses a package whose signature does not match, and says why', () => {
    const result = verdict({ signature: { ok: false, reason: 'the signature does not match these bytes' } });
    expect(result).toMatchObject({ allowed: false, code: 'not-signed' });
    expect(result.allowed === false && result.error).toContain('does not match these bytes');
  });

  it('lets an unsigned working copy through Developer Mode — and still asks', () => {
    const result = verdict({ signature: null, developerMode: true });
    expect(result).toMatchObject({ allowed: false, code: 'no-consent', askable: true });
  });

  it('records the basis it was allowed on', () => {
    recordNativeConsent('studio.acme.fx', CONSENT);
    expect(verdict({ signature: null, developerMode: true })).toMatchObject({
      allowed: true,
      basis: 'developer',
    });
    expect(verdict()).toMatchObject({ allowed: true, basis: 'signed' });
  });
});

describe('consent, pinned to the bytes', () => {
  it('asks for a plugin that has never been allowed', () => {
    expect(verdict()).toMatchObject({ allowed: false, code: 'no-consent', askable: true });
  });

  it('does not ask again for the same binary', () => {
    recordNativeConsent('studio.acme.fx', CONSENT);
    expect(verdict()).toMatchObject({ allowed: true });
  });

  it('asks again when the FILE changed under the same version', () => {
    recordNativeConsent('studio.acme.fx', CONSENT);
    const result = verdict({ sha256: HASH_B });
    expect(result).toMatchObject({ allowed: false, code: 'no-consent', askable: true });
    expect(result.allowed === false && result.error).toContain('has changed');
  });

  it('does not ask for a version bump that ships the identical binary', () => {
    // A manifest edit is not new code. Prompting for it trains people to click
    // through the prompt that matters.
    recordNativeConsent('studio.acme.fx', CONSENT);
    expect(verdict({ version: '1.0.1' })).toMatchObject({ allowed: true });
  });

  it('asks on a different platform, because that is a different build', () => {
    recordNativeConsent('studio.acme.fx', CONSENT);
    expect(needsNativeConsent(CONSENT, {
      version: '1.0.0',
      platformKey: 'darwin-arm64',
      binaryPath: 'bin/darwin-arm64/fx.node',
      sha256: HASH_A,
    })).toBe(true);
  });

  it('survives being written and read back', () => {
    recordNativeConsent('studio.acme.fx', CONSENT);
    expect(getNativeConsent('studio.acme.fx')).toMatchObject({ sha256: HASH_A });
  });
});

describe('the refusals that come first', () => {
  it('refuses a revoked plugin before asking anything else', () => {
    recordNativeConsent('studio.acme.fx', CONSENT);
    const result = verdict({ revoked: true });
    expect(result).toMatchObject({ allowed: false, code: 'revoked', askable: false });
  });

  it('kills the consent record, so nothing starts it again', () => {
    recordNativeConsent('studio.acme.fx', CONSENT);
    killNativeConsent('studio.acme.fx');
    expect(getNativeConsent('studio.acme.fx')).toBeNull();
    expect(verdict()).toMatchObject({ allowed: false, code: 'no-consent' });
  });

  it('refuses a machine the package has no binary for, without a prompt', () => {
    const result = verdict({
      selection: {
        ok: false,
        code: 'unsupported-platform',
        error: 'not built for Linux (x64)',
        available: ['win32-x64'],
      },
    });
    expect(result).toMatchObject({ allowed: false, code: 'unsupported-platform', askable: false });
  });

  it('refuses when there is no hash to pin to', () => {
    // Consent is pinned to a hash. Without one there is nothing to agree to,
    // and "allow anyway" would make every later comparison meaningless.
    const result = verdict({ sha256: undefined });
    expect(result).toMatchObject({ allowed: false, code: 'missing-binary' });
  });
});

describe('what the user is actually told', () => {
  const summary = (basis: 'signed' | 'developer'): string => nativeConsentSummary({
    pluginName: 'Acme FX',
    binaryPath: 'bin/win32-x64/fx.node',
    sha256: HASH_A,
    platformKey: 'win32-x64',
    basis,
    publisher: 'Acme',
  });

  it('names the file, the platform and the hash', () => {
    const text = summary('signed');
    expect(text).toContain('bin/win32-x64/fx.node');
    expect(text).toContain('win32-x64');
    expect(text).toContain(shortHash(HASH_A));
  });

  it('says the sentence that matters, rather than listing capabilities', () => {
    const text = summary('signed');
    expect(text).toContain('OUTSIDE the plugin sandbox');
    expect(text).toContain('full user privileges');
    // The permission list governs a boundary that does not exist here, and the
    // prompt has to say so — otherwise a user reads this as one more permission.
    expect(text).toContain('permission list does not limit it');
    expect(text).toContain('asked again');
  });

  it('says plainly when nothing has vouched for the bytes', () => {
    expect(summary('developer')).toContain('NOT signed');
    expect(summary('signed')).toContain('signed by Acme');
  });
});
