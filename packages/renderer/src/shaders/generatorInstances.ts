/**
 * The instanced draw behind a plugin `generator` layer kind.
 *
 * Three shaders, one idea: the unit quad (or a plugin's mesh) drawn once per
 * INSTANCE, with the per-instance data coming from a vertex buffer that
 * advances once per instance rather than once per vertex. Fifty thousand
 * particles is one draw call and one buffer upload, which is the only shape in
 * which "the plugin produces geometry every frame" is a feature rather than a
 * demonstration.
 *
 * ── The instance layout, stated once ─────────────────────────────────────────
 *
 * It is the plugin's own buffer, uploaded with no repacking, so the attribute
 * offsets below ARE `src/core/plugins/generator/generatorContract.ts`'s field
 * list:
 *
 *   location 1  `iPos`     vec3  x, y, z          bytes  0..11
 *   location 2  `iSizeRot` vec2  size, rotation   bytes 12..19
 *   location 3  `iColor`   vec4  r, g, b, a       bytes 20..35
 *   location 4  `iUv`      vec2  u, v             bytes 36..43  (stride 44 only)
 *
 * Location 0 is the geometry in slot 0 — the shared unit quad for sprites, a
 * mesh's own vertices for `primitive: 'mesh'`.
 *
 * ── Space ────────────────────────────────────────────────────────────────────
 *
 * Instance positions are LAYER PIXELS with the origin at the centre of the
 * layer box, and the field is rendered into a layer-sized offscreen. So `mvp`
 * here is an orthographic map from that box to clip space and nothing else —
 * the layer's own transform, its 3D placement, its masks and its effects all
 * happen afterwards, to the resulting texture, through the ordinary layer path.
 *
 * `z` is not a depth test. It is a PERSPECTIVE divide within the field, scaling
 * position and size by `focal / (focal − z)` the way the built-in particle
 * system's own perspective parameter does, so a system flying past the camera
 * parallaxes. Instances are drawn in the order the plugin packed them; under
 * `blend: 'add'` that is order-independent and exact, and under `normal` a
 * nearer instance does not automatically win. Sorting fifty thousand instances
 * on the CPU every frame would cost more than the draw does.
 *
 * ── Alpha ────────────────────────────────────────────────────────────────────
 *
 * Instance colours are STRAIGHT — the shape a simulation naturally computes —
 * and every one of these shaders emits PREMULTIPLIED, because that is this
 * renderer's invariant for everything a pass can sample (see `gpu/types.ts`).
 * The multiply happens once, in the fragment stage, at the last line.
 */

import type { ShaderSource } from './builtin';

/** `params.x` — which primitive is being drawn. */
export const GEN_KIND_POINT = 0;
export const GEN_KIND_QUAD = 1;
export const GEN_KIND_SPRITE = 2;

/**
 * The shared vertex stage, as WGSL.
 *
 * A template rather than three copies: the sprite variant differs from the
 * point variant in ONE line (it passes the instance's atlas cell through), and
 * three hand-maintained copies of a perspective divide is three places for the
 * divide to drift.
 */
const VS_WGSL = (uv: boolean): string => /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  params : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
};

@vertex
fn vs(
  @location(0) corner : vec2<f32>,
  @location(1) iPos : vec3<f32>,
  @location(2) iSizeRot : vec2<f32>,
  @location(3) iColor : vec4<f32>${uv ? ',\n  @location(4) iUv : vec2<f32>' : ''}
) -> VOut {
  var o : VOut;
  let focal = obj.params.y;
  // The perspective divide, guarded: an instance AT or BEHIND the focal plane
  // would scale to infinity or turn inside out, so the denominator floors at
  // one pixel. A particle that flew past the camera simply stops growing.
  var k = 1.0;
  if (focal > 0.0) { k = focal / max(focal - iPos.z, 1.0); }
  let c = corner - vec2<f32>(0.5, 0.5);
  let s = sin(iSizeRot.y);
  let cs = cos(iSizeRot.y);
  let size = iSizeRot.x * k;
  let r = vec2<f32>(c.x * cs - c.y * s, c.x * s + c.y * cs) * size;
  let p = obj.mvp * vec3<f32>(iPos.xy * k + r, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = ${uv ? 'iUv + corner * obj.params.zw' : 'corner'};
  o.color = iColor;
  return o;
}
`;

const VS_GLSL = (uv: boolean): string => /* glsl */ `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in vec3 iPos;
layout(location = 2) in vec2 iSizeRot;
layout(location = 3) in vec4 iColor;
${uv ? 'layout(location = 4) in vec2 iUv;' : ''}
layout(std140) uniform Object { mat3 mvp; vec4 params; };
out vec2 ${uv ? 'vUv' : 'vQuad'};
out vec4 vColor;
void main() {
  float focal = params.y;
  float k = 1.0;
  if (focal > 0.0) { k = focal / max(focal - iPos.z, 1.0); }
  vec2 c = corner - vec2(0.5);
  float s = sin(iSizeRot.y);
  float cs = cos(iSizeRot.y);
  float size = iSizeRot.x * k;
  vec2 r = vec2(c.x * cs - c.y * s, c.x * s + c.y * cs) * size;
  vec3 p = mvp * vec3(iPos.xy * k + r, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  ${uv ? 'vUv = iUv + corner * params.zw' : 'vQuad = corner'};
  vColor = iColor;
}
`;

/**
 * Point and quad: no texture.
 *
 * A POINT gets a soft round falloff — `1 − d²` over the quad's inscribed circle,
 * which is the cheapest curve that reaches zero with zero slope, so a particle
 * has no visible rim. A QUAD is the same geometry with the falloff off, for a
 * generator drawing hard-edged cells or a debug view of its own layout.
 */
const GENERATOR_POINT: ShaderSource = {
  name: 'generator-point',
  wgsl: `${VS_WGSL(false)}
@fragment
fn fs(@location(0) quad : vec2<f32>, @location(1) color : vec4<f32>) -> @location(0) vec4<f32> {
  var a = color.a;
  if (obj.params.x < 0.5) {
    // The parameter is the INSTANCE's own quad corner in 0..1, not a target
    // coordinate, so centring on 0.5 finds the centre of this particle rather
    // than the centre of the frame. That is why the raw-centre rule in
    // shaderBackendParity.test.ts does not apply here, and why the name says so.
    let d = length(quad - vec2<f32>(0.5, 0.5)) * 2.0;
    let f = clamp(1.0 - d * d, 0.0, 1.0);
    a = a * f;
  }
  return vec4<f32>(color.rgb * a, a);
}
`,
  glsl: {
    vertex: VS_GLSL(false),
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 params; };
in vec2 vQuad;
in vec4 vColor;
out vec4 frag;
void main() {
  float a = vColor.a;
  if (params.x < 0.5) {
    float d = length(vQuad - vec2(0.5)) * 2.0;
    a *= clamp(1.0 - d * d, 0.0, 1.0);
  }
  frag = vec4(vColor.rgb * a, a);
}
`,
  },
};

/**
 * Sprite: the plugin's own image, tinted by the instance colour.
 *
 * The texture is premultiplied, like everything else this renderer samples, so
 * the tint multiplies its RGB by the straight instance colour and its alpha by
 * the instance alpha — which keeps the result premultiplied without ever
 * dividing, and therefore without the division-by-a-small-alpha noise a
 * straight round-trip would introduce at a sprite's soft edge.
 */
const GENERATOR_SPRITE: ShaderSource = {
  name: 'generator-sprite',
  wgsl: `${VS_WGSL(true)}
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;

@fragment
fn fs(@location(0) uv : vec2<f32>, @location(1) color : vec4<f32>) -> @location(0) vec4<f32> {
  let t = textureSample(tex, smp, uv);
  return vec4<f32>(t.rgb * color.rgb * color.a, t.a * color.a);
}
`,
  glsl: {
    vertex: VS_GLSL(true),
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 params; };
uniform sampler2D uTex;
in vec2 vUv;
in vec4 vColor;
out vec4 frag;
void main() {
  vec4 t = texture(uTex, vUv);
  frag = vec4(t.rgb * vColor.rgb * vColor.a, t.a * vColor.a);
}
`,
  },
};

/**
 * Mesh: the plugin's own triangles, placed once per instance.
 *
 * Its own shader rather than a flag on the sprite one, because the GEOMETRY
 * slot is a different layout — a mesh vertex is position xyz plus uv, where a
 * sprite's is a 2D quad corner — and a vertex layout is part of a pipeline. The
 * instance attributes are the same four, at the same locations, deliberately:
 * one instance buffer format serves every primitive, so a generator can change
 * `primitive` between frames without the host re-packing anything.
 *
 * The mesh's own z is added to the instance's, so a mesh has real depth WITHIN
 * the field's perspective divide — a 3D glyph tumbling in a particle system —
 * while still compositing as one flat layer afterwards.
 */
const GENERATOR_MESH: ShaderSource = {
  name: 'generator-mesh',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  params : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
};

@vertex
fn vs(
  @location(0) mPos : vec3<f32>,
  @location(5) mUv : vec2<f32>,
  @location(1) iPos : vec3<f32>,
  @location(2) iSizeRot : vec2<f32>,
  @location(3) iColor : vec4<f32>
) -> VOut {
  var o : VOut;
  let scaled = mPos * iSizeRot.x;
  let s = sin(iSizeRot.y);
  let cs = cos(iSizeRot.y);
  let rotated = vec3<f32>(scaled.x * cs - scaled.y * s, scaled.x * s + scaled.y * cs, scaled.z);
  let world = iPos + rotated;
  let focal = obj.params.y;
  var k = 1.0;
  if (focal > 0.0) { k = focal / max(focal - world.z, 1.0); }
  let p = obj.mvp * vec3<f32>(world.xy * k, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = mUv;
  o.color = iColor;
  return o;
}

@fragment
fn fs(@location(0) uv : vec2<f32>, @location(1) color : vec4<f32>) -> @location(0) vec4<f32> {
  let t = textureSample(tex, smp, uv);
  return vec4<f32>(t.rgb * color.rgb * color.a, t.a * color.a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec3 mPos;
layout(location = 5) in vec2 mUv;
layout(location = 1) in vec3 iPos;
layout(location = 2) in vec2 iSizeRot;
layout(location = 3) in vec4 iColor;
layout(std140) uniform Object { mat3 mvp; vec4 params; };
out vec2 vUv;
out vec4 vColor;
void main() {
  vec3 scaled = mPos * iSizeRot.x;
  float s = sin(iSizeRot.y);
  float cs = cos(iSizeRot.y);
  vec3 rotated = vec3(scaled.x * cs - scaled.y * s, scaled.x * s + scaled.y * cs, scaled.z);
  vec3 world = iPos + rotated;
  float focal = params.y;
  float k = 1.0;
  if (focal > 0.0) { k = focal / max(focal - world.z, 1.0); }
  vec3 p = mvp * vec3(world.xy * k, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = mUv;
  vColor = iColor;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 params; };
uniform sampler2D uTex;
in vec2 vUv;
in vec4 vColor;
out vec4 frag;
void main() {
  vec4 t = texture(uTex, vUv);
  frag = vec4(t.rgb * vColor.rgb * vColor.a, t.a * vColor.a);
}
`,
  },
};

export const GENERATOR_SHADERS: readonly ShaderSource[] = [
  GENERATOR_POINT,
  GENERATOR_SPRITE,
  GENERATOR_MESH,
];
