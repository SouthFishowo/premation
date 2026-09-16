/**
 * `fx-effect-opacity` — the chain's Effect Opacity blend — is wired the same way
 * in both dialects and into the chain loop.
 *
 * Nothing here executes a shader (no GPU in jest); what is checked is the shape
 * a silent failure would take: a second texture declared on one backend only
 * (an invalid pipeline → the layer vanishes), a lerp in linear light on one
 * backend (a brighter blend on that backend only), or a blend queued at the
 * bottom of the loop where the branches' `continue` never reach it.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';
import { EFFECT_OPACITY_FX_MATERIAL } from '../shaders/Material';
import { readFileSync } from 'fs';
import { join } from 'path';

const shader = BUILTIN_SHADERS.find((s) => s.name === 'fx-effect-opacity')!;

describe('fx-effect-opacity', () => {
  it('is registered, with the two-texture layout it declares', () => {
    expect(shader).toBeDefined();
    expect(EFFECT_OPACITY_FX_MATERIAL.shader).toBe('fx-effect-opacity');
    expect(EFFECT_OPACITY_FX_MATERIAL.layout.map((b) => b.binding)).toEqual([0, 1, 2, 3]);
    expect(shader.wgsl).toMatch(/@binding\(3\) var tex2 : texture_2d<f32>/);
    // GLSL binds samplers in declaration order: the layer first, the input second.
    const frag = shader.glsl.fragment;
    expect(frag.indexOf('uniform sampler2D uTex;')).toBeGreaterThanOrEqual(0);
    expect(frag.indexOf('uniform sampler2D uMaskTex;')).toBeGreaterThan(frag.indexOf('uniform sampler2D uTex;'));
  });

  it('both dialects bring BOTH taps to display space before the lerp and re-encode after', () => {
    expect(shader.wgsl.match(/displayPremul\(textureSampleLevel\((tex|tex2), smp, uv, 0\.0\)\)/g)).toHaveLength(2);
    expect(shader.glsl.fragment.match(/displayPremul\(textureLod\((uTex|uMaskTex), vUv, 0\.0\)\)/g)).toHaveLength(2);
    for (const src of [shader.wgsl, shader.glsl.fragment]) {
      expect(src).toMatch(/linearToSrgbRgb\(clamp\(s\.rgb \/ s\.a/);
      expect(src).toMatch(/encodeOut\(m\.rgb \/ m\.a, m\.a\)/);
      expect(src).toMatch(/\* \(1\.0 - a\) \+ outP \* a/);
    }
  });

  it('the chain lands a pending blend at the top of every iteration and after the loop', () => {
    const src = readFileSync(join(__dirname, '../rendergraph/passes/CompositionPass.ts'), 'utf8');
    const start = src.indexOf('private runEffectsChain(');
    const end = src.indexOf('\n  }\n', src.indexOf('return { tex: curTex, name: curName };', start));
    const body = src.slice(start, end);
    expect(body).toMatch(/for \(const effect of effects\) \{\s*landBlendBack\(\);/);
    expect(body).toMatch(/landBlendBack\(\);\s*return \{ tex: curTex, name: curName \};/);
    // The input is remembered only once the entry is known to draw (after the target check).
    expect(body.indexOf('blendBack = { tex: curTex')).toBeGreaterThan(body.indexOf('if (!f0 || !f1) continue;'));
  });
});
