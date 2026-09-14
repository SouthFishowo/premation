/**
 * Per-character 3D: the animator's Anchor Point X/Y/Z reaches each glyph plane,
 * and composed the way buildSnapshot composes it, rotations pivot about it.
 */

import { Matrix4Math } from '@motion/scene';
import { layoutPerChar3D, FALLBACK_ADVANCE_RATIO } from './perChar3D';
import { identityGlyphTransform } from './textAnimators';

const measure = (char: string, style: { fontSize?: number }) =>
  (style.fontSize ?? 16) * FALLBACK_ADVANCE_RATIO * (char === ' ' ? 0.5 : 1);
const style = { fontSize: 40, fontFamily: 'Inter', align: 'center' as const, lineHeight: 1.2 };
const DEG = Math.PI / 180;

/** The glyph frame buildSnapshot builds, and where its plane's centre lands. */
function centreOf(g: ReturnType<typeof layoutPerChar3D>[number]): { x: number; y: number; z: number } {
  const m = Matrix4Math.compose({
    position: { x: g.offsetX, y: g.offsetY, z: g.offsetZ },
    rotation: { x: g.rotationX * DEG, y: g.rotationY * DEG, z: g.rotation * DEG },
    scale: { x: g.scale, y: g.scale, z: 1 },
    anchor: { x: g.anchorX, y: g.anchorY, z: g.anchorZ },
  });
  return Matrix4Math.transformPoint(m, { x: 0, y: 0, z: 0 });
}

describe('per-character 3D anchor point', () => {
  it('carries X / Y / Z anchors through (0 when unset)', () => {
    const [a, b] = layoutPerChar3D({
      text: 'AB', style, boxWidth: 600, measure,
      transforms: [identityGlyphTransform('A', { anchorX: 5, anchorY: -3, anchorZ: 50 }), identityGlyphTransform('B')],
    });
    expect([a!.anchorX, a!.anchorY, a!.anchorZ]).toEqual([5, -3, 50]);
    expect([b!.anchorX, b!.anchorY, b!.anchorZ]).toEqual([0, 0, 0]);
  });

  it('a Z anchor with no rotation sits the glyph that far toward the viewer', () => {
    const [g] = layoutPerChar3D({ text: 'A', style, boxWidth: 600, measure, transforms: [identityGlyphTransform('A', { anchorZ: 50 })] });
    const c = centreOf(g!);
    expect(c.x).toBeCloseTo(g!.offsetX, 6);
    expect(c.z).toBeCloseTo(-50, 6);
  });

  it('Y rotation pivots about the Z anchor: the glyph swings around it', () => {
    const [still] = layoutPerChar3D({ text: 'A', style, boxWidth: 600, measure, transforms: [identityGlyphTransform('A', { anchorZ: 50 })] });
    const [turned] = layoutPerChar3D({
      text: 'A', style, boxWidth: 600, measure, transforms: [identityGlyphTransform('A', { anchorZ: 50, rotationY: 90 })],
    });
    const c = centreOf(turned!);
    // A quarter turn about a pivot 50px behind the glyph carries it 50px sideways
    // and back onto the pivot's depth; without the anchor it would spin in place.
    expect(c.x).toBeCloseTo(still!.offsetX - 50, 6);
    expect(c.z).toBeCloseTo(0, 6);
    const [inPlace] = layoutPerChar3D({ text: 'A', style, boxWidth: 600, measure, transforms: [identityGlyphTransform('A', { rotationY: 90 })] });
    expect(centreOf(inPlace!).x).toBeCloseTo(still!.offsetX, 6);
  });

  it('vertical per-character text turns sideways glyphs 90° and stacks them', () => {
    const g = layoutPerChar3D({ text: 'ab', style, boxWidth: 600, measure, vertical: {} });
    expect(g.map((p) => p.rotation)).toEqual([90, 90]);
    expect(g[1]!.offsetY).toBeGreaterThan(g[0]!.offsetY);
    expect(g[0]!.offsetX).toBeCloseTo(g[1]!.offsetX, 9);
  });

  it('an anchored auto-height box offset moves every glyph plane down', () => {
    const [plain] = layoutPerChar3D({ text: 'A', style, boxWidth: 600, measure });
    const [low] = layoutPerChar3D({ text: 'A', style, boxWidth: 600, measure, boxOffsetY: 12 });
    expect(low!.offsetY - plain!.offsetY).toBe(12);
  });
});
