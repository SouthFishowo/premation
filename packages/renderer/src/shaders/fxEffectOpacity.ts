/**
 * Compositing Options ▸ Effect Opacity on the GPU chain — the twin of the flat
 * (unmasked) branch of `compositeBlend` in `src/core/effects/effectBake.ts`.
 *
 *   out = before·(1 − a) + after·a
 *
 * in PREMULTIPLIED DISPLAY sRGB, because that is the space the CPU blend runs
 * in: a Canvas2D surface stores premultiplied sRGB-encoded bytes, and the
 * `destination-in` + `lighter` pair lerps exactly those. The chain's render
 * targets hold premultiplied LINEAR light, and a lerp there is a different
 * picture — a half-strength blur over a hard colour edge comes out visibly
 * brighter in linear — so each tap is brought to display space, lerped, and
 * the result re-encoded (the decodeS/encodeOut discipline of every byte-maths
 * port; see the render-gate-red notes on interior styles).
 *
 * tex = the effect's output (after), tex2 = the chain's input to that effect
 * (before). p0.x = a, 0..1. Both are full chain buffers sampled at the same uv,
 * so no field mapping is involved.
 */

import type { ShaderSource } from './builtin';
import { withHelpers } from './fxRoundEight';
import { fxShader } from './fxRoundSix';
import { withSecondTexture } from './fxRoundTen';

const WGSL_HELPERS = `fn displayPremul(s : vec4<f32>) -> vec4<f32> {
  if (s.a <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return vec4<f32>(linearToSrgbRgb(clamp(s.rgb / s.a, vec3<f32>(0.0), vec3<f32>(1.0))) * s.a, s.a);
}
`;
const GLSL_HELPERS = `vec4 displayPremul(vec4 s) {
  if (s.a <= 0.0) return vec4(0.0);
  return vec4(linearToSrgbRgb(clamp(s.rgb / s.a, vec3(0.0), vec3(1.0))) * s.a, s.a);
}
`;

export const EFFECT_OPACITY_FX: ShaderSource = withHelpers(withSecondTexture(fxShader('fx-effect-opacity', 1,
  `  let a = clamp(obj.p0.x, 0.0, 1.0);
  let outP = displayPremul(textureSampleLevel(tex, smp, uv, 0.0));
  let inP = displayPremul(textureSampleLevel(tex2, smp, uv, 0.0));
  let m = inP * (1.0 - a) + outP * a;
  if (m.a <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return encodeOut(m.rgb / m.a, m.a);`,
  `  float a = clamp(p0.x, 0.0, 1.0);
  vec4 outP = displayPremul(textureLod(uTex, vUv, 0.0));
  vec4 inP = displayPremul(textureLod(uMaskTex, vUv, 0.0));
  vec4 m = inP * (1.0 - a) + outP * a;
  if (m.a <= 0.0) { frag = vec4(0.0); return; }
  frag = encodeOut(m.rgb / m.a, m.a);`,
)), WGSL_HELPERS, GLSL_HELPERS);

export const FX_EFFECT_OPACITY_SHADERS: readonly ShaderSource[] = [EFFECT_OPACITY_FX];
