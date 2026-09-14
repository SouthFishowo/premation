/**
 * Font picker preferences — Recent fonts and Favourites.
 *
 * Per-USER conveniences, not document state: they follow the person across
 * projects and must never ride along in a saved file. So they live in
 * localStorage, and every read and write is wrapped — storage can be missing
 * (a sandboxed renderer), full, or throw on access, and a font picker must
 * still open when it does.
 *
 * Shaped for `useSyncExternalStore`: snapshots are cached arrays whose
 * identity changes only on a write, so React re-renders exactly when the list
 * changed. Writes from another window arrive through the `storage` event.
 */

export const RECENT_FONTS_KEY = 'premation.fonts.recent';
export const FAVOURITE_FONTS_KEY = 'premation.fonts.favourites';
/** AE keeps a short list; ten is what fits above the fold of the picker. */
export const MAX_RECENT_FONTS = 10;

const listeners = new Set<() => void>();
let recentCache: readonly string[] | null = null;
let favouriteCache: readonly string[] | null = null;

function readList(key: string): readonly string[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(list));
  } catch {
    // Quota or a blocked store: the in-memory list still works this session.
  }
}

function emit(): void {
  for (const l of listeners) l();
}

export function getRecentFonts(): readonly string[] {
  return (recentCache ??= readList(RECENT_FONTS_KEY));
}

export function getFavouriteFonts(): readonly string[] {
  return (favouriteCache ??= readList(FAVOURITE_FONTS_KEY));
}

/** Most-recent first, de-duplicated case-insensitively, capped at MAX_RECENT_FONTS. */
export function pushRecentFont(family: string): void {
  const f = family.trim();
  if (!f) return;
  const next = [f, ...getRecentFonts().filter((x) => x.toLowerCase() !== f.toLowerCase())].slice(0, MAX_RECENT_FONTS);
  recentCache = next;
  writeList(RECENT_FONTS_KEY, next);
  emit();
}

export function isFavouriteFont(family: string): boolean {
  const k = family.trim().toLowerCase();
  return getFavouriteFonts().some((x) => x.toLowerCase() === k);
}

/** Star / un-star a family. Returns whether it is now a favourite. */
export function toggleFavouriteFont(family: string): boolean {
  const f = family.trim();
  if (!f) return false;
  const on = !isFavouriteFont(f);
  const next = on
    ? [...getFavouriteFonts(), f].sort((a, b) => a.localeCompare(b))
    : getFavouriteFonts().filter((x) => x.toLowerCase() !== f.toLowerCase());
  favouriteCache = next;
  writeList(FAVOURITE_FONTS_KEY, next);
  emit();
  return on;
}

let storageBound = false;

export function subscribeFontPrefs(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageBound && typeof window !== 'undefined') {
    storageBound = true;
    window.addEventListener('storage', (e) => {
      if (e.key === RECENT_FONTS_KEY) recentCache = null;
      else if (e.key === FAVOURITE_FONTS_KEY) favouriteCache = null;
      else return;
      emit();
    });
  }
  return () => { listeners.delete(listener); };
}

/** Test seam: forget the cached lists so the next read goes back to storage. */
export function resetFontPrefsCacheForTest(): void {
  recentCache = null;
  favouriteCache = null;
}
