/**
 * A plugin that is more than one file.
 *
 * ── The ceiling this removes ─────────────────────────────────────────────────
 *
 * The worker booted a plugin by wrapping its entry module in ONE blob URL and
 * importing that. A blob URL has no directory, so `import './util.js'` inside it
 * resolves against the blob origin and fails — which meant a plugin was exactly
 * one file. Every author of anything substantial hit this immediately, and the
 * workarounds were all bad: one 4000-line module, a build step that inlines
 * everything, or base64 blobs passed around by hand.
 *
 * So the host now sends the whole package and the worker builds a blob per
 * file, rewriting each relative specifier to the blob URL of the file it
 * resolves to. That is a real ES module graph: live bindings, one evaluation
 * per module, `import()` where the author wrote it.
 *
 * This module is the part that can be reasoned about and tested without a
 * Worker: it resolves the specifiers, orders the graph, and produces the EDITS
 * the worker applies once it knows each file's URL. Nothing here executes
 * anything, and nothing here touches the DOM.
 *
 * ── Why dependencies first, and why a cycle is refused ───────────────────────
 *
 * A blob URL is minted FROM ITS CONTENT. A module's URL therefore cannot exist
 * until every specifier inside it has been rewritten, which means until every
 * module it imports already has a URL. That gives a strict order — leaves
 * first, entry last — and it makes a cycle unrepresentable rather than merely
 * hard: `a.js` and `b.js` importing each other have no order at all, because
 * each needs the other's URL to be minted first.
 *
 * ESM itself handles cycles, so this is a real restriction and it is stated as
 * one, with the fix in the message. The alternative would be to stop using blob
 * URLs and ship a CommonJS-style module runtime instead — which would mean
 * parsing and rewriting every `import`/`export` statement into function calls,
 * losing live bindings, and owning a miniature bundler in the sandbox. A
 * refusal with a one-line fix is the smaller cost.
 *
 * ── Bare specifiers ──────────────────────────────────────────────────────────
 *
 * `import { mat4 } from 'gl-matrix'` cannot work here and never will: there is
 * no node_modules, no resolver, no network in the worker, and the package the
 * user installed is the whole world this code can see. Refused by NAME, with
 * the actual instruction ("bundle your dependencies into the package"), because
 * the alternative is an author reading "failed to fetch" and concluding the
 * sandbox is broken.
 */

/** Which files may be modules. Anything else is data — see `package.read`. */
const MODULE_EXT = ['.js', '.mjs'];

/** One specifier to replace, as byte offsets into the module's own source. */
export interface ModuleEdit {
  /** Index of the opening quote. */
  start: number;
  /** Index just past the closing quote. */
  end: number;
  /** What the author wrote, for messages. */
  specifier: string;
  /** The package-relative path it resolves to. Always a key of `files`. */
  resolved: string;
}

export interface PlannedModule {
  /** Package-relative path, normalised. */
  path: string;
  source: string;
  edits: ModuleEdit[];
}

export type ModulePlan =
  | { ok: true; modules: PlannedModule[] }
  | { ok: false; error: string };

/** Forward slashes, no leading `./`, `..` segments folded. */
export function normalizePath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/**
 * Resolve one relative specifier against the module that wrote it.
 *
 * Extensionless specifiers are resolved the way a bundler would (`./util` →
 * `./util.js`, then `./util/index.js`) rather than the way a browser would
 * (not at all). Authors write the former, every tool they have used accepts it,
 * and the browser's rule would produce "module not found" for code that is
 * correct everywhere else.
 */
export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  files: Readonly<Record<string, string>>,
): { path: string } | { error: string } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return {
      error:
        `"${specifier}" in ${fromPath} points outside the package. A plugin runs with no network, `
        + 'so only files inside the package can be imported.',
    };
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
    return {
      error:
        `"${specifier}" in ${fromPath} is a package dependency, and a plugin has no node_modules. `
        + 'Bundle your dependencies into the package (esbuild, rollup or vite will inline them) '
        + 'and import the bundled file with a relative path.',
    };
  }

  const base = specifier.startsWith('/') ? normalizePath(specifier) : normalizePath(`${dirOf(fromPath)}/${specifier}`);
  const candidates = [base, ...MODULE_EXT.map((e) => `${base}${e}`), ...MODULE_EXT.map((e) => `${base}/index${e}`)];
  for (const candidate of candidates) {
    if (files[candidate] !== undefined) {
      if (!MODULE_EXT.some((e) => candidate.endsWith(e))) {
        return {
          error:
            `"${specifier}" in ${fromPath} resolves to ${candidate}, which is not a JavaScript module. `
            + 'Read data files with `await motion.package.read("path")` instead of importing them.',
        };
      }
      return { path: candidate };
    }
  }
  return {
    error:
      `"${specifier}" in ${fromPath} is not in the package. `
      + `Looked for ${candidates.slice(0, 3).join(', ')}.`,
  };
}

/**
 * Every module specifier in one source file, with its position.
 *
 * A scanner rather than a regex over the whole text, because a regex cannot
 * tell `import x from './a.js'` from the same words inside a string or a
 * comment — and rewriting a specifier that was only ever a quoted example would
 * corrupt the file silently. The scanner tracks strings, template literals,
 * comments and regex literals, and decides each string literal by what precedes
 * it in CODE.
 */
export function findSpecifiers(source: string): Array<{ start: number; end: number; specifier: string }> {
  const out: Array<{ start: number; end: number; specifier: string }> = [];
  /** The last few characters of real code, for deciding a literal's role. */
  let tail = '';
  const pushTail = (ch: string): void => {
    tail = (tail + ch).slice(-64);
  };

  const n = source.length;
  let i = 0;
  // Nesting of `${ … }` inside template literals, so a template containing an
  // object literal is not ended by the wrong brace.
  const templateStack: number[] = [];

  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];

    // Comments.
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      pushTail(' ');
      continue;
    }

    // Regex literal, decided by what a `/` can legally follow.
    if (ch === '/' && /(^|[([{,;:=!&|?+\-*%~^<>]|\b(?:return|typeof|case|in|of|do|else|void|delete|instanceof|new|yield|await))\s*$/.test(tail)) {
      let j = i + 1;
      let inClass = false;
      for (; j < n; j += 1) {
        const c = source[j]!;
        if (c === '\\') { j += 1; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break; // unterminated — treat as division after all
      }
      if (source[j] === '/') { i = j + 1; pushTail('r'); continue; }
      // Fall through: it was a division.
    }

    // Template literal.
    if (ch === '`') {
      let j = i + 1;
      for (; j < n; j += 1) {
        const c = source[j]!;
        if (c === '\\') { j += 1; continue; }
        if (c === '`') break;
        if (c === '$' && source[j + 1] === '{') {
          // Re-enter the scanner for the interpolation, which is code.
          templateStack.push(j);
          break;
        }
      }
      if (source[j] === '`') { i = j + 1; pushTail('"'); continue; }
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === j) {
        // Scan the interpolation as code; the closing `}` is handled below.
        i = j + 2;
        pushTail('(');
        continue;
      }
      i = n;
      continue;
    }
    if (ch === '}' && templateStack.length > 0) {
      // Back into the template's text half. Find its end (or the next `${`).
      let j = i + 1;
      for (; j < n; j += 1) {
        const c = source[j]!;
        if (c === '\\') { j += 1; continue; }
        if (c === '`') { templateStack.pop(); break; }
        if (c === '$' && source[j + 1] === '{') break;
      }
      if (source[j] === '`') { i = j + 1; pushTail('"'); continue; }
      if (j < n) { i = j + 2; pushTail('('); continue; }
      i = n;
      continue;
    }

    // String literal — the thing this scanner exists to locate.
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      let terminated = false;
      for (; j < n; j += 1) {
        const c = source[j]!;
        if (c === '\\') { value += source[j + 1] ?? ''; j += 1; continue; }
        if (c === ch) { terminated = true; break; }
        if (c === '\n') break; // unterminated string; give up on this literal
        value += c;
      }
      if (terminated) {
        const trimmed = tail.replace(/\s+$/, '');
        const isSpecifier =
          /(^|[^\w$.])from$/.test(trimmed)
          || /(^|[^\w$.])import$/.test(trimmed)
          || /(^|[^\w$.])import\s*\($/.test(tail)
          || /(^|[^\w$.])require\s*\($/.test(tail);
        if (isSpecifier) out.push({ start: i, end: j + 1, specifier: value });
        i = j + 1;
        pushTail('"');
        continue;
      }
      i += 1;
      pushTail(ch);
      continue;
    }

    pushTail(ch);
    i += 1;
  }

  return out;
}

/**
 * Plan the whole graph, dependencies first.
 *
 * Returns modules in the order the worker must create them. Only the files
 * REACHABLE from the entry are included — a package shipping a test fixture or
 * an alternative entry point should not have it evaluated because it happens to
 * be in the same directory.
 */
export function planModuleGraph(
  files: Readonly<Record<string, string>>,
  entryPath: string,
): ModulePlan {
  const entry = normalizePath(entryPath);
  if (files[entry] === undefined) {
    return { ok: false, error: `The entry module "${entryPath}" is missing from the package.` };
  }

  const planned = new Map<string, PlannedModule>();
  const order: string[] = [];
  /** Grey = on the current path, black = finished. */
  const state = new Map<string, 'grey' | 'black'>();
  let failure: string | null = null;

  const visit = (path: string, stack: string[]): void => {
    if (failure) return;
    const seen = state.get(path);
    if (seen === 'black') return;
    if (seen === 'grey') {
      const from = stack[stack.length - 1] ?? path;
      failure =
        `${from} and ${path} import each other. A plugin's files are loaded in dependency order, `
        + 'so a circular import has no order to be loaded in — move the shared code into a third '
        + 'file that both import.';
      return;
    }
    state.set(path, 'grey');

    const source = files[path]!;
    const edits: ModuleEdit[] = [];
    for (const found of findSpecifiers(source)) {
      const resolved = resolveSpecifier(path, found.specifier, files);
      if ('error' in resolved) { failure = resolved.error; return; }
      edits.push({ ...found, resolved: resolved.path });
      visit(resolved.path, [...stack, path]);
      if (failure) return;
    }

    state.set(path, 'black');
    planned.set(path, { path, source, edits });
    order.push(path);
  };

  visit(entry, []);
  if (failure) return { ok: false, error: failure };
  return { ok: true, modules: order.map((p) => planned.get(p)!) };
}

/**
 * Apply a module's edits, given the URL each dependency ended up at.
 *
 * Right to left, so an earlier edit's offsets are still valid after a later one
 * has changed the string's length.
 */
export function rewriteModule(module: PlannedModule, urlOf: (path: string) => string): string {
  let out = module.source;
  for (const edit of [...module.edits].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, edit.start)}${JSON.stringify(urlOf(edit.resolved))}${out.slice(edit.end)}`;
  }
  return out;
}
