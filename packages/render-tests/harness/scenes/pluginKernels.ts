/**
 * Round C2's four capabilities, each rendered through the production pipeline.
 *
 * ── Why these four, and why each needs pixels ───────────────────────────────
 *
 * Every one of them is a place where the unit tests can only see half of a
 * conversation. A manifest test proves an effect DECLARES a GLSL kernel; only a
 * render proves the backend compiled it and bound the block at the offsets the
 * struct claims. The plugin effect surface shipped inert three times with green
 * unit suites (see `pluginEffects.ts` in this directory), which is the reason
 * this family exists at all.
 *
 *   plugin-kernel-time     WGSL + GLSL, reading the host block (time, compSize)
 *   plugin-kernel-cpu      a CPU kernel, on the raster/bake path
 *   plugin-kernel-inputs   two layer inputs, blended by a third parameter
 *   plugin-kernel-expand   an effect drawing OUTSIDE its layer box
 *
 * ── How each is measured ────────────────────────────────────────────────────
 *
 * Every scene carries a control that differs from it in exactly one way, so the
 * reading is a comparison rather than a golden of a picture nobody has checked.
 * A golden blessed while a feature was inert records "the effect changes
 * nothing" as correct, which is the bug rather than the reference.
 *
 *   time    at frame 0 vs frame 15   must DIFFER — an effect reading `time`
 *                                    that does not change over time is an
 *                                    effect that did not read it
 *   cpu     vs `plugin-kernel-cpu-control`   must DIFFER
 *   inputs  vs `plugin-kernel-inputs-control` must DIFFER (the second input is
 *                                    a different colour; an effect that bound
 *                                    the wrong texture self-samples and matches)
 *   expand  vs `plugin-kernel-expand-control` must be WIDER than the layer box
 *
 * ── NOT RUN by the agent that wrote them ────────────────────────────────────
 *
 * These are unblessed. The orchestrator blesses them after reviewing the
 * pictures; a first golden written by the same pass that wrote the feature
 * proves only that the feature is self-consistent.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { registerEffects } from '@core/plugins/pluginEffects';
import { setPackageReader } from '@core/plugins/kernel/kernelHost';
import type { EffectContribution } from '@core/plugins/effectSchema';

const COMP = { width: 320, height: 180, background: '#0c0c12' };
const SIZE = { w: 320, h: 180 };
const PLUGIN_ID = 'studio.rendertest.kernels';

const SUBJECT = { size: 120, centre: { x: 160, y: 90 } };

/**
 * Reads the HOST BLOCK: a horizontal ramp whose phase comes from `time` and
 * whose period comes from `compSize`.
 *
 * Both halves are deliberate. `time` makes frame 0 and frame 15 different
 * pictures — an effect that failed to read it renders the same frame twice, and
 * the comparison catches it. `compSize` makes the period a property of the
 * composition rather than of the layer, so a shader handed a zeroed block
 * produces a division by zero and a flat result rather than a plausible ramp.
 */
const TIME_WGSL = `
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(src, samp, uv);
  let period = params.compSize.x / 80.0;
  let wave = 0.5 + 0.5 * sin((uv.x * period + params.time) * 6.2831853);
  return vec4<f32>(c.rgb * wave, c.a);
}`;

/** The same arithmetic in GLSL ES 3.0, for the WebGL2 tier. */
const TIME_GLSL = `
vec4 fs(vec2 uv) {
  vec4 c = texture(src, uv);
  float period = compSize.x / 80.0;
  float wave = 0.5 + 0.5 * sin((uv.x * period + time) * 6.2831853);
  return vec4(c.rgb * wave, c.a);
}`;

/**
 * A CPU kernel: swap red and blue.
 *
 * Chosen for the same reason `killred` was in the sibling family — no blend
 * mode, opacity or alpha misreading swaps two channels, so a difference here
 * cannot be anything but the kernel having run.
 */
const CPU_KERNEL = `
exports.render = function (input, output, width, height, params, host) {
  for (var i = 0; i < input.length; i += 4) {
    output[i] = input[i + 2];
    output[i + 1] = input[i + 1];
    output[i + 2] = input[i];
    output[i + 3] = input[i + 3];
  }
};`;

/**
 * Two layer inputs, mixed.
 *
 * `a` at binding 3 and `b` at binding 5 — the gap at 4 is `origin`, permanently.
 * Mixing rather than picking one means a wrong binding is visible as the wrong
 * COLOUR rather than as a missing layer, which a clipped or absent input could
 * also produce.
 */
const MIX_WGSL = `
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let one = textureSample(inputA, samp, uv);
  let two = textureSample(inputB, samp, uv);
  return mix(one, two, params.blend);
}`;

/**
 * The same mix in GLSL ES 3.0, for the WebGL2 tier — which is the GATE backend
 * (`run.mjs` `GATE_BACKEND`). Without it the effect is `unsupported` there by
 * design (docs/PLUGINS.md, "A kernel missing for the LIVE backend is reported,
 * not passed through"), emits no pass, and the blessed frame is byte-identical
 * to the control — which is exactly how this scene first read as a no-op.
 */
const MIX_GLSL = `
vec4 fs(vec2 uv) {
  vec4 one = texture(inputA, uv);
  vec4 two = texture(inputB, uv);
  return mix(one, two, blend);
}`;

/**
 * Draws a 24px border OUTSIDE the layer's own rectangle — the reach it declares
 * in `expand`.
 *
 * ── Why this reads `layerRect`, not `uv < 0` ────────────────────────────────
 *
 * The first version tested `uv.x < 0.0 || uv.x > 1.0 …`, on the belief that
 * `uv` runs 0..1 over the layer's box. It does not, on any route: the generated
 * vertex stage writes `uv = uvRect.xy + pos * uvRect.zw` for a full-target quad
 * with `pos` in [0,1] (docs/PLUGINS.md: "the same full-screen quad transform"),
 * so `uv` spans the TARGET — the whole viewport here — and is never outside
 * [0,1]. That condition was unreachable, the shader returned `c` unchanged on
 * every pixel, and the frame was byte-identical to its control.
 *
 * Nor could it have been written correctly: nothing in the block said where the
 * layer was. `layerRect` (host-filled, in `uv` units) is what closes that, and
 * `(uv - layerRect.xy) / layerRect.zw` is the layer-local 0..1 this scene meant.
 */
const EXPAND_WGSL = `
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(src, samp, uv);
  let px = (uv - params.layerRect.xy) / params.layerRect.zw * params.layerSize;
  let inBox = all(px >= vec2<f32>(0.0)) && all(px <= params.layerSize);
  let inReach = all(px >= vec2<f32>(-24.0)) && all(px <= params.layerSize + vec2<f32>(24.0));
  let band = select(0.0, 1.0, inReach && !inBox);
  return mix(c, vec4<f32>(0.9, 0.8, 0.2, 1.0), band * params.ring);
}`;

/** The same border in GLSL ES 3.0, for the WebGL2 gate backend (see `MIX_GLSL`). */
const EXPAND_GLSL = `
vec4 fs(vec2 uv) {
  vec4 c = texture(src, uv);
  vec2 px = (uv - layerRect.xy) / layerRect.zw * layerSize;
  bool inBox = all(greaterThanEqual(px, vec2(0.0))) && all(lessThanEqual(px, layerSize));
  bool inReach = all(greaterThanEqual(px, vec2(-24.0))) && all(lessThanEqual(px, layerSize + vec2(24.0)));
  float band = (inReach && !inBox) ? 1.0 : 0.0;
  return mix(c, vec4(0.9, 0.8, 0.2, 1.0), band * ring);
}`;

const effect = (over: Partial<EffectContribution> & { id: string }): EffectContribution => ({
  label: over.id,
  shader: '',
  params: {},
  ...over,
} as EffectContribution);

/*
  Registered at MODULE LOAD, for the reason the sibling family states: the
  renderer bridge compiles what is registered when it attaches, and it attaches
  while the backend initialises — after the scene is built and before it
  renders. Registering here means the harness's readiness wait has something to
  wait for.
*/
registerEffects(PLUGIN_ID, 'Render Test Kernels', [
  effect({
    id: 'timeramp',
    shader: TIME_WGSL,
    glsl: TIME_GLSL,
    params: {},
  }),
  effect({
    id: 'swaprb',
    cpu: { module: 'kernels/swap.js', format: 'js', entry: 'render' },
    params: {},
  }),
  effect({
    id: 'mix',
    shader: MIX_WGSL,
    glsl: MIX_GLSL,
    params: {
      inputA: { type: 'layer', default: '' },
      inputB: { type: 'layer', default: '' },
      blend: { type: 'number', default: 0.5, min: 0, max: 1 },
    },
  }),
  effect({
    id: 'ring',
    shader: EXPAND_WGSL,
    glsl: EXPAND_GLSL,
    params: { ring: { type: 'number', default: 1, min: 0, max: 1 } },
    expand: { left: 24, top: 24, right: 24, bottom: 24 },
  }),
  /*
    The same ring with NO `expand` — the control that actually isolates it.

    On the 2D route the chain's buffer is the whole viewport, so nothing is ever
    clipped at the layer box and `plugin-kernel-expand` draws its band with or
    without the declaration. Only a 3D layer's buffer is sized to the layer plus
    the declared reach (`effectSpreadPx`), so only there does omitting `expand`
    cut the band off — which is what the 3D pair below compares.
  */
  effect({
    id: 'ringclipped',
    shader: EXPAND_WGSL,
    glsl: EXPAND_GLSL,
    params: { ring: { type: 'number', default: 1, min: 0, max: 1 } },
  }),
]);

/*
  The CPU kernel's bytes.

  A harness has no installed package, so the reader is supplied directly. This
  is the whole reason `setPackageReader` is an interface rather than a direct
  read of the plugin store: a scene can hand over a kernel without installing
  anything, and the production path is unchanged.
*/
setPackageReader({
  read: async (_pluginId, path) => (path === 'kernels/swap.js' ? CPU_KERNEL : null),
});

interface KernelSceneOptions {
  id: string;
  description: string;
  effectId: string | null;
  params?: Record<string, unknown>;
  frames?: number[];
  /** A second, differently-coloured layer for the two-input scene. */
  withSecondLayer?: boolean;
  /**
   * Put the subject in 3D (face-on, at 1:1 through a camera), where the effect
   * buffer is the layer plus its declared reach rather than the whole viewport.
   */
  threeD?: boolean;
}

function kernelScene(options: KernelSceneOptions): Scene {
  return defineScene({
    id: options.id,
    description: options.description,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: options.frames ?? [0],
    /*
      GPU is the oracle, and there is no Canvas2D comparison to make: the
      reference engine cannot run a plugin kernel and would render the subject
      unaffected — precisely the failure these scenes exist to catch, so
      comparing against it would gate the bug in as correct.
    */
    oracle: 'gpu' as const,
    gpuParity: 'expect-pass' as const,
    build(graph) {
      if (options.withSecondLayer) {
        graph.addNode(node('other', {
          kind: 'shape',
          position: { x: SUBJECT.centre.x, y: SUBJECT.centre.y },
          transform: { width: SUBJECT.size, height: SUBJECT.size, shapeType: 'ellipse' },
          style: { fill: '#3ca0ff' },
        }));
      }
      graph.addNode(node('subj', {
        kind: 'shape',
        position: { x: SUBJECT.centre.x, y: SUBJECT.centre.y },
        transform: {
          width: SUBJECT.size, height: SUBJECT.size, shapeType: 'rect',
          ...(options.threeD ? { z: 0 } : {}),
        },
        // All three channels present, so a channel swap has something to swap
        // and a ramp has something to modulate.
        style: { fill: '#c86464' },
      }));
      if (options.threeD) {
        // Camera 1000 px back with a 1000 px focal length: z = 0 renders 1:1.
        graph.addNode(node('cam', {
          kind: 'camera',
          position: { x: SUBJECT.centre.x, y: SUBJECT.centre.y },
          transform: { z: -1000, focalLength: 1000 },
        }));
      }
      if (options.effectId) {
        graph.setEffects('subj', [{
          id: 'fx',
          type: `${PLUGIN_ID}.${options.effectId}`,
          params: options.params ?? {},
        }]);
      }
    },
  });
}

export const pluginKernelScenes: Scene[] = [
  kernelScene({
    id: 'plugin-kernel-time',
    description: 'A WGSL+GLSL plugin kernel modulated by the host block time and comp size. Frames 0 and 15 must differ.',
    effectId: 'timeramp',
    // Two frames, half a second apart at 30 fps: the comparison between them is
    // the assertion that `time` reached the shader at all.
    frames: [0, 15],
  }),
  kernelScene({
    id: 'plugin-kernel-cpu-control',
    description: 'The subject with no effect — the control for the CPU kernel scene.',
    effectId: null,
  }),
  kernelScene({
    id: 'plugin-kernel-cpu',
    description: 'A CPU kernel swapping red and blue on the raster path. Must differ from its control in those two channels only.',
    effectId: 'swaprb',
  }),
  kernelScene({
    id: 'plugin-kernel-inputs-control',
    description: 'The two-input subject with the effect disabled — the control.',
    effectId: null,
    withSecondLayer: true,
  }),
  kernelScene({
    id: 'plugin-kernel-inputs',
    description: 'An effect mixing TWO layer inputs (bindings 3 and 5). Must differ from its control.',
    effectId: 'mix',
    params: { inputA: 'subj', inputB: 'other', blend: 0.5 },
    withSecondLayer: true,
  }),
  kernelScene({
    id: 'plugin-kernel-expand-control',
    description: 'The ring effect with its reach turned off — the control for expand().',
    effectId: 'ring',
    params: { ring: 0 },
  }),
  kernelScene({
    id: 'plugin-kernel-expand',
    description: 'An effect declaring expand(): 24px of margin on every side, drawn as a band outside the layer box.',
    effectId: 'ring',
    params: { ring: 1 },
  }),
  kernelScene({
    id: 'plugin-kernel-expand-3d-control',
    description: 'The same ring on a face-on 3D layer, WITHOUT expand(): the buffer is the layer box, so the band is clipped away.',
    effectId: 'ringclipped',
    params: { ring: 1 },
    threeD: true,
  }),
  kernelScene({
    id: 'plugin-kernel-expand-3d',
    description: 'The ring on a face-on 3D layer WITH expand(): the host reserves 24px of margin, so the band survives. Must be wider than its control.',
    effectId: 'ring',
    params: { ring: 1 },
    threeD: true,
  }),
];
