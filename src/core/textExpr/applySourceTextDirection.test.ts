/**
 * `style.setDirection(...)` in a Source Text expression reaches the painter
 * through `textExtras.direction` (it used to be accepted and dropped).
 */

import type { SourceTextExpressionResult } from '@motion/animation';
import { applySourceTextExpressionResult, type SourceTextSpec } from './applySourceTextResult';

const result = (direction: string | undefined): SourceTextExpressionResult => ({
  text: 'hello',
  style: direction === undefined ? {} : { direction },
  ranges: [],
});

describe('Source Text expression direction', () => {
  it('rtl sets textExtras.direction, keeping the other extras', () => {
    const spec: SourceTextSpec = { text: 'hello', textExtras: { fauxBold: true } };
    expect(applySourceTextExpressionResult(spec, result('rtl')).textExtras).toEqual({ fauxBold: true, direction: 'rtl' });
  });

  it('ltr clears it, dropping an extras object that only carried it', () => {
    expect(applySourceTextExpressionResult({ text: 'hello', textExtras: { direction: 'rtl' } }, result('ltr')).textExtras).toBeUndefined();
    expect(
      applySourceTextExpressionResult({ text: 'hello', textExtras: { direction: 'rtl', noFill: true } }, result('ltr')).textExtras,
    ).toEqual({ noFill: true });
  });

  it('an expression that does not touch direction leaves the layer as it was', () => {
    const spec: SourceTextSpec = { text: 'hello', textExtras: { direction: 'rtl' } };
    expect(applySourceTextExpressionResult(spec, result(undefined)).textExtras).toEqual({ direction: 'rtl' });
  });
});
