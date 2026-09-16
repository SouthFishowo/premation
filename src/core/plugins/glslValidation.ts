/**
 * The gate a plugin's GLSL ES 3.0 kernel passes, beside the WGSL one.
 *
 * ── Why a second language at all ─────────────────────────────────────────────
 *
 * A plugin effect used to be WGSL, which meant WebGPU, which meant that on the
 * WebGL2 tier the effect rendered its input UNCHANGED — inert, not degraded.
 * Every surface said so, which was the honest thing to do about a gap, but it
 * is still a gap: the machines on the fallback tier are the ones least able to
 * spare an effect, and an author who already has a GLSL implementation (the
 * fx-engine bloom on the user's desktop is exactly this) had no way to offer it.
 *
 * So an effect may now declare `shader` (WGSL), `glsl`, or both, and the host
 * picks the one the live backend can compile.
 *
 * ── The rules are the WGSL rules, and that is the point ──────────────────────
 *
 * A GLSL kernel hangs the same GPU. `checkSourceSize` and `checkCost` are
 * IMPORTED rather than reimplemented, so "is this loop bounded" has one answer
 * in this codebase — two copies would be two places that can be relaxed
 * independently until one of them is wrong. What differs here is only what the
 * host owns in each language: WGSL authors must not write `@group`/`@binding`,
 * GLSL authors must not write `uniform`, `layout(...)` or `#version`, because
 * in both cases the host generates them and an author's copy collides.
 *
 * ── The entry point is `fs`, in both languages ───────────────────────────────
 *
 * An author writes `vec4 fs(vec2 uv)` and the host generates `main()` around
 * it. Symmetric with the WGSL contract — same name, same shape, same reason:
 * the host owns the varyings and the output binding, and a hand-written `main`
 * would have to agree with generated declarations it cannot see.
 */

import {
  checkCost,
  checkSourceSize,
  STANDARD_SHADER_LIMITS,
  type ShaderLimits,
  type WgslCheck,
  type WgslProblem,
} from './wgslValidation';

/**
 * Constructs refused outright, each for a stated reason.
 *
 *  • `while` / `do` have no syntactic bound — the same refusal WGSL's `while`
 *    and `loop` get, for the same reason: "it exits eventually" is a claim only
 *    the author can make and only the GPU can disprove.
 *  • `#version` / `#extension` are the host's. The host emits `#version 300 es`
 *    as the first line (GLSL requires it there, before anything else), so an
 *    author's copy is a compile error at line 1 of a file they did not write.
 *  • `uniform` and `layout(...)` declare the interface the host generates from
 *    the manifest. An author-declared uniform either collides with a generated
 *    one or silently shadows the parameter block — the GLSL equivalent of the
 *    padding bug `@group`/`@binding` is refused to prevent.
 *  • `discard` composites wrong: a discarded fragment leaves whatever was
 *    underneath, which reads as corruption. `alpha = 0.0` is available.
 *  • `gl_FragColor` / `gl_FragData` are ES 1.0. Under `#version 300 es` they do
 *    not exist, and the driver's error names a symbol the author is sure of.
 *  • `main` is generated. An author's would redefine it.
 *  • `image*` / `atomic*` are the write path to memory the host owns, refused
 *    exactly as WGSL's storage bindings are.
 */
const FORBIDDEN: Array<{ rule: string; re: RegExp; detail: string }> = [
  {
    rule: 'while-loop',
    re: /\bwhile\s*\(/,
    detail:
      'A `while` loop has no bound the host can check. Use `for` with a literal count — the cost of a fragment shader has to be knowable before it runs, because a GPU cannot be interrupted once it starts.',
  },
  {
    rule: 'do-loop',
    re: /\bdo\s*\{/,
    detail: 'A `do … while` loop has no bound the host can check. Use `for` with a literal count.',
  },
  {
    rule: 'author-version',
    re: /^\s*#\s*version\b/,
    detail:
      'Do not write `#version`. The host emits `#version 300 es` as the first line — GLSL requires it there — and a second one is a compile error in a file you did not write.',
  },
  {
    rule: 'author-extension',
    re: /^\s*#\s*extension\b/,
    detail:
      'Extensions are not available to effects. The kernel has to compile on every machine the document opens on, and an extension the author\'s GPU happens to have is a black layer on the one that does not.',
  },
  {
    rule: 'author-uniform',
    re: /(^|[^\w])uniform\s/,
    detail:
      'Do not declare `uniform` yourself. The host generates the parameter block and the samplers from your declared parameters and prepends them — an author-declared uniform collides with those, and getting std140 padding right by hand is a class of bug nobody should have to debug from a black frame.',
  },
  {
    rule: 'author-layout',
    re: /\blayout\s*\(/,
    detail:
      'Do not write `layout(...)`. Locations and the uniform block are the host\'s, generated from your manifest so the CPU-side packing and the GPU-side block cannot disagree.',
  },
  {
    rule: 'discard',
    re: /\bdiscard\b/,
    detail:
      'Use `alpha = 0.0` instead of `discard`. Effects composite onto what is beneath them, so a discarded fragment shows the layer below rather than transparency — which reads as corruption.',
  },
  {
    rule: 'legacy-output',
    re: /\bgl_Frag(Color|Data)\b/,
    detail:
      '`gl_FragColor` is GLSL ES 1.0 and does not exist under `#version 300 es`. Return the colour from `fs` instead — the host writes it to the output.',
  },
  {
    rule: 'author-main',
    re: /\bvoid\s+main\s*\(/,
    detail:
      'Do not write `main`. The host generates it around your `fs` function, together with the varyings and the output declaration it has to agree with.',
  },
  {
    rule: 'image-store',
    re: /\b(image2D|imageStore|imageLoad|atomic[A-Z_])/,
    detail:
      'Images and atomics are not available to effects. Everything an effect reads comes from its declared parameters and its input textures.',
  },
];

/**
 * Strip comments so a rule cannot be dodged by, or fired by, a comment.
 *
 * Identical in shape to `stripWgslComments` — the two languages share `//` and
 * block comments — but kept as its own export so a future GLSL-only case (a
 * preprocessor line continuation, say) has somewhere to live that does not
 * change WGSL's behaviour.
 */
export function stripGlslComments(src: string): string {
  return src
    // Block comments become spaces, so line numbers survive.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/** Check a plugin's GLSL ES 3.0 fragment kernel. */
export function validateGlsl(
  source: string,
  limits: ShaderLimits = STANDARD_SHADER_LIMITS,
): WgslCheck {
  const problems: WgslProblem[] = [];

  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, problems: [{ rule: 'empty', detail: 'The shader source is empty.' }] };
  }

  const size = checkSourceSize(source, limits);
  if (size) return { ok: false, problems: [size] };

  const code = stripGlslComments(source);
  const lines = code.split('\n');

  for (const { rule, re, detail } of FORBIDDEN) {
    const index = lines.findIndex((l) => re.test(l));
    if (index !== -1) problems.push({ rule, detail, line: index + 1 });
  }

  problems.push(...checkCost(code, lines, limits));

  /*
    The entry point, by the same rule the WGSL side follows: a refusal an author
    can act on in seconds, instead of a driver message about an undefined
    symbol in generated code.
  */
  if (!/\bvec4\s+fs\s*\(/.test(code)) {
    problems.push({
      rule: 'no-fragment-entry',
      detail:
        'Declare your kernel as `vec4 fs(vec2 uv)`. The host generates `main` around it — same name and same shape as the WGSL entry point, so one manifest describes both.',
    });
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Re-point a driver's compile log at the AUTHOR's line numbers.
 *
 * ── Why this is worth its own function ───────────────────────────────────────
 *
 * The host prepends a generated preamble — the uniform block, the samplers, the
 * varyings — so the driver counts lines from the top of a file the author never
 * saw. A report saying "line 34" against a 12-line kernel is worse than no line
 * at all: it sends the author looking for code that is not theirs, and the
 * natural conclusion is that the error message is lying.
 *
 * Handles the two shapes drivers actually emit:
 *
 *   `ERROR: 0:34: 'foo' : undeclared identifier`   (ANGLE / Mesa / desktop GL)
 *   `34:12 error: unresolved identifier 'foo'`      (Tint / WGSL)
 *
 * Lines that land INSIDE the preamble are reported as line 1 with the original
 * text kept — the author still needs to see them (a parameter name that is not
 * a legal identifier surfaces there), and silently renumbering them to a
 * negative line would be its own puzzle.
 */
export function remapCompileLog(log: string, preambleLines: number): string {
  if (!log) return log;
  const shift = (n: number): number => Math.max(1, n - preambleLines);
  return log
    .replace(/(\b\d+\s*:\s*)(\d+)(\s*:)/g, (_, head: string, line: string, tail: string) =>
      `${head}${shift(Number(line))}${tail}`)
    .replace(/^(\s*)(\d+):(\d+)(\s+error)/gm, (_, pad: string, line: string, col: string, tail: string) =>
      `${pad}${shift(Number(line))}:${col}${tail}`);
}
