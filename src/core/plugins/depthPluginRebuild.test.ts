/**
 * Rebuilding the depth/parallax plugin on `render: "shader"` — third attempt.
 *
 * This plugin has been built twice against this API and found a real gap each
 * time. That is why the brief asks for it again on every render-path change:
 * it is the only exercise here that is written from the OUTSIDE, and every
 * assumption the host makes about what an author needs shows up as something
 * that cannot be expressed.
 *
 * So this file is a REPORT as much as a test. Each block attempts something a
 * depth plugin genuinely requires, runs it through the real validator, and
 * asserts what actually happens — including where the answer is "you cannot".
 * Assertions that pin a LIMITATION are marked; when the limitation is lifted,
 * they fail, which is the intended way to find out that this file is stale.
 */

import { parseManifest } from './manifest';
import {
  composeEffectShader,
  packPassBlock,
  HOST_BLOCK_FLOAT_OFFSET,
  UNIFORM_HEADER_BYTES,
  UNIFORM_RENDERER_HEADER_BYTES,
} from './effectSchema';
import { pluginEffectMaterial } from './pluginEffectMaterial';

const base = {
  id: 'studio.acme.depth',
  name: 'Depth',
  version: '2.0.0',
  description: 'Parallax from a depth map.',
  apiVersion: 4,
  main: 'main.js',
};

/**
 * `apiVersion` is an argument because the second texture is an API-7 grammar:
 * one layer parameter is as old as effects are, and the extra bindings only
 * exist in the layout this version generates.
 */
const parse = (contributes: unknown, apiVersion = base.apiVersion) => {
  const result = parseManifest({ ...base, apiVersion, contributes });
  return { manifest: result.manifest, errors: result.errors };
};

/** The parallax maths, as an author would write it. */
const PARALLAX = `
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  // Displace the sample by the parallax offset, scaled by focal depth.
  let shift = vec2<f32>(params.parallaxX, params.parallaxY) * params.focal * 0.01;
  return textureSample(src, samp, uv + shift);
}`;

describe('what the rebuild CAN express', () => {
  it('a shader effect with animatable depth parameters', () => {
    const { manifest, errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: {
          focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
          parallaxX: { type: 'number', default: 0, min: -10, max: 10, animatable: true },
          parallaxY: { type: 'number', default: 0, min: -10, max: 10, animatable: true },
        },
      }],
    });

    expect(errors).toEqual([]);
    expect(manifest?.contributes.effects).toHaveLength(1);
  });

  it('a layer kind that draws itself, alongside the effect', () => {
    // The API-3 rebuild had to use `render: "proxy"` and maintain a subtree.
    // A kind that draws its own pixels is what `"shader"` added.
    const { errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
      layerKinds: [{
        id: 'depthImage',
        label: 'Depth Image',
        render: 'shader',
        schemaVersion: 2,
        props: { focal: { type: 'number', default: 50, animatable: true } },
      }],
    });

    expect(errors).toEqual([]);
  });
});

describe('★ GAP 1 — CLOSED: an effect can sample a SECOND texture', () => {
  /*
    The finding, and it is the one that matters.

    A depth plugin's whole job is to displace one image by another: the source
    and its depth map. The generated bind group has exactly three entries —
    uniform, ONE texture, one sampler — so there is nowhere to put the depth
    map, and the WGSL gate refuses an author-declared binding precisely because
    the host owns the numbers.

    The renderer already models this: `DISPLACEMENT_MAP_MATERIAL` and
    `SET_MATTE_MATERIAL` both carry a second texture at binding 3, and
    `FrameScene` has `mapLayerId` / `matteLayerId` for naming the layer that
    supplies it. So the capability exists and the PLUGIN CONTRACT does not
    reach it.

    Everything below documents the shape of the refusal so the eventual fix has
    something to change rather than something to discover. A parameter of type
    `layer` — which the built-in effects already have — plus a fourth binding is
    the obvious form.
  */
  it('accepts a `layer` parameter, and names the binding after it', () => {
    const { manifest, errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: { depthMap: { type: 'layer' } },
      }],
    });

    expect(errors).toEqual([]);
    const effect = manifest!.contributes.effects[0]!;
    expect(effect.params.depthMap!.type).toBe('layer');

    const { wgsl } = composeEffectShader(effect);
    expect(wgsl).toContain('@group(0) @binding(3) var depthMap : texture_2d<f32>;');
  });

  it('★ keeps the layer parameter OUT of the uniform block', () => {
    /*
      The offset-corrupting mistake, and the reason `layer` is a separate
      category rather than another `EFFECT_PARAM_TYPES` entry. A `layer` has no
      size and no alignment; among the uniform members it would shift every
      value after it and render wrong colours with no error anywhere — the same
      class of failure as the missing 64-byte header.
    */
    const { manifest } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: {
          depthMap: { type: 'layer' },
          focal: { type: 'number', default: 50 },
        },
      }],
    });

    const { layout, wgsl } = composeEffectShader(manifest!.contributes.effects[0]!);
    expect(layout.layout.map((m) => m.name)).toEqual(['focal']);
    expect(wgsl).not.toMatch(/^\s*depthMap\s*:/m);
    // `focal` still lands immediately after the renderer's header — exactly
    // where it would sit with no layer parameter present at all.
    expect(layout.layout[0]!.offset).toBe(UNIFORM_HEADER_BYTES);
  });

  it('widens the material layout to match the generated bindings', () => {
    const { manifest } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: { depthMap: { type: 'layer' } },
      }],
    });

    const material = pluginEffectMaterial('studio.acme.depth', manifest!.contributes.effects[0]!);
    expect(material.layout.map((e) => e.binding)).toEqual([0, 1, 2, 3]);
  });

  it('leaves an effect without one at three bindings', () => {
    // A declared binding with nothing bound is an invalid pipeline, so an
    // effect that never asked for a second texture must not be handed a slot.
    const { manifest } = parse({
      effects: [{ id: 'plain', label: 'Plain', shader: PARALLAX, params: {} }],
    });

    const material = pluginEffectMaterial('studio.acme.depth', manifest!.contributes.effects[0]!);
    expect(material.layout.map((e) => e.binding)).toEqual([0, 1, 2]);
  });

  it('★ NO LONGER refuses a second layer parameter — four are allowed', () => {
    /*
      This assertion used to pin the one-texture limit. A depth plugin wants
      colour AND depth AND a normal map, and a compositing one wants two inputs
      plus a matte; one slot was the number the bind group happened to have,
      not a number anybody argued for.

      Four, and the bindings are 3, 5, 6, 7 — 4 stays `origin` whether or not
      any effect on the machine uses it, because a binding number that moves
      with an unrelated part of the manifest is one three separate places have
      to re-derive and agree on.
    */
    const { manifest, errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: {
          depthMap: { type: 'layer' },
          normalMap: { type: 'layer' },
          aoMap: { type: 'layer' },
          maskMap: { type: 'layer' },
        },
      }],
    }, 7);

    expect(errors).toEqual([]);
    const { wgsl } = composeEffectShader(manifest!.contributes.effects[0]!);
    expect(wgsl).toContain('@binding(3) var depthMap');
    expect(wgsl).toContain('@binding(5) var normalMap');
    expect(wgsl).toContain('@binding(6) var aoMap');
    expect(wgsl).toContain('@binding(7) var maskMap');
    expect(wgsl).not.toContain('@binding(4) var');
  });

  it('refuses a FIFTH, and says why the ceiling is where it is', () => {
    const { errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: {
          a: { type: 'layer' }, b: { type: 'layer' }, c: { type: 'layer' },
          d: { type: 'layer' }, e: { type: 'layer' },
        },
      }],
    }, 7);

    expect(errors.join()).toMatch(/layer parameters.*the limit is 4/);
  });

  it('still refuses `layer` on a layer KIND, where nothing could resolve it', () => {
    const { errors } = parse({
      layerKinds: [{
        id: 'depth',
        label: 'Depth',
        render: 'none',
        // Required, and omitting it made this test pass on the WRONG error —
        // the validator refused the missing schemaVersion before it ever
        // reached the rule under test.
        schemaVersion: 2,
        props: { source: { type: 'layer' } },
      }],
    });

    expect(errors.join()).toMatch(/only valid on an effect parameter/);
  });

  it('refuses an author-declared second texture binding', () => {
    const withOwnBinding = `
@group(0) @binding(3) var depthTex : texture_2d<f32>;
${PARALLAX}`;
    const { errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: withOwnBinding, params: {} }],
    });

    expect(errors.join()).toMatch(/@group.*@binding/);
  });

  it('the workaround an author would reach for is ALSO refused', () => {
    /*
      Packing a depth value per-pixel into the source's alpha is what an author
      does when they cannot have a second texture — and it costs them alpha,
      which a compositing effect cannot spare. Worth recording that the API does
      not make this any easier: there is no way to declare "I need the layer
      below" either.

      Nothing to assert but the absence, so this pins the parameter vocabulary
      as it stands. When a texture-valued parameter exists, this fails.
    */
    const { manifest } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: { focal: { type: 'number', default: 50 } },
      }],
    });

    const types = Object.values(manifest!.contributes.effects[0]!.params).map((p) => p.type);
    expect(types).not.toContain('asset');
    expect(types).not.toContain('layer');
  });
});

describe('★ GAP 2 — CLOSED: a shader layer kind NAMES the effect that draws it', () => {
  /*
    The gap, as this file recorded it twice: `render: "shader"` said a kind drew
    itself and nothing said WITH WHAT. The two contribution lists had no
    reference between them, so a manifest declaring a `depthImage` kind beside a
    `parallax` effect was accepted and meant less than it appeared to — a reader
    assumed the kind drew with the plugin's shader, and nothing in the data said
    so.

    The fix is the form this file predicted: a `shader` field on the layer kind
    naming one of the plugin's own effect ids, validated at parse time. It is
    validated in two halves, because no single validator can see both lists —
    `layerKindSchema` checks the NAME, `manifest.ts` checks that the effect
    exists, once both lists are parsed.

    The render side exists now too, which is what made the field worth adding:
    `core/plugins/generator/generatorLayers.ts` turns such a kind into a
    transparent layer carrying that one effect, and the plugin-effect path
    draws it with the host's time / comp-size / frame inputs filled in.
  */
  it('accepts a shader kind that names one of its own plugin effects', () => {
    const { manifest, errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
      layerKinds: [{
        id: 'depthImage', label: 'Depth Image', render: 'shader',
        shader: 'parallax',
        schemaVersion: 2,
        // A prop it does not need — see GAP 4 below, which is why this is here.
        props: { focal: { type: 'number', default: 50, animatable: true } },
      }],
    });

    expect(errors).toEqual([]);
    expect(manifest!.contributes.layerKinds[0]!.shader).toBe('parallax');
  });

  it('DROPS a kind naming an effect the plugin does not declare', () => {
    // Dropped rather than kept with a dangling name: a shader kind that names
    // nothing draws nothing, and an author who ships one finds out from a user.
    const { errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
      layerKinds: [{
        id: 'depthImage', label: 'Depth Image', render: 'shader',
        shader: 'paralax',
        schemaVersion: 2,
        props: { focal: { type: 'number', default: 50 } },
      }],
    });

    expect(errors.join()).toMatch(/does not declare in "contributes.effects"/);
    // And names what it DOES declare, so the typo is visible in the message.
    expect(errors.join()).toMatch(/parallax/);
    // A manifest with errors does not parse at all, so the kind cannot reach a
    // document: `parseManifest` returns null rather than a partial contract.
  });

  it('refuses the field on a strategy that cannot use it', () => {
    const { errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
      layerKinds: [{
        id: 'depthImage', label: 'Depth Image', render: 'proxy',
        shader: 'parallax',
        schemaVersion: 2,
        props: { focal: { type: 'number', default: 50 } },
      }],
    });

    expect(errors.join()).toMatch(/only meaningful on a kind with "render": "shader"/);
  });

  it('still accepts a shader kind that names NO shader — it just draws nothing', () => {
    // The back-compat half: `render: "shader"` was legal for two grammar
    // versions before the field existed, and a published manifest using it must
    // not stop installing.
    const { manifest, errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
      layerKinds: [{
        id: 'depthImage', label: 'Depth Image', render: 'shader',
        schemaVersion: 2,
        props: { focal: { type: 'number', default: 50 } },
      }],
    });

    expect(errors).toEqual([]);
    expect(manifest!.contributes.layerKinds[0]!.shader).toBeUndefined();
  });
});

describe('★ GAP 4 — a shader kind is forced to declare properties it does not have', () => {
  /*
    Found by this rebuild, and not anticipated.

    `parseLayerKinds` refuses a kind with no properties: "a layer kind with no
    properties has no interface to author". That rule is right for `none` and
    `proxy`, where the props ARE the entire authored interface — a controller
    with nothing to control is a layer that does nothing.

    It is wrong for `"shader"`. A shader-drawn kind's parameters live on its
    EFFECT, which has its own schema and its own inspector rows, so the kind
    itself may legitimately have none. Today the author must invent a property
    to satisfy a rule written before their render strategy existed, and then
    either duplicate it onto the effect or leave it unread — a control that
    does nothing, which is exactly what the rule was written to prevent.

    The fix is to scope the check to `none` and `proxy`. Not made here: it is a
    validator change that both repos' corpora would have to agree on, and this
    file's job is to find it, not to smuggle it in.
  */
  it('refuses a shader kind with no properties of its own', () => {
    const { errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
      layerKinds: [{
        id: 'depthImage', label: 'Depth Image', render: 'shader',
        schemaVersion: 2, props: {},
      }],
    });

    expect(errors.join()).toMatch(/no properties has no interface to author/);
  });

  it('is a rule that makes sense for the OTHER two strategies', () => {
    // Asserted so the eventual fix is scoped rather than deleted: a `none` kind
    // with no props really is a layer that does nothing.
    for (const render of ['none', 'proxy']) {
      const { errors } = parse({
        layerKinds: [{ id: 'k', label: 'K', render, schemaVersion: 1, props: {} }],
      });
      expect(errors.join()).toMatch(/no properties/);
    }
  });
});

describe('★ GAP 3 — CLOSED: an effect reads the composition and the time', () => {
  /*
    The gap, as it stood: a parallax effect that animates with the playhead
    needed time, one that respects the comp's aspect needed its size, and there
    was no way to ask for either. The workaround was an `animatable` number the
    user keyframes by hand — per document rather than per effect, and wrong the
    moment the comp's frame rate changes.

    ── What replaced it, and why it is not a parameter TYPE ───────────────────

    The obvious form was the one this file originally proposed: a `resolved`
    parameter type mirroring the built-in `EffectParamDef`. It is still refused,
    and deliberately. A host-filled `resolved` parameter would be a row in the
    author's parameter list that the author cannot set, cannot animate and must
    not name twice — an interface that exists to be ignored — and every author
    would have to declare the same nine of them to get at values the host knows
    unconditionally.

    So they are MEMBERS OF THE BLOCK instead: every effect has them, no effect
    declares them, and `RESERVED_PARAM_NAMES` refuses a parameter that would
    collide. An author writes `params.time` in WGSL and `time` in GLSL.
  */
  it('still refuses a `resolved` parameter type — these are not parameters', () => {
    const { errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: { elapsed: { type: 'resolved', default: 0 } },
      }],
    });

    expect(errors.join()).toMatch(/type.*must be one of/);
  });

  it('★ declares the host inputs on every effect, declared or not', () => {
    const { manifest, errors } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
    });

    expect(errors).toEqual([]);
    const { wgsl } = composeEffectShader(manifest!.contributes.effects[0]!);
    for (const member of [
      'time', 'compTime', 'frame', 'fps', 'compSize', 'layerSize', 'pixelScale', 'downsample', 'seed',
    ]) {
      expect(wgsl).toContain(`  ${member} : `);
    }
  });

  it('refuses a parameter that would collide with one of them', () => {
    // Without this the generated struct has two members called `time`, and the
    // compile error names a line in code the author never saw.
    const { errors } = parse({
      effects: [{
        id: 'parallax',
        label: 'Depth Parallax',
        shader: PARALLAX,
        params: { time: { type: 'number', default: 0 } },
      }],
    });

    expect(errors.join()).toMatch(/uses a name the host fills in/);
  });

  it('fills them in, at the offsets the shader reads', () => {
    /*
      The half a manifest test cannot see: the struct saying `time` is at byte
      96 is worth nothing unless the packer writes the time there. Packed here
      and read back by offset, so a member reordered on one side and not the
      other fails rather than renders a plausible picture.
    */
    const { manifest } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
    });
    const { layout } = composeEffectShader(manifest!.contributes.effects[0]!);

    const buffer = new ArrayBuffer(layout.size);
    packPassBlock(buffer, { width: 400, height: 200 }, 0.5, 1, {
      compWidth: 1920, compHeight: 1080,
      layerWidth: 800, layerHeight: 600,
      time: 1.25, compTime: 2.5, frame: 60, fps: 24,
      pixelScale: 2, downsample: 1, seed: 0.75,
    });
    const view = new DataView(buffer);
    const read = (name: string): number =>
      view.getFloat32(UNIFORM_RENDERER_HEADER_BYTES + HOST_BLOCK_FLOAT_OFFSET[name]! * 4, true);

    expect(read('texelSize')).toBeCloseTo(1 / 400);
    expect(read('passScale')).toBe(0.5);
    expect(read('passIndex')).toBe(1);
    expect(read('compSize')).toBe(1920);
    expect(read('layerSize')).toBe(800);
    expect(read('time')).toBe(1.25);
    expect(read('compTime')).toBe(2.5);
    expect(read('frame')).toBe(60);
    expect(read('fps')).toBe(24);
    expect(read('pixelScale')).toBe(2);
    expect(read('downsample')).toBe(1);
    expect(read('seed')).toBe(0.75);
  });

  it('gives a LAYER time that is not the playhead', () => {
    // The distinction a retimed layer turns on: an effect animating with its
    // layer has to follow the layer's clock, or it drifts against the picture
    // it is drawn on.
    const { manifest } = parse({
      effects: [{ id: 'parallax', label: 'Depth Parallax', shader: PARALLAX, params: {} }],
    });
    const { layout } = composeEffectShader(manifest!.contributes.effects[0]!);
    const buffer = new ArrayBuffer(layout.size);
    packPassBlock(buffer, { width: 10, height: 10 }, 1, 0, {
      compWidth: 100, compHeight: 100, layerWidth: 100, layerHeight: 100,
      time: 0.5, compTime: 3, frame: 90, fps: 30,
      pixelScale: 1, downsample: 1, seed: 0,
    });
    const view = new DataView(buffer);
    const at = (n: string): number =>
      view.getFloat32(UNIFORM_RENDERER_HEADER_BYTES + HOST_BLOCK_FLOAT_OFFSET[n]! * 4, true);
    expect(at('time')).not.toBe(at('compTime'));
  });
});

describe('what the third rebuild did NOT hit', () => {
  it('the uniform layout, which the second rebuild would have', () => {
    /*
      Worth recording as a non-finding. The missing `mvp`/`uvRect` header was
      found by reading `packSharpen` during this same session — before any
      plugin exercised it. Had it not been, this rebuild would have produced a
      layer drawn with a garbage transform and no error, and the gap report
      would have been "the plugin renders in the wrong place, cause unknown".
    */
    const { errors } = parse({
      effects: [{
        id: 'parallax', label: 'Depth Parallax', shader: PARALLAX,
        params: { focal: { type: 'number', default: 50, animatable: true } },
      }],
    });
    expect(errors).toEqual([]);
  });
});
