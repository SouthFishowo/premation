/**
 * The tool-options bar's Fill and Stroke swatches for the shape and pen tools —
 * AE's toolbar Fill / Stroke: a type (None / Solid / Linear / Radial) and a
 * colour for each, and the stroke width as a scrubbable px field. They set what
 * the NEXT drawn shape is born with (`shapeToolPaint`); they never edit a layer.
 */

import { useReducer } from 'react';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { setShapeToolPaint, shapeToolPaint, type ShapeToolPaint, type ToolPaintType } from '@core/workspace/shapeToolPaint';
import styles from './ToolOptionsBar.module.css';

const TYPES: ReadonlyArray<{ value: ToolPaintType; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'solid', label: 'Solid' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
];

export function ShapePaintOptions(): JSX.Element {
  // The state is a framework-free singleton; this only re-renders the bar.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const set = (patch: Partial<ShapeToolPaint>): void => {
    setShapeToolPaint(patch);
    bump();
  };
  const p = shapeToolPaint;

  return (
    <>
      <div className={styles.opt}>
        <span className={styles.optLabel}>Fill</span>
        <select
          className={styles.paintSelect}
          value={p.fillType}
          onChange={(e) => set({ fillType: e.target.value as ToolPaintType })}
          aria-label="New shape fill type"
          title="Fill for newly drawn shapes"
        >
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {p.fillType !== 'none' && (
          <ColorPicker
            compact
            className={styles.paintSwatchTrigger}
            value={p.fillColor}
            onChange={(hex) => set({ fillColor: hex })}
            aria-label="New shape fill color"
          />
        )}
      </div>
      <div className={styles.opt}>
        <span className={styles.optLabel}>Stroke</span>
        <select
          className={styles.paintSelect}
          value={p.strokeType}
          onChange={(e) => set({ strokeType: e.target.value as ToolPaintType })}
          aria-label="New shape stroke type"
          title="Stroke for newly drawn shapes"
        >
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {p.strokeType !== 'none' && (
          <>
            <ColorPicker
              compact
              className={styles.paintSwatchTrigger}
              value={p.strokeColor}
              onChange={(hex) => set({ strokeColor: hex })}
              aria-label="New shape stroke color"
            />
            <ValueField
              value={p.strokeWidth}
              unit="px"
              min={0}
              max={400}
              onChange={(v) => set({ strokeWidth: Number(v) })}
              aria-label="New shape stroke width"
            />
          </>
        )}
      </div>
    </>
  );
}

export default ShapePaintOptions;
