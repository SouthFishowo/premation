/**
 * The effect catalogue as React reads it — every addable effect type, and the
 * user's starred ones.
 *
 * Shared by the Effects browser (the library you browse) and the Properties
 * panel's "Add effect" menu (the quick add beside the stack you edit). Both
 * used to be one component's private hooks; a second copy of "which effects
 * exist" would drift the first time a plugin was installed while only one of
 * them was listening.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { usePreferenceStore } from '@stores/preferenceStore';
import { EFFECT_DEFS, type EffectDef } from '@core/effects/effects';
import { pluginEffectDefs } from '@core/effects/pluginEffectDefs';
import { subscribeToEffects, pluginEffectRevision } from '@core/plugins/pluginEffects';

/** Starred effect type ids — preference, same rationale as library favourites. */
export function useEffectFavorites(): {
  favorites: ReadonlySet<string>;
  toggle: (id: string) => void;
  isFavorite: (id: string) => boolean;
} {
  const list = usePreferenceStore((s) => s.effectFavorites);
  const setPref = usePreferenceStore((s) => s.set);
  const favorites = useMemo(() => new Set(list), [list]);
  return {
    favorites,
    isFavorite: (id) => favorites.has(id),
    toggle: (id) =>
      setPref('effectFavorites', favorites.has(id) ? list.filter((x) => x !== id) : [...list, id]),
  };
}

/**
 * Built-in effects followed by plugin effects.
 *
 * Appended, not merged: `EFFECT_DEFS` is a module-level constant, while the
 * plugin set changes as the app runs — a plugin is enabled, disabled, updated,
 * or turned off after a device loss. It is read through the store's revision,
 * which is what makes a list re-render instead of showing whatever was
 * installed at load.
 */
export function useAllEffectDefs(): ReadonlyArray<EffectDef> {
  const pluginRev = useSyncExternalStore(subscribeToEffects, () => pluginEffectRevision());
  return useMemo(
    () => [...EFFECT_DEFS, ...pluginEffectDefs()],
    // `pluginRev` is the dependency that matters; `pluginEffectDefs()` reads
    // module state and would otherwise be memoised against nothing.
    [pluginRev],
  );
}
