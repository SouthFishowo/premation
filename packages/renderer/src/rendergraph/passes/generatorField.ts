/**
 * Drawing a plugin generator's instances.
 *
 * One function, called from `CompositionPass.processRenderable` beside the
 * precomp branch and shaped like it: render the layer's content into an
 * offscreen, register the result under the renderable's `textureKey`, and hand
 * back an ordinary textured renderable. Everything after that — masks, track
 * mattes, blend modes, effect chains, motion blur, adjustment layers above it —
 * is the path every other layer already takes, with no case for generators in
 * any of it.
 *
 * ── Why the field is drawn in SCREEN space ───────────────────────────────────
 *
 * The obvious alternative is a layer-sized target: draw the instances into a
 * `width × height` buffer in layer pixels and composite that as a quad. It is
 * how the CPU particle field works, and it is wrong here for two reasons that
 * both come from the same place — a generator's instances are not confined to
 * the layer box.
 *
 *   · A simulation throws particles OUT of its emitter. Clipping them to the
 *     box would make the box visible, and the box is not a thing the user
 *     drew — it is a property panel default.
 *   · A layer scaled to 400% would rasterise its field at 100% and magnify it,
 *     so a 2-pixel spark would land as an 8-pixel blur. Instances are geometry;
 *     drawing them at the resolution they will be SEEN at costs nothing extra
 *     and is simply correct.
 *
 * So the field renders at viewport resolution through the layer's own matrix,
 * exactly as an isolated precomp does, and composites 1:1. The cost is the same
 * as a precomp's: the effect chain then runs in screen space rather than layer
 * space.
 *
 * ── Buffer reuse ─────────────────────────────────────────────────────────────
 *
 * One GPU buffer per layer, pooled by the ResourceManager under a key holding
 * its CAPACITY, and re-uploaded only when the frame's `revision` changes. A
 * paused viewport re-renders the same frame continuously; without the revision
 * check that would be two megabytes across the bus sixty times a second for a
 * simulation that is not moving.
 */

import { Color } from '../../core/math/Color';
import { Mat3 } from '../../core/math/Mat3';
import { CommandBuffer } from '../../commands/DrawCommand';
import type { BufferHandle, TextureHandle } from '../../gpu/types';
import type { Renderable } from '../../scene/FrameScene';
import type { RenderPassContext } from '../RenderPass';
import {
  GENERATOR_MESH_MATERIAL,
  GENERATOR_MESH_WIDE_MATERIAL,
  GENERATOR_POINT_MATERIAL,
  GENERATOR_POINT_WIDE_MATERIAL,
  GENERATOR_SPRITE_MATERIAL,
} from '../../shaders/Material';
import { GEN_KIND_POINT, GEN_KIND_QUAD, GEN_KIND_SPRITE } from '../../shaders/generatorInstances';
import { MAT3_STD140_FLOATS, packMat3 } from '../../pipeline/uniforms';
import { beginViewportPass, modelFromRect, mvpFor, targetSampleUv, writeAttachment } from './passUtils';

/** The offscreen a generator's instances are drawn into. Viewport-sized. */
export const GENERATOR_TARGET = 'generator-target';

/**
 * Where each layer's instance buffer is, and which revision is in it.
 *
 * Module state rather than pass state, because the ResourceManager already owns
 * the buffers and this is only the note of what was last written into them. It
 * is cleaned by layer id when a frame no longer mentions the layer — see
 * `forgetGeneratorBuffers`.
 */
const uploaded = new Map<string, { key: string; revision: number }>();

/** Drop what is remembered about one layer's buffer, or all of them. */
export function forgetGeneratorBuffers(layerId?: string): void {
  if (layerId === undefined) uploaded.clear();
  else uploaded.delete(layerId);
}

/**
 * Round a capacity UP to a power of two.
 *
 * The buffer's key holds its size (the ResourceManager bakes a size in at
 * creation and ignores the descriptor afterwards), so a buffer sized exactly to
 * the instance count would be a NEW allocation on every frame a particle was
 * born or died — which is every frame of every simulation. Powers of two mean a
 * system oscillating around 30 000 particles reuses one 32 768-instance buffer
 * for its whole life.
 */
function capacityFor(count: number): number {
  let n = 64;
  while (n < count) n *= 2;
  return n;
}

/** The instance buffer for this frame, uploaded if the data changed. */
function instanceBuffer(ctx: RenderPassContext, r: Renderable): BufferHandle | null {
  const gen = r.generator!;
  if (gen.count <= 0) return null;
  const floats = capacityFor(gen.count) * gen.stride;
  const key = `generator:instances:${r.id}:${floats}`;
  const buffer = ctx.services.resources.buffer(key, {
    label: `generator-instances:${r.id}`,
    sizeBytes: floats * 4,
    usage: ['vertex', 'copy'],
  });
  const last = uploaded.get(r.id);
  if (!last || last.key !== key || last.revision !== gen.revision) {
    // The exact bytes the plugin produced, not one float more: a 32 768-capacity
    // buffer holding 12 000 live instances uploads 12 000, and the draw's
    // instance count stops there.
    ctx.services.backend.writeBuffer(
      buffer,
      0,
      gen.instances.subarray(0, gen.count * gen.stride),
    );
    uploaded.set(r.id, { key, revision: gen.revision });
  }
  return buffer;
}

/** A generator mesh's vertex + index buffers, keyed so they upload once. */
function meshBuffers(
  ctx: RenderPassContext,
  r: Renderable,
): { vertex: BufferHandle; index: BufferHandle; count: number; format: 'uint16' | 'uint32' } | null {
  const mesh = r.generator?.mesh;
  if (!mesh) return null;
  const res = ctx.services.resources;
  // Keyed on the layer AND the sizes, so a generator that swaps its mesh gets a
  // new buffer rather than a stale one of the same name. A mesh is static
  // geometry by construction — the instances are what move — so the `data`
  // form (uploaded at creation, never rewritten) is the right one here and the
  // `copy` usage the instance buffer needs is not.
  const vkey = `generator:mesh-v:${r.id}:${mesh.vertices.length}:${r.generator!.revision}`;
  const ikey = `generator:mesh-i:${r.id}:${mesh.indices.length}:${r.generator!.revision}`;
  return {
    vertex: res.buffer(vkey, { label: vkey, sizeBytes: mesh.vertices.byteLength, usage: ['vertex'], data: mesh.vertices }),
    index: res.buffer(ikey, { label: ikey, sizeBytes: mesh.indices.byteLength, usage: ['index'], data: mesh.indices }),
    count: mesh.indices.length,
    format: mesh.indices.BYTES_PER_ELEMENT === 2 ? 'uint16' : 'uint32',
  };
}

/**
 * Field space → world.
 *
 * `r.modelMatrix` maps the unit square onto the layer's box in world space.
 * Instance positions are layer PIXELS around the box's centre, so the step in
 * between is "divide by the box, then move the origin from the centre to the
 * corner" — which is this, and is the only place the two conventions meet.
 */
function fieldToWorld(r: Renderable): Mat3 {
  const gen = r.generator!;
  const w = gen.width > 0 ? gen.width : 1;
  const h = gen.height > 0 ? gen.height : 1;
  return Mat3.multiply(
    r.modelMatrix,
    Mat3.multiply(Mat3.translation(0.5, 0.5), Mat3.scaling(1 / w, 1 / h)),
  );
}

/**
 * `mat3 mvp` + `vec4 params` — 16 floats, shared by all three generator
 * shaders (they differ in their VERTEX layout, not their uniform block).
 *
 * Exported for `uniformPackerSize.test.ts`, which compares every packer against
 * the struct its shader declares: a packer one vec4 short makes the bind group
 * invalid and the layer simply vanishes, which is how Spotlight once shipped.
 */
export function packGenerator(mvp: Mat3, kind: number, focal: number, cell: readonly [number, number]): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4);
  const o = packMat3(mvp, out, 0);
  out[o + 0] = kind;
  out[o + 1] = focal;
  out[o + 2] = cell[0]!;
  out[o + 3] = cell[1]!;
  return out;
}

/**
 * Draw one generator layer's instances and return the renderable that
 * composites the result.
 *
 * Null when there is nothing to draw AND nothing to composite — which is not
 * the same as an empty generator: a zero-instance frame still returns a
 * renderable over an empty (cleared) target, so the layer keeps its place in
 * the stack, its mattes still resolve against it, and a layer matted BY it goes
 * correctly transparent instead of silently keeping the previous frame.
 */
export function renderGeneratorField(
  ctx: RenderPassContext,
  r: Renderable,
  register: (key: string, texture: TextureHandle) => void,
): Renderable | null {
  const gen = r.generator;
  if (!gen) return null;

  const cmds = new CommandBuffer();
  const instances = instanceBuffer(ctx, r);
  if (instances) {
    const mvp = mvpFor(ctx.viewport, fieldToWorld(r));
    const sampler = ctx.services.resources.sampler('linear-clamp', {
      min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp',
    });
    /*
      READY, not merely resolved.

      A provider answers an unknown key with a 1×1 transparent placeholder
      rather than null — that is what keeps an undecoded photo from flashing a
      white box. Taking it at face value here drew the sprite shader against a
      transparent texel, so a field whose atlas had not decoded (or whose plugin
      shipped no such file) came out COMPLETELY INVISIBLE, which is the failure
      the untextured fallback below exists to avoid. `ready` is the provider's
      own answer to "are these the real pixels", so it is the test.
    */
    const resolved = gen.textureKey ? ctx.services.textures.get(gen.textureKey) : null;
    const texture = resolved?.ready ? resolved : null;
    const kind = gen.primitive === 'point' ? GEN_KIND_POINT
      : gen.primitive === 'quad' ? GEN_KIND_QUAD
        : GEN_KIND_SPRITE;
    // The focal length that drives the in-field perspective divide, resolved
    // by the snapshot adapter: the comp camera's when the layer is 3D, zero
    // (orthographic) otherwise — so a 2D generator treats instance z as depth
    // it does not project rather than silently inventing a lens.
    const focal = gen.perspective ?? 0;
    const uniforms = packGenerator(mvp, kind, focal, gen.cellSize);
    const blend = gen.blend === 'add' ? 'add' : 'normal';

    /*
      Two independent choices, and conflating them is a bug that draws.

      The MATERIAL's shader comes from the primitive; its VERTEX LAYOUT comes
      from the buffer's stride. A plugin may send stride 11 with any primitive,
      and a sprite whose texture has not loaded falls back to points — in both
      cases the shader changes and the stride does not. Reading a stride-44
      buffer through a stride-36 layout does not fail: it walks the wrong bytes
      and every particle lands somewhere plausible and wrong.
    */
    const wide = gen.stride === 11;
    const mesh = gen.primitive === 'mesh' ? meshBuffers(ctx, r) : null;
    // The mesh material DECLARES a texture binding, and a pipeline with a
    // declared binding and nothing bound is invalid — so a mesh draws only when
    // something can fill it. White is the identity for the shader's multiply.
    const meshTexture = texture ?? ctx.services.textures.get('texture:white');
    if (gen.primitive === 'mesh') {
      if (mesh && meshTexture) {
        cmds.add({
          batchKey: `gen-mesh|${r.id}`,
          material: wide ? GENERATOR_MESH_WIDE_MATERIAL : GENERATOR_MESH_MATERIAL,
          blend,
          uniforms,
          texture: meshTexture.texture,
          sampler,
          vertexBuffer: mesh.vertex,
          indexBuffer: mesh.index,
          indexCount: mesh.count,
          indexFormat: mesh.format,
          instanceBuffer: instances,
          instanceCount: gen.count,
        });
      }
    } else if (gen.primitive === 'sprite' && texture && wide) {
      cmds.add({
        batchKey: `gen-sprite|${r.id}`,
        material: GENERATOR_SPRITE_MATERIAL,
        blend,
        uniforms,
        texture: texture.texture,
        sampler,
        instanceBuffer: instances,
        instanceCount: gen.count,
      });
    } else {
      // Points and quads — and a sprite whose texture has not loaded yet, which
      // draws as untextured points rather than as nothing. A particle system
      // that appears grey for one frame while its image decodes is a far better
      // failure than one that appears empty and looks broken.
      cmds.add({
        batchKey: `gen-point|${r.id}`,
        material: wide ? GENERATOR_POINT_WIDE_MATERIAL : GENERATOR_POINT_MATERIAL,
        blend,
        uniforms: gen.primitive === 'sprite' ? packGenerator(mvp, GEN_KIND_POINT, focal, gen.cellSize) : uniforms,
        instanceBuffer: instances,
        instanceCount: gen.count,
      });
    }
  }

  const target = ctx.target(GENERATOR_TARGET);
  if (!target) return null;
  const enc = beginViewportPass(ctx, 'generator-field', writeAttachment(ctx, GENERATOR_TARGET, Color.transparent()));
  if (cmds.length > 0) ctx.services.quad.execute(enc, cmds);
  enc.end();

  const texture = ctx.services.backend.renderTargetTexture(target);
  if (!texture || !r.textureKey) return null;
  register(r.textureKey, texture);

  /*
    The handoff, identical in shape to the precomp one: a screen-space textured
    quad over the visible rect, with the generator field stripped off so nothing
    downstream tries to draw it twice.
  */
  const { generator: _generator, ...rest } = r;
  return {
    ...rest,
    kind: 'image',
    modelMatrix: modelFromRect(ctx.viewport.visibleWorldRect),
    bounds: ctx.viewport.visibleWorldRect,
    uvRect: targetSampleUv(ctx),
    color: Color.white(),
  };
}
