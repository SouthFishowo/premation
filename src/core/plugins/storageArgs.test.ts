/**
 * Both spellings of the storage verbs, and the refusals between them.
 *
 * The guide documented `storage.set(key, value, scope)` while the worker took
 * `(scope, key, value)`, so every plugin written from the guide threw on its
 * first write. Both orders are in published plugins now; these pin that each
 * one lands on the same `(scope, key, …)` the host receives, and that a call
 * matching neither is refused with the signature it should have used.
 */

import {
  parseStorageDelete,
  parseStorageGet,
  parseStorageList,
  parseStorageSet,
} from './storageArgs';

describe('key-first — the documented form', () => {
  it('defaults the scope to global', () => {
    expect(parseStorageGet(['theme'])).toEqual({ scope: 'global', key: 'theme' });
    expect(parseStorageSet(['theme', 'dark'])).toEqual({ scope: 'global', key: 'theme', value: 'dark' });
    expect(parseStorageDelete(['theme'])).toEqual({ scope: 'global', key: 'theme' });
  });

  it('takes an explicit trailing scope', () => {
    expect(parseStorageGet(['seed', 'project'])).toEqual({ scope: 'project', key: 'seed' });
    expect(parseStorageSet(['seed', 42, 'project'])).toEqual({ scope: 'project', key: 'seed', value: 42 });
    expect(parseStorageDelete(['seed', 'project'])).toEqual({ scope: 'project', key: 'seed' });
  });

  it('★ reads a key NAMED like a scope as a key when nothing follows it', () => {
    // Arity decides, not the string alone: a one-argument get cannot be the
    // scope-first form, which needs two.
    expect(parseStorageGet(['project'])).toEqual({ scope: 'global', key: 'project' });
    // A two-argument set is never scope-first — it would have no value.
    expect(parseStorageSet(['global', 'dark'])).toEqual({ scope: 'global', key: 'global', value: 'dark' });
  });

  it('stores falsy values rather than mistaking them for a missing argument', () => {
    expect(parseStorageSet(['count', 0])).toEqual({ scope: 'global', key: 'count', value: 0 });
    expect(parseStorageSet(['flag', false, 'project'])).toEqual({ scope: 'project', key: 'flag', value: false });
  });
});

describe('scope-first — the legacy form', () => {
  it('keeps working for every verb', () => {
    expect(parseStorageGet(['global', 'theme'])).toEqual({ scope: 'global', key: 'theme' });
    expect(parseStorageSet(['project', 'spine', 'layer_7'])).toEqual({
      scope: 'project', key: 'spine', value: 'layer_7',
    });
    expect(parseStorageDelete(['project', 'spine'])).toEqual({ scope: 'project', key: 'spine' });
  });
});

describe('list', () => {
  it('accepts no arguments, a scope, a scope and prefix, or a prefix and scope', () => {
    expect(parseStorageList([])).toEqual({ scope: 'global' });
    expect(parseStorageList(['project'])).toEqual({ scope: 'project' });
    expect(parseStorageList(['global', 'ui.'])).toEqual({ scope: 'global', prefix: 'ui.' });
    expect(parseStorageList(['ui.', 'project'])).toEqual({ scope: 'project', prefix: 'ui.' });
  });

  it('refuses a lone string that is not a scope, naming the signature', () => {
    expect(() => parseStorageList(['ui.'])).toThrow(/storage\.list\(scope\?, prefix\?\)/);
  });
});

describe('refusals name the expected signature', () => {
  it('a misspelled trailing scope', () => {
    expect(() => parseStorageSet(['theme', 'dark', 'glbal'])).toThrow(/"glbal" is not a storage scope/);
    expect(() => parseStorageSet(['theme', 'dark', 'glbal'])).toThrow(/storage\.set\(key, value, scope\?\)/);
  });

  it('a missing key or value', () => {
    expect(() => parseStorageGet([])).toThrow(/storage\.get\(key, scope\?\)/);
    expect(() => parseStorageSet(['onlyKey'])).toThrow(/needs a key and a value/);
  });

  it('a key that is not a string', () => {
    expect(() => parseStorageGet([42])).toThrow(/key must be a non-empty string/);
    expect(() => parseStorageSet(['project', 7, 'x'])).toThrow(/key must be a non-empty string/);
  });

  it('mentions that the older order is still accepted', () => {
    expect(() => parseStorageDelete([])).toThrow(/storage\.delete\(scope, key\)/);
  });
});
