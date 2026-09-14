/**
 * Which variation axes a FAMILY has — read from the installed font's `fvar`.
 *
 * Kept apart from `fontAxes.ts` so the rasterizer's pure axis maths never
 * imports the Local Font Access plumbing. Needs the whole file (the `fvar`
 * table can sit anywhere in it), so it reads one face's blob per family, once,
 * and caches the answer.
 *
 * Without Local Font Access (permission refused, a browser without it, a
 * bundled web font) there is no file to read, and the answer falls back to the
 * registered axes wght / wdth / slnt / ital / opsz — which a variable font may
 * or may not implement, so the panel says the ranges are nominal.
 */

import { loadLocalFontIndex, cachedLocalFontIndex } from '@core/fonts/localFontIndex';
import { parseFvarAxes, type FvarAxis } from './variableFontProbe';
import { REGISTERED_AXES } from './fontAxes';

export interface FamilyAxes {
  axes: FvarAxis[];
  /** True when read from the font file; false for the registered fallback. */
  fromFont: boolean;
}

const cache = new Map<string, Promise<FamilyAxes>>();

/** The registered axes as `fvar`-shaped records. */
export function registeredAxisFallback(): FamilyAxes {
  return {
    axes: REGISTERED_AXES.map((a) => ({ tag: a.tag, min: a.min, default: a.default, max: a.max, hidden: false })),
    fromFont: false,
  };
}

export function loadFamilyAxes(family: string): Promise<FamilyAxes> {
  const key = family.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<FamilyAxes> => {
    try {
      const index = cachedLocalFontIndex() ?? (await loadLocalFontIndex());
      const face = index?.fonts.find((f) => String(f.family ?? '').trim().toLowerCase() === key && typeof f.blob === 'function');
      if (!face?.blob) return registeredAxisFallback();
      const axes = parseFvarAxes(await (await face.blob()).arrayBuffer()).filter((a) => !a.hidden);
      return axes.length > 0 ? { axes, fromFont: true } : { axes: [], fromFont: true };
    } catch {
      return registeredAxisFallback();
    }
  })();
  cache.set(key, p);
  return p;
}
