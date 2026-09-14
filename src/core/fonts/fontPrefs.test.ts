import {
  FAVOURITE_FONTS_KEY,
  MAX_RECENT_FONTS,
  RECENT_FONTS_KEY,
  getFavouriteFonts,
  getRecentFonts,
  isFavouriteFont,
  pushRecentFont,
  resetFontPrefsCacheForTest,
  subscribeFontPrefs,
  toggleFavouriteFont,
} from './fontPrefs';

beforeEach(() => {
  localStorage.clear();
  resetFontPrefsCacheForTest();
});

describe('recent fonts', () => {
  it('most recent first, de-duplicated case-insensitively, persisted', () => {
    pushRecentFont('Inter');
    pushRecentFont('Roboto');
    pushRecentFont('inter');
    expect(getRecentFonts()).toEqual(['inter', 'Roboto']);
    expect(JSON.parse(localStorage.getItem(RECENT_FONTS_KEY)!)).toEqual(['inter', 'Roboto']);
    resetFontPrefsCacheForTest();
    expect(getRecentFonts()).toEqual(['inter', 'Roboto']);
  });

  it(`keeps only the last ${MAX_RECENT_FONTS}`, () => {
    for (let i = 0; i < 15; i++) pushRecentFont(`Font ${i}`);
    expect(getRecentFonts()).toHaveLength(MAX_RECENT_FONTS);
    expect(getRecentFonts()[0]).toBe('Font 14');
  });

  it('snapshot identity changes only on a write (useSyncExternalStore contract)', () => {
    const a = getRecentFonts();
    expect(getRecentFonts()).toBe(a);
    pushRecentFont('Lora');
    expect(getRecentFonts()).not.toBe(a);
  });
});

describe('favourites', () => {
  it('toggles, sorts and notifies', () => {
    const cb = jest.fn();
    const off = subscribeFontPrefs(cb);
    expect(toggleFavouriteFont('Roboto')).toBe(true);
    expect(toggleFavouriteFont('Arial')).toBe(true);
    expect(getFavouriteFonts()).toEqual(['Arial', 'Roboto']);
    expect(isFavouriteFont('roboto')).toBe(true);
    expect(toggleFavouriteFont('ROBOTO')).toBe(false);
    expect(getFavouriteFonts()).toEqual(['Arial']);
    expect(cb).toHaveBeenCalledTimes(3);
    off();
  });

  it('survives corrupt or blocked storage', () => {
    localStorage.setItem(FAVOURITE_FONTS_KEY, '{not json');
    expect(getFavouriteFonts()).toEqual([]);
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => toggleFavouriteFont('Inter')).not.toThrow();
    expect(isFavouriteFont('Inter')).toBe(true);
    spy.mockRestore();
  });
});
