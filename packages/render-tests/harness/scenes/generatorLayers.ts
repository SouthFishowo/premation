/**
 * Plugin GENERATOR and SHADER layer kinds, rendered through the real pipeline.
 *
 * ── Why these exist ──────────────────────────────────────────────────────────
 *
 * For the reason `pluginEffects.ts` next door exists, and it is the same
 * failure: every half of a plugin render path can be correct about its own half
 * of a conversation the halves are not having, and every unit test stays green
 * while nothing draws. These scenes run the production path — manifest kind,
 * scheduler, instance buffer, instanced draw, composite — and read pixels.
 *
 * ── The frames must be PRIMED, and that is the interesting part ──────────────
 *
 * A generator's geometry comes from plugin code, which cannot run inside the
 * render loop: `requestGeneratorFrame` states a demand and returns whatever is
 * available, which on the first call is nothing. The harness builds a scene,
 * then initialises a backend (asynchronously), then renders — so a demand
 * stated during `build` is satisfied by the time the frame is drawn, because
 * the runner here resolves immediately and the intervening awaits drain the
 * microtask queue.
 *
 * That is exactly the ordering `pluginEffects.ts` relies on for compilation,
 * and it is stated here for the same reason: it ties correctness to an ordering
 * the harness is free to change, so a scene that suddenly renders empty should
 * be read as "the priming window closed", not as "the generator broke".
 *
 * ── Oracle ───────────────────────────────────────────────────────────────────
 *
 * GPU, with no Canvas2D comparison to make. The Canvas2D reference engine has
 * no instanced draw and would render these layers empty — which is precisely
 * the failure the scenes exist to catch, so comparing against it would gate the
 * bug in as correct.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { registerEffects } from '@core/plugins/pluginEffects';
import type { EffectContribution } from '@core/plugins/effectSchema';
import { registerLayerKinds } from '@core/plugins/layerKindRegistry';
import { buildCustomLayerComponent } from '@core/plugins/customLayers';
import type { LayerKindContribution } from '@core/plugins/layerKindSchema';
import {
  GEN_STRIDE,
  GEN_STRIDE_UV,
  requestGeneratorFrame,
  setGeneratorRunner,
} from '@core/plugins/generator';
// The leaf module, for `generatorSeed`: the barrel deliberately does not
// re-export the snapshot seam, and the seed has to MATCH what `buildSnapshot`
// will ask for — the scheduler keys a simulation on it, so priming under a
// different seed primes a different simulation and the frame renders empty.
import { generatorSeed } from '@core/plugins/generator/generatorLayers';
import { setPluginAssetHost } from '@core/plugins/pluginAssetTextures';

const COMP = { width: 360, height: 280, background: '#0c0c12' };
const SIZE = { w: 360, h: 280 };
const FPS = 30;

const PLUGIN_ID = 'studio.rendertest.gen';

/** The frame every scene here renders. Not 0: a simulation at rest proves less
 *  than one that has been stepped, and 12 is past the first checkpoint. */
const FRAME = 12;

/**
 * A deterministic spiral — the same instances for the same frame, forever.
 *
 * Closed-form rather than integrated, so the golden does not depend on how many
 * times the scheduler happened to step the simulation. A stateful simulation is
 * covered by `generatorState.test.ts`, where an oracle can check it; a GOLDEN
 * needs a function of the frame alone or it records one particular history as
 * correct.
 */
function spiral(count: number, frame: number): Float32Array {
  const out = new Float32Array(count * GEN_STRIDE);
  const spin = frame * 0.04;
  for (let i = 0; i < count; i++) {
    const o = i * GEN_STRIDE;
    const a = i * 0.21 + spin;
    const r = 4 + i * 0.055;
    const t = i / count;
    out[o] = Math.cos(a) * r;
    out[o + 1] = Math.sin(a) * r;
    out[o + 2] = 0;
    out[o + 3] = 2 + t * 5;
    out[o + 4] = a;
    out[o + 5] = 1;
    out[o + 6] = 0.45 + t * 0.5;
    out[o + 7] = 0.15 + t * 0.2;
    out[o + 8] = 0.35 + t * 0.65;
  }
  return out;
}

/** A 6×6 grid of sprite instances, each addressing one cell of a 2×2 atlas. */
function sprites(frame: number): Float32Array {
  const n = 36;
  const out = new Float32Array(n * GEN_STRIDE_UV);
  for (let i = 0; i < n; i++) {
    const o = i * GEN_STRIDE_UV;
    const col = i % 6;
    const row = Math.floor(i / 6);
    out[o] = (col - 2.5) * 44;
    out[o + 1] = (row - 2.5) * 40;
    out[o + 2] = 0;
    out[o + 3] = 34;
    out[o + 4] = (frame * 0.05) + i * 0.1;
    out[o + 5] = 1;
    out[o + 6] = 1;
    out[o + 7] = 1;
    out[o + 8] = 1;
    out[o + 9] = (i % 2) * 0.5;
    out[o + 10] = (Math.floor(i / 2) % 2) * 0.5;
  }
  return out;
}

/** The file the sprite generator names, as it would inside a real package. */
const ATLAS_PATH = 'sprites/atlas.png';

/**
 * The 2×2 sprite atlas this "plugin" ships, built once and served as PNG bytes.
 *
 * Four quadrants, four colours, each an inset disc with transparent margins —
 * which is what makes the scene able to fail. A flat atlas would render
 * identically under a wrong cell origin, a dropped `cellSize`, a V-flip or a
 * straight-alpha upload; four distinct discs with soft edges disagree visibly
 * under every one of them.
 *
 * Drawn rather than checked in as a fixture because the harness has no asset
 * pipeline for binary files, and a canvas is deterministic enough for a golden:
 * the GOLDEN records the rendered frame, not the PNG, and the decoded pixels of
 * a canvas-encoded PNG are the pixels that were drawn.
 */
const ATLAS_PX = 128;
let atlasBytes: Promise<Uint8Array> | null = null;

function atlas(): Promise<Uint8Array> {
  if (!atlasBytes) atlasBytes = buildAtlas();
  return atlasBytes;
}

async function buildAtlas(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_PX;
  canvas.height = ATLAS_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('the sprite atlas needs a 2D context');
  const half = ATLAS_PX / 2;
  const cells = ['#ff5a3c', '#3cff8a', '#3c8aff', '#ffd23c'];
  for (let i = 0; i < 4; i++) {
    const cx = (i % 2) * half + half / 2;
    const cy = Math.floor(i / 2) * half + half / 2;
    ctx.fillStyle = cells[i]!;
    ctx.beginPath();
    // 0.38 of the cell, so every disc keeps a transparent margin and no two
    // neighbouring cells can bleed into one another under linear filtering.
    ctx.arc(cx, cy, half * 0.38, 0, Math.PI * 2);
    ctx.fill();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the sprite atlas could not be encoded');
  return new Uint8Array(await blob.arrayBuffer());
}

/*
  The package-file route, as the harness's own installed payload.

  Injected for the same reason the generator runner above is: the texture cache
  reaches a plugin's package through a host, and the harness has no plugin store
  to be one. This is the ONE file this "plugin" ships; anything else is a miss,
  exactly as it would be for a real package.
*/
setPluginAssetHost({
  read: async (pluginId, path) =>
    (pluginId === PLUGIN_ID && path === ATLAS_PATH ? atlas() : null),
});

const kinds: LayerKindContribution[] = [
  {
    id: 'spiral',
    label: 'Spiral',
    render: 'generator',
    schemaVersion: 1,
    props: { density: { type: 'number', default: 2000, min: 1, max: 20000 } },
  },
  {
    id: 'sprites',
    label: 'Sprites',
    render: 'generator',
    schemaVersion: 1,
    props: { density: { type: 'number', default: 36, min: 1, max: 100 } },
  },
  {
    id: 'ramp',
    label: 'Ramp',
    render: 'shader',
    shader: 'ramp',
    schemaVersion: 1,
    props: { amount: { type: 'number', default: 1, min: 0, max: 1 } },
  },
];

/**
 * A full-layer procedural kernel: a diagonal ramp that ignores its input.
 *
 * It must ignore the input, because a `shader` layer kind's carrier is
 * transparent — the kernel IS the content. A shader that sampled `src` would
 * render nothing and the scene would pass while proving nothing.
 *
 * ── Why it reads `layerRect` ────────────────────────────────────────────────
 *
 * It first used raw `uv`, on the belief that `uv` spans the layer. It spans the
 * pass's TARGET (a full-target quad; see `EXPAND_WGSL` in `pluginKernels.ts`),
 * which on the 2D route is the whole viewport — and it runs bottom-up on WebGL2
 * and top-down on WebGPU. Measured with the GLSL twin in place: both backends
 * painted all 360×280 px of the comp for a 240×180 layer, and the top-left
 * pixel was (22,137,254) on WebGPU but (187,137,188) on WebGL2 — the same ramp,
 * mirrored. `layerRect` gives a top-down layer-local frame on both, and the
 * ramp is bounded to it because a layer's content belongs inside the layer.
 */
const RAMP = `
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let local = (uv - params.layerRect.xy) / params.layerRect.zw;
  let inside = select(0.0, 1.0, all(local >= vec2<f32>(0.0)) && all(local <= vec2<f32>(1.0)));
  let v = (local.x + local.y) * 0.5 * params.amount;
  return vec4<f32>(v, 0.25, 1.0 - v, 1.0) * inside;
}`;

/**
 * The same ramp in GLSL ES 3.0. The golden gate blesses from WebGL2
 * (`run.mjs` `GATE_BACKEND`), where a WGSL-only effect is `unsupported` by
 * design and emits no pass — so without this twin the carrier stays
 * transparent and the frame is the empty background.
 */
const RAMP_GLSL = `
vec4 fs(vec2 uv) {
  vec2 local = (uv - layerRect.xy) / layerRect.zw;
  float inside = (all(greaterThanEqual(local, vec2(0.0))) && all(lessThanEqual(local, vec2(1.0)))) ? 1.0 : 0.0;
  float v = (local.x + local.y) * 0.5 * amount;
  return vec4(v, 0.25, 1.0 - v, 1.0) * inside;
}`;

/*
  Registered at MODULE LOAD, for the reason `pluginEffects.ts` gives: the
  renderer bridge compiles what is registered when it attaches, and it attaches
  while the backend initialises — after the scene is built, before it renders.
*/
registerEffects(PLUGIN_ID, 'Render Test', [{
  id: 'ramp',
  label: 'ramp',
  params: { amount: { type: 'number', label: 'Amount', default: 1, min: 0, max: 1 } },
  shader: RAMP,
  glsl: RAMP_GLSL,
} as unknown as EffectContribution]);

registerLayerKinds(PLUGIN_ID, 'Render Test', kinds);

setGeneratorRunner({
  generate: (_pluginId, kindId, request) => {
    const frame = (request as { frame: number }).frame;
    return Promise.resolve(
      kindId === 'sprites'
        ? {
            instances: sprites(frame),
            count: 36,
            stride: GEN_STRIDE_UV,
            primitive: 'sprite' as const,
            textureAssetKey: ATLAS_PATH,
            cellSize: [0.5, 0.5] as const,
          }
        : {
            instances: spiral(2000, frame),
            count: 2000,
            primitive: 'point' as const,
            blend: 'add' as const,
          },
    );
  },
});

/** The layer box the instance positions are measured from. */
const BOX = { width: 320, height: 240 };

function generatorScene(id: string, kindId: string, description: string): Scene {
  return defineScene({
    id,
    description,
    size: SIZE,
    comp: COMP,
    fps: FPS,
    frames: [FRAME],
    oracle: 'gpu' as const,
    gpuParity: 'expect-pass' as const,
    build(graph) {
      const kind = kinds.find((k) => k.id === kindId)!;
      graph.addNode(node('gen', {
        kind: `${PLUGIN_ID}.${kindId}`,
        position: { x: COMP.width / 2, y: COMP.height / 2 },
        transform: { width: BOX.width, height: BOX.height },
        components: [buildCustomLayerComponent(PLUGIN_ID, kind, {}, 'gen_p')],
      }));

      // Prime the scheduler — see the header. Without this the first render
      // finds nothing produced and draws an empty layer.
      requestGeneratorFrame({
        layerId: 'gen',
        pluginId: PLUGIN_ID,
        kindId,
        request: {
          layerTime: FRAME / FPS,
          compTime: FRAME / FPS,
          frame: FRAME,
          fps: FPS,
          compSize: { width: COMP.width, height: COMP.height },
          layerSize: BOX,
          params: {},
          seed: generatorSeed('gen'),
        },
      });
    },
  });
}

export const generatorLayerScenes: Scene[] = [
  generatorScene(
    'generator-spiral',
    'spiral',
    'A plugin generator layer: 2000 additively-blended points on a deterministic spiral, drawn instanced.',
  ),
  generatorScene(
    'generator-sprite',
    'sprites',
    'A plugin generator drawing a 6×6 grid of textured sprites from a 2×2 atlas the plugin package ships — '
    + 'the `pluginAsset:*` route end to end: the file is read out of the installed payload, decoded once, '
    + 'shared by every instance, and addressed per instance by the stride-11 u,v against `cellSize`. Each '
    + 'quadrant of the atlas is a different colour, so a wrong cell origin, a dropped cellSize or a V-flip '
    + 'moves colours between sprites rather than changing nothing.',
  ),
  defineScene({
    id: 'generator-shader-kind',
    description: 'A `render: "shader"` layer kind drawn by the plugin effect it names: a full-layer procedural ramp.',
    size: SIZE,
    comp: COMP,
    fps: FPS,
    frames: [FRAME],
    oracle: 'gpu' as const,
    gpuParity: 'expect-pass' as const,
    build(graph) {
      const kind = kinds.find((k) => k.id === 'ramp')!;
      graph.addNode(node('shaderkind', {
        kind: `${PLUGIN_ID}.ramp`,
        position: { x: COMP.width / 2, y: COMP.height / 2 },
        transform: { width: 240, height: 180 },
        components: [buildCustomLayerComponent(PLUGIN_ID, kind, {}, 'shaderkind_p')],
      }));
    },
  }),
];
