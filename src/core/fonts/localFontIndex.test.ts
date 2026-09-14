import { cachedFamilyFaces, groupFaces, loadLocalFontIndex, resetLocalFontIndexForTest } from './localFontIndex';

const g = globalThis as unknown as { queryLocalFonts?: unknown };

afterEach(() => {
  delete g.queryLocalFonts;
  resetLocalFontIndexForTest();
});

describe('groupFaces', () => {
  it('groups by family, keeps REAL style names, upright before italic then by weight', () => {
    const byFamily = groupFaces([
      { family: 'Brand', style: 'Bold Italic', fullName: 'Brand Bold Italic', postscriptName: 'Brand-BoldItalic' },
      { family: 'Brand', style: 'Condensed Semibold' },
      { family: 'Brand', style: 'Regular' },
      { family: 'Brand', style: 'Regular' }, // duplicate face
      { family: 'Other', style: 'Light' },
      { family: '  ' },
    ]);
    expect([...byFamily.keys()]).toEqual(['Brand', 'Other']);
    expect(byFamily.get('Brand')!.map((f) => [f.style, f.weight, f.italic])).toEqual([
      ['Regular', 400, false],
      ['Condensed Semibold', 600, false],
      ['Bold Italic', 700, true],
    ]);
    expect(byFamily.get('Brand')![2]!.postscriptName).toBe('Brand-BoldItalic');
  });
});

describe('loadLocalFontIndex', () => {
  it('queries once and caches', async () => {
    const q = jest.fn(async () => [{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Black' }]);
    g.queryLocalFonts = q;
    const a = await loadLocalFontIndex();
    const b = await loadLocalFontIndex();
    expect(a).toBe(b);
    expect(q).toHaveBeenCalledTimes(1);
    expect(cachedFamilyFaces('Inter').map((f) => f.style)).toEqual(['Regular', 'Black']);
  });

  it('is null without the API or when permission is refused', async () => {
    expect(await loadLocalFontIndex()).toBeNull();
    resetLocalFontIndexForTest();
    g.queryLocalFonts = async () => { throw new Error('denied'); };
    expect(await loadLocalFontIndex()).toBeNull();
    expect(cachedFamilyFaces('Inter')).toEqual([]);
  });
});
