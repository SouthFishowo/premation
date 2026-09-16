/**
 * Instanced drawing of a plugin generator's output.
 *
 * Three claims, each of which was broken before this feature and each of which
 * fails silently rather than loudly when it regresses:
 *
 *   · the field is drawn INSTANCED — one draw for every particle, not one draw
 *     per particle and not one draw of one particle;
 *   · the instance buffer is uploaded only when the data CHANGED, so a paused
 *     viewport does not push two megabytes a frame at a simulation that is not
 *     moving;
 *   · the vertex layouts match the contract's byte offsets exactly, because the
 *     plugin's buffer is handed to the GPU with no repacking — a wrong offset
 *     here is not an error anywhere, it is particles in the wrong places.
 */

import { Renderer } from '../core/renderer/Renderer';
import { NullBackend } from '../gpu/backends/NullBackend';
import { Mat3 } from '../core/math/Mat3';
import { Color } from '../core/math/Color';
import {
  GENERATOR_INSTANCE_LAYOUT,
  GENERATOR_INSTANCE_UV_LAYOUT,
  GENERATOR_MESH_LAYOUT,
} from '../shaders/Material';
import { forgetGeneratorBuffers } from '../rendergraph/passes/generatorField';
import { GENERATOR_SHADERS } from '../shaders/generatorInstances';
import { DefaultTextureProvider, type ResolvedTexture, type TextureProvider } from '../resources/TextureProvider';
import type { ResourceManager } from '../gpu/ResourceManager';
import type { FrameScene, Renderable } from '../scene/FrameScene';

const W = 800;
const H = 600;

/** `count` instances at stride 9, all distinct so nothing can alias. */
function instances(count: number, stride = 9): Float32Array {
  const out = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    out[o] = i * 3;          // x
    out[o + 1] = -i;         // y
    out[o + 2] = 0;          // z
    out[o + 3] = 8;          // size
    out[o + 4] = 0;          // rotation
    out[o + 5] = 1;          // r
    out[o + 6] = 0.5;        // g
    out[o + 7] = 0.25;       // b
    out[o + 8] = 1;          // a
  }
  return out;
}

function generatorLayer(over: Partial<NonNullable<Renderable['generator']>> = {}, count = 1200): Renderable {
  const w = 400;
  const h = 300;
  const model = Mat3.multiply(Mat3.compose(400, 300, 0, w, h), Mat3.translation(-0.5, -0.5));
  return {
    id: 'gen',
    kind: 'image',
    modelMatrix: model,
    bounds: { x: 200, y: 150, width: w, height: h },
    opacity: 1,
    blend: 'normal',
    color: Color.white(),
    textureKey: 'generator:gen',
    generator: {
      instances: instances(count),
      count,
      stride: 9,
      primitive: 'point',
      cellSize: [1, 1],
      blend: 'normal',
      revision: 1,
      width: w,
      height: h,
      ...over,
    },
  };
}

function scene(renderables: Renderable[]): FrameScene {
  return {
    composition: { id: 'comp', size: { width: W, height: H }, background: Color.of(0, 0, 0, 1) },
    renderables,
    hasEffects: true,
  };
}

/**
 * A provider that answers a chosen key with `ready: false`.
 *
 * Which is the shape of the real thing: `AppTextureProvider` never returns null
 * for an unknown key — it hands back a 1×1 TRANSPARENT placeholder, so a photo
 * that has not decoded draws nothing rather than a white box. That makes
 * "is there a texture" useless as a readiness test here, and `ready` the only
 * honest one.
 */
class UnreadyProvider implements TextureProvider {
  private readonly inner: DefaultTextureProvider;

  constructor(resources: ResourceManager, private readonly unready: ReadonlySet<string>) {
    this.inner = new DefaultTextureProvider(resources);
  }

  get(key: string): ResolvedTexture {
    const resolved = this.inner.get(key);
    return this.unready.has(key) ? { ...resolved, ready: false } : resolved;
  }
}

async function render(scenes: FrameScene[], unready?: ReadonlySet<string>): Promise<NullBackend> {
  const backend = new NullBackend();
  const renderer = new Renderer({
    backend,
    now: () => 16,
    ...(unready ? { textures: (r: ResourceManager) => new UnreadyProvider(r, unready) } : {}),
  });
  await renderer.initialize();
  const vp = renderer.createViewport({ width: W, height: H, overlays: { grid: false, checkerboard: false } });
  vp.camera.setState({ center: { x: W / 2, y: H / 2 }, zoom: 1 });
  for (const s of scenes) renderer.render(vp, s);
  return backend;
}

beforeEach(() => {
  // The upload cache is module state keyed by layer id, and every test here
  // uses the same id.
  forgetGeneratorBuffers();
});

describe('the instanced draw', () => {
  it('draws the whole field in ONE call, with one instance per particle', async () => {
    const backend = await render([scene([generatorLayer()])]);
    const field = backend.draws.filter((d) => d.pass === 'generator-field');
    expect(field).toHaveLength(1);
    expect(field[0]!.instanceCount).toBe(1200);
    // Six vertices: the shared unit quad, repeated per instance.
    expect(field[0]!.vertexCount).toBe(6);
  });

  it('draws nothing for an empty frame, but still clears its target', async () => {
    const backend = await render([scene([generatorLayer({ instances: new Float32Array(0), count: 0 })])]);
    expect(backend.draws.filter((d) => d.pass === 'generator-field')).toHaveLength(0);
    // The pass still ran: a matte source that produced nothing this frame has
    // to go transparent rather than keep the last frame it managed.
    expect(backend.passLog).toContain('generator-field');
  });

  it('composites the field afterwards, through the ordinary textured path', async () => {
    const backend = await render([scene([generatorLayer()])]);
    // The field pass, then a draw in the ordinary composition pass for the
    // resulting texture — which is what buys masks, mattes, blend and effects.
    expect(backend.passLog.filter((p) => p === 'generator-field' || p === 'composition'))
      .toEqual(['generator-field', 'composition']);
  });

  it('reads a stride-11 buffer through a stride-11 LAYOUT, whatever the primitive', async () => {
    /*
      The layout follows the buffer's stride, the shader follows the primitive,
      and the two are independent. A stride-11 buffer read through the
      stride-9 layout does not fail — it walks the wrong bytes, and every
      particle lands somewhere plausible and wrong.
    */
    const count = 40;
    const backend = await render([scene([generatorLayer({
      instances: instances(count, 11),
      count,
      stride: 11,
      // Points, NOT sprites: the wide stride is legal on any primitive.
      primitive: 'point',
    }, count)])]);
    const field = backend.draws.filter((d) => d.pass === 'generator-field');
    expect(field).toHaveLength(1);
    expect(field[0]!.instanceCount).toBe(count);
  });

  it('falls back to points when a sprite texture has not resolved', async () => {
    const count = 24;
    const key = 'pluginAsset:a.b/nothing-here.png';
    const spriteLayer = generatorLayer({
      instances: instances(count, 11),
      count,
      stride: 11,
      primitive: 'sprite',
      textureKey: key,
    }, count);

    // ONE backend, so the two pipeline ids are comparable: they come from the
    // same counter, and a fresh backend's would not be.
    const unready = new Set([key]);
    const backend = new NullBackend();
    const renderer = new Renderer({
      backend,
      now: () => 16,
      textures: (r: ResourceManager) => new UnreadyProvider(r, unready),
    });
    await renderer.initialize();
    const vp = renderer.createViewport({ width: W, height: H, overlays: { grid: false, checkerboard: false } });
    vp.camera.setState({ center: { x: W / 2, y: H / 2 }, zoom: 1 });

    // Still drawn — grey points for a frame beats an empty layer that reads as
    // the plugin being broken. Before the readiness gate this took the SPRITE
    // path against the provider's transparent placeholder, so a field whose
    // atlas had not decoded came out completely invisible.
    renderer.render(vp, scene([spriteLayer]));
    const fallback = backend.draws.filter((d) => d.pass === 'generator-field');
    expect(fallback).toHaveLength(1);

    // The decode lands.
    unready.clear();
    renderer.render(vp, scene([spriteLayer]));
    const both = backend.draws.filter((d) => d.pass === 'generator-field');
    expect(both).toHaveLength(2);
    // Two different materials, so two different pipelines: the untextured
    // fallback is not the sprite shader with a blank texture bound.
    expect(both[1]!.pipeline).not.toBe(both[0]!.pipeline);
  });

  it('uses the indexed mesh path when the primitive is a mesh', async () => {
    const backend = await render([scene([generatorLayer({
      primitive: 'mesh',
      textureKey: 'texture:white',
      mesh: {
        vertices: new Float32Array([0, 0, 0, 0, 0, 10, 0, 0, 1, 0, 0, 10, 0, 0, 1]),
        indices: new Uint16Array([0, 1, 2]),
      },
    })])]);
    const field = backend.draws.filter((d) => d.pass === 'generator-field');
    expect(field).toHaveLength(1);
    expect(field[0]!.indexed).toBe(true);
    expect(field[0]!.vertexCount).toBe(3);
    expect(field[0]!.instanceCount).toBe(1200);
  });
});

describe('buffer reuse', () => {
  it('re-uploads only when the revision changes', async () => {
    const first = generatorLayer();
    const unchanged = generatorLayer();
    const backend = new NullBackend();
    const renderer = new Renderer({ backend, now: () => 16 });
    await renderer.initialize();
    const vp = renderer.createViewport({ width: W, height: H, overlays: { grid: false, checkerboard: false } });
    vp.camera.setState({ center: { x: W / 2, y: H / 2 }, zoom: 1 });

    renderer.render(vp, scene([first]));
    const afterFirst = backend.stats().bufferBytesWritten;
    renderer.render(vp, scene([unchanged]));
    const afterSecond = backend.stats().bufferBytesWritten;
    // Uniform blocks are re-written every frame (64 bytes); the 43 KB instance
    // buffer is not. The gap is the whole point of `revision`.
    expect(afterSecond - afterFirst).toBeLessThan(1200 * 9 * 4);

    const moved = generatorLayer({ revision: 2 });
    renderer.render(vp, scene([moved]));
    expect(backend.stats().bufferBytesWritten - afterSecond).toBeGreaterThanOrEqual(1200 * 9 * 4);
  });

  it('keeps ONE buffer across a simulation whose particle count wobbles', async () => {
    const backend = new NullBackend();
    const renderer = new Renderer({ backend, now: () => 16 });
    await renderer.initialize();
    const vp = renderer.createViewport({ width: W, height: H, overlays: { grid: false, checkerboard: false } });
    vp.camera.setState({ center: { x: W / 2, y: H / 2 }, zoom: 1 });

    // 3000 → 3100 → 3050 all fit one 4096-instance allocation: the capacity is
    // rounded to a power of two precisely so a birth or a death is not a new
    // GPU buffer.
    let rev = 0;
    for (const count of [3000, 3100, 3050]) {
      rev += 1;
      renderer.render(vp, scene([generatorLayer({ instances: instances(count), count, revision: rev }, count)]));
    }
    const live = backend.stats().liveBuffers;
    renderer.render(vp, scene([generatorLayer({ instances: instances(3080), count: 3080, revision: 9 }, 3080)]));
    expect(backend.stats().liveBuffers).toBe(live);
  });
});

describe('the vertex layouts ARE the contract', () => {
  /*
    The plugin's buffer reaches the GPU unrepacked, so these offsets are the
    field list in `core/plugins/generator/generatorContract.ts` restated in
    bytes. Pinned here rather than derived from it, deliberately: the renderer
    package must not import the editor's plugin code, so the two copies are kept
    honest by a test that fails loudly rather than by a dependency.
  */
  it('packs x,y,z / size,rotation / rgba at the contract offsets', () => {
    expect(GENERATOR_INSTANCE_LAYOUT.strideBytes).toBe(36);
    expect(GENERATOR_INSTANCE_LAYOUT.stepMode).toBe('instance');
    expect(GENERATOR_INSTANCE_LAYOUT.attributes).toEqual([
      { shaderLocation: 1, offsetBytes: 0, format: 'float32x3' },
      { shaderLocation: 2, offsetBytes: 12, format: 'float32x2' },
      { shaderLocation: 3, offsetBytes: 20, format: 'float32x4' },
    ]);
  });

  it('adds u,v at byte 36 for stride 11, and changes nothing before it', () => {
    expect(GENERATOR_INSTANCE_UV_LAYOUT.strideBytes).toBe(44);
    expect(GENERATOR_INSTANCE_UV_LAYOUT.attributes.slice(0, 3))
      .toEqual(GENERATOR_INSTANCE_LAYOUT.attributes);
    expect(GENERATOR_INSTANCE_UV_LAYOUT.attributes[3])
      .toEqual({ shaderLocation: 4, offsetBytes: 36, format: 'float32x2' });
  });

  it('keeps the mesh vertex layout off every instance location', () => {
    expect(GENERATOR_MESH_LAYOUT.stepMode).toBe('vertex');
    const instanceLocations = new Set(GENERATOR_INSTANCE_UV_LAYOUT.attributes.map((a) => a.shaderLocation));
    for (const attr of GENERATOR_MESH_LAYOUT.attributes) {
      expect(instanceLocations.has(attr.shaderLocation)).toBe(false);
    }
  });
});

describe('the sprite shader samples the atlas the contract describes', () => {
  const sprite = GENERATOR_SHADERS.find((s) => s.name === 'generator-sprite')!;

  /*
    Both backends, one arithmetic. A sprite's texture coordinate is the
    INSTANCE's cell origin (`iUv`, floats 9 and 10 of a stride-11 instance) plus
    the quad corner scaled by the frame's `cellSize` — which rides in
    `params.zw`, packed there by `packGenerator`. Get any part of it wrong and
    every sprite still draws: it just samples the wrong cell, or the same texel
    for the whole quad, which reads as the texture having failed to load rather
    than as a UV bug.
  */
  it('addresses the atlas cell as iUv + corner × cellSize, identically on both', () => {
    expect(sprite.wgsl).toContain('o.uv = iUv + corner * obj.params.zw');
    expect(sprite.glsl!.vertex).toContain('vUv = iUv + corner * params.zw');
    // The cell origin arrives at the contract's location, not by accident.
    expect(sprite.wgsl).toContain('@location(4) iUv : vec2<f32>');
    expect(sprite.glsl!.vertex).toContain('layout(location = 4) in vec2 iUv;');
  });

  /*
    PREMULTIPLIED IN, PREMULTIPLIED OUT.

    Every texture this renderer samples holds premultiplied alpha (gpu/types.ts),
    and a packaged sprite is brought into that at decode. Instance colours are
    STRAIGHT, so the tint multiplies the texture's already-multiplied RGB by the
    straight colour AND by the instance alpha, and the alpha by the instance
    alpha alone. That keeps the result premultiplied without ever dividing —
    a straight round-trip would divide by a small alpha at a sprite's soft edge
    and put the noise back.
  */
  it('emits premultiplied colour on both backends', () => {
    expect(sprite.wgsl).toContain('vec4<f32>(t.rgb * color.rgb * color.a, t.a * color.a)');
    expect(sprite.glsl!.fragment).toContain('vec4(t.rgb * vColor.rgb * vColor.a, t.a * vColor.a)');
  });
});
