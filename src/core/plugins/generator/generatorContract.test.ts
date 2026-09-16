/**
 * The contract validator, from the outside.
 *
 * Every case here is something a plugin can actually send — including the ones
 * that would read past the end of a GPU buffer if they were believed. The point
 * of the file is that each refusal names the PLUGIN's mistake, because a
 * validator that says "invalid generate result" sends an author to read the
 * host's source.
 */

import {
  GEN_STRIDE,
  GEN_STRIDE_UV,
  MAX_GENERATOR_INSTANCES,
  emptyGeneratorFrame,
  generatorBoundsOf,
  measureInstanceBounds,
  validateGeneratorFrame,
} from './generatorContract';

const SIZE = { width: 400, height: 300 };

/** Nine floats: x, y, z, size, rotation, r, g, b, a. */
const instance = (x: number, y: number, size = 10): number[] => [x, y, 0, size, 0, 1, 1, 1, 1];

const frame = (over: Record<string, unknown> = {}) => ({
  instances: new Float32Array([...instance(0, 0), ...instance(50, -20)]),
  count: 2,
  primitive: 'point' as const,
  ...over,
});

const ok = (raw: unknown) => {
  const r = validateGeneratorFrame(raw, 1, SIZE);
  if ('error' in r) throw new Error(`expected a valid frame, got: ${r.error}`);
  return r.frame;
};

const why = (raw: unknown): string => {
  const r = validateGeneratorFrame(raw, 1, SIZE);
  if (!('error' in r)) throw new Error('expected a refusal');
  return r.error;
};

describe('what a generator may return', () => {
  it('accepts the minimum: a buffer, a count and a primitive', () => {
    const f = ok(frame());
    expect(f.count).toBe(2);
    expect(f.stride).toBe(GEN_STRIDE);
    expect(f.primitive).toBe('point');
    expect(f.blend).toBe('normal');
    expect(f.cellSize).toEqual([1, 1]);
  });

  it('carries the plugin\u2019s own buffer through, not a copy', () => {
    const raw = frame();
    expect(ok(raw).instances).toBe(raw.instances);
  });

  it('accepts a textured sprite at stride 11', () => {
    const f = ok(frame({
      instances: new Float32Array(GEN_STRIDE_UV * 2),
      primitive: 'sprite',
      stride: GEN_STRIDE_UV,
      textureAssetKey: 'sprites/spark.png',
      cellSize: [0.25, 0.25],
    }));
    expect(f.stride).toBe(GEN_STRIDE_UV);
    expect(f.cellSize).toEqual([0.25, 0.25]);
  });
});

describe('what it may not', () => {
  it('refuses a count its buffer cannot back \u2014 the read-past-the-end case', () => {
    expect(why(frame({ count: 3 }))).toMatch(/reported 3 instances .* buffer holds 18/);
  });

  it('refuses more instances than this host draws', () => {
    expect(why(frame({ count: MAX_GENERATOR_INSTANCES + 1 })))
      .toMatch(new RegExp(`at most ${MAX_GENERATOR_INSTANCES}`));
  });

  it('refuses a texture without the uv stride to address it', () => {
    expect(why(frame({ textureAssetKey: 'a.png' }))).toMatch(/needs stride 11/);
  });

  it('refuses a texture key that points outside the package', () => {
    for (const key of ['../secrets.png', '/etc/passwd', 'C:/Users/x.png']) {
      expect(why(frame({
        instances: new Float32Array(GEN_STRIDE_UV * 2),
        stride: GEN_STRIDE_UV,
        textureAssetKey: key,
      }))).toMatch(/inside the plugin package/);
    }
  });

  it('refuses a mesh whose indices point past its vertices', () => {
    expect(why(frame({
      primitive: 'mesh',
      mesh: { vertices: new Float32Array(5 * 3), indices: new Uint16Array([0, 1, 7]) },
    }))).toMatch(/index 2 is 7, past its 3 vertices/);
  });

  it('refuses a mesh primitive with no mesh', () => {
    expect(why(frame({ primitive: 'mesh' }))).toMatch(/without a mesh/);
  });

  it('refuses a stride the shaders have no layout for', () => {
    expect(why(frame({ stride: 10 }))).toMatch(/must be 9 .* or 11/);
  });

  it('refuses instances that are not a Float32Array', () => {
    expect(why(frame({ instances: [1, 2, 3] }))).toMatch(/Float32Array/);
  });

  it('names the primitives it knows', () => {
    expect(why(frame({ primitive: 'blob' }))).toMatch(/point, sprite, quad, mesh/);
  });
});

describe('bounds', () => {
  it('measures the instances, each contributing its own size', () => {
    const f = ok(frame());
    // x \u2208 {0, 50} with size 10 \u21d2 [-5, 55]; y \u2208 {0, -20} \u21d2 [-25, 5].
    expect(f.bounds).toEqual({ x: -5, y: -25, width: 60, height: 30 });
  });

  it('takes a declared maxBounds instead of measuring, when given one', () => {
    const f = ok(frame({ maxBounds: { x: -500, y: -500, width: 1000, height: 1000 } }));
    expect(f.bounds).toEqual({ x: -500, y: -500, width: 1000, height: 1000 });
  });

  it('falls back to the layer box when there are no instances', () => {
    expect(measureInstanceBounds(new Float32Array(0), 0, GEN_STRIDE, SIZE))
      .toEqual({ x: -200, y: -150, width: 400, height: 300 });
  });

  it('skips a non-finite position rather than poisoning the whole box', () => {
    const buf = new Float32Array([...instance(NaN, 0), ...instance(20, 20, 4)]);
    expect(measureInstanceBounds(buf, 2, GEN_STRIDE, SIZE))
      .toEqual({ x: 18, y: 18, width: 4, height: 4 });
  });

  it('converts to comp space around the layer centre, in one place', () => {
    const f = ok(frame());
    expect(generatorBoundsOf(f, { x: 960, y: 540 }))
      .toEqual({ x: 955, y: 515, width: 60, height: 30 });
  });
});

describe('the empty frame', () => {
  it('fills the layer box and carries revision 0, which nothing else produces', () => {
    const f = emptyGeneratorFrame(SIZE);
    expect(f.count).toBe(0);
    expect(f.revision).toBe(0);
    expect(f.bounds).toEqual({ x: -200, y: -150, width: 400, height: 300 });
  });
});
