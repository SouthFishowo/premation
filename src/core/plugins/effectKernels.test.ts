/**
 * What an effect may declare after round C2, and what each declaration buys.
 *
 * The through-line: every one of these exists because a real plugin could not
 * be expressed. A GLSL kernel because the WebGL2 tier rendered plugin effects
 * unchanged; a CPU kernel because a baked layer dropped them entirely; four
 * layer inputs because one was the number the bind group happened to have; a
 * limits tier because the ceilings are sized for code the user did not write.
 *
 * The assertions that matter most are the REFUSALS. A manifest that is accepted
 * and means less than it appears to is the failure mode this file exists to
 * prevent — the author ships, and finds out from a black frame.
 */

import { parseEffects, effectKernelFor, composeEffectGlsl, effectIsIdentity, effectExpandFor, type EffectContribution } from './effectSchema';
import { pluginShaderSource, pluginEffectMaterial } from './pluginEffectMaterial';
import { parseManifest } from './manifest';

const WGSL = '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> { return textureSample(src, samp, uv); }';
const GLSL = 'vec4 fs(vec2 uv) { return texture(src, uv); }';

const parse = (effect: Record<string, unknown>, trusted = false): { effect?: EffectContribution; errors: string[] } => {
  const errors: string[] = [];
  const [out] = parseEffects([{ id: 'fx', label: 'FX', params: {}, ...effect }], errors, { trusted });
  return { effect: out, errors };
};

describe('declaring kernels', () => {
  it('accepts WGSL alone, exactly as before', () => {
    const { effect, errors } = parse({ shader: WGSL });
    expect(errors).toEqual([]);
    expect(effect!.glsl).toBeUndefined();
  });

  it('accepts GLSL alone', () => {
    const { effect, errors } = parse({ glsl: GLSL });
    expect(errors).toEqual([]);
    expect(effect!.glsl).toBe(GLSL);
  });

  it('accepts both', () => {
    const { effect, errors } = parse({ shader: WGSL, glsl: GLSL });
    expect(errors).toEqual([]);
    expect(effect!.shader).toBe(WGSL);
    expect(effect!.glsl).toBe(GLSL);
  });

  it('accepts a CPU kernel as the only one', () => {
    const { effect, errors } = parse({ cpu: { module: 'kernels/bloom.wasm' } });
    expect(errors).toEqual([]);
    expect(effect!.cpu).toEqual({ module: 'kernels/bloom.wasm', format: 'wasm', entry: 'render' });
  });

  it('refuses an effect with NO kernel, naming all three', () => {
    // It would appear in the browser, show its parameters, and change no pixels
    // on any machine — which reads as a broken plugin.
    const { effect, errors } = parse({});
    expect(effect).toBeUndefined();
    expect(errors.join()).toMatch(/declares no kernel.*shader.*glsl.*cpu/s);
  });

  it('refuses a kernel path that leaves the package', () => {
    // A kernel is read through the package so it carries the same integrity
    // check as the rest of it; a path that escaped would be reading a file
    // nobody signed.
    expect(parse({ shader: WGSL, cpu: { module: '../../etc/passwd' } }).errors.join())
      .toMatch(/path inside the package/);
  });

  it('infers the format from the extension, and takes an explicit one', () => {
    expect(parse({ shader: WGSL, cpu: { module: 'k/x.js' } }).effect!.cpu!.format).toBe('js');
    expect(parse({ shader: WGSL, cpu: { module: 'k/x.bin', format: 'wasm' } }).effect!.cpu!.format).toBe('wasm');
  });

  it('runs the GLSL through the same safety rules', () => {
    expect(parse({ glsl: 'vec4 fs(vec2 uv) { while (true) { } return vec4(0.0); }' }).errors.join())
      .toMatch(/while/);
  });
});

describe('which backend can draw it', () => {
  const kernel = (effect: Record<string, unknown>, backend: 'webgpu' | 'webgl2' | 'cpu'): ReturnType<typeof effectKernelFor> =>
    effectKernelFor(parse(effect).effect!, backend);

  it('says WGSL runs on WebGPU and not on WebGL2', () => {
    expect(kernel({ shader: WGSL }, 'webgpu').ok).toBe(true);
    expect(kernel({ shader: WGSL }, 'webgl2').ok).toBe(false);
  });

  it('says GLSL runs on WebGL2', () => {
    expect(kernel({ glsl: GLSL }, 'webgl2').ok).toBe(true);
  });

  it('lets a CPU kernel stand in for a missing GPU one', () => {
    // Slower, and the honest degradation: it draws the effect the author wrote,
    // which passthrough never did.
    expect(kernel({ cpu: { module: 'k.js' } }, 'webgl2').ok).toBe(true);
    expect(kernel({ cpu: { module: 'k.js' } }, 'webgpu').ok).toBe(true);
  });

  it('says what is MISSING, in the author’s terms', () => {
    const answer = kernel({ shader: WGSL }, 'webgl2');
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      // The difference between "this plugin is broken" and "this effect ships
      // no GLSL" is the whole reason this returns a reason.
      expect(answer.reason).toMatch(/ships WGSL/);
      expect(answer.reason).toMatch(/GLSL ES 3\.0/);
      expect(answer.reason).toMatch(/"glsl"/);
    }
  });

  it('requires EVERY pass of a chain to speak the language', () => {
    // A four-pass bloom missing GLSL on its third pass would run three passes
    // and stop, leaving the layer holding an intermediate step.
    const errors = parse({
      passes: [
        { name: 'a', wgsl: WGSL, glsl: GLSL },
        { name: 'b', wgsl: WGSL },
      ],
    }).errors;
    expect(errors.join()).toMatch(/GLSL on 1 of 2 passes/);
  });
});

describe('the generated GLSL', () => {
  it('declares the host block, the samplers and `main`', () => {
    const { fragment } = composeEffectGlsl(parse({ glsl: GLSL, params: {} }).effect!);
    expect(fragment).toContain('#version 300 es');
    expect(fragment).toContain('layout(std140) uniform Object');
    expect(fragment).toContain('uniform sampler2D src;');
    expect(fragment).toContain('void main() { fragColor = fs(vUv); }');
  });

  it('carries the SAME host inputs the WGSL struct does', () => {
    const { fragment } = composeEffectGlsl(parse({ glsl: GLSL }).effect!);
    for (const member of ['time', 'compTime', 'frame', 'fps', 'compSize', 'layerSize', 'seed']) {
      expect(fragment).toMatch(new RegExp(`\\b${member};`));
    }
  });

  it('gives the author their own name for a layer input', () => {
    // WebGL2 matches samplers to units by NAME, and the material is built in a
    // package that has never heard of a plugin's vocabulary — so the sampler is
    // declared under a fixed name and aliased back to the author's.
    const { fragment } = composeEffectGlsl(parse({
      glsl: GLSL,
      params: { depth: { type: 'layer' } },
    }).effect!);
    expect(fragment).toContain('uniform sampler2D pluginLayer0;');
    expect(fragment).toContain('#define depth pluginLayer0');
  });

  it('reports a preamble length the driver log can be shifted by', () => {
    const composed = composeEffectGlsl(parse({ glsl: GLSL }).effect!);
    const lines = composed.fragment.split('\n');
    // The author's first line is exactly `preambleLines` down: asserted against
    // the TEXT, so a preamble that grows without the count following it fails.
    expect(lines[composed.preambleLines]).toBe(GLSL);
  });

  it('is generated only for an effect that ships GLSL', () => {
    const plain = pluginShaderSource('studio.acme', parse({ shader: WGSL }).effect!);
    expect(plain.glslIsAuthored).toBe(false);
    // The passthrough stays: `ShaderSource` has no optional variant, and a
    // pipeline built from a missing one fails to create — a black layer rather
    // than "this effect does nothing here".
    expect(plain.glsl.fragment).toContain('Passthrough');

    const authored = pluginShaderSource('studio.acme', parse({ shader: WGSL, glsl: GLSL }).effect!);
    expect(authored.glslIsAuthored).toBe(true);
    expect(authored.glsl.fragment).toContain(GLSL);
  });
});

describe('the material for a multi-input effect', () => {
  it('declares 3, 5, 6, 7 — never 4', () => {
    const effect = parse({
      shader: WGSL,
      params: { a: { type: 'layer' }, b: { type: 'layer' }, c: { type: 'layer' }, d: { type: 'layer' } },
    }).effect!;
    const material = pluginEffectMaterial('studio.acme', effect);
    expect(material.layout.map((e) => e.binding)).toEqual([0, 1, 2, 3, 5, 6, 7]);
  });

  it('names the GLSL samplers in BIND-GROUP ENTRY order', () => {
    // Entry order is what WebGL2 counts texture units in — input, 3, 4, then
    // 5/6/7 — which is not the order the bindings are numbered.
    const effect = parse({
      shader: WGSL,
      params: { a: { type: 'layer' }, b: { type: 'layer' } },
      passes: undefined,
    }).effect!;
    expect(pluginEffectMaterial('studio.acme', effect).glslSamplers)
      .toEqual(['src', 'pluginLayer0', 'pluginLayer1']);
  });
});

describe('identity and expand', () => {
  it('is the identity only when EVERY rule holds', () => {
    const effect = parse({
      shader: WGSL,
      params: { amount: { type: 'number', default: 1 }, on: { type: 'boolean', default: true } },
      identity: [{ param: 'amount', equals: 0 }, { param: 'on', equals: false }],
    }).effect!;
    expect(effectIsIdentity(effect, { amount: 0, on: false })).toBe(true);
    expect(effectIsIdentity(effect, { amount: 0, on: true })).toBe(false);
  });

  it('is never the identity for an effect that declared no rules', () => {
    // The opposite default would silently remove effects.
    expect(effectIsIdentity(parse({ shader: WGSL }).effect!, {})).toBe(false);
  });

  it('refuses a rule naming a parameter that does not exist', () => {
    // It would make the effect NEVER the identity — invisible, and a pass per
    // frame forever.
    expect(parse({ shader: WGSL, identity: [{ param: 'nope', equals: 0 }] }).errors.join())
      .toMatch(/not a number or boolean parameter/);
  });

  it('refuses an empty rule list', () => {
    expect(parse({ shader: WGSL, identity: [] }).errors.join()).toMatch(/non-empty/);
  });

  it('takes the LARGER of spread and expand, per side', () => {
    // The only reading that cannot clip: both declarations, read literally.
    const effect = parse({
      shader: WGSL,
      params: { r: { type: 'number', default: 10 } },
      spread: { param: 'r' },
      expand: { right: { param: 'r', factor: 3 } },
    }).effect!;
    expect(effectExpandFor(effect, { r: 10 })).toEqual({ left: 10, top: 10, right: 30, bottom: 10 });
  });

  it('accepts a plain number as a side', () => {
    const effect = parse({ shader: WGSL, expand: { top: 12 } }).effect!;
    expect(effectExpandFor(effect, {}).top).toBe(12);
  });
});

describe('thread safety and the temporal window', () => {
  it('records a declared thread safety and defaults to none', () => {
    expect(parse({ shader: WGSL, threadSafety: 'full' }).effect!.threadSafety).toBe('full');
    expect(parse({ shader: WGSL }).effect!.threadSafety).toBeUndefined();
  });

  it('refuses one that is not in the vocabulary', () => {
    expect(parse({ shader: WGSL, threadSafety: 'mostly' }).errors.join()).toMatch(/must be one of/);
  });

  it('accepts a window inside the ceiling', () => {
    expect(parse({ shader: WGSL, cpu: { module: 'k.js' }, frames: [-2, 1] }).effect!.frames).toEqual([-2, 1]);
  });

  it('refuses one past it', () => {
    expect(parse({ shader: WGSL, cpu: { module: 'k.js' }, frames: [-5, 0] }).errors.join())
      .toMatch(/neither further than 2/);
  });

  it('refuses a window on an effect with no CPU kernel to receive it', () => {
    // Accepting it and ignoring it would be a feature that exists in the
    // manifest and nowhere else — the shape of gap this round closes.
    expect(parse({ shader: WGSL, frames: [-1, 0] }).errors.join()).toMatch(/needs a "cpu" kernel/);
  });
});

describe('the limits tier', () => {
  const BIG_LOOP = `@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  for (var i = 0; i < 512; i++) { }
  return textureSample(src, samp, uv);
}`;

  it('refuses `extended` for a package the installer did not vouch for', () => {
    // A manifest field that raised its own ceiling would be a ceiling that does
    // not exist — every registry plugin would simply declare it.
    expect(parse({ shader: WGSL, limits: 'extended' }).errors.join())
      .toMatch(/only granted to a plugin you installed yourself/);
  });

  it('grants it to a trusted one, and the bigger loop compiles', () => {
    expect(parse({ shader: BIG_LOOP, limits: 'extended' }, true).errors).toEqual([]);
  });

  it('still refuses that loop at the standard tier', () => {
    expect(parse({ shader: BIG_LOOP }, true).errors.join()).toMatch(/the limit is 256/);
  });

  it('raises the pass count and the fill budget', () => {
    const passes = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, wgsl: WGSL }));
    expect(parse({ passes, limits: 'extended' }, true).errors).toEqual([]);
    expect(parse({ passes }, true).errors.join()).toMatch(/the limit is 8/);
  });

  it('does not record the standard tier, so an untouched effect is unchanged', () => {
    expect(parse({ shader: WGSL }).effect!.limits).toBeUndefined();
  });

  it('is decided by the CALLER, through `parseManifest`', () => {
    /*
      The plumbing, pinned: trust travels from whoever chose to install the
      package, never from the package. The default is untrusted, which is what
      the registry's own validation must use — it runs on a server for a package
      nobody has chosen to trust, and a default of "trusted" there would publish
      a plugin against ceilings no installing machine would honour.
    */
    const manifest = {
      id: 'studio.acme.fx', name: 'FX', version: '1.0.0',
      // 7: `limits` is an API-7 field, so an older grammar refuses it with a
      // version message before trust is ever consulted.
      description: 'Draws pixels.', apiVersion: 7, main: 'main.js',
      contributes: { effects: [{ id: 'fx', label: 'FX', params: {}, shader: WGSL, limits: 'extended' }] },
    };
    expect(parseManifest(manifest).errors.join()).toMatch(/installed yourself/);
    expect(parseManifest(manifest, { trusted: true }).errors).toEqual([]);
  });
});

describe('names the host owns', () => {
  it.each(['time', 'compSize', 'texelSize', 'seed', 'src', 'origin'])('refuses a parameter called %s', (name) => {
    // The generated struct would have two members of that name, and the compile
    // error would name a line in code the author never saw.
    expect(parse({ shader: WGSL, params: { [name]: { type: 'number', default: 0 } } }).errors.join())
      .toMatch(/uses a name the host fills in/);
  });

  it('leaves ordinary names alone', () => {
    expect(parse({ shader: WGSL, params: { amount: { type: 'number', default: 0 } } }).errors).toEqual([]);
  });
});
