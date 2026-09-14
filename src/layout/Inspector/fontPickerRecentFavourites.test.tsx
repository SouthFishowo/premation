/**
 * FontPicker: Recent fonts, Favourites and the real per-family style strip.
 *
 * The Local Font Access API is faked BEFORE the first open, because the
 * picker's font list is cached for the session (the query can prompt).
 */

import { render, screen, fireEvent, within, act, cleanup } from '@testing-library/react';
import { FontPicker } from './FontPicker';
import { getFavouriteFonts, getRecentFonts, resetFontPrefsCacheForTest, RECENT_FONTS_KEY } from '@core/fonts/fontPrefs';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const g = globalThis as unknown as { queryLocalFonts?: unknown; ResizeObserver?: unknown };

beforeAll(() => {
  g.ResizeObserver = StubResizeObserver;
  g.queryLocalFonts = async () => [
    { family: 'Brand', style: 'Regular', fullName: 'Brand Regular' },
    { family: 'Brand', style: 'Bold Italic', fullName: 'Brand Bold Italic' },
    { family: 'Other', style: 'Light' },
  ];
});

afterAll(() => {
  delete g.queryLocalFonts;
});

beforeEach(() => {
  localStorage.clear();
  resetFontPrefsCacheForTest();
});

afterEach(cleanup);

async function openPicker(value: string, props: Partial<Parameters<typeof FontPicker>[0]> = {}) {
  const onChange = jest.fn();
  render(<FontPicker value={value} onChange={onChange} {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: value }));
  });
  await screen.findByRole('searchbox', { name: 'Search fonts' });
  return onChange;
}

describe('Recent fonts', () => {
  it('lists recents above the full list, and picking one moves it to the top', async () => {
    localStorage.setItem(RECENT_FONTS_KEY, JSON.stringify(['Other', 'Georgia']));
    const onChange = await openPicker('Brand');
    const recent = await screen.findByRole('listbox', { name: 'Recent fonts' });
    const rows = within(recent).getAllByRole('option');
    expect(rows.map((r) => r.getAttribute('title'))).toEqual(['Other', 'Georgia']);

    fireEvent.click(within(recent).getByTitle('Georgia'));
    expect(onChange).toHaveBeenCalledWith('Georgia');
    expect(getRecentFonts()).toEqual(['Georgia', 'Other']);
  });

  it('hides recents while searching', async () => {
    localStorage.setItem(RECENT_FONTS_KEY, JSON.stringify(['Other']));
    await openPicker('Brand');
    await screen.findByRole('listbox', { name: 'Recent fonts' });
    await act(async () => {
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search fonts' }), { target: { value: 'bra' } });
    });
    expect(screen.queryByRole('listbox', { name: 'Recent fonts' })).toBeNull();
  });
});

describe('Favourites', () => {
  it('a star toggles a favourite without selecting the row', async () => {
    localStorage.setItem(RECENT_FONTS_KEY, JSON.stringify(['Other']));
    const onChange = await openPicker('Brand');
    const recent = await screen.findByRole('listbox', { name: 'Recent fonts' });
    const star = within(recent).getByRole('button', { name: 'Add Other to favourites' });
    fireEvent.click(star);
    expect(onChange).not.toHaveBeenCalled();
    expect(getFavouriteFonts()).toEqual(['Other']);
    expect(within(recent).getByRole('button', { name: 'Remove Other from favourites' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('"Show favourites" filters the list, and says so when there are none', async () => {
    await openPicker('Brand');
    const filter = screen.getByRole('button', { name: 'Show favourites' });
    await act(async () => { fireEvent.click(filter); });
    expect(filter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/No favourites yet/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show all fonts' })); });
    expect(filter).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('Real per-family styles', () => {
  it('lists the installed faces by style name and applies one', async () => {
    const onStyleChange = jest.fn();
    const onChange = await openPicker('Brand', { onStyleChange });
    const strip = await screen.findByRole('group', { name: 'Brand styles' });
    const faces = within(strip).getAllByRole('button');
    expect(faces.map((b) => b.textContent)).toEqual(['Regular', 'Bold Italic']);
    fireEvent.click(within(strip).getByRole('button', { name: 'Bold Italic' }));
    expect(onStyleChange).toHaveBeenCalledWith({ weight: '700', fontStyle: 'italic', styleName: 'Bold Italic' });
    expect(onChange).not.toHaveBeenCalled(); // same family
  });

  it('shows no style strip unless the caller opts in', async () => {
    await openPicker('Brand');
    expect(screen.queryByRole('group', { name: 'Brand styles' })).toBeNull();
  });
});
