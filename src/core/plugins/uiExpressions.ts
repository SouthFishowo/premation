/**
 * Expression functions a plugin contributes, and the one honest way to make an
 * asynchronous plugin callable from a synchronous interpreter.
 *
 * ── The problem, stated plainly ──────────────────────────────────────────────
 *
 * The expression engine is synchronous by construction: `evaluateExpression`
 * interprets an AST and calls `fn.apply(...)`, once per animated property per
 * frame, inside the frame budget. A plugin lives in a Worker and every call to
 * it is a `postMessage` round trip. There is no arrangement of those two facts
 * in which a plugin's JavaScript runs *during* an expression evaluation, and
 * pretending otherwise would mean either blocking the render thread on a worker
 * (`Atomics.wait` on the main thread, which the platform forbids and which
 * would be a hang if it did not) or making every expression async, which would
 * change the meaning of every expression already written.
 *
 * ── What is implemented instead: precomputed values with a live cache ────────
 *
 * A contributed function is SYNCHRONOUS AT THE CALL SITE and answers from a
 * cache:
 *
 *   1. `plugin.<namespace>.<name>(args…)` looks the arguments up in the cache.
 *   2. A hit returns the plugin's value immediately — no round trip, no stall.
 *   3. A miss returns the DECLARED DEFAULT and asks the worker, once, for that
 *      argument list. When the answer arrives it lands in the cache and the
 *      host bumps the animation revision, so the next frame is correct.
 *
 * The visible consequence, which is documented rather than hidden: the first
 * frame that calls a function with new arguments uses the declared default, and
 * the frame after it uses the plugin's value. For a plugin driving animation
 * from data it has already computed — the case this exists for — every call is
 * a hit, because a plugin is expected to push its values with
 * `motion.expressions.provide(...)` when it computes them.
 *
 * This is the same shape AE's own answer has: an effect's expression-visible
 * output is what the last render produced, not a callback into the plugin.
 *
 * ── Why one `plugin` namespace object ────────────────────────────────────────
 *
 * The expression scope is a flat `Map` whose contents are pinned by
 * `expressionApi.test.ts` — every bound name must appear in the autocomplete
 * table and vice versa. Names that appear and disappear with what the user has
 * installed cannot satisfy that, and should not: `wiggle` is part of the
 * language and `plugin.acme_lab.pulse` is not. So exactly one name is bound,
 * `plugin`, and everything a plugin contributes hangs off it.
 */

export interface PluginExpressionContribution {
  /** camelCase; the member name under the plugin's namespace. */
  name: string;
  /** How many arguments it takes. Fixed — the cache key is the argument list. */
  args: number;
  /** What a call returns before the plugin has answered for those arguments. */
  default: number | number[];
  /** One line for the expression editor's autocomplete hint. */
  description?: string;
}

export const MAX_EXPRESSIONS_PER_PLUGIN = 8;
export const MAX_EXPRESSION_ARGS = 4;
/** Cached results per function. Past it, the oldest argument list is dropped. */
export const MAX_CACHED_RESULTS = 256;

const NAME_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;

/** Validate `contributes.expressions`, pushing messages rather than throwing. */
export function parsePluginExpressions(
  raw: unknown,
  at: string,
  errors: string[],
): PluginExpressionContribution[] {
  const out: PluginExpressionContribution[] = [];
  if (!Array.isArray(raw)) {
    errors.push(`"${at}" must be an array.`);
    return out;
  }
  if (raw.length > MAX_EXPRESSIONS_PER_PLUGIN) {
    errors.push(`"${at}" declares ${raw.length} functions; the limit is ${MAX_EXPRESSIONS_PER_PLUGIN}.`);
    return out;
  }

  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`"${where}" must be an object.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : '';
    if (!NAME_RE.test(name)) {
      errors.push(`"${where}.name" must be camelCase letters and digits (1–32 characters).`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`"${where}.name" duplicates an earlier function "${name}".`);
      return;
    }
    seen.add(name);

    const args = e.args === undefined ? 1 : e.args;
    if (typeof args !== 'number' || !Number.isInteger(args) || args < 0 || args > MAX_EXPRESSION_ARGS) {
      errors.push(`"${where}.args" must be a whole number from 0 to ${MAX_EXPRESSION_ARGS}.`);
      return;
    }
    const fallback = e.default;
    if (!isExpressionValue(fallback)) {
      // Required, and the reason is the whole design: a miss has to return
      // SOMETHING, and a function that returns undefined on its first frame
      // makes every expression using it throw on the frame the user adds it.
      errors.push(`"${where}.default" is required — a number, or an array of 2–4 numbers.`);
      return;
    }
    if (e.description !== undefined && (typeof e.description !== 'string' || e.description.length > 120)) {
      errors.push(`"${where}.description", when present, is at most 120 characters.`);
      return;
    }

    out.push({
      name,
      args,
      default: Array.isArray(fallback) ? [...fallback] : fallback,
      ...(typeof e.description === 'string' && e.description ? { description: e.description } : {}),
    });
  });

  return out;
}

/** A number, or a short vector. Anything an expression can go on to use. */
export function isExpressionValue(v: unknown): v is number | number[] {
  if (typeof v === 'number') return Number.isFinite(v);
  if (!Array.isArray(v) || v.length < 2 || v.length > 4) return false;
  return v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * A plugin id as an identifier-safe namespace.
 *
 * `studio.acme-lab` → `studio_acme_lab`, so an author writes
 * `plugin.studio_acme_lab.pulse(time)` rather than bracket-indexing a string.
 * Two plugins CAN collide here (`a.b-c` and `a-b.c` fold to the same thing);
 * the registry refuses the second rather than letting one shadow the other.
 */
export function expressionNamespace(pluginId: string): string {
  return pluginId.replace(/[.-]/g, '_');
}

interface RegisteredFn {
  pluginId: string;
  decl: PluginExpressionContribution;
  /** Argument list (JSON) → the plugin's latest value. */
  cache: Map<string, number | number[]>;
  /** Argument lists already asked for and not yet answered. */
  pending: Set<string>;
}

type ComputeHook = (pluginId: string, name: string, args: readonly number[]) => void;

const byNamespace = new Map<string, { pluginId: string; fns: Map<string, RegisteredFn> }>();
let compute: ComputeHook | null = null;
let onValue: (() => void) | null = null;
/** Invalidated whenever the set of functions changes, never per call. */
let namespaceCache: Readonly<Record<string, unknown>> | null = null;

/**
 * Wire the registry to the host.
 *
 * `compute` asks a plugin for one argument list; `onValue` is called when an
 * answer lands, so whatever holds sampled values can invalidate. Injected
 * rather than imported: this module is read by the animation package, which
 * must not pull the plugin host into a test that has no worker.
 */
export function configurePluginExpressions(hooks: { compute: ComputeHook; onValue: () => void }): void {
  compute = hooks.compute;
  onValue = hooks.onValue;
}

/** Put one plugin's declared functions in the registry. Returns any refusals. */
export function registerPluginExpressions(
  pluginId: string,
  contributions: readonly PluginExpressionContribution[],
): string[] {
  unregisterPluginExpressions(pluginId);
  if (contributions.length === 0) return [];

  const ns = expressionNamespace(pluginId);
  const held = byNamespace.get(ns);
  if (held && held.pluginId !== pluginId) {
    return [
      `its expression namespace "${ns}" is already used by "${held.pluginId}", so none of its `
      + 'expression functions were registered. Rename the plugin id to claim a distinct namespace.',
    ];
  }

  const fns = new Map<string, RegisteredFn>();
  for (const decl of contributions) {
    fns.set(decl.name, { pluginId, decl, cache: new Map(), pending: new Set() });
  }
  byNamespace.set(ns, { pluginId, fns });
  namespaceCache = null;
  return [];
}

export function unregisterPluginExpressions(pluginId: string): void {
  const ns = expressionNamespace(pluginId);
  const held = byNamespace.get(ns);
  if (!held || held.pluginId !== pluginId) return;
  byNamespace.delete(ns);
  namespaceCache = null;
}

/** A value a plugin computed, for one argument list. */
export function providePluginExpressionValue(
  pluginId: string,
  name: string,
  args: readonly number[],
  value: number | number[],
): boolean {
  const entry = byNamespace.get(expressionNamespace(pluginId));
  const fn = entry?.pluginId === pluginId ? entry.fns.get(name) : undefined;
  if (!fn || !isExpressionValue(value)) return false;

  const key = argKey(args);
  fn.pending.delete(key);
  // Bounded, and oldest-first. An expression evaluated over a scrub calls with
  // a new `time` every frame, so an unbounded cache here is a leak with a
  // user-controlled growth rate.
  if (fn.cache.size >= MAX_CACHED_RESULTS && !fn.cache.has(key)) {
    const oldest = fn.cache.keys().next();
    if (!oldest.done) fn.cache.delete(oldest.value);
  }
  fn.cache.set(key, Array.isArray(value) ? [...value] : value);
  onValue?.();
  return true;
}

/**
 * The `plugin` object bound into the expression scope.
 *
 * Rebuilt only when the registry changes. The scope `Map` is rebuilt on every
 * `run`, which is once per animated property per frame, so anything allocated
 * here would be allocated thousands of times a second.
 */
export function pluginExpressionScope(): Readonly<Record<string, unknown>> {
  if (namespaceCache) return namespaceCache;

  const root: Record<string, unknown> = {};
  for (const [ns, entry] of byNamespace) {
    const members: Record<string, unknown> = {};
    for (const [name, fn] of entry.fns) {
      members[name] = (...raw: unknown[]): number | number[] => {
        const args: number[] = [];
        for (let i = 0; i < fn.decl.args; i += 1) {
          const n = raw[i];
          args.push(typeof n === 'number' && Number.isFinite(n) ? n : 0);
        }
        const key = argKey(args);
        const hit = fn.cache.get(key);
        if (hit !== undefined) return Array.isArray(hit) ? [...hit] : hit;
        if (!fn.pending.has(key)) {
          fn.pending.add(key);
          // Fire and forget, exactly once per argument list. An expression is
          // evaluated many times per second and a request per evaluation would
          // be a flood into a worker that answers at its own pace.
          compute?.(fn.pluginId, name, args);
        }
        return Array.isArray(fn.decl.default) ? [...fn.decl.default] : fn.decl.default;
      };
    }
    root[ns] = Object.freeze(members);
  }

  namespaceCache = Object.freeze(root);
  return namespaceCache;
}

/** Is anything contributing expression functions right now? */
export function hasPluginExpressions(): boolean {
  return byNamespace.size > 0;
}

/** Every registered function, for the expression editor's hint list. */
export function pluginExpressionHints(): Array<{ insert: string; label: string; hint: string }> {
  const out: Array<{ insert: string; label: string; hint: string }> = [];
  for (const [ns, entry] of byNamespace) {
    for (const [name, fn] of entry.fns) {
      out.push({
        insert: `plugin.${ns}.${name}(`,
        label: `plugin.${ns}.${name}()`,
        hint: fn.decl.description ?? `From ${entry.pluginId}.`,
      });
    }
  }
  return out;
}

function argKey(args: readonly number[]): string {
  return args.join(',');
}

/** Tests only — the registry is process-wide. */
export function resetPluginExpressionsForTests(): void {
  byNamespace.clear();
  namespaceCache = null;
  compute = null;
  onValue = null;
}
