/**
 * Transform value UNITS for the Properties panel (AE "Edit Value…" units).
 *
 * After Effects lets Position be read and typed in pixels or as a percentage
 * of the composition, and Anchor Point in pixels or as a percentage of the
 * layer's source. The document always stores pixels; this module is only the
 * display mapping and the remembered choice.
 *
 * A display mapping is affine — `display = (px + offset) × scale` — which is
 * what `ValueFieldDisplay` consumes:
 *
 *  • Position x / y  → % of comp width / height: scale 100/size, offset 0.
 *  • Anchor   x / y  → % of layer width / height, measured from the layer's
 *                      left/top edge (AE's numbering): this model stores the
 *                      anchor as an offset FROM THE CENTRE (`anchor.ts`), so
 *                      offset = size/2 puts 0% on the edge and 50% at centre.
 */

export type TransformUnit = 'px' | '%';

export interface TransformUnits {
  position: TransformUnit;
  anchor: TransformUnit;
}

export const DEFAULT_TRANSFORM_UNITS: TransformUnits = { position: 'px', anchor: 'px' };

const STORAGE_KEY = 'premation.inspector.transformUnits';

/** The remembered unit choice (defaults when storage is unavailable or garbage). */
export function loadTransformUnits(): TransformUnits {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULT_TRANSFORM_UNITS };
    const parsed = JSON.parse(raw) as Partial<TransformUnits>;
    return {
      position: parsed.position === '%' ? '%' : 'px',
      anchor: parsed.anchor === '%' ? '%' : 'px',
    };
  } catch {
    return { ...DEFAULT_TRANSFORM_UNITS };
  }
}

export function saveTransformUnits(units: TransformUnits): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(units));
  } catch {
    /* storage blocked — the choice lasts for this mount only */
  }
}

/** An affine display mapping for a numeric field (see module comment). */
export interface UnitDisplay {
  scale: number;
  offset: number;
  unit: string;
  precision: number;
}

/** Position as % of the composition dimension on that axis. Null when the comp has no size. */
export function positionPercentDisplay(compSize: number): UnitDisplay | null {
  if (!(compSize > 0)) return null;
  return { scale: 100 / compSize, offset: 0, unit: '%', precision: 2 };
}

/** Anchor as % of the layer dimension, 0% at the left/top edge. Null when the layer has no size. */
export function anchorPercentDisplay(layerSize: number): UnitDisplay | null {
  if (!(layerSize > 0)) return null;
  return { scale: 100 / layerSize, offset: layerSize / 2, unit: '%', precision: 2 };
}

/** px → display units. */
export function toDisplayUnits(px: number, d: Pick<UnitDisplay, 'scale' | 'offset'>): number {
  return (px + d.offset) * d.scale;
}

/** display units → px. */
export function fromDisplayUnits(display: number, d: Pick<UnitDisplay, 'scale' | 'offset'>): number {
  return display / d.scale - d.offset;
}
