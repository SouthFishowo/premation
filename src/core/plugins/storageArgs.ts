/**
 * The two spellings of the storage verbs, told apart in the worker.
 *
 * ── Why there are two ────────────────────────────────────────────────────────
 *
 * The guide has always documented KEY-first — `storage.set(key, value, scope)`
 * with the scope optional and defaulting to `'global'` — while the worker
 * shipped SCOPE-first, `storage.set(scope, key, value)`. Every plugin written
 * from the guide therefore threw on its first write: `"lastPreset" is not a
 * storage scope`. Both spellings exist in published code now, so the fix is to
 * accept both rather than pick a side and break the other half.
 *
 * Key-first is canonical and is what the guide teaches. Scope-first keeps
 * working as the legacy form.
 *
 * ── The rule, and why it is by arity ─────────────────────────────────────────
 *
 * A call is scope-first when its FIRST argument is exactly `'global'` or
 * `'project'` AND it carries at least as many arguments as the scope-first form
 * needs (get/delete: 2, set: 3). Everything else is key-first.
 *
 * Arity rather than "does the first argument look like a scope" alone, because
 * `storage.get('project')` is a perfectly good key-first read of a key named
 * `project`, and `storage.set('global', 'dark')` cannot be scope-first at all —
 * it has no value. The cost is one real ambiguity, stated in the guide: a key
 * literally named `global` or `project`, passed with an explicit scope, reads
 * as scope-first. Name keys something else.
 *
 * The RPC protocol is unchanged — the host still receives `(scope, key, …)` —
 * so this is purely a worker-side normalisation and an older host is unaffected.
 */

export type StorageScopeName = 'global' | 'project';

const isScope = (v: unknown): v is StorageScopeName => v === 'global' || v === 'project';

/** The canonical signatures, quoted in every refusal. */
export const STORAGE_SIGNATURES = Object.freeze({
  get: 'storage.get(key, scope?)',
  set: 'storage.set(key, value, scope?)',
  delete: 'storage.delete(key, scope?)',
  list: 'storage.list(scope?, prefix?)',
});

type Verb = keyof typeof STORAGE_SIGNATURES;

function refuse(verb: Verb, why: string): never {
  throw new Error(
    `${why} Expected ${STORAGE_SIGNATURES[verb]} — scope is 'global' (the default) or 'project'. `
    + `The older ${verb === 'list' ? 'storage.list(scope, prefix?)' : `storage.${verb}(scope, key${verb === 'set' ? ', value' : ''})`} `
    + 'order is also accepted.',
  );
}

/** A trailing scope: absent means `'global'`, anything else must be a scope name. */
function trailingScope(verb: Verb, v: unknown): StorageScopeName {
  if (v === undefined) return 'global';
  if (isScope(v)) return v;
  return refuse(verb, `"${String(v)}" is not a storage scope.`);
}

function keyOf(verb: Verb, v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) {
    refuse(verb, `The key must be a non-empty string, got ${v === undefined ? 'nothing' : typeof v}.`);
  }
  return v as string;
}

export function parseStorageGet(args: readonly unknown[]): { scope: StorageScopeName; key: string } {
  if (args.length === 0) refuse('get', 'storage.get needs a key.');
  if (args.length >= 2 && isScope(args[0])) return { scope: args[0], key: keyOf('get', args[1]) };
  return { key: keyOf('get', args[0]), scope: trailingScope('get', args[1]) };
}

export function parseStorageDelete(args: readonly unknown[]): { scope: StorageScopeName; key: string } {
  if (args.length === 0) refuse('delete', 'storage.delete needs a key.');
  if (args.length >= 2 && isScope(args[0])) return { scope: args[0], key: keyOf('delete', args[1]) };
  return { key: keyOf('delete', args[0]), scope: trailingScope('delete', args[1]) };
}

export function parseStorageSet(
  args: readonly unknown[],
): { scope: StorageScopeName; key: string; value: unknown } {
  if (args.length < 2) refuse('set', 'storage.set needs a key and a value.');
  if (args.length >= 3 && isScope(args[0])) {
    return { scope: args[0], key: keyOf('set', args[1]), value: args[2] };
  }
  return { key: keyOf('set', args[0]), value: args[1], scope: trailingScope('set', args[2]) };
}

/**
 * `list` has no key, so the two orders are `(scope?, prefix?)` and the
 * key-first-shaped `(prefix, scope)`. The second is recognised only when the
 * SECOND argument is a scope and the first is not — otherwise a prefix that
 * happens to be named `global` would be read as a scope.
 */
export function parseStorageList(args: readonly unknown[]): { scope: StorageScopeName; prefix?: string } {
  const [a, b] = args;
  if (a === undefined) return { scope: 'global' };
  if (isScope(a)) {
    if (b !== undefined && typeof b !== 'string') refuse('list', 'The prefix must be a string.');
    return b === undefined ? { scope: a } : { scope: a, prefix: b as string };
  }
  if (typeof a === 'string' && isScope(b)) return { scope: b, prefix: a };
  return refuse('list', `"${String(a)}" is not a storage scope.`);
}
