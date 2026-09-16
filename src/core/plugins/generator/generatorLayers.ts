/**
 * The seam between a scene node and a generator's instance buffer.
 *
 * `buildSnapshot` calls exactly one function from here, once per generator
 * layer, and nothing at all for a document that has none — which is the whole
 * cost requirement. Everything the call needs to do (recognise the kind, sample
 * the declared properties at this frame, derive the seed, state the demand, take
 * whatever the scheduler has) lives here rather than inline, because
 * `buildSnapshot` is already six thousand lines and the part of this that is
 * genuinely about generators is the part below.
 */

import { parseCssColor } from '@core/text/cssColor';
import { readCustomLayer } from '../customLayers';
import { findKindFor } from '../layerKindRegistry';
import type { LayerKindContribution } from '../layerKindSchema';
import type { SceneNode } from '../../types';
import { emptyGeneratorFrame, requestGeneratorFrame, type GeneratorFrame } from './index';

/**
 * Frames requested past the playhead during playback.
 *
 * Eight at 60 fps is about 130 ms of runway, which is what turns a simulation
 * that costs 5 ms a frame from "always one frame behind" into "always exactly
 * on time". More would be wasted the moment the user stops or scrubs, and every
 * prefetched frame is an instance buffer held in memory.
 */
export const GENERATOR_LOOK_AHEAD = 8;

/**
 * The kind registered for this namespaced kind string, when it is a generator.
 *
 * Returns null for every native layer, and does so on the FIRST character in
 * the common case: a native kind (`shape`, `text`, `video`…) has no dot in it,
 * and a namespaced plugin kind always does. That test is the reason a project
 * with no plugins pays nothing for this feature.
 */
export function generatorKindOf(kind: string): LayerKindContribution | null {
  if (kind.indexOf('.') < 0) return null;
  const at = kind.lastIndexOf('.');
  const found = findKindFor(kind.slice(0, at), kind.slice(at + 1));
  return found && found.render === 'generator' ? found : null;
}

/**
 * The kind registered for this namespaced kind string, when it is a `shader`
 * kind that NAMES its shader — GAP 2 of the depth-plugin rebuild.
 *
 * A `shader` kind without a `shader` field is still accepted by the manifest
 * (it was legal for two API versions before the field existed) and still draws
 * nothing, which is what it always did. What this returns is the subset that
 * can now be drawn.
 */
export function shaderKindOf(kind: string): LayerKindContribution | null {
  if (kind.indexOf('.') < 0) return null;
  const at = kind.lastIndexOf('.');
  const found = findKindFor(kind.slice(0, at), kind.slice(at + 1));
  return found && found.render === 'shader' && found.shader ? found : null;
}

/**
 * The effect entry that DRAWS a `shader` layer kind.
 *
 * ── How a layer kind ends up drawn by an effect ──────────────────────────────
 *
 * It does not get a render path of its own. The layer is emitted as a
 * transparent surface of its own size carrying exactly one effect — the
 * plugin's, named by the kind's `shader` field — so the pixels come out of the
 * machinery that already compiles, binds and draws a plugin effect on both
 * backends, with the host's time / comp-size / frame inputs filled in for it.
 *
 * That is the whole of the wiring, and it is deliberately the whole of it. The
 * alternative — a second render path that runs a kind's kernel directly —
 * would be a second place for plugin WGSL to be validated, compiled, budgeted
 * and attributed, and the interesting half of an effect (its parameter block,
 * its multi-pass chain, its GLSL twin) would have to be reimplemented there to
 * reach parity with the path beside it.
 *
 * The effect's PARAMS come from the kind's own declared properties, by name.
 * An author who declares `focal` on the kind and `focal` on the effect gets one
 * control in the inspector driving the shader; one that does not match is
 * simply a parameter at its own default, which is what a parameter nobody set
 * should be.
 */
export function shaderLayerEffect(
  node: SceneNode,
  kind: LayerKindContribution,
  sampled: ReadonlyMap<string, number> | undefined,
): { id: string; type: string; enabled: true; params: Record<string, unknown> } | null {
  const record = readCustomLayer(node);
  if (!record || !kind.shader) return null;
  const params = resolveGeneratorParams(kind, record.props, sampled);
  return {
    // Stable per layer, so an effect-level cache (raster keys, compiled
    // pipelines, bake results) sees one effect over the layer's life rather
    // than a new one every frame.
    id: `kindshader-${node.id}`,
    type: `${record.pluginId}.${kind.shader}`,
    enabled: true,
    params,
  };
}

/**
 * A layer's seed, derived from its id.
 *
 * Not a stored property, and not `Math.random()` at creation. The id is already
 * in the document, already unique, and already stable across save/reload — so
 * deriving from it gives every guarantee a stored seed would, with no schema
 * version to migrate and nothing for a plugin to accidentally overwrite.
 *
 * FNV-1a, because the ids are short strings and it is four lines. The quality
 * that matters is that two adjacent layers (`n1`, `n2`) get unrelated seeds, so
 * duplicating a particle layer gives a different system rather than the same one
 * twice — which a plain character sum would not.
 */
export function generatorSeed(nodeId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The declared properties, at this frame, in the shape the plugin receives.
 *
 * Two normalisations, both so a plugin never has to branch on how a value
 * happened to arrive:
 *
 *   · An ANIMATED property comes from the sampled map (keyed `plugin.<name>`,
 *     the same path the timeline and graph editor use); an un-animated one comes
 *     from the stored props. Same key, same type, either way.
 *   · A COLOUR is always `{ r, g, b, a }` in 0..1 — never the `#rrggbb` string
 *     the schema's default is written as, and never the `_r`/`_g`/`_b`/`_a`
 *     channel tracks an animated one is stored under. A generator packs colours
 *     into a float buffer; handing it a string to parse fifty thousand times a
 *     frame would be handing it the host's job.
 */
export function resolveGeneratorParams(
  kind: LayerKindContribution,
  stored: Record<string, unknown>,
  sampled: ReadonlyMap<string, number> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(kind.props)) {
    const path = `plugin.${name}`;
    switch (schema.type) {
      case 'number':
      case 'angle': {
        const animated = sampled?.get(path);
        out[name] = animated ?? stored[name] ?? schema.default;
        break;
      }
      case 'boolean': {
        const animated = sampled?.get(path);
        out[name] = animated !== undefined ? animated !== 0 : (stored[name] ?? schema.default);
        break;
      }
      case 'point': {
        const x = sampled?.get(`${path}X`);
        const y = sampled?.get(`${path}Y`);
        const base = (stored[name] ?? schema.default) as { x?: number; y?: number } | undefined;
        out[name] = { x: x ?? base?.x ?? 0, y: y ?? base?.y ?? 0 };
        break;
      }
      case 'color': {
        const r = sampled?.get(`${path}_r`);
        if (r !== undefined) {
          out[name] = {
            r,
            g: sampled?.get(`${path}_g`) ?? 0,
            b: sampled?.get(`${path}_b`) ?? 0,
            a: sampled?.get(`${path}_a`) ?? 1,
          };
          break;
        }
        const parsed = parseCssColor(String(stored[name] ?? schema.default ?? '#ffffff'));
        out[name] = parsed
          ? { r: parsed[0] / 255, g: parsed[1] / 255, b: parsed[2] / 255, a: parsed[3] }
          : { r: 1, g: 1, b: 1, a: 1 };
        break;
      }
      default:
        // `string`, `enum`, `asset` — none of them animate, so the stored value
        // is the value. `layer` cannot appear: `parseLayerKinds` refuses it.
        out[name] = stored[name] ?? schema.default;
        break;
    }
  }
  return out;
}

/** Everything `buildSnapshot` knows that this needs, and nothing it does not. */
export interface GeneratorLayerContext {
  /** Composition time, seconds. */
  compTime: number;
  /** This layer's own clock (retime / stretch / in-point applied). */
  layerTime: number;
  fps: number;
  compSize: { width: number; height: number };
  layerSize: { width: number; height: number };
  /** Sampled animated values for this node, keyed by property path. */
  sampled: ReadonlyMap<string, number> | undefined;
}

/**
 * Ask for this node's geometry and take whatever is ready.
 *
 * Never null once the kind is a generator: an EMPTY frame is the answer while
 * the plugin has not produced one, and for a plugin that is stopped or gone. A
 * generator layer with no geometry is an empty layer, not a missing one — it
 * still selects, still animates and still holds its place in the stack, and the
 * adapter has one shape to reason about rather than two.
 */
export function generatorFrameFor(
  node: SceneNode,
  kindString: string,
  ctx: GeneratorLayerContext,
): GeneratorFrame | null {
  const kind = generatorKindOf(kindString);
  if (!kind) return null;
  const record = readCustomLayer(node);
  // A node whose kind string says generator but which carries no custom-layer
  // component: a hand-edited or half-migrated document. It is still that layer.
  if (!record) return emptyGeneratorFrame(ctx.layerSize);

  return requestGeneratorFrame({
    layerId: node.id,
    pluginId: record.pluginId,
    kindId: record.kindId,
    // Always asked for; the scheduler spends it only when the requests it is
    // receiving look like playback (each frame one past the last). That test is
    // there rather than here because `buildSnapshot` has no idea whether the
    // transport is running — and because it is a better test: a slow manual
    // step through frames benefits from the runway too, and a scrub, which
    // jumps, correctly gets none.
    lookAhead: GENERATOR_LOOK_AHEAD,
    request: {
      layerTime: ctx.layerTime,
      compTime: ctx.compTime,
      // Rounded, because a simulation is stepped in whole frames and the
      // checkpoint machinery keys on the number. A sub-frame time still
      // reaches the plugin through `compTime`/`layerTime` for anything that
      // wants it (a shutter-aware emitter, say).
      frame: Math.round(ctx.compTime * ctx.fps),
      fps: ctx.fps,
      compSize: ctx.compSize,
      layerSize: ctx.layerSize,
      params: resolveGeneratorParams(kind, record.props, ctx.sampled),
      seed: generatorSeed(node.id),
    },
  }) ?? emptyGeneratorFrame(ctx.layerSize);
}
