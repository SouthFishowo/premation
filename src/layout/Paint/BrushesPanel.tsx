/**
 * BrushesPanel — AE's Brushes panel (Ctrl+9): the tip list, the tip itself
 * (Diameter, Angle, Roundness, Hardness, Spacing) and Brush Dynamics (what pen
 * pressure and tilt drive, and the Minimum Size pressure can shrink to).
 *
 * Diameter is the shared `drawToolOptions.brushSize`, so this panel, the Tool
 * Options bar and Ctrl-drag in the viewer all move the same number.
 */

import { useReducer, useState } from 'react';
import { drawToolOptions } from '@motion/workspace';
import type { DynamicsSource } from '@core/paint/paintStrokes';
import { usePaintStore, type BrushPreset } from '@stores/paintStore';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import styles from './Paint.module.css';

const SOURCES: ReadonlyArray<{ value: DynamicsSource; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'pressure', label: 'Pen Pressure' },
  { value: 'tilt', label: 'Pen Tilt' },
];

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      {children}
    </label>
  );
}

const pct = (v: number): number => Math.round(v * 1000) / 10;

/** Is the live tip exactly this preset? */
function matches(p: BrushPreset, size: number, s: { angle: number; roundness: number; hardness: number; spacing: number }): boolean {
  return p.diameter === size && p.angle === s.angle && p.roundness === s.roundness && p.hardness === s.hardness && p.spacing === s.spacing;
}

export function BrushesPanel(): JSX.Element {
  const paint = usePaintStore();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [spacingOn, setSpacingOn] = useState(true);
  const size = drawToolOptions.brushSize;

  const dynRow = (key: 'size' | 'angle' | 'roundness' | 'opacity' | 'flow', label: string): JSX.Element => (
    <Row label={label}>
      <select
        className={styles.select}
        aria-label={`${label} dynamics`}
        value={paint.dynamics[key]}
        onChange={(e) => paint.setDynamics(key, e.target.value as DynamicsSource)}
      >
        {SOURCES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Row>
  );

  return (
    <div className={styles.panelRoot} aria-label="Brushes">
      <div className={styles.group}>
        <span className={styles.groupLabel}>Brush Tips</span>
        <div className={styles.presetGrid} role="listbox" aria-label="Brush tips">
          {paint.brushPresets.map((p, i) => {
            const on = matches(p, size, paint);
            const dot = Math.max(2, Math.min(28, p.diameter * 0.4));
            return (
              <button
                key={`${p.name}-${i}`}
                type="button"
                role="option"
                aria-selected={on}
                className={on ? styles.presetActive : styles.preset}
                title={`${p.name} — ${p.diameter}px, hardness ${pct(p.hardness)}%`}
                onClick={() => { paint.applyBrushPreset(p); bump(); }}
              >
                <span
                  className={styles.tip}
                  style={{
                    width: dot,
                    height: dot * p.roundness,
                    transform: `rotate(${p.angle}deg)`,
                    filter: p.hardness < 1 ? `blur(${(1 - p.hardness) * dot * 0.2}px)` : undefined,
                  }}
                />
                <span>{p.diameter}</span>
              </button>
            );
          })}
        </div>
        <button type="button" className={styles.button} onClick={() => paint.saveBrushPreset(`Custom ${size}`)}>
          Save Current Tip
        </button>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Tip</span>
        <Row label="Diameter">
          <ValueField value={size} unit="px" min={1} max={2500} precision={0} onChange={(v) => { drawToolOptions.brushSize = Math.max(1, Number(v)); bump(); }} />
        </Row>
        <Row label="Angle">
          <ValueField value={paint.angle} unit="°" min={-180} max={180} precision={0} onChange={(v) => paint.set({ angle: Number(v) })} />
        </Row>
        <Row label="Roundness">
          <ValueField value={pct(paint.roundness)} unit="%" min={1} max={100} precision={0} onChange={(v) => paint.set({ roundness: Math.max(0.01, Number(v) / 100) })} />
        </Row>
        <Row label="Hardness">
          <ValueField value={pct(paint.hardness)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ hardness: Number(v) / 100 })} />
        </Row>
        <div className={styles.row}>
          <Checkbox
            label="Spacing"
            checked={spacingOn}
            onChange={() => {
              // AE's unchecked Spacing lays dabs as fast as the pointer moves;
              // the dab renderer's densest honest equivalent is 1 %.
              setSpacingOn(!spacingOn);
              paint.set({ spacing: spacingOn ? 0.01 : 0.25 });
            }}
          />
          <ValueField value={pct(paint.spacing)} unit="%" min={1} max={1000} precision={0} disabled={!spacingOn} onChange={(v) => paint.set({ spacing: Math.max(0.01, Number(v) / 100) })} />
        </div>
        <Row label="Smoothing">
          <ValueField value={pct(paint.smoothing)} unit="%" min={0} max={95} precision={0} onChange={(v) => paint.set({ smoothing: Number(v) / 100 })} />
        </Row>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Brush Dynamics</span>
        {dynRow('size', 'Size')}
        <Row label="Minimum Size">
          <ValueField value={pct(paint.dynamics.minSize)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.setDynamics('minSize', Number(v) / 100)} />
        </Row>
        {dynRow('angle', 'Angle')}
        {dynRow('roundness', 'Roundness')}
        {dynRow('opacity', 'Opacity')}
        {dynRow('flow', 'Flow')}
        <span className={styles.hint}>Dynamics read a pen. A mouse paints at full pressure and upright.</span>
      </div>
    </div>
  );
}

export default BrushesPanel;
