/**
 * What happens inside a plugin's process, against a fake addon.
 *
 * Two things are pinned here and they are different in kind. The ORDER of the
 * calls is a safety property: a binary whose ABI does not match must not have
 * `register` called on it, because calling a function whose stack frame the
 * host disagrees about is the crash the version check exists to avoid. The
 * pixel conversion is arithmetic, and it is checked round-trip, because a
 * premultiply that is wrong by one alpha is a soft edge with a bright fringe
 * that nobody can trace back to this file.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

import { NATIVE_ABI_VERSION } from './pluginNativeAbi';
import {
  NativeAddonRunner,
  fromAddonPixels,
  normaliseDescribe,
  toAddonPixels,
  transfersOf,
} from './pluginNativeChildCore';

interface FakeOptions {
  abi?: unknown;
  register?: () => unknown;
  describe?: unknown;
  render?: (request: Record<string, unknown>) => unknown;
  missing?: string[];
}

function fakeAddon(options: FakeOptions = {}) {
  const calls: string[] = [];
  const addon: Record<string, unknown> = {
    motion_plugin_abi_version: () => { calls.push('abi'); return options.abi ?? NATIVE_ABI_VERSION; },
    motion_plugin_register: () => { calls.push('register'); return options.register?.() ?? { ok: true }; },
    motion_plugin_describe: () => {
      calls.push('describe');
      return options.describe ?? { name: 'Fake', version: '1.0.0', calls: ['effect', 'invoke'] };
    },
    motion_plugin_render: (request: Record<string, unknown>) => {
      calls.push('render');
      return options.render?.(request) ?? { ok: true, identity: true };
    },
    motion_plugin_dispose: () => { calls.push('dispose'); },
  };
  for (const name of options.missing ?? []) delete addon[name];
  return { addon, calls };
}

const HOST = { abi: 1, app: 'Premation', appVersion: '0.8.3', pluginId: 'a.b', pluginVersion: '1.0.0', pluginDir: '/p' };

describe('loading an addon', () => {
  it('asks the version first and then the rest', () => {
    const fake = fakeAddon();
    const runner = new NativeAddonRunner(() => fake.addon);
    const outcome = runner.open('/p/x.node', HOST);
    expect(outcome.ok).toBe(true);
    expect(fake.calls).toEqual(['abi', 'register', 'describe']);
  });

  it('never calls into a module whose ABI disagrees', () => {
    const fake = fakeAddon({ abi: 2000 });
    const runner = new NativeAddonRunner(() => fake.addon);
    const outcome = runner.open('/p/x.node', HOST);
    expect(outcome).toMatchObject({ ok: false, code: 'abi-mismatch' });
    expect(outcome.error).toContain('2.0');
    // The whole point of the version function.
    expect(fake.calls).toEqual(['abi']);
  });

  it('refuses a file that is not a Premation module at all', () => {
    const runner = new NativeAddonRunner(() => ({ hello: 1 }));
    expect(runner.open('/p/x.node', HOST)).toMatchObject({ ok: false, code: 'abi-mismatch' });
  });

  it('refuses a module that reports an ABI and is missing an export', () => {
    const fake = fakeAddon({ missing: ['motion_plugin_render'] });
    const runner = new NativeAddonRunner(() => fake.addon);
    const outcome = runner.open('/p/x.node', HOST);
    expect(outcome).toMatchObject({ ok: false, code: 'abi-mismatch' });
    expect(outcome.error).toContain('motion_plugin_render');
  });

  it('carries the OS message when the file will not load', () => {
    const runner = new NativeAddonRunner(() => { throw new Error('is not a valid Win32 application'); });
    const outcome = runner.open('/p/x.node', HOST);
    expect(outcome).toMatchObject({ ok: false, code: 'missing-binary' });
    expect(outcome.error).toContain('valid Win32');
  });

  it('lets the addon refuse itself, with its own sentence', () => {
    const fake = fakeAddon({ register: () => ({ ok: false, error: 'no licence on this machine' }) });
    const runner = new NativeAddonRunner(() => fake.addon);
    expect(runner.open('/p/x.node', HOST)).toMatchObject({
      ok: false,
      code: 'register-failed',
      error: 'no licence on this machine',
    });
  });
});

describe('what describe() means when it is incomplete', () => {
  it('falls back to the CONSERVATIVE choice, not the convenient one', () => {
    const described = normaliseDescribe({ name: 'x' });
    // Serialised per instance and float pixels: an addon that said nothing gets
    // the answer that cannot corrupt a frame.
    expect(described.threadSafety).toBe('instance');
    expect(described.pixelFormat).toBe('f32-premul');
    expect(described.calls).toEqual([]);
  });

  it('drops call kinds it does not recognise rather than passing them on', () => {
    expect(normaliseDescribe({ calls: ['effect', 'audio'] }).calls).toEqual(['effect']);
  });
});

describe('pixels', () => {
  const pixels = new Uint8ClampedArray([255, 128, 0, 255, 100, 50, 25, 128, 9, 9, 9, 0]);

  it('premultiplies into float and back without drifting', () => {
    const f = toAddonPixels(pixels, 'f32-premul') as Float32Array;
    expect(f[0]).toBeCloseTo(1, 5);
    expect(f[3]).toBeCloseTo(1, 5);
    // The second pixel is half-transparent, so its colour is scaled by alpha.
    expect(f[4]).toBeCloseTo((100 / 255) * (128 / 255), 5);

    const back = fromAddonPixels(f, 'f32-premul');
    expect([...back.slice(0, 8)]).toEqual([255, 128, 0, 255, 100, 50, 25, 128]);
  });

  it('never scales alpha itself', () => {
    const f = toAddonPixels(pixels, 'f32-premul') as Float32Array;
    expect(f[7]).toBeCloseTo(128 / 255, 5);
  });

  it('leaves a fully transparent pixel black rather than dividing by nothing', () => {
    const back = fromAddonPixels(toAddonPixels(pixels, 'f32-premul'), 'f32-premul');
    expect([...back.slice(8)]).toEqual([0, 0, 0, 0]);
  });

  it('hands straight-alpha bytes through untouched, and does not copy them', () => {
    expect(toAddonPixels(pixels, 'rgba8-straight')).toBe(pixels);
  });
});

describe('calling', () => {
  function loaded(options: FakeOptions = {}) {
    const fake = fakeAddon(options);
    const runner = new NativeAddonRunner(() => fake.addon);
    runner.open('/p/x.node', HOST);
    return { runner, fake };
  }

  const effectRequest = {
    call: 'effect',
    effectId: 'exposure',
    instanceId: 'i1',
    width: 1,
    height: 1,
    pixels: new Uint8ClampedArray([10, 20, 30, 255]),
    params: { stops: 1 },
    host: {},
  };

  it('hands the addon an input and an output buffer and returns what it wrote', () => {
    const { runner } = loaded({
      render: (request) => {
        const out = request.output as Float32Array;
        const input = request.input as Float32Array;
        for (let i = 0; i < out.length; i += 4) {
          out[i] = input[i]! * 2;
          out[i + 1] = input[i + 1]!;
          out[i + 2] = input[i + 2]!;
          out[i + 3] = input[i + 3]!;
        }
        return { ok: true, output: out };
      },
    });
    const outcome = runner.call(effectRequest);
    expect(outcome.ok).toBe(true);
    const result = outcome.result as { pixels: Uint8ClampedArray };
    expect(result.pixels[0]).toBe(20);
    expect(result.pixels[3]).toBe(255);
    // The buffer is handed BACK, not copied back.
    expect(outcome.transfer).toContain(result.pixels.buffer);
  });

  it('returns nothing at all for an identity answer', () => {
    const { runner } = loaded({ render: () => ({ ok: true, identity: true }) });
    const outcome = runner.call(effectRequest);
    expect(outcome.result).toEqual({ call: 'effect', identity: true });
    // Nothing to transfer: the caller keeps the buffer it already had, which is
    // the whole saving.
    expect(outcome.transfer).toBeUndefined();
  });

  it('refuses a call the addon did not say it implements', () => {
    const { runner, fake } = loaded();
    const outcome = runner.call({ call: 'generate', generatorId: 'g' });
    expect(outcome).toMatchObject({ ok: false, code: 'no-such-call' });
    // Refused BEFORE the addon is bothered with it.
    expect(fake.calls).not.toContain('render');
  });

  it('turns a throw into a sentence naming the plugin', () => {
    const { runner } = loaded({ render: () => { throw new Error('bad pointer'); } });
    const outcome = runner.call(effectRequest);
    expect(outcome).toMatchObject({ ok: false, code: 'failed' });
    expect(outcome.error).toContain('Fake');
    expect(outcome.error).toContain('bad pointer');
  });

  it('catches an output buffer of the wrong size instead of shipping it', () => {
    const { runner } = loaded({ render: () => ({ ok: true, output: new Float32Array(3) }) });
    const outcome = runner.call(effectRequest);
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.error).toContain('3 samples');
  });

  it('passes the addon its own error text through', () => {
    const { runner } = loaded({ render: () => ({ ok: false, error: 'unsupported colour space' }) });
    expect(runner.call(effectRequest).error).toContain('unsupported colour space');
  });
});

describe('transfer collection', () => {
  it('finds every buffer in a nested response, once each', () => {
    const shared = new Float32Array(4);
    const found = transfersOf({
      instances: shared,
      mesh: { vertices: shared, indices: new Uint16Array(2) },
      count: 1,
    });
    expect(found).toHaveLength(2);
    expect(found).toContain(shared.buffer);
  });
});
