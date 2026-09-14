/**
 * FontPicker — searchable font-family dropdown for the text inspector.
 *
 * Enumerates locally installed fonts via the Chromium Local Font Access API
 * (`window.queryLocalFonts`, through the shared `localFontIndex`) lazily on
 * first open (the call may show a permission prompt). On failure or
 * unavailability it falls back to a curated Google-font list plus universal
 * system fonts. Each option renders in its own font family as a live preview.
 * Arrow keys + Enter select, Escape closes (via Popover).
 *
 * AE's font-menu conveniences:
 *   • RECENT fonts — the last ten families picked, above the full list;
 *   • FAVOURITES — a star per row, and a filter that shows only starred ones;
 *   • real STYLES — when the caller takes `onStyleChange`, the highlighted
 *     family's installed faces are listed by their foundry style names
 *     ("Condensed Semibold Italic"), not a fixed nine-weight guess. Families
 *     the index knows nothing about (web fonts, no permission) show no style
 *     strip, and the caller's own weight control stays the fallback.
 * Recents and favourites are per-user preferences (`fontPrefs.ts`), never
 * document state.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Popover } from '@components/Popover';
import { SearchField } from '@components/SearchField';
import { EmptyState } from '@components/EmptyState';
import { VirtualList } from '@components/VirtualList';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import styles from './FontPicker.module.css';
import { hasVariableAxes, VARIABLE_PROBE_BYTES } from '@core/text/variableFontProbe';
import { loadLocalFontIndex, cachedFamilyFaces, type LocalFace, type LocalFontData } from '@core/fonts/localFontIndex';
import {
  getFavouriteFonts,
  getRecentFonts,
  pushRecentFont,
  subscribeFontPrefs,
  toggleFavouriteFont,
} from '@core/fonts/fontPrefs';

/** Curated Google fonts (the previous hardcoded list) — kept as fallback. */
const CURATED_FONTS = [
  'Inter', 'Roboto', 'Outfit', 'Playfair Display', 'Fira Code', 'Montserrat',
  'Lora', 'Merriweather', 'PT Sans', 'Open Sans',
];

/** Universal system fonts available on virtually every desktop OS. */
const SYSTEM_FONTS = [
  'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New',
  'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'Segoe UI',
];

const FALLBACK_FONTS = [...new Set([...CURATED_FONTS, ...SYSTEM_FONTS])]
  .sort((a, b) => a.localeCompare(b));

/** Module-level cache so the (possibly permission-prompting) query runs once. */
let fontListCache: string[] | null = null;
let fontListPromise: Promise<string[]> | null = null;

/**
 * Which families are VARIABLE fonts (AE 26.3's font-list filter). Filled in
 * the background after the list is shown — probing means reading the head of
 * one file per family, and the picker must not wait on a few hundred reads
 * to open. Curated Google families are known up front: every one of them
 * ships as a variable face, which is why they were curated.
 */
const CURATED_VARIABLE = new Set(['Inter', 'Roboto', 'Outfit', 'Playfair Display', 'Fira Code', 'Montserrat', 'Lora', 'Merriweather', 'Open Sans']);
let variableCache: Set<string> | null = null;
const variableListeners = new Set<(v: Set<string>) => void>();

async function probeVariableFamilies(fonts: ReadonlyArray<LocalFontData>): Promise<void> {
  const found = new Set<string>(CURATED_VARIABLE);
  const seen = new Set<string>();
  for (const f of fonts) {
    const family = String(f?.family ?? '').trim();
    if (!family || seen.has(family) || typeof f.blob !== 'function') continue;
    seen.add(family);
    try {
      const head = await (await f.blob()).slice(0, VARIABLE_PROBE_BYTES).arrayBuffer();
      if (hasVariableAxes(head)) found.add(family);
    } catch {
      // A face that will not read is simply not marked variable.
    }
  }
  variableCache = found;
  for (const cb of variableListeners) cb(found);
}

function loadFontList(): Promise<string[]> {
  if (fontListCache) return Promise.resolve(fontListCache);
  if (fontListPromise) return fontListPromise;

  fontListPromise = (async () => {
    const index = await loadLocalFontIndex();
    let families: string[] = [];
    if (index) {
      families = [...index.byFamily.keys()].sort((a, b) => a.localeCompare(b));
      // Not awaited: the list shows now, the badges arrive when they do.
      void probeVariableFamilies(index.fonts);
    } else {
      variableCache = new Set(CURATED_VARIABLE);
      for (const cb of variableListeners) cb(variableCache);
    }
    const result = families.length > 0 ? families : FALLBACK_FONTS;
    fontListCache = result;
    return result;
  })();

  return fontListPromise;
}

const ITEM_HEIGHT = 26;
const LIST_MAX_HEIGHT = 234; // 9 rows
const NO_FONTS: readonly string[] = [];

/** A face chosen from the style strip. */
export interface FontFaceChoice {
  /** CSS weight, e.g. '700'. */
  weight: string;
  fontStyle: 'normal' | 'italic';
  /** The foundry's style name, e.g. "Bold Italic". */
  styleName: string;
}

export interface FontPickerProps {
  value: string;
  onChange: (family: string) => void;
  /**
   * Opt in to the real per-family style list. Called after `onChange` when a
   * face is picked, so a caller can set weight and italic from it.
   */
  onStyleChange?: (face: FontFaceChoice) => void;
}

export function FontPicker({ value, onChange, onStyleChange }: FontPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [fonts, setFonts] = useState<string[] | null>(fontListCache);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [variableOnly, setVariableOnly] = useState(false);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [variable, setVariable] = useState<Set<string> | null>(variableCache);
  const listWrapRef = useRef<HTMLDivElement | null>(null);

  const recent = useSyncExternalStore(subscribeFontPrefs, getRecentFonts, () => NO_FONTS);
  const favourites = useSyncExternalStore(subscribeFontPrefs, getFavouriteFonts, () => NO_FONTS);
  const favouriteKeys = useMemo(() => new Set(favourites.map((f) => f.toLowerCase())), [favourites]);

  // Variable-font badges land whenever the background probe finishes.
  useEffect(() => {
    if (variableCache) setVariable(variableCache);
    variableListeners.add(setVariable);
    return () => { variableListeners.delete(setVariable); };
  }, []);

  const filtered = useMemo(() => {
    const all = fonts ?? [];
    const q = search.trim().toLowerCase();
    let list = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
    if (variableOnly && variable) list = list.filter((f) => variable.has(f));
    if (favouritesOnly) list = list.filter((f) => favouriteKeys.has(f.toLowerCase()));
    return list;
  }, [fonts, search, variableOnly, variable, favouritesOnly, favouriteKeys]);

  // Recents sit above the list only while it is unfiltered — inside a search
  // or a filter they would be results that do not match it.
  const recentShown = fonts && !search.trim() && !variableOnly && !favouritesOnly ? recent : NO_FONTS;
  const rows = useMemo(() => [...recentShown, ...filtered], [recentShown, filtered]);
  const recentCount = recentShown.length;

  const listHeight = Math.max(
    ITEM_HEIGHT,
    Math.min(filtered.length * ITEM_HEIGHT, LIST_MAX_HEIGHT),
  );

  /** VirtualList's root div (our wrapper's only child) is the scroll container. */
  const getScroller = (): HTMLElement | null =>
    (listWrapRef.current?.firstElementChild as HTMLElement | null) ?? null;

  const scrollIndexIntoView = (rowIndex: number): void => {
    const index = rowIndex - recentCount;
    const scroller = getScroller();
    if (!scroller || index < 0) return;
    const top = index * ITEM_HEIGHT;
    const bottom = top + ITEM_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight;
    }
  };

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) {
      setSearch('');
      // Lazy-load local fonts on first open (may show a permission prompt).
      if (!fonts) void loadFontList().then(setFonts);
    }
  };

  // When the list becomes available while open (or on open), highlight and
  // reveal the currently selected family — in the full list, not in Recent.
  useEffect(() => {
    if (!open || !fonts) return;
    const inList = filtered.indexOf(value);
    const idx = inList >= 0 ? recentCount + inList : Math.max(0, rows.indexOf(value));
    setActiveIndex(idx);
    // Wait a frame so the portal + VirtualList have mounted and measured.
    const raf = requestAnimationFrame(() => scrollIndexIntoView(idx));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fonts]);

  // Reset the highlight when the filter changes.
  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const scroller = getScroller();
    if (scroller) scroller.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, favouritesOnly, variableOnly]);

  const select = (family: string): void => {
    onChange(family);
    pushRecentFont(family);
    setOpen(false);
  };

  const selectFace = (face: LocalFace): void => {
    if (face.family !== value) onChange(face.family);
    onStyleChange?.({ weight: String(face.weight), fontStyle: face.italic ? 'italic' : 'normal', styleName: face.style });
    pushRecentFont(face.family);
    setOpen(false);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(rows.length - 1, Math.max(0, activeIndex + dir));
      setActiveIndex(next);
      scrollIndexIntoView(next);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : rows.length - 1;
      setActiveIndex(next);
      scrollIndexIntoView(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const family = rows[activeIndex];
      if (family) select(family);
    }
  };

  const renderRow = (family: string, rowIndex: number): JSX.Element => {
    const favourite = favouriteKeys.has(family.toLowerCase());
    return (
      <div
        role="option"
        aria-selected={family === value}
        className={cn(
          styles.item,
          rowIndex === activeIndex && styles.itemActive,
          family === value && styles.itemSelected,
        )}
        onClick={() => select(family)}
        onMouseEnter={() => setActiveIndex(rowIndex)}
        title={family}
      >
        <span className={styles.itemLabel} style={{ fontFamily: family }}>
          {family}
        </span>
        {variable?.has(family) ? (
          <span className={styles.variableBadge} title="Variable font" aria-label="variable">
            VAR
          </span>
        ) : null}
        {family === value ? (
          <Icon name="check" size="sm" className={styles.check} />
        ) : null}
        <button
          type="button"
          className={cn(styles.star, favourite && styles.starOn)}
          aria-pressed={favourite}
          aria-label={favourite ? `Remove ${family} from favourites` : `Add ${family} to favourites`}
          title={favourite ? 'Remove from favourites' : 'Add to favourites'}
          // The row selects on click; the star must not.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavouriteFont(family);
          }}
        >
          {favourite ? '★' : '☆'}
        </button>
      </div>
    );
  };

  // The style strip follows the HIGHLIGHT, so arrowing through the list shows
  // each family's faces before committing to one.
  const styleFamily = rows[activeIndex] ?? value;
  const faces = onStyleChange && fonts ? cachedFamilyFaces(styleFamily) : [];

  const clearFilters = (): void => {
    setSearch('');
    setFavouritesOnly(false);
    setVariableOnly(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      placement="bottom-start"
      closeOnOutside
      closeOnEscape
      trigger={
        <button
          type="button"
          className={styles.trigger}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={value}
        >
          <span className={styles.triggerLabel} style={{ fontFamily: value }}>
            {value}
          </span>
          <Icon name="chevron-down" size="sm" className={styles.chevron} />
        </button>
      }
    >
      {/* The popover portals to <body>, outside the Character panel's keep
          zone — without this, picking a font ended in-place text editing. */}
      <div className={styles.panel} data-text-edit-keep="">
        <div className={styles.searchWrap}>
          <SearchField
            size="sm"
            placeholder="Search fonts…"
            value={search}
            onChange={setSearch}
            onKeyDown={onSearchKeyDown}
            autoFocus
            ariaLabel="Search fonts"
          />
          <button
            type="button"
            className={cn(styles.filterChip, favouritesOnly && styles.filterChipOn)}
            aria-pressed={favouritesOnly}
            aria-label="Show favourites"
            title="Show only favourite fonts"
            onClick={() => setFavouritesOnly((v) => !v)}
          >
            ★
          </button>
          <button
            type="button"
            className={cn(styles.filterChip, variableOnly && styles.filterChipOn)}
            aria-pressed={variableOnly}
            // Disabled until the probe has answered — a filter that hides
            // everything because nothing is known yet reads as "no fonts".
            disabled={!variable}
            title={variable ? 'Show only variable fonts (weight / width / slant axes)' : 'Checking which fonts are variable…'}
            onClick={() => setVariableOnly((v) => !v)}
          >
            Variable
          </button>
        </div>
        {!fonts ? (
          <div className={styles.status}>Loading fonts…</div>
        ) : (
          <>
            {recentCount > 0 ? (
              <div role="listbox" aria-label="Recent fonts" className={styles.recentList}>
                <div className={styles.sectionLabel} aria-hidden>Recent</div>
                {recentShown.map((family, i) => (
                  <div key={`recent-${family}`} className={styles.recentRow}>{renderRow(family, i)}</div>
                ))}
                <div className={styles.sectionLabel} aria-hidden>All fonts</div>
              </div>
            ) : null}
            {filtered.length === 0 ? (
              <EmptyState
                compact
                icon="type"
                message={favouritesOnly && favourites.length === 0
                  ? 'No favourites yet — star a font to add it.'
                  : `No fonts match “${search}”.`}
                action={{ label: 'Show all fonts', onClick: clearFilters }}
              />
            ) : (
              <div
                ref={listWrapRef}
                className={styles.listWrap}
                style={{ height: listHeight }}
                role="listbox"
                aria-label="Font family"
              >
                <VirtualList
                  items={filtered}
                  itemHeight={ITEM_HEIGHT}
                  height="100%"
                  renderItem={(family, i) => renderRow(family, recentCount + i)}
                />
              </div>
            )}
            {faces.length > 0 ? (
              <div className={styles.faces} role="group" aria-label={`${styleFamily} styles`}>
                <div className={styles.sectionLabel}>
                  {styleFamily} · {faces.length} {faces.length === 1 ? 'style' : 'styles'}
                </div>
                <div className={styles.faceList}>
                  {faces.map((face) => (
                    <button
                      key={`${face.family}/${face.style}`}
                      type="button"
                      className={styles.face}
                      style={{ fontFamily: face.family, fontWeight: face.weight, fontStyle: face.italic ? 'italic' : 'normal' }}
                      title={face.fullName}
                      onClick={() => selectFace(face)}
                    >
                      {face.style}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Popover>
  );
}

export default FontPicker;
