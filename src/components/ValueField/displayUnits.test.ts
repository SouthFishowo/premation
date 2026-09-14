/**
 * Position / Anchor in % (AE "Edit Value…" units): the pure conversions and
 * the ValueField prop wrapper that shows % and writes pixels.
 */

import { toDisplayProps, type ValueFieldProps } from './ValueField';
import {
  anchorPercentDisplay,
  fromDisplayUnits,
  loadTransformUnits,
  positionPercentDisplay,
  saveTransformUnits,
  toDisplayUnits,
} from '@core/scene/transformUnits';

describe('transform unit conversion', () => {
  it('position: px ↔ % of the composition dimension', () => {
    const d = positionPercentDisplay(1920)!;
    expect(toDisplayUnits(960, d)).toBeCloseTo(50);
    expect(fromDisplayUnits(25, d)).toBeCloseTo(480);
    expect(positionPercentDisplay(0)).toBeNull();
  });

  it('anchor: centre-offset px ↔ % of the layer from its left/top edge', () => {
    const d = anchorPercentDisplay(200)!;
    expect(toDisplayUnits(0, d)).toBeCloseTo(50); // centre
    expect(toDisplayUnits(-100, d)).toBeCloseTo(0); // left edge
    expect(fromDisplayUnits(100, d)).toBeCloseTo(100); // right edge
  });

  it('remembers the choice and survives garbage in storage', () => {
    saveTransformUnits({ position: '%', anchor: 'px' });
    expect(loadTransformUnits()).toEqual({ position: '%', anchor: 'px' });
    localStorage.setItem('premation.inspector.transformUnits', '{not json');
    expect(loadTransformUnits()).toEqual({ position: 'px', anchor: 'px' });
  });
});

describe('toDisplayProps', () => {
  const base = (over: Partial<ValueFieldProps> = {}): ValueFieldProps => ({
    value: 960,
    onChange: jest.fn(),
    step: 1,
    ...over,
  });
  const pct = { scale: 100 / 1920, offset: 0, unit: '%', precision: 2 };

  it('shows the value in % and writes pixels back', () => {
    const props = base();
    const shown = toDisplayProps(props, pct);
    expect(shown.value).toBeCloseTo(50);
    expect(shown.unit).toBe('%');
    shown.onChange(25);
    expect(props.onChange).toHaveBeenCalledWith(480);
  });

  it('converts a relative scrub delta by the scale only (no offset)', () => {
    const onRelative = jest.fn();
    const anchor = { scale: 0.5, offset: 100 };
    toDisplayProps(base({ onRelative }), anchor).onRelative!(10, true);
    expect(onRelative).toHaveBeenCalledWith(20, true);
  });

  it('keeps the drag feel: one display step is one pixel step', () => {
    expect(toDisplayProps(base({ step: 2 }), pct).step).toBeCloseTo(2 * (100 / 1920));
  });

  it('typed text on a mixed field: a plain % sets every layer; +N converts', () => {
    const onChange = jest.fn();
    const onCommitText = jest.fn(() => true);
    const shown = toDisplayProps(base({ onChange, onCommitText, mixed: true }), pct);
    expect(shown.onCommitText!('50')).toBe(true);
    expect(onChange).toHaveBeenCalledWith(960);
    shown.onCommitText!('+10');
    expect(onCommitText).toHaveBeenCalledWith(`+${10 / (100 / 1920)}`);
  });

  it('maps finite min/max and leaves infinite ones alone', () => {
    const shown = toDisplayProps(base({ min: 0, max: Infinity }), pct);
    expect(shown.min).toBe(0);
    expect(shown.max).toBe(Infinity);
  });
});
