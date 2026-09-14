import type { SourceTextExpressionResult } from '@motion/animation';
import { applySourceTextExpressionResult, unsupportedRangeKeys, type SourceTextSpec } from './applySourceTextResult';

const result = (patch: Partial<SourceTextExpressionResult> & { text: string }): SourceTextExpressionResult => ({
  style: {},
  ranges: [],
  ...patch,
});

describe('applySourceTextExpressionResult', () => {
  const spec: SourceTextSpec & { id: string } = {
    id: 'layer-1',
    text: 'Hello',
    fontSize: 40,
    fontFamily: 'Inter',
    letterSpacing: 2,
    fill: '#ffffff',
  };

  it('returns the SAME spec for no result, and never mutates its input', () => {
    expect(applySourceTextExpressionResult(spec, null)).toBe(spec);
    const before = JSON.stringify(spec);
    applySourceTextExpressionResult(spec, result({ text: 'Bye', style: { fontSize: 99 } }));
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('writes only the fields the expression touched; unrelated fields survive', () => {
    const out = applySourceTextExpressionResult(spec, result({ text: 'Hello', style: { fontSize: 80, fill: '#ff0000' } }));
    expect(out).toEqual({ ...spec, fontSize: 80, fill: '#ff0000' });
    expect('lineHeight' in out).toBe(false);
  });

  it('maps every layer-wide override onto its spec field', () => {
    const out = applySourceTextExpressionResult(spec, result({
      text: 'Hello',
      style: {
        fontFamily: 'Roboto', fontWeight: '700', fontStyle: 'italic', stroke: '#000000', strokeWidth: 3,
        leading: 60, baselineShift: 5, horizontalScale: 150, verticalScale: 80,
        textTransform: 'uppercase', fontVariant: 'small-caps', align: 'center', spaceAfter: 10, spaceBefore: 2,
      },
    }));
    expect(out).toMatchObject({
      fontFamily: 'Roboto', fontWeight: '700', fontStyle: 'italic', textStroke: '#000000', textStrokeWidth: 3,
      lineHeight: 1.5, baselineShift: 5, horizontalScale: 150, verticalScale: 80,
      textTransform: 'uppercase', fontVariant: 'small-caps', align: 'center', paragraphSpacing: 12,
    });
  });

  it('tracking converts at the final font size; applyFill/applyStroke off hide paint', () => {
    const out = applySourceTextExpressionResult({ ...spec, textStrokeWidth: 4 }, result({
      text: 'Hello', style: { fontSize: 100, tracking: 50, applyFill: false, applyStroke: false },
    }));
    expect(out.letterSpacing).toBe(5);
    expect(out.fill).toBe('transparent');
    expect(out.textStrokeWidth).toBe(0);
  });

  it('a changed text re-indexes the stored runs instead of leaving them on the wrong letters', () => {
    const styled = { ...spec, text: 'Hello world', runs: [{ start: 6, end: 11, style: { fill: '#f00' } }] };
    const out = applySourceTextExpressionResult(styled, result({ text: 'Oh, Hello world' }));
    expect(out.text).toBe('Oh, Hello world');
    expect(out.runs).toEqual([{ start: 10, end: 15, style: { fill: '#f00' } }]);
  });

  it('per-character ranges become disjoint runs, merged over stored runs, later wins', () => {
    const styled = { ...spec, text: 'abcdef', runs: [{ start: 0, end: 3, style: { fill: '#111111' } }] };
    const out = applySourceTextExpressionResult(styled, result({
      text: 'abcdef',
      ranges: [
        { start: 1, count: 3, style: { fontSize: 20 } },
        { start: 2, count: 1, style: { fill: '#00ff00' } },
      ],
    }));
    expect(out.runs).toEqual([
      { start: 0, end: 1, style: { fill: '#111111' } },
      { start: 1, end: 2, style: { fontSize: 20, fill: '#111111' } },
      { start: 2, end: 3, style: { fontSize: 20, fill: '#00ff00' } },
      { start: 3, end: 4, style: { fontSize: 20 } },
    ]);
  });

  it('range tracking uses the character’s own size; range all-caps upper-cases those characters', () => {
    const out = applySourceTextExpressionResult(spec, result({
      text: 'hello',
      ranges: [
        { start: 0, count: 2, style: { fontSize: 100 } },
        { start: 0, count: 5, style: { tracking: 100 } },
        { start: 3, count: 2, style: { textTransform: 'uppercase' } },
      ],
    }));
    expect(out.text).toBe('helLO');
    expect(out.runs).toEqual([
      { start: 0, end: 2, style: { fontSize: 100, letterSpacing: 10 } },
      { start: 2, end: 5, style: { letterSpacing: 4 } },
    ]);
  });

  it('ranges index grapheme clusters, not code units', () => {
    const out = applySourceTextExpressionResult(spec, result({
      text: '👍🏽ab',
      ranges: [{ start: 1, count: 1, style: { fill: '#ff0000' } }],
    }));
    expect(out.runs).toEqual([{ start: 1, end: 2, style: { fill: '#ff0000' } }]);
  });

  it('names the range overrides the renderer cannot draw per character', () => {
    expect(unsupportedRangeKeys(result({
      text: 'x',
      ranges: [{ start: 0, count: 1, style: { fontSize: 3 } }, { start: 0, count: 1, style: { baselineShift: 2, strokeWidth: 1 } }],
    }))).toEqual(['baselineShift', 'strokeWidth']);
    expect(unsupportedRangeKeys(null)).toEqual([]);
  });
});
