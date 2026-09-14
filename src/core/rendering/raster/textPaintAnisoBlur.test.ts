/**
 * Anisotropic (2-D) animator blur on a REAL canvas — jest.setup backs jsdom
 * <canvas> with @napi-rs/canvas (Skia), which applies `ctx.filter` for real,
 * so the ink can be measured. The requested contract:
 *
 *   • blur X ≠ blur Y bleeds the glyph farther along the LARGER axis;
 *   • the smaller axis stays close to sharp (≤ the composite's ~1 px floor);
 *   • linked X == Y takes the untouched single-filter path (isotropic).
 */

import { identityGlyphTransform, type GlyphTransform } from '@core/text/textAnimators';
import { paintTextInBox } from './textPaint';

const SIZE = 200;
const ALPHA = 12; // ink threshold, out of 255

function paintGlyph(patch: Partial<GlyphTransform>): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  paintTextInBox(ctx, {
    text: 'O',
    fontSize: 48,
    color: '#ffffff',
    width: SIZE,
    height: SIZE,
    glyphs: [identityGlyphTransform('O', patch)],
  });
  return ctx;
}

/** Bounding box of every pixel with alpha above the threshold. */
function inkExtent(ctx: CanvasRenderingContext2D): { w: number; h: number } {
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  let minX = SIZE, minY = SIZE, maxX = -1, maxY = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (data[(y * SIZE + x) * 4 + 3]! > ALPHA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? { w: 0, h: 0 } : { w: maxX - minX + 1, h: maxY - minY + 1 };
}

describe('anisotropic animator blur (real pixels)', () => {
  it('paints ink at all through the composite (nothing silently dropped)', () => {
    const aniso = inkExtent(paintGlyph({ blur: 0, blurY: 12 }));
    expect(aniso.w).toBeGreaterThan(0);
    expect(aniso.h).toBeGreaterThan(0);
  });

  it('Y-only blur bleeds vertically, not horizontally', () => {
    const sharp = inkExtent(paintGlyph({ dx: 1e-4 })); // non-identity, unblurred
    const aniso = inkExtent(paintGlyph({ blur: 0, blurY: 12 }));
    expect(aniso.h - sharp.h).toBeGreaterThan(10);
    expect(Math.abs(aniso.w - sharp.w)).toBeLessThan(8);
  });

  it('X-only blur is the mirror case', () => {
    const sharp = inkExtent(paintGlyph({ dx: 1e-4 }));
    const aniso = inkExtent(paintGlyph({ blur: 12, blurY: 0 }));
    expect(aniso.w - sharp.w).toBeGreaterThan(10);
    expect(Math.abs(aniso.h - sharp.h)).toBeLessThan(8);
  });

  it('an unlinked blur stays narrower than the same radius applied uniformly', () => {
    const uniform = inkExtent(paintGlyph({ blur: 12 }));
    const aniso = inkExtent(paintGlyph({ blur: 0, blurY: 12 }));
    expect(aniso.w).toBeLessThan(uniform.w - 6);
    // …while matching its vertical reach to within a few pixels.
    expect(Math.abs(aniso.h - uniform.h)).toBeLessThan(8);
  });
});
