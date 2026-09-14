/**
 * Optical kerning on VARIABLE faces: the outline path (gvar / CFF2 instances)
 * agrees with the raster path Chromium draws.
 *
 * The raster side is real Chromium: `chromiumInkProfiles.json` holds the ink
 * profiles opticalKerning's own default rasterizer measured in Playwright's
 * Chromium, each face loaded as a FontFace with `variationSettings: 'wght' N`
 * — the alias mechanism the painter uses (fontFaceVariants.ts). Replaying them
 * through `setOpticalRasterizer` reproduces that raster path exactly in jsdom;
 * the outline side parses the committed OFL fonts (see openTypeVariations.test).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseFont, type ParsedFont } from './openType';
import {
  opticalKernPx,
  registerOpticalOutlineFace,
  resetOpticalKerningForTest,
  setOpticalRasterizer,
  REF_EM_PX,
  type InkProfile,
  type OpticalFace,
} from './opticalKerning';

const FIXTURES = join(__dirname, '__fixtures__', 'variable');

interface Recorded {
  profiles: Record<string, Record<string, { advance: number; left: Array<number | null>; right: Array<number | null>; top: number | null }>>;
  pairs: Array<{ font: string; wght: number; raster: Record<string, number>; outline: Record<string, number> }>;
}
const recorded = JSON.parse(readFileSync(join(FIXTURES, 'chromiumInkProfiles.json'), 'utf8')) as Recorded;

/** JSON has no NaN: empty bands were written as null. */
const revive = (p: Recorded['profiles'][string][string]): InkProfile => ({
  advance: p.advance,
  left: p.left.map((v) => (v === null ? NaN : v)),
  right: p.right.map((v) => (v === null ? NaN : v)),
  top: p.top === null ? NaN : p.top,
});

function load(file: string): ParsedFont {
  const b = readFileSync(join(FIXTURES, file));
  return parseFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)!;
}
const FONTS: Record<string, ParsedFont> = {
  Oswald: load('Oswald[wght].ttf'),
  SourceSans3VF: load('SourceSans3VF-Upright.otf'),
};

const PAIRS = ['AV', 'To', 'nn'] as const;
const em = (face: OpticalFace, pair: string): number => opticalKernPx(face, pair[0]!, 100, face, pair[1]!, 100) / 100;

function rasterFace(font: string, wght: number): OpticalFace {
  const fam = `vf_${font}_${wght}`;
  return { css: `${wght} ${REF_EM_PX}px "${fam}"`, family: fam, weight: wght, italic: false };
}

afterEach(() => resetOpticalKerningForTest());

describe.each(recorded.pairs.map((p) => [p.font, p.wght, p] as const))('%s wght %d', (font, wght, rec) => {
  it('the replayed Chromium raster reproduces the recorded raster pairs', () => {
    setOpticalRasterizer((css, cluster) => {
      const p = recorded.profiles[css]?.[cluster];
      return p ? revive(p) : null;
    });
    const face = rasterFace(font, wght);
    for (const pair of PAIRS) expect(em(face, pair)).toBeCloseTo(rec.raster[pair]!, 9);
  });

  it('outline path (instanced from the variation string) agrees with the raster within 0.005 em', () => {
    setOpticalRasterizer(null);
    registerOpticalOutlineFace(`vfo_${font}`, 400, false, FONTS[font]!);
    // Drawn through an alias face: CSS weight 400, the axis in the variation string.
    const face: OpticalFace = {
      css: `400 ${REF_EM_PX}px "__pv_${font}_${wght}"`,
      family: `vfo_${font}`, weight: 400, italic: false,
      variable: true, variation: `'wght' ${wght}`,
    };
    for (const pair of PAIRS) {
      const outline = em(face, pair);
      expect([pair, Math.abs(outline - rec.raster[pair]!) <= 0.005]).toEqual([pair, true]);
      expect(outline).toBeCloseTo(rec.outline[pair]!, 9);
    }
  });

  it('a plain CSS weight on a variable file registered at another weight is instanced too', () => {
    setOpticalRasterizer(null);
    registerOpticalOutlineFace(`vfw_${font}`, 400, false, FONTS[font]!);
    const face: OpticalFace = { css: `${wght} ${REF_EM_PX}px "vfw_${font}"`, family: `vfw_${font}`, weight: wght, italic: false };
    for (const pair of PAIRS) expect(em(face, pair)).toBeCloseTo(rec.outline[pair]!, 9);
  });
});

describe('instancing is what makes them agree', () => {
  it('the default instance kerns a heavy weight differently from its own instance', () => {
    setOpticalRasterizer(null);
    const heavy = recorded.pairs.find((p) => p.font === 'SourceSans3VF' && p.wght === 900)!;
    // A STATIC registration of the same file's default outlines (no axes): the
    // pre-variations behaviour, profiled at wght 200.
    const f = FONTS.SourceSans3VF!;
    const defaultOnly: ParsedFont = { unitsPerEm: f.unitsPerEm, ascender: f.ascender, descender: f.descender, kind: f.kind, glyphFor: (cp) => f.glyphFor(cp) };
    registerOpticalOutlineFace('ss3static', 900, false, defaultOnly);
    const face: OpticalFace = { css: `900 ${REF_EM_PX}px "ss3static"`, family: 'ss3static', weight: 900, italic: false };
    expect(Math.abs(em(face, 'To') - heavy.raster.To!)).toBeGreaterThan(0.02);
  });
});
