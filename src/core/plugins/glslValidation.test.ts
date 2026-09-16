/**
 * The GLSL gate, and the one property that matters about it: it is the WGSL
 * gate with a different vocabulary, not a second, laxer gate.
 *
 * A plugin shipping a GLSL kernel to reach the WebGL2 tier hangs the same GPU
 * as a WGSL one. So the tests below pair each rule with its WGSL twin where one
 * exists, and the file ends by asserting that the two validators agree about a
 * hostile loop — the rule that a second implementation would eventually relax.
 */

import { validateGlsl, remapCompileLog } from './glslValidation';
import { validateWgsl, EXTENDED_SHADER_LIMITS } from './wgslValidation';

const OK = `
vec4 fs(vec2 uv) {
  vec4 c = texture(src, uv);
  return vec4(c.rgb * amount, c.a);
}`;

const problems = (src: string): string[] => validateGlsl(src).problems.map((p) => p.rule);

describe('what a GLSL kernel may be', () => {
  it('accepts an ordinary one', () => {
    expect(validateGlsl(OK).ok).toBe(true);
  });

  it('refuses an empty source', () => {
    expect(problems('')).toEqual(['empty']);
  });

  it('requires the entry point to be `fs`', () => {
    expect(problems('vec4 tint(vec2 uv) { return vec4(0.0); }')).toContain('no-fragment-entry');
  });

  it('names the shape it wants, not just the name', () => {
    // An author who wrote `void fs()` needs to be told about the signature, not
    // sent to rename a function that would still not bind.
    const detail = validateGlsl('void fs() {}').problems[0]!.detail;
    expect(detail).toMatch(/vec4 fs\(vec2 uv\)/);
  });
});

describe('what the host owns', () => {
  it.each([
    ['#version 300 es\n' + OK, 'author-version'],
    ['#extension GL_OES_standard_derivatives : enable\n' + OK, 'author-extension'],
    ['uniform sampler2D mine;\n' + OK, 'author-uniform'],
    ['layout(location = 3) in vec2 mine;\n' + OK, 'author-layout'],
    ['void main() { }\n' + OK, 'author-main'],
  ])('refuses %#', (src, rule) => {
    expect(problems(src)).toContain(rule);
  });

  it('points at the offending LINE', () => {
    const found = validateGlsl(`\n\nuniform float sneaky;\n${OK}`).problems
      .find((p) => p.rule === 'author-uniform');
    expect(found?.line).toBe(3);
  });

  it('does not fire on a comment that mentions a uniform', () => {
    // The strip pass is what makes the lexical rules bearable to write around.
    expect(validateGlsl(`// the host declares the uniform block for you\n${OK}`).ok).toBe(true);
  });
});

describe('cost', () => {
  it('refuses a while loop', () => {
    expect(problems(`vec4 fs(vec2 uv) { while (true) { } return vec4(0.0); }`))
      .toContain('while-loop');
  });

  it('refuses a do loop', () => {
    expect(problems(`vec4 fs(vec2 uv) { do { } while (false); return vec4(0.0); }`))
      .toContain('do-loop');
  });

  it('refuses a loop whose bound is a parameter', () => {
    expect(problems(`vec4 fs(vec2 uv) {\n  for (int i = 0; i < int(taps); i++) { }\n  return vec4(0.0);\n}`))
      .toContain('dynamic-loop-bound');
  });

  it('accepts a literal bound inside the ceiling', () => {
    expect(validateGlsl(`vec4 fs(vec2 uv) {\n  for (int i = 0; i < 33; i++) { }\n  return vec4(0.0);\n}`).ok)
      .toBe(true);
  });

  it('refuses one past it, and says the number', () => {
    const p = validateGlsl(`vec4 fs(vec2 uv) {\n  for (int i = 0; i < 512; i++) { }\n  return vec4(0.0);\n}`)
      .problems.find((x) => x.rule === 'loop-too-long');
    expect(p?.detail).toMatch(/512/);
  });

  it('accepts that same loop under the extended tier', () => {
    // The RULE is identical — a literal bound — and only the number moves. That
    // is the whole claim the tier makes.
    expect(validateGlsl(
      `vec4 fs(vec2 uv) {\n  for (int i = 0; i < 512; i++) { }\n  return vec4(0.0);\n}`,
      EXTENDED_SHADER_LIMITS,
    ).ok).toBe(true);
  });

  it('still refuses an UNBOUNDED loop under the extended tier', () => {
    // The part that must never move: trust raises a ceiling, it does not make
    // an uncostable loop costable.
    expect(validateGlsl(
      `vec4 fs(vec2 uv) {\n  for (int i = 0; i < int(taps); i++) { }\n  return vec4(0.0);\n}`,
      EXTENDED_SHADER_LIMITS,
    ).ok).toBe(false);
  });
});

describe('the two validators agree about the dangerous shapes', () => {
  const wgsl = (body: string): string =>
    `@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {\n${body}\n  return vec4<f32>(0.0);\n}`;
  const glsl = (body: string): string => `vec4 fs(vec2 uv) {\n${body}\n  return vec4(0.0);\n}`;

  it.each([
    ['an unbounded loop', '  for (var i = 0; i < n; i++) { }', '  for (int i = 0; i < n; i++) { }'],
    ['a loop past the ceiling', '  for (var i = 0; i < 4096; i++) { }', '  for (int i = 0; i < 4096; i++) { }'],
  ])('both refuse %s', (_name, w, g) => {
    expect(validateWgsl(wgsl(w)).ok).toBe(false);
    expect(validateGlsl(glsl(g)).ok).toBe(false);
  });
});

describe('re-pointing a driver log at the author’s lines', () => {
  it('subtracts the preamble from an ANGLE-style log', () => {
    expect(remapCompileLog(`ERROR: 0:34: 'foo' : undeclared identifier`, 20))
      .toBe(`ERROR: 0:14: 'foo' : undeclared identifier`);
  });

  it('never reports a line above the file', () => {
    // A problem inside the generated preamble — a parameter name that is not a
    // legal identifier lands there — still has to be shown, so it is clamped to
    // line 1 rather than renumbered to a negative line nobody can open.
    expect(remapCompileLog('ERROR: 0:3: bad', 20)).toBe('ERROR: 0:1: bad');
  });

  it('leaves a log with no line numbers alone', () => {
    expect(remapCompileLog('Program link failed: varying mismatch', 20))
      .toBe('Program link failed: varying mismatch');
  });
});
