/**
 * The multi-file module graph.
 *
 * Two things carry the whole feature and both are pinned here: that a
 * specifier is only rewritten when it really IS one (a quoted path in a comment
 * or a string must survive untouched, or the file is silently corrupted), and
 * that the order handed to the worker is dependencies-first — because a blob
 * URL is minted from content, so an importer cannot be built before the thing
 * it imports.
 */

import {
  findSpecifiers,
  normalizePath,
  planModuleGraph,
  resolveSpecifier,
  rewriteModule,
} from './moduleGraph';

describe('finding specifiers', () => {
  it('finds every static form', () => {
    const src = [
      "import a from './a.js';",
      "import { b } from './b.js';",
      "import './side-effect.js';",
      "export { c } from './c.js';",
      "export * from './d.js';",
      "const e = await import('./e.js');",
    ].join('\n');
    expect(findSpecifiers(src).map((s) => s.specifier)).toEqual([
      './a.js', './b.js', './side-effect.js', './c.js', './d.js', './e.js',
    ]);
  });

  /*
    The case a regex over the source gets wrong. Rewriting one of these would
    change a string the plugin prints, or a line of documentation, into a blob
    URL — with no error anywhere.
  */
  it('ignores quoted paths that are not specifiers', () => {
    const src = [
      "// import x from './commented.js'",
      "/* import y from './blocked.js' */",
      "const note = 'import z from \"./quoted.js\"';",
      "const re = /from '\\.\\/regex.js'/;",
      "const t = `import from './template.js'`;",
      "const path = './data.json';",
      "import real from './real.js';",
    ].join('\n');
    expect(findSpecifiers(src).map((s) => s.specifier)).toEqual(['./real.js']);
  });

  it('is not fooled by an object key named from', () => {
    const src = "const o = { from: './not-an-import.js' };\nimport x from './yes.js';";
    expect(findSpecifiers(src).map((s) => s.specifier)).toEqual(['./yes.js']);
  });

  it('keeps scanning after a template literal with an interpolation', () => {
    const src = "const s = `a${1 + 2}b`;\nimport x from './after.js';";
    expect(findSpecifiers(src).map((s) => s.specifier)).toEqual(['./after.js']);
  });

  it('reports byte offsets that bracket the quotes', () => {
    const src = "import x from './a.js';";
    const [found] = findSpecifiers(src);
    expect(src.slice(found!.start, found!.end)).toBe("'./a.js'");
  });
});

describe('resolving', () => {
  const files = {
    'main.js': '',
    'lib/util.js': '',
    'lib/index.js': '',
    'shader.wgsl': '',
  };

  it('resolves a relative path', () => {
    expect(resolveSpecifier('main.js', './lib/util.js', files)).toEqual({ path: 'lib/util.js' });
  });

  it('adds the extension an author left off', () => {
    expect(resolveSpecifier('main.js', './lib/util', files)).toEqual({ path: 'lib/util.js' });
  });

  it('falls back to index.js for a directory', () => {
    expect(resolveSpecifier('main.js', './lib', files)).toEqual({ path: 'lib/index.js' });
  });

  it('resolves upwards from a nested module', () => {
    expect(resolveSpecifier('lib/util.js', '../main.js', files)).toEqual({ path: 'main.js' });
  });

  /*
    The message is the feature. "Failed to fetch gl-matrix" reads as a broken
    sandbox; naming the fix does not.
  */
  it('refuses a bare npm specifier and says what to do', () => {
    const out = resolveSpecifier('main.js', 'gl-matrix', files) as { error: string };
    expect(out.error).toMatch(/no node_modules/);
    expect(out.error).toMatch(/Bundle your dependencies/);
  });

  it('refuses a URL', () => {
    const out = resolveSpecifier('main.js', 'https://cdn.example/x.js', files) as { error: string };
    expect(out.error).toMatch(/outside the package/);
  });

  it('points a data import at package.read', () => {
    const out = resolveSpecifier('main.js', './shader.wgsl', files) as { error: string };
    expect(out.error).toMatch(/package\.read/);
  });

  it('names what it looked for when a file is missing', () => {
    const out = resolveSpecifier('main.js', './nope', files) as { error: string };
    expect(out.error).toMatch(/not in the package/);
    expect(out.error).toMatch(/nope\.js/);
  });
});

describe('planning', () => {
  it('orders dependencies before their importers, entry last', () => {
    const plan = planModuleGraph(
      {
        'main.js': "import { a } from './a.js';",
        'a.js': "import { b } from './lib/b.js';",
        'lib/b.js': 'export const b = 1;',
      },
      'main.js',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.modules.map((m) => m.path)).toEqual(['lib/b.js', 'a.js', 'main.js']);
  });

  it('visits a shared dependency once', () => {
    const plan = planModuleGraph(
      {
        'main.js': "import './a.js';\nimport './b.js';",
        'a.js': "import './shared.js';",
        'b.js': "import './shared.js';",
        'shared.js': 'export const x = 1;',
      },
      'main.js',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.modules.filter((m) => m.path === 'shared.js')).toHaveLength(1);
    expect(plan.modules.map((m) => m.path)).toEqual(['shared.js', 'a.js', 'b.js', 'main.js']);
  });

  it('leaves unreachable files out of the graph', () => {
    const plan = planModuleGraph(
      { 'main.js': 'export const x = 1;', 'fixtures/other.js': 'throw new Error("never");' },
      'main.js',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.modules.map((m) => m.path)).toEqual(['main.js']);
  });

  it('refuses a cycle and says how to break it', () => {
    const plan = planModuleGraph(
      { 'a.js': "import './b.js';", 'b.js': "import './a.js';" },
      'a.js',
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/import each other/);
    expect(plan.error).toMatch(/third file/);
  });

  it('refuses a self-import rather than looping forever', () => {
    const plan = planModuleGraph({ 'a.js': "import './a.js';" }, 'a.js');
    expect(plan.ok).toBe(false);
  });

  it('reports a missing entry', () => {
    const plan = planModuleGraph({ 'other.js': '' }, 'main.js');
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/missing from the package/);
  });

  it('normalises a `./`-prefixed entry', () => {
    const plan = planModuleGraph({ 'main.js': '' }, './main.js');
    expect(plan.ok).toBe(true);
  });
});

describe('rewriting', () => {
  it('replaces every specifier with the URL its file landed at', () => {
    const plan = planModuleGraph(
      {
        'main.js': "import { a } from './a.js';\nimport('./a.js');",
        'a.js': 'export const a = 1;',
      },
      'main.js',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const main = plan.modules.find((m) => m.path === 'main.js')!;
    const out = rewriteModule(main, (p) => `blob:fake/${p}`);
    expect(out).toBe('import { a } from "blob:fake/a.js";\nimport("blob:fake/a.js");');
  });

  it('leaves a module with no imports byte-identical', () => {
    const plan = planModuleGraph({ 'main.js': 'export const x = 1;' }, 'main.js');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(rewriteModule(plan.modules[0]!, () => 'never')).toBe('export const x = 1;');
  });
});

describe('normalizePath', () => {
  it.each([
    ['./main.js', 'main.js'],
    ['lib/../main.js', 'main.js'],
    ['lib\\util.js', 'lib/util.js'],
    ['a//b.js', 'a/b.js'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});
