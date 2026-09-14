/**
 * Can this machine draw a font family? The browser half of the missing-font
 * check (`missingFonts.ts` is the pure scan).
 *
 * ## Why not just `document.fonts.check`
 *
 * `FontFaceSet.check()` answers "would loading be needed", not "is it
 * installed": for a family with no FontFace in the set it reports true, so it
 * calls every font installed — including ones that are not. It is reliable
 * only for web fonts the document actually loaded, which is how it is used
 * here.
 *
 * ## The evidence, strongest first
 *
 *   1. CSS generics, web-safe system fonts and the document's own web fonts
 *      (the `doc-fonts` link in index.html) — always available.
 *   2. The Local Font Access list, when permission is ALREADY granted — an
 *      authoritative installed list. (Never prompted for here: a permission
 *      dialog is the wrong first thing opening a project does.)
 *   3. A loaded FontFace with that family in `document.fonts`.
 *   4. Canvas metrics: the family, falling back to monospace and to serif,
 *      measured against the bare generics. Different widths mean the family
 *      drew. Equal widths under both generics mean it did not.
 *
 * With no local list and no canvas (headless, jsdom) the answer is "available"
 * — a false "missing" warning on every open is worse than a missed one.
 */

import { GENERIC_FONT_FAMILIES, familyKey } from './missingFonts';
import { cachedLocalFontIndex, loadLocalFontIndex, localFontPermissionGranted } from './localFontIndex';

/** Loaded by index.html's `doc-fonts` stylesheet — present whenever the app is. */
export const DOCUMENT_WEB_FONTS: readonly string[] = [
  'Inter', 'Roboto', 'Outfit', 'Playfair Display', 'Fira Code', 'Montserrat',
  'Lora', 'Merriweather', 'PT Sans', 'Open Sans',
];

/** System fonts every supported desktop ships (the picker's system list). */
export const WEB_SAFE_FONTS: readonly string[] = [
  'Arial', 'Helvetica', 'Times New Roman', 'Times', 'Georgia', 'Courier New', 'Courier',
  'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'Segoe UI',
];

export interface FontAvailabilityEvidence {
  /** Lower-cased installed families, or null when the list is not available. */
  localFamilies: ReadonlySet<string> | null;
  /** Lower-cased families of FontFaces loaded into the document. */
  loadedFamilies: ReadonlySet<string>;
  /** Canvas probe: true drew, false did not, undefined could not measure. */
  measure: (family: string) => boolean | undefined;
}

const ALWAYS = new Set([...DOCUMENT_WEB_FONTS, ...WEB_SAFE_FONTS].map((f) => f.toLowerCase()));

/** Combine the evidence into a checker. Pure given its inputs. */
export function makeFontAvailability(e: FontAvailabilityEvidence): (family: string) => boolean {
  return (family) => {
    const key = familyKey(family);
    if (!key || GENERIC_FONT_FAMILIES.has(key) || ALWAYS.has(key)) return true;
    if (e.localFamilies?.has(key)) return true;
    if (e.loadedFamilies.has(key)) return true;
    const measured = e.measure(family);
    if (measured === true) return true;
    if (e.localFamilies !== null) return false;
    return measured !== false;
  };
}

const PROBE_TEXT = 'mmmmmmmmmmlli10OQ@#';

/** Canvas width probe (see the module note). */
export function canvasFontProbe(): (family: string) => boolean | undefined {
  let g: CanvasRenderingContext2D | null = null;
  try {
    g = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  } catch {
    g = null;
  }
  if (!g) return () => undefined;
  const ctx = g;
  const width = (font: string): number => {
    ctx.font = font;
    return ctx.measureText(PROBE_TEXT).width;
  };
  const baseMono = width('72px monospace');
  const baseSerif = width('72px serif');
  if (!(baseMono > 0)) return () => undefined;
  return (family) => {
    const quoted = `"${family.replace(/"/g, '')}"`;
    return width(`72px ${quoted}, monospace`) !== baseMono || width(`72px ${quoted}, serif`) !== baseSerif;
  };
}

/** Gather the evidence from the running app and build the checker. */
export async function detectFontAvailability(): Promise<(family: string) => boolean> {
  try {
    await (globalThis.document as Document | undefined)?.fonts?.ready;
  } catch {
    /* no FontFaceSet — the other evidence still applies */
  }
  let local = cachedLocalFontIndex();
  if (!local && await localFontPermissionGranted()) local = await loadLocalFontIndex();
  const loaded = new Set<string>();
  try {
    const set = (globalThis.document as Document | undefined)?.fonts as unknown as Iterable<FontFace> | undefined;
    if (set && typeof (set as { forEach?: unknown }).forEach === 'function') {
      (set as unknown as { forEach(cb: (f: FontFace) => void): void }).forEach((f) => {
        if (f.status === 'loaded') loaded.add(familyKey(f.family));
      });
    }
  } catch {
    /* ignore */
  }
  return makeFontAvailability({
    localFamilies: local ? new Set([...local.byFamily.keys()].map((f) => f.toLowerCase())) : null,
    loadedFamilies: loaded,
    measure: canvasFontProbe(),
  });
}
