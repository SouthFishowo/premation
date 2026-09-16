/**
 * Expression functions a plugin contributes, and the compromise that makes a
 * Worker callable from a synchronous interpreter.
 *
 * The interpreter calls `fn.apply(...)` once per animated property per frame,
 * inside the frame budget; a plugin lives behind a `postMessage`. There is no
 * arrangement of those two facts in which the plugin's code runs DURING an
 * evaluation, so the contract is a cache: a hit answers immediately, a miss
 * answers with the declared default and asks the plugin once.
 *
 * That "once" is the part worth pinning. An expression is evaluated thousands
 * of times a second, and a request per evaluation would flood a worker that
 * answers at its own pace.
 */

import { parseManifest } from './manifest';
import {
  MAX_CACHED_RESULTS,
  configurePluginExpressions,
  expressionNamespace,
  hasPluginExpressions,
  parsePluginExpressions,
  pluginExpressionHints,
  pluginExpressionScope,
  providePluginExpressionValue,
  registerPluginExpressions,
  resetPluginExpressionsForTests,
  unregisterPluginExpressions,
} from './uiExpressions';

const PLUGIN = 'studio.acme-lab';
const NS = expressionNamespace(PLUGIN);

const DECL = [{ name: 'pulse', args: 1, default: 0, description: 'beat strength' }];

/** Call `plugin.<ns>.<name>(...)` the way an expression would. */
function call(name: string, ...args: number[]): unknown {
  const ns = pluginExpressionScope()[NS] as Record<string, (...a: number[]) => unknown>;
  return ns[name]!(...args);
}

let asked: Array<[string, string, number[]]> = [];

beforeEach(() => {
  resetPluginExpressionsForTests();
  asked = [];
  configurePluginExpressions({
    compute: (pluginId, name, args) => { asked.push([pluginId, name, [...args]]); },
    onValue: () => {},
  });
});

describe('the declaration', () => {
  it('requires a default, because a miss has to return something', () => {
    // Without one, every expression using the function throws on the frame the
    // user adds it — before the plugin has had a chance to answer once.
    const errors: string[] = [];
    parsePluginExpressions([{ name: 'pulse', args: 1 }], 'contributes.expressions', errors);
    expect(errors).toEqual([expect.stringContaining('.default" is required')]);
  });

  it('accepts a number or a short vector', () => {
    const errors: string[] = [];
    const out = parsePluginExpressions(
      [{ name: 'pulse', default: 1 }, { name: 'offset', args: 2, default: [0, 0] }],
      'contributes.expressions',
      errors,
    );
    expect(errors).toEqual([]);
    expect(out.map((e) => e.args)).toEqual([1, 2]);
  });

  it('needs apiVersion 7', () => {
    const base = {
      id: PLUGIN, name: 'Acme Lab', version: '1.0.0', description: 'x', main: 'main.js',
      contributes: { expressions: DECL },
    };
    expect(parseManifest({ ...base, apiVersion: 6 }).errors)
      .toEqual([expect.stringContaining('requires "apiVersion": 7')]);
    expect(parseManifest({ ...base, apiVersion: 7 }).errors).toEqual([]);
  });
});

describe('the scope object', () => {
  it('hangs everything off ONE identifier-safe namespace', () => {
    // The expression scope's keys are the LANGUAGE, and they are pinned by
    // `expressionApi.test.ts`. Names that appear with what the user installed
    // cannot live there, so they live under `plugin.<ns>`.
    expect(expressionNamespace('studio.acme-lab')).toBe('studio_acme_lab');
    registerPluginExpressions(PLUGIN, DECL);
    expect(Object.keys(pluginExpressionScope())).toEqual([NS]);
    expect(hasPluginExpressions()).toBe(true);
  });

  it('refuses a second plugin that folds to a namespace already held', () => {
    registerPluginExpressions('studio.acme-lab', DECL);
    const problems = registerPluginExpressions('studio-acme.lab', DECL);
    expect(problems).toEqual([expect.stringContaining('already used by')]);
    // And nothing of the second plugin's is bound — shadowing would make which
    // function answers depend on install order.
    expect(Object.keys(pluginExpressionScope())).toEqual([NS]);
  });

  it('goes away with the plugin', () => {
    registerPluginExpressions(PLUGIN, DECL);
    unregisterPluginExpressions(PLUGIN);
    expect(pluginExpressionScope()).toEqual({});
    expect(hasPluginExpressions()).toBe(false);
  });
});

describe('calling a contributed function', () => {
  beforeEach(() => registerPluginExpressions(PLUGIN, DECL));

  it('returns the declared default on a miss, and asks the plugin once', () => {
    expect(call('pulse', 2)).toBe(0);
    expect(call('pulse', 2)).toBe(0);
    expect(call('pulse', 2)).toBe(0);
    // Once per ARGUMENT LIST, not once per evaluation.
    expect(asked).toEqual([[PLUGIN, 'pulse', [2]]]);

    call('pulse', 3);
    expect(asked).toHaveLength(2);
  });

  it('answers from the cache once the plugin has provided a value', () => {
    call('pulse', 2);
    expect(providePluginExpressionValue(PLUGIN, 'pulse', [2], 0.75)).toBe(true);
    expect(call('pulse', 2)).toBe(0.75);
    // A hit is not a request: the whole point is that a plugin pushing its
    // values ahead of time never round-trips at all.
    expect(asked).toHaveLength(1);
  });

  it('hands back a COPY of a vector, so an expression cannot poison the cache', () => {
    registerPluginExpressions(PLUGIN, [{ name: 'offset', args: 1, default: [0, 0] }]);
    const first = call('offset', 0) as number[];
    first[0] = 999;
    expect(call('offset', 0)).toEqual([0, 0]);
  });

  it('refuses a value that is not a number or a short vector', () => {
    expect(providePluginExpressionValue(PLUGIN, 'pulse', [1], NaN as never)).toBe(false);
    expect(providePluginExpressionValue(PLUGIN, 'pulse', [1], 'loud' as never)).toBe(false);
    expect(providePluginExpressionValue(PLUGIN, 'ghost', [1], 1)).toBe(false);
  });

  it('coerces a non-numeric argument rather than failing the frame', () => {
    // An expression can pass anything. Zero is a value; a thrown error in the
    // middle of a frame is a property that stops animating.
    expect(call('pulse', undefined as never)).toBe(0);
  });

  it('bounds the cache, oldest argument list first', () => {
    // A scrub calls with a new `time` every frame, so an unbounded cache is a
    // leak with a user-controlled growth rate.
    for (let i = 0; i < MAX_CACHED_RESULTS + 10; i += 1) {
      providePluginExpressionValue(PLUGIN, 'pulse', [i], i);
    }
    expect(call('pulse', 0)).toBe(0); // evicted → the declared default
    expect(call('pulse', MAX_CACHED_RESULTS + 5)).toBe(MAX_CACHED_RESULTS + 5);
  });

  it('offers a hint per function for the expression editor', () => {
    expect(pluginExpressionHints()).toEqual([
      { insert: `plugin.${NS}.pulse(`, label: `plugin.${NS}.pulse()`, hint: 'beat strength' },
    ]);
  });
});
