/**
 * The layer-input binding numbers, pinned across the app/renderer boundary.
 *
 * ── Why the numbers are written twice ────────────────────────────────────────
 *
 * `effectSchema.ts` generates the WGSL — `@group(0) @binding(N) var depthMap` —
 * from {@link LAYER_BINDINGS}. `CompositionPass.ts` builds the bind-group LAYOUT
 * the pipeline is created with, from its own `PLUGIN_EXTRA_LAYER_BINDINGS`. The
 * renderer package has never heard of a plugin manifest and must not start: it
 * is published on its own, and an import from it into the app's plugin schema
 * would make the renderer depend on the thing it renders.
 *
 * So the duplication is deliberate, and the cost of it is drift. If the two
 * lists disagree, the shader declares a binding the layout does not, which
 * WebGPU reports as a pipeline-creation failure naming generated code the
 * author never wrote — or, worse on the GLSL tier, the sampler names line up
 * one slot off and the effect reads the wrong texture with no error anywhere.
 *
 * Read as TEXT rather than imported, for the same reason the duplication
 * exists: a test that imported the renderer's constant would be the first
 * import across that boundary, and the next reader would take it as licence to
 * collapse the two into one — which is the change this file exists to make
 * unnecessary rather than to permit.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLSL_LAYER_SAMPLERS, LAYER_BINDINGS, ORIGIN_BINDING_INDEX } from './effectSchema';

const COMPOSITION_PASS = join(
  __dirname, '..', '..', '..',
  'packages', 'renderer', 'src', 'rendergraph', 'passes', 'CompositionPass.ts',
);

const source = readFileSync(COMPOSITION_PASS, 'utf8');

/** One `const NAME = [ ... ]` array literal out of the renderer's source. */
function literalArray(name: string): string[] {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!match) throw new Error(`${name} is no longer a literal array in CompositionPass.ts`);
  return match[1]!
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part) => part !== '');
}

describe('plugin layer bindings agree with the renderer', () => {
  it('holds the app side to 3, 5, 6, 7', () => {
    // Pinned as a literal, not derived: this is the number the generated WGSL
    // carries, and a test that computed it would agree with any mistake.
    expect([...LAYER_BINDINGS]).toEqual([3, 5, 6, 7]);
    expect(ORIGIN_BINDING_INDEX).toBe(4);
  });

  it('matches PLUGIN_EXTRA_LAYER_BINDINGS for every input past the first', () => {
    // The renderer names only the EXTRA ones: binding 3 is the map texture it
    // already had, and 5/6/7 are what the four-input layout added.
    expect(literalArray('PLUGIN_EXTRA_LAYER_BINDINGS')).toEqual(
      LAYER_BINDINGS.slice(1).map(String),
    );
  });

  it('leaves binding 4 to origin on both sides', () => {
    // The gap is the point. `origin` is fixed at 4 whether or not any layer
    // parameter exists, so neither side may pack a layer into it.
    expect(LAYER_BINDINGS).not.toContain(ORIGIN_BINDING_INDEX);
    expect(literalArray('PLUGIN_EXTRA_LAYER_BINDINGS')).not.toContain(String(ORIGIN_BINDING_INDEX));
  });

  it('matches the GLSL sampler names the renderer counts texture units by', () => {
    /*
      WebGL2 has no binding numbers for samplers — the backend points a uniform
      at a texture unit by NAME — so this list is the other half of the same
      contract, and it is spelled out again in `pluginMaterial`'s
      `glslSamplers`. One name out of step is an effect sampling the wrong
      input, silently.
    */
    const slice = /\[\s*'pluginLayer1'[^\]]*\]/.exec(source);
    expect(slice).not.toBeNull();
    const names = slice![0].slice(1, -1).split(',').map((p) => p.trim().replace(/'/g, ''));
    expect(names).toEqual([...GLSL_LAYER_SAMPLERS].slice(1));
  });
});
