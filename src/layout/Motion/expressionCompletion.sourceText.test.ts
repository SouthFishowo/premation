/**
 * Autocomplete for Source Text: `text.sourceText` members, the style object's
 * getters and setters, and setters CHAINED after a call — the shape every AE 25
 * text-style expression takes (`…style.setFontSize(80).setFillColor(…)`).
 */

import { EXPRESSION_API } from '@motion/animation';
import { applyCompletion, completionsAt } from './expressionCompletion';

const labels = (text: string): string[] => completionsAt(text, text.length, EXPRESSION_API, 50).items.map((i) => i.label);

describe('Source Text completions', () => {
  test('`text` is discoverable at the top level', () => {
    expect(labels('tex')).toContain('text.sourceText');
  });

  test('members of text, text.sourceText and its style', () => {
    expect(labels('text.so')).toEqual(['text.sourceText', 'text.sourceText.style']);
    expect(labels('text.sourceText.st')).toContain('text.sourceText.style');
    expect(labels('text.sourceText.getS')).toContain('text.sourceText.getStyleAt()');
    const style = labels('text.sourceText.style.setF');
    expect(style).toEqual(expect.arrayContaining([
      'text.sourceText.style.setFont()', 'text.sourceText.style.setFontSize()',
      'text.sourceText.style.setFillColor()', 'text.sourceText.style.setFauxBold()', 'text.sourceText.style.setFauxItalic()',
      'text.sourceText.style.setFirstLineIndent()',
    ]));
    expect(labels('thisLayer.text.sourceText.style.font')).toContain('thisLayer.text.sourceText.style.fontSize');
    expect(labels('value.style.setJ')).toEqual(['value.style.setJustification()']);
  });

  test('a setter CHAINED after a call offers style members, and accepting keeps the chain', () => {
    const src = 'text.sourceText.style.setFontSize(80).setFi';
    const { items } = completionsAt(src, src.length);
    expect(items[0]?.label).toBe('setFillColor()');
    const out = applyCompletion(src, src.length, items[0]!);
    expect(out.text).toBe('text.sourceText.style.setFontSize(80).setFillColor([1, 0, 0])');
  });

  test('a chain that never touched a style does not get style members', () => {
    const src = 'wiggle(2, 3).setFi';
    expect(completionsAt(src, src.length).items.map((i) => i.label)).not.toContain('setFillColor()');
  });
});
