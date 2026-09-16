/**
 * AE's Composite and Blend Mode rows for one paint operation — a Fill or a
 * Stroke. Shared by `FillRows` and `StrokeRows` so the two menus cannot drift.
 *
 * Stateless: the caller owns the write, because a fill and a stroke store these
 * fields in different places (the fill paint object vs the stroke stack). The
 * value passed to `onChange` may carry defaults; both stores normalise them away
 * (`normalizePaintOpOptions`) so a paint set back to Below/Normal is the same
 * object it was before either menu was touched.
 */

import {
  PAINT_BLEND_MODES,
  PAINT_COMPOSITES,
  type PaintBlendMode,
  type PaintComposite,
  type PaintOpOptions,
} from '@core/paint/stroke';
import styles from '../TransformSection.module.css';

export function PaintOpRows({
  label,
  value,
  onChange,
}: {
  /** "Fill 2", "Stroke 1" — names the controls for assistive tech. */
  label: string;
  value: PaintOpOptions;
  onChange: (next: PaintOpOptions) => void;
}): JSX.Element {
  return (
    <>
      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>Composite</span>
        <select
          className={styles.select}
          style={{ width: 110 }}
          value={value.composite ?? 'below'}
          aria-label={`${label} composite`}
          title="Render this paint below or above the previous paint in the layer (AE: Composite)"
          onChange={(e) => onChange({ ...value, composite: e.target.value as PaintComposite })}
        >
          {PAINT_COMPOSITES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>
      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>Blend Mode</span>
        <select
          className={styles.select}
          style={{ width: 110 }}
          value={value.blendMode ?? 'normal'}
          aria-label={`${label} blend mode`}
          title="Blend with the paints already drawn in this layer"
          onChange={(e) => onChange({ ...value, blendMode: e.target.value as PaintBlendMode })}
        >
          {PAINT_BLEND_MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>
    </>
  );
}

export default PaintOpRows;
