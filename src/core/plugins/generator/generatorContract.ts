/**
 * What a `generator` layer kind produces, and what the host will accept.
 *
 * A generator is the third answer to "how does this layer get on screen", after
 * `proxy` (the plugin maintains native child layers) and `shader` (the plugin's
 * own fragment kernel fills the layer). It is the answer for output that is
 * neither a subtree nor a full-frame kernel: ten thousand particles, a logo
 * dissolving into points, a spring rig's trail. The plugin runs real JavaScript
 * once per frame and hands back a packed buffer; the host draws it instanced.
 *
 * ── The buffer is the contract, deliberately ─────────────────────────────────
 *
 * `generate` returns ONE `Float32Array` of instances rather than an array of
 * objects. Not an optimisation detail — it is the difference between a feature
 * that works at 50 000 particles and one that does not:
 *
 *   · 50 000 objects is 50 000 allocations per frame on the plugin side and a
 *     structured clone of 50 000 objects across the worker boundary. A single
 *     typed array is one allocation and a TRANSFER — the buffer is moved, not
 *     copied, so a 2 MB instance set costs the same as an empty one.
 *   · The packed layout IS the GPU vertex layout. Nothing repacks it between
 *     the plugin and `writeBuffer`, so the cost of a frame is the plugin's own
 *     simulation and nothing else.
 *
 * The price is that the layout is fixed and must be documented exactly, which
 * is what the constants below are for. A plugin that writes the fields in the
 * wrong order gets a wrong picture rather than an error, so the field order is
 * stated once here and repeated in `docs/PLUGINS.md` and in the WGSL/GLSL the
 * renderer generates — three copies of one list, and the test suite pins them
 * together.
 *
 * ── Everything here is validated, nothing here is trusted ────────────────────
 *
 * A generate result arrives from a worker running third-party code. It may
 * claim a count its buffer cannot back, a mesh whose indices point past its
 * vertices, or a hundred million instances. `validateGeneratorFrame` is the one
 * door it comes through, and it refuses with a message naming the plugin's own
 * mistake — the alternative is a driver reading past the end of a buffer, which
 * reports as the whole application dying with no attribution at all.
 */

/**
 * Floats per instance, without texture coordinates:
 *
 *   0 `x`        layer-space X, px, origin at the layer box CENTRE
 *   1 `y`        layer-space Y, px, +Y down (comp convention)
 *   2 `z`        layer-space Z, px — depth for 3D placement and parallax
 *   3 `size`     diameter in layer px (the instance quad's side)
 *   4 `rotation` RADIANS, about the instance centre
 *   5 `r`        0..1, STRAIGHT alpha (the shader premultiplies)
 *   6 `g`
 *   7 `b`
 *   8 `a`        0..1 opacity of this instance
 *
 * Radians rather than degrees, which is the one place this API disagrees with
 * the authored-property vocabulary elsewhere in the editor. An authored angle is
 * a number a human types into a field and reads back, and degrees is what they
 * mean; this is a number a simulation computes and a shader consumes, and every
 * trigonometric function on both sides speaks radians. Converting twice per
 * instance per frame to honour a UI convention no user ever sees would be
 * 100 000 multiplications a frame spent on nothing.
 */
export const GEN_STRIDE = 9;

/**
 * Floats per instance WITH texture coordinates (`stride: 11`):
 *
 *   9  `u`   left edge of this instance's cell in the texture, 0..1
 *   10 `v`   top edge of the cell
 *
 * The cell SIZE is declared once per frame (`cellSize`), not per instance:
 * every sprite in an atlas run is the same size, and spending two floats per
 * instance to repeat it would cost 400 KB a frame at 50 000 sprites to say one
 * thing 50 000 times.
 */
export const GEN_STRIDE_UV = 11;

/** The strides a plugin may declare. */
export const GEN_STRIDES: readonly number[] = [GEN_STRIDE, GEN_STRIDE_UV];

/**
 * Hard ceiling on instances in one frame.
 *
 * Four times the 50 000 the renderer is tuned for, and it exists to bound the
 * DAMAGE rather than to express a performance opinion: a plugin with an
 * arithmetic error asks for two billion instances, and the honest failure is a
 * named refusal rather than an allocation that takes the tab down. A plugin
 * that genuinely needs more has hit the point where the simulation belongs in a
 * compute kernel, not in a per-frame JS callback.
 */
export const MAX_GENERATOR_INSTANCES = 200_000;

/** Floats per mesh vertex: position xyz + uv. */
export const GEN_MESH_VERTEX_STRIDE = 5;

/** Caps on a generator's instanced MESH — see `MAX_GENERATOR_INSTANCES`. */
export const MAX_GENERATOR_MESH_VERTICES = 65_536;
export const MAX_GENERATOR_MESH_INDICES = 196_608;

/** How an instance set is drawn. */
export type GeneratorPrimitive = 'point' | 'sprite' | 'quad' | 'mesh';

export const GENERATOR_PRIMITIVES: readonly GeneratorPrimitive[] = ['point', 'sprite', 'quad', 'mesh'];

/**
 * Everything the host tells a generator about the frame it is asking for.
 *
 * `layerTime` and `compTime` are both here and both needed: a layer with a time
 * stretch, a time remap or a Speed % ramp runs on its own clock, and a
 * simulation that integrated comp time would drift out of step with the layer
 * the user is looking at. `frame` is the INTEGER frame of the composition and is
 * what the checkpoint machinery keys on — a simulation is stepped in whole
 * frames or it is not reproducible.
 */
export interface GeneratorFrameRequest {
  /** Seconds on the LAYER's clock (retime, stretch and in-point applied). */
  layerTime: number;
  /** Seconds on the composition's clock. */
  compTime: number;
  /** Integer composition frame. The unit the simulation is stepped in. */
  frame: number;
  fps: number;
  compSize: { width: number; height: number };
  /** The layer box, in comp px. Instance positions are relative to its centre. */
  layerSize: { width: number; height: number };
  /**
   * The kind's declared properties, sampled at `layerTime` — the same
   * vocabulary an effect's params use (`number`, `color`, `boolean`, `enum`,
   * `point`, `angle`, `string`, `asset`).
   */
  params: Record<string, unknown>;
  /**
   * The layer's seed. Stable for the life of the layer and saved with the
   * document, so "the same frame gives the same instances" survives a reload.
   */
  seed: number;
  /**
   * The state this generator returned for the PREVIOUS frame, or undefined at
   * the start of a run. A stateless generator ignores it and never returns one;
   * see `generatorState.ts` for what the host does with it.
   */
  state?: unknown;
}

/** A generator's mesh, when `primitive` is `'mesh'`. */
export interface GeneratorMesh {
  /** `GEN_MESH_VERTEX_STRIDE` floats per vertex: x, y, z, u, v. */
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
}

/** What `generate` returns, as the plugin wrote it (before validation). */
export interface GeneratorFrameResult {
  instances: Float32Array;
  count: number;
  primitive: GeneratorPrimitive;
  /** 9 (default) or 11 — see `GEN_STRIDE_UV`. */
  stride?: number;
  mesh?: GeneratorMesh;
  /**
   * A file inside the plugin's own package, drawn on every instance.
   *
   * A package-relative path rather than a project asset id, for the same reason
   * a layer-kind `asset` property cannot carry a default: an asset id means
   * nothing in another user's project, while a file the plugin shipped is the
   * same everywhere.
   */
  textureAssetKey?: string;
  /** Size of one atlas cell in texture UV, default the whole texture. */
  cellSize?: readonly [number, number];
  /** `add` composites the instances additively inside the layer (the classic
   *  glow look); `normal` is the default. The LAYER's own blend mode still
   *  applies to the result, exactly as it does for a particle field. */
  blend?: 'normal' | 'add';
  /**
   * The largest box this generator will ever fill, in layer px around the
   * centre. Optional: the host measures the instances it was given when this is
   * absent. Declaring it is worth doing for a simulation whose particles leave
   * the box — see `generatorBoundsOf`.
   */
  maxBounds?: { x: number; y: number; width: number; height: number };
  /** Carried to the next sequential frame, and checkpointed. */
  state?: unknown;
}

/**
 * A validated frame, which is the only shape anything downstream sees.
 *
 * `stride` and `cellSize` are resolved rather than optional here: a consumer
 * that has to re-derive a default is a consumer that can derive it differently
 * from the validator, and the two disagreeing is a wrong picture with nothing
 * to point at.
 */
export interface GeneratorFrame {
  instances: Float32Array;
  count: number;
  stride: number;
  primitive: GeneratorPrimitive;
  mesh?: GeneratorMesh;
  textureAssetKey?: string;
  /**
   * WHOSE package `textureAssetKey` names.
   *
   * Stamped by the scheduler, which is the only thing that knows: the validator
   * is handed a RESULT, not the layer that asked for it, and a package-relative
   * path with no owner cannot be resolved to a file. Present only alongside
   * `textureAssetKey`, so a generator drawing plain points carries neither.
   */
  pluginId?: string;
  cellSize: readonly [number, number];
  blend: 'normal' | 'add';
  /** Layer-space box the instances occupy, centred on the layer's origin. */
  bounds: { x: number; y: number; width: number; height: number };
  /**
   * Cheap identity of the instance DATA, so the renderer can skip re-uploading
   * a buffer that did not change. Bumped by the scheduler per accepted frame
   * rather than hashed — hashing 2 MB per frame to avoid a 2 MB upload is not a
   * saving, and a monotonic counter is exactly as good at answering "is this
   * the same array I uploaded last time".
   */
  revision: number;
}

/**
 * A generator frame with nothing in it, filling the layer box.
 *
 * What a generator layer carries before its plugin has answered — and, for a
 * plugin that is stopped or uninstalled, forever. It exists so that "no
 * geometry yet" is a frame with `count: 0` rather than an absent field, which
 * matters at exactly one place and matters a lot there: the snapshot adapter
 * decides how to draw a layer from what it carries, and a generator layer
 * WITHOUT this would fall through to the ordinary shape path and paint its
 * carrier rectangle — a comp-sized opaque black hole over the frame, which is
 * precisely the bug the particle path's own comment records.
 *
 * `revision: 0` is never produced by the scheduler (it counts from 1), so the
 * renderer's "did the instance data change" test treats it as its own thing
 * rather than colliding with a real frame.
 */
export function emptyGeneratorFrame(layerSize: { width: number; height: number }): GeneratorFrame {
  return {
    instances: EMPTY_INSTANCES,
    count: 0,
    stride: GEN_STRIDE,
    primitive: 'point',
    cellSize: [1, 1],
    blend: 'normal',
    bounds: {
      x: -layerSize.width / 2,
      y: -layerSize.height / 2,
      width: layerSize.width,
      height: layerSize.height,
    },
    revision: 0,
  };
}

/** Shared, because every empty frame's buffer is the same zero bytes. */
const EMPTY_INSTANCES = new Float32Array(0);

const isFloat32 = (v: unknown): v is Float32Array =>
  typeof Float32Array !== 'undefined' && v instanceof Float32Array;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate one generate result and resolve its defaults.
 *
 * Returns the frame, or a message. Never throws: the caller is a scheduler
 * serving a viewport, and a rejection has to become a plugin error the user can
 * read rather than an exception that takes the render loop with it.
 *
 * The per-instance floats are deliberately NOT scanned for NaN. A degenerate
 * instance draws nothing — the quad collapses — so the cost of a bad number is
 * a missing particle, while the cost of scanning is 450 000 reads a frame at
 * 50 000 instances, every frame, on the main thread, to catch something that
 * cannot hurt anything. The numbers that CAN hurt something (count, stride,
 * bounds, mesh indices) are all checked, and all of them are O(1) or small.
 */
export function validateGeneratorFrame(
  raw: unknown,
  revision: number,
  layerSize: { width: number; height: number },
): { frame: GeneratorFrame } | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'generate() must return an object like { instances, count, primitive }.' };
  }
  const r = raw as Partial<GeneratorFrameResult>;

  if (!isFloat32(r.instances)) {
    return { error: 'generate() must return "instances" as a Float32Array.' };
  }

  const primitive = r.primitive;
  if (typeof primitive !== 'string' || !GENERATOR_PRIMITIVES.includes(primitive as GeneratorPrimitive)) {
    return { error: `generate() returned primitive "${String(r.primitive)}"; it must be one of: ${GENERATOR_PRIMITIVES.join(', ')}.` };
  }

  const stride = r.stride ?? GEN_STRIDE;
  if (!GEN_STRIDES.includes(stride)) {
    return { error: `generate() returned stride ${String(r.stride)}; it must be ${GEN_STRIDE} (x,y,z,size,rotation,r,g,b,a) or ${GEN_STRIDE_UV} (…,u,v).` };
  }
  if (r.textureAssetKey !== undefined && stride !== GEN_STRIDE_UV) {
    // Caught here rather than in the shader, where it presents as every sprite
    // sampling the same texel — a single flat colour, which reads as the
    // texture having failed to load.
    return { error: `generate() set textureAssetKey but stride ${stride}; a textured instance needs stride ${GEN_STRIDE_UV} to carry its u,v.` };
  }

  const count = r.count;
  if (!finite(count) || !Number.isInteger(count) || count < 0) {
    return { error: `generate() returned count ${String(r.count)}; it must be a whole number of 0 or more.` };
  }
  if (count > MAX_GENERATOR_INSTANCES) {
    return { error: `generate() returned ${count} instances; this host draws at most ${MAX_GENERATOR_INSTANCES} per layer per frame.` };
  }
  if (count * stride > r.instances.length) {
    // The check that stops a driver reading past the end of a buffer.
    return { error: `generate() reported ${count} instances at stride ${stride} (${count * stride} floats) but its buffer holds ${r.instances.length}.` };
  }

  let mesh: GeneratorMesh | undefined;
  if (primitive === 'mesh') {
    const m = r.mesh;
    if (!m || !isFloat32(m.vertices)) {
      return { error: 'generate() returned primitive "mesh" without a mesh { vertices, indices }.' };
    }
    const idx = m.indices;
    const isIdx = (typeof Uint16Array !== 'undefined' && idx instanceof Uint16Array)
      || (typeof Uint32Array !== 'undefined' && idx instanceof Uint32Array);
    if (!isIdx) {
      return { error: 'generate() returned a mesh whose "indices" is not a Uint16Array or Uint32Array.' };
    }
    if (m.vertices.length % GEN_MESH_VERTEX_STRIDE !== 0) {
      return { error: `A generator mesh's vertices are ${GEN_MESH_VERTEX_STRIDE} floats each (x,y,z,u,v); ${m.vertices.length} is not a whole number of vertices.` };
    }
    const vertexCount = m.vertices.length / GEN_MESH_VERTEX_STRIDE;
    if (vertexCount === 0 || vertexCount > MAX_GENERATOR_MESH_VERTICES) {
      return { error: `A generator mesh has ${vertexCount} vertices; the range is 1…${MAX_GENERATOR_MESH_VERTICES}.` };
    }
    if (idx.length === 0 || idx.length % 3 !== 0 || idx.length > MAX_GENERATOR_MESH_INDICES) {
      return { error: `A generator mesh has ${idx.length} indices; it must be a non-zero multiple of 3, at most ${MAX_GENERATOR_MESH_INDICES}.` };
    }
    // Scanned in full, unlike the instances: an out-of-range index is a read
    // past the end of the vertex buffer, and a mesh is small enough that the
    // scan is a rounding error next to the instance draw it feeds.
    for (let i = 0; i < idx.length; i++) {
      if (idx[i]! >= vertexCount) {
        return { error: `A generator mesh's index ${i} is ${idx[i]}, past its ${vertexCount} vertices.` };
      }
    }
    mesh = { vertices: m.vertices, indices: idx };
  }

  if (r.textureAssetKey !== undefined) {
    const key = r.textureAssetKey;
    if (typeof key !== 'string' || !key || key.length > 256) {
      return { error: 'generate() returned a textureAssetKey that is not a package-relative file path.' };
    }
    if (key.includes('..') || key.startsWith('/') || key.startsWith('\\') || /^[a-zA-Z]+:/.test(key)) {
      // A path a plugin can point outside its own package is a file-read
      // primitive wearing a texture's clothes.
      return { error: `generate() returned textureAssetKey "${key}"; it must name a file inside the plugin package.` };
    }
  }

  let cellSize: readonly [number, number] = [1, 1];
  if (r.cellSize !== undefined) {
    const c = r.cellSize;
    if (!Array.isArray(c) || c.length !== 2 || !finite(c[0]) || !finite(c[1]) || c[0]! <= 0 || c[1]! <= 0) {
      return { error: 'generate() returned a cellSize that is not [width, height] in texture UV (both greater than 0).' };
    }
    cellSize = [c[0]!, c[1]!];
  }

  const blend = r.blend ?? 'normal';
  if (blend !== 'normal' && blend !== 'add') {
    return { error: `generate() returned blend "${String(r.blend)}"; it must be "normal" or "add".` };
  }

  let bounds: { x: number; y: number; width: number; height: number };
  if (r.maxBounds !== undefined) {
    const b = r.maxBounds;
    if (!b || typeof b !== 'object'
      || !finite(b.x) || !finite(b.y) || !finite(b.width) || !finite(b.height)
      || b.width < 0 || b.height < 0) {
      return { error: 'generate() returned maxBounds that is not { x, y, width, height } with finite, non-negative size.' };
    }
    bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  } else {
    bounds = measureInstanceBounds(r.instances, count, stride, layerSize);
  }

  return {
    frame: {
      instances: r.instances,
      count,
      stride,
      primitive,
      ...(mesh ? { mesh } : {}),
      ...(r.textureAssetKey !== undefined ? { textureAssetKey: r.textureAssetKey } : {}),
      cellSize,
      blend,
      bounds,
      revision,
    },
  };
}

/**
 * The box the instances actually occupy, in layer space around the centre.
 *
 * Each instance contributes its own `size` as a half-extent on both axes, so a
 * large sprite at the edge of the field is inside the box rather than clipped by
 * it — which is what the box is FOR: raster padding, culling and click
 * selection all ask "could this layer have painted here", and the answer has to
 * include the sprite's own footprint.
 *
 * Falls back to the layer box when there are no instances, so an empty frame
 * still selects and still reports a sane rectangle rather than a degenerate
 * point at the origin.
 *
 * Non-finite positions are skipped rather than propagated: one NaN would
 * otherwise poison the whole box, and a poisoned box disables culling for the
 * entire composition.
 */
export function measureInstanceBounds(
  instances: Float32Array,
  count: number,
  stride: number,
  layerSize: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0, o = 0; i < count; i++, o += stride) {
    const x = instances[o]!;
    const y = instances[o + 1]!;
    const size = instances[o + 3]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const half = Number.isFinite(size) ? Math.abs(size) / 2 : 0;
    if (x - half < minX) minX = x - half;
    if (y - half < minY) minY = y - half;
    if (x + half > maxX) maxX = x + half;
    if (y + half > maxY) maxY = y + half;
  }
  if (!Number.isFinite(minX)) {
    return {
      x: -layerSize.width / 2,
      y: -layerSize.height / 2,
      width: layerSize.width,
      height: layerSize.height,
    };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The generator's bounds in COMP px for a layer placed at (cx, cy).
 *
 * The one conversion between the two spaces, exported so hit-testing, raster
 * padding and culling cannot each write their own version of `+ centre` and
 * disagree about whether the box was already centred.
 */
export function generatorBoundsOf(
  frame: Pick<GeneratorFrame, 'bounds'>,
  centre: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: centre.x + frame.bounds.x,
    y: centre.y + frame.bounds.y,
    width: frame.bounds.width,
    height: frame.bounds.height,
  };
}
