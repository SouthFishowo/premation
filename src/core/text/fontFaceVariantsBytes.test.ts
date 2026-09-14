/**
 * Vertical alternates from font BYTES: the face is built from the bytes and the
 * font's GSUB decides per character (fontFaceVariants.verticalAlternatesFor).
 */

import { fontVariantEpoch, registerFontBytes, resetFontVariantsForTest, verticalAlternatesFor } from './fontFaceVariants';
import { cmapTable, nameTable, sfnt, standardGsub, ttc } from './__fixtures__/syntheticVertFont';

interface Made { family: string; source: unknown; desc: Record<string, string> }
const made: Made[] = [];

class FakeFontFace {
  constructor(public family: string, public source: unknown, public desc: Record<string, string>) {
    made.push({ family, source, desc });
  }
  load(): Promise<this> {
    return Promise.resolve(this);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const g = globalThis as { FontFace?: unknown };
let savedFontFace: unknown;

beforeEach(() => {
  resetFontVariantsForTest();
  made.length = 0;
  savedFontFace = g.FontFace;
  g.FontFace = FakeFontFace;
  Object.defineProperty(document, 'fonts', { value: { add: jest.fn() }, configurable: true });
});

afterEach(() => {
  g.FontFace = savedFontFace;
  delete (document as { fonts?: unknown }).fonts;
});

describe('verticalAlternatesFor — registered bytes', () => {
  it('builds a vert face from the bytes; GSUB says which characters turn', async () => {
    registerFontBytes('Web JP', sfnt({ cmap: cmapTable(), GSUB: standardGsub() }));
    const style = { fontFamily: 'Web JP', fontWeight: '400' };
    expect(verticalAlternatesFor(style, undefined, undefined)).toBeNull(); // loading
    const before = fontVariantEpoch();
    await flush();
    expect(fontVariantEpoch()).toBeGreaterThan(before);
    const alt = verticalAlternatesFor(style, undefined, undefined)!;
    expect(alt.source).toBe('gsub');
    expect(alt.family).toMatch(/^__pv_/);
    expect([0x3001, 0x300c, 0x30fc].map(alt.has)).toEqual([true, true, true]);
    // 漢 has no alternate; A is not in vert; 、 is but ｛ is not in the font at all.
    expect([0x6f22, 0x41, 0xff5b].map(alt.has)).toEqual([false, false, false]);
    expect(made).toHaveLength(1);
    expect(made[0]!.desc).toMatchObject({ featureSettings: `'vert' 1`, weight: '400', style: 'normal' });
    expect(made[0]!.source).toBeInstanceOf(ArrayBuffer);
  });

  it('keeps the layer’s own features and passes variation axes through', async () => {
    registerFontBytes('Web JP', sfnt({ cmap: cmapTable(), GSUB: standardGsub() }));
    const style = { fontFamily: 'Web JP' };
    verticalAlternatesFor(style, `'wght' 500`, `'liga' 0`);
    await flush();
    expect(made[0]!.desc).toMatchObject({ featureSettings: `'liga' 0, 'vert' 1`, variationSettings: `'wght' 500`, weight: '1 1000' });
  });

  it('slices the named face out of a collection', async () => {
    const collection = ttc([
      { cmap: cmapTable(), name: nameTable('Synth', 'Synth-UI') },
      { cmap: cmapTable(), GSUB: standardGsub(), name: nameTable('Synth', 'Synth-Regular') },
    ]);
    registerFontBytes('Synth', collection, { postscriptName: 'Synth-Regular' });
    verticalAlternatesFor({ fontFamily: 'Synth' }, undefined, undefined);
    await flush();
    const alt = verticalAlternatesFor({ fontFamily: 'Synth' }, undefined, undefined)!;
    expect(alt.has(0x300c)).toBe(true);
    const src = made[0]!.source as ArrayBuffer;
    expect(new DataView(src).getUint32(0)).toBe(0x00010000); // a plain sfnt, not 'ttcf'
  });

  it('a font with no vert at all: no face, no alternates', async () => {
    registerFontBytes('Latin Web', sfnt({ cmap: cmapTable() }));
    verticalAlternatesFor({ fontFamily: 'Latin Web' }, undefined, undefined);
    await flush();
    expect(verticalAlternatesFor({ fontFamily: 'Latin Web' }, undefined, undefined)).toBeNull();
    expect(made).toHaveLength(0);
  });

  it('honours unicode-range: characters the bytes do not serve are not claimed', async () => {
    registerFontBytes('Ranged', sfnt({ cmap: cmapTable(), GSUB: standardGsub() }), { unicodeRange: 'U+3000-303F' });
    verticalAlternatesFor({ fontFamily: 'Ranged' }, undefined, undefined);
    await flush();
    const alt = verticalAlternatesFor({ fontFamily: 'Ranged' }, undefined, undefined)!;
    expect(alt.has(0x3001)).toBe(true);
    expect(alt.has(0x30fc)).toBe(false);
    expect(made[0]!.desc.unicodeRange).toBe('U+3000-303F');
  });

  it('picks the nearest registered weight and unregisters', async () => {
    const off = registerFontBytes('Weights', sfnt({ cmap: cmapTable() }), { weight: 700 });
    registerFontBytes('Weights', sfnt({ cmap: cmapTable(), GSUB: standardGsub() }), { weight: 400 });
    verticalAlternatesFor({ fontFamily: 'Weights', fontWeight: '400' }, undefined, undefined);
    await flush();
    expect(verticalAlternatesFor({ fontFamily: 'Weights', fontWeight: '400' }, undefined, undefined)?.has(0x3001)).toBe(true);
    const epoch = fontVariantEpoch();
    off();
    expect(fontVariantEpoch()).toBe(epoch + 1);
  });

  it('is null without the FontFace API', () => {
    g.FontFace = undefined;
    registerFontBytes('Web JP', sfnt({ cmap: cmapTable(), GSUB: standardGsub() }));
    expect(verticalAlternatesFor({ fontFamily: 'Web JP' }, undefined, undefined)).toBeNull();
  });
});
