/**
 * The host block, as the RENDERER packs it, against the app's layout table.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * `packages/renderer/src/pipeline/uniforms.ts` said its hand-indexed offsets
 * were "checked against each other in `pluginHostInputs.test.ts`". No such file
 * existed. `uniformLayoutOracle.test.ts` checks the WGSL struct against
 * `HOST_BLOCK_FLOAT_OFFSET`, and `depthPluginRebuild.test.ts` reads what the
 * APP's `packPassBlock` wrote — but the bytes a GPU actually receives come from
 * the renderer's `packPluginEffect`, and nothing compared those with either.
 *
 * ── And `layerRect` ──────────────────────────────────────────────────────────
 *
 * Added because `uv` spans the pass's TARGET, not the layer: three golden scenes
 * (`plugin-kernel-expand`, `generator-shader-kind`, and the in-code comment that
 * called `layerSize` "what uv spans") assumed otherwise and rendered no-ops. The
 * assertions below pin the one property a kernel relies on: that
 * `(uv - layerRect.xy) / layerRect.zw` is top-down layer-local on a flipped
 * backend as well as an unflipped one.
 */

import { Mat3, packPluginEffect } from '@motion/renderer';
import {
  HOST_BLOCK_FLOAT_OFFSET,
  HOST_BLOCK_MEMBERS,
  UNIFORM_HEADER_BYTES,
  UNIFORM_RENDERER_HEADER_BYTES,
  packPassBlock,
  type EffectHostInputs,
} from './effectSchema';

const HOST: EffectHostInputs = {
  compWidth: 1920, compHeight: 1080,
  layerWidth: 640, layerHeight: 360,
  time: 1.25, compTime: 2.5, frame: 75, fps: 30,
  pixelScale: 2, downsample: 4, seed: 12345,
};

const FULL_UV = { x: 0, y: 0, width: 1, height: 1 };
// The rect `targetSampleUv` hands a backend whose render targets run bottom-up.
const FLIP_UV = { x: 0, y: 1, width: 1, height: -1 };
const BOX = { x: 0.25, y: 0.1, width: 0.5, height: 0.4 };

const TARGET = { width: 800, height: 600 };

function rendererBlock(uvRect: typeof FULL_UV, box?: typeof BOX): Float32Array {
  const params = new Float32Array(UNIFORM_HEADER_BYTES / 4 + 4);
  return packPluginEffect(Mat3.identity(), uvRect, params, TARGET.width, TARGET.height, 0.5, 2, HOST, box);
}

function appBlock(box?: typeof BOX): Float32Array {
  const buffer = new ArrayBuffer(UNIFORM_HEADER_BYTES + 16);
  packPassBlock(buffer, TARGET, 0.5, 2, HOST, box);
  return new Float32Array(buffer);
}

const hostFloat = (block: Float32Array, name: string, component = 0): number =>
  block[UNIFORM_RENDERER_HEADER_BYTES / 4 + HOST_BLOCK_FLOAT_OFFSET[name]! + component]!;

describe('the host block the renderer packs', () => {
  it('writes every member where the app’s layout table says it lives', () => {
    // FULL_UV, so the renderer's `layerRect` (pushed through uvRect) and the
    // app's (written as given) are the same numbers and the WHOLE block can be
    // compared member by member.
    const gpu = rendererBlock(FULL_UV, BOX);
    const cpu = appBlock(BOX);
    for (const m of HOST_BLOCK_MEMBERS) {
      for (let i = 0; i < m.floats; i++) {
        expect([m.name, i, hostFloat(gpu, m.name, i)]).toEqual([m.name, i, hostFloat(cpu, m.name, i)]);
      }
    }
    // And they are the values supplied, not two identical zeros.
    expect(hostFloat(gpu, 'fps')).toBe(30);
    expect(hostFloat(gpu, 'seed')).toBe(12345);
    expect(hostFloat(gpu, 'layerSize', 1)).toBe(360);
  });

  it('defaults layerRect to the whole target, in uv units', () => {
    const flipped = rendererBlock(FLIP_UV);
    expect([0, 1, 2, 3].map((i) => hostFloat(flipped, 'layerRect', i))).toEqual([0, 1, 1, -1]);
    expect([0, 1, 2, 3].map((i) => hostFloat(appBlock(), 'layerRect', i))).toEqual([0, 0, 1, 1]);
  });

  it.each([
    ['an unflipped backend', FULL_UV],
    ['a backend whose targets run bottom-up', FLIP_UV],
  ])('makes (uv - layerRect.xy) / layerRect.zw top-down layer-local on %s', (_label, uvRect) => {
    const block = rendererBlock(uvRect, BOX);
    const [rx, ry, rw, rh] = [0, 1, 2, 3].map((i) => hostFloat(block, 'layerRect', i)) as [number, number, number, number];
    // The vertex stage: uv = uvRect.xy + pos * uvRect.zw, pos top-down in [0,1].
    const uvOf = (px: number, py: number) => [uvRect.x + px * uvRect.width, uvRect.y + py * uvRect.height] as const;
    const local = (px: number, py: number) => {
      const [u, v] = uvOf(px, py);
      return [(u - rx) / rw, (v - ry) / rh];
    };
    // The box's top-left corner is (0,0), its bottom-right (1,1), whatever the flip.
    expect(local(BOX.x, BOX.y)[0]).toBeCloseTo(0, 6);
    expect(local(BOX.x, BOX.y)[1]).toBeCloseTo(0, 6);
    expect(local(BOX.x + BOX.width, BOX.y + BOX.height)[0]).toBeCloseTo(1, 6);
    expect(local(BOX.x + BOX.width, BOX.y + BOX.height)[1]).toBeCloseTo(1, 6);
    // And a point above-left of the box is NEGATIVE — the margin an `expand`
    // border draws in, which raw `uv` can never reach.
    const outside = local(BOX.x - 0.05, BOX.y - 0.05);
    expect(outside[0]).toBeLessThan(0);
    expect(outside[1]).toBeLessThan(0);
  });
});
