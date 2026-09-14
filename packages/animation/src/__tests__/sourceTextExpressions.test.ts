/**
 * Source Text in expressions — `text.sourceText`, the AE 25 style API, and
 * expressions ON the Source Text property.
 *
 * Two layers under test: the evaluator (a context with a `sourceTextAt`
 * provider, no engine) and the engine (provider binding, cross-layer reads,
 * cycles, and that a Source Text expression never leaks into the numeric
 * sampler).
 */

import { compileExpression, type ExprContext } from '../expressions';
import { AnimationEngine } from '../AnimationEngine';
import {
  MAX_RANGE_OVERRIDES,
  SOURCE_TEXT_PROP,
  resolveSourceTextStyle,
  type SourceTextSample,
  type SourceTextStyle,
} from '../sourceText';

const STYLE: SourceTextStyle = {
  fontFamily: 'Inter', fontSize: 48, fontWeight: '400', fontStyle: 'normal',
  fill: '#ffffff', stroke: '#000000', strokeWidth: 0,
  letterSpacing: 4.8, lineHeight: 1.25, baselineShift: 0,
  horizontalScale: 100, verticalScale: 100, textTransform: 'none', fontVariant: 'normal',
  align: 'left', paragraphSpacing: 6, firstLineIndent: 0, leftIndent: 0, rightIndent: 0, spaceBefore: 0,
};
const sample = (text: string, extra: Partial<SourceTextSample> = {}): SourceTextSample => ({ text, style: STYLE, ...extra });

const layers: Record<string, SourceTextSample> = {
  self: sample('Hello'),
  Title: sample('Big Title', { runs: [{ start: 0, end: 3, style: { fontSize: 96, fill: '#ff0000' } }] }),
};
const ctx: ExprContext = {
  time: 0,
  value: 0,
  sourceTextAt: (name) => (name === null ? layers.self : layers[name]),
};

function num(src: string, c: ExprContext = ctx): number {
  const r = compileExpression(src).run(c);
  if (r.error) throw new Error(`${src} → ${r.error}`);
  return r.value as number;
}
function text(src: string, c: ExprContext = { ...ctx, textValue: layers.self }) {
  const r = compileExpression(src).runText(c);
  if (r.error) throw new Error(`${src} → ${r.error}`);
  return r.result!;
}

describe('text.sourceText reads like a string', () => {
  it('length, concatenation and string methods', () => {
    expect(num('text.sourceText.length')).toBe(5);
    expect(text('text.sourceText + " world"').text).toBe('Hello world');
    expect(text('text.sourceText.toUpperCase()').text).toBe('HELLO');
    expect(num('text.sourceText.split("l").length')).toBe(3);
    expect(num('text.sourceText == "Hello" ? 1 : 0')).toBe(1);
  });

  it('thisLayer.text and a cross-layer thisComp.layer(name).text', () => {
    expect(num('thisLayer.text.sourceText.length')).toBe(5);
    expect(text('thisComp.layer("Title").text.sourceText').text).toBe('Big Title');
  });

  it('a missing layer or a non-text layer is a STATED error, not an empty string', () => {
    const r = compileExpression('thisComp.layer("Nope").text.sourceText + ""').runText(ctx);
    expect(r.result).toBeNull();
    expect(r.error).toMatch(/no text layer named “Nope”/);
    const none = compileExpression('text.sourceText.length').run({ time: 0, value: 0 });
    expect(none.error).toMatch(/no Source Text/);
  });

  it('the prototype chain stays unreachable through the String object', () => {
    for (const src of ['text.sourceText.constructor', 'text.sourceText["__proto__"]', 'text.sourceText.style["con" + "structor"]']) {
      expect(compileExpression(src).runText(ctx).error).toMatch(/isn’t allowed/);
    }
  });
});

describe('style getters (AE units)', () => {
  it('reads the layer-wide style', () => {
    expect(num('text.sourceText.style.fontSize')).toBe(48);
    expect(num('text.sourceText.style.tracking')).toBeCloseTo(100); // 4.8px at 48px = 100/1000 em
    expect(num('text.sourceText.style.leading')).toBeCloseTo(60);
    expect(num('text.sourceText.style.fillColor[0]')).toBe(1);
    expect(num('text.sourceText.style.horizontalScaling')).toBe(1);
    expect(num('text.sourceText.style.isFauxBold ? 1 : 0')).toBe(0);
    expect(num('text.sourceText.style.applyStroke ? 1 : 0')).toBe(0);
    expect(text('text.sourceText.style.font').text).toBe('Inter');
    expect(text('text.sourceText.style.justification').text).toBe('alignLeft');
    expect(num('text.sourceText.style.spaceAfter')).toBe(6);
  });

  it('getStyleAt(i) sees the stored runs at that character', () => {
    expect(num('thisComp.layer("Title").text.sourceText.getStyleAt(1).fontSize')).toBe(96);
    expect(num('thisComp.layer("Title").text.sourceText.getStyleAt(5).fontSize')).toBe(48);
    expect(num('thisComp.layer("Title").text.sourceText.getStyleAt(0).fillColor[1]')).toBe(0);
  });

  it('getters reflect earlier setters in the chain', () => {
    expect(num('text.sourceText.style.setFontSize(100).fontSize')).toBe(100);
    expect(num('text.sourceText.style.setFauxBold(true).isFauxBold ? 1 : 0')).toBe(1);
    // Tracking is em-relative: 100/1000 em at the NEW size.
    expect(num('text.sourceText.style.setFontSize(96).setTracking(100).tracking')).toBeCloseTo(100);
  });
});

describe('style setters → SourceTextExpressionResult', () => {
  it('chainable layer-wide overrides; text stays the source text', () => {
    const r = text('text.sourceText.style.setFontSize(80).setFillColor([1, 0, 0]).setFont("Roboto").setStrokeWidth(2).setStrokeColor([0, 0, 1])');
    expect(r.text).toBe('Hello');
    expect(r.style).toEqual({ fontSize: 80, fill: '#ff0000', fontFamily: 'Roboto', strokeWidth: 2, stroke: '#0000ff' });
    expect(r.ranges).toEqual([]);
  });

  it('setters never mutate: the original style object is unchanged', () => {
    expect(num('text.sourceText.style.setFontSize(10) ? text.sourceText.style.fontSize : 0')).toBe(48);
  });

  it('faux bold / italic, caps, baseline shift, scaling, tracking, leading', () => {
    const r = text('value.style.setFauxBold(true).setFauxItalic(true).setAllCaps(true).setSmallCaps(true).setBaselineShift(4).setHorizontalScaling(1.5).setVerticalScaling(0.5).setTracking(50).setLeading(72)');
    expect(r.style).toEqual({
      fontWeight: '700', fontStyle: 'italic', textTransform: 'uppercase', fontVariant: 'small-caps',
      baselineShift: 4, horizontalScale: 150, verticalScale: 50, tracking: 50, leading: 72,
    });
  });

  it('per-character ranges: setX(value, startIndex, numChars)', () => {
    const r = text('value.style.setFontSize(20, 1, 3).setFillColor([0, 1, 0], 0, 2).setFauxBold(true, 4)');
    expect(r.ranges).toEqual([
      { start: 1, count: 3, style: { fontSize: 20 } },
      { start: 0, count: 2, style: { fill: '#00ff00' } },
      // numChars omitted → to the end of the text.
      { start: 4, count: 1, style: { fontWeight: '700' } },
    ]);
    expect(r.style).toEqual({});
  });

  it('paragraph setters (AE 25) and their getters', () => {
    const r = text('value.style.setJustification("alignCenter").setFirstLineIndent(10).setLeftMargin(5).setRightMargin(6).setSpaceBefore(3).setSpaceAfter(9).setDirection("dirRightToLeft").setLeadingType("leadingEastAsian")');
    expect(r.style).toEqual({
      align: 'center', firstLineIndent: 10, leftIndent: 5, rightIndent: 6,
      spaceBefore: 3, spaceAfter: 9, direction: 'rtl', leadingType: 'eastAsian',
    });
    expect(text('value.style.setJustification("justifyLastLineFull").justification').text).toBe('justifyLastLineLeft');
    expect(text('value.style.setDirection("dirRightToLeft").direction').text).toBe('dirRightToLeft');
    expect(num('text.sourceText.style.setLeftMargin(12).leftMargin')).toBe(12);
    // A paragraph setter takes no character range.
    expect(compileExpression('value.style.setJustification("alignCenter", 0, 2)').runText({ ...ctx, textValue: layers.self }).error)
      .toMatch(/paragraph-wide/);
  });

  it('returning ANOTHER layer’s style copies its whole style onto this text (AE idiom)', () => {
    const r = text('thisComp.layer("Title").text.sourceText.style.setFontSize(64)');
    expect(r.text).toBe('Hello');
    expect(r.style.fontSize).toBe(64);
    expect(r.style.fontFamily).toBe('Inter');
    expect(r.style.tracking).toBeCloseTo(100);
    // Its own style object carries only what the chain set.
    expect(text('value.style.setFontSize(64)').style).toEqual({ fontSize: 64 });
  });

  it('setText replaces the text the style applies to', () => {
    const r = text('value.style.setText("Bye").setFontSize(30, 0, 1)');
    expect(r.text).toBe('Bye');
    expect(r.ranges).toEqual([{ start: 0, count: 1, style: { fontSize: 30 } }]);
  });

  it('numbers and booleans display as text; value is the pre-expression text', () => {
    expect(text('Math.round(time * 10) + 7').text).toBe('7');
    expect(text('value + "!"').text).toBe('Hello!');
    expect(text('thisProperty.value.length > 3').text).toBe('true');
  });

  it('bad arguments are stated errors', () => {
    const c = { ...ctx, textValue: layers.self };
    expect(compileExpression('value.style.setFontSize("big")').runText(c).error).toMatch(/setFontSize\(\) needs a number/);
    expect(compileExpression('value.style.setFillColor(3)').runText(c).error).toMatch(/needs a colour/);
    expect(compileExpression('value.style.setJustification("middle")').runText(c).error).toMatch(/setJustification/);
    expect(compileExpression('null').runText(c).error).toMatch(/must return text/);
  });

  it('range overrides are capped (budget)', () => {
    let src = 'value.style';
    for (let i = 0; i <= MAX_RANGE_OVERRIDES; i++) src += `.setFontSize(10, ${i}, 1)`;
    expect(compileExpression(src).runText({ ...ctx, textValue: layers.self }).error).toMatch(/Too many per-character/);
  });
});

describe('resolveSourceTextStyle — the one unit conversion', () => {
  it('tracking and leading convert at the FINAL size; applyFill/applyStroke switch off paint', () => {
    const s = resolveSourceTextStyle({ ...STYLE, strokeWidth: 3 }, { fontSize: 100, tracking: 50, leading: 120, applyFill: false, applyStroke: false });
    expect(s.letterSpacing).toBe(5);
    expect(s.lineHeight).toBeCloseTo(1.2);
    expect(s.fill).toBe('transparent');
    expect(s.strokeWidth).toBe(0);
  });
  it('spaceBefore adds to spaceAfter as the paragraph gap', () => {
    expect(resolveSourceTextStyle(STYLE, { spaceBefore: 4 }).paragraphSpacing).toBe(10);
    expect(resolveSourceTextStyle(STYLE, { spaceAfter: 2, spaceBefore: 4 }).paragraphSpacing).toBe(6);
  });
});

describe('the engine', () => {
  const make = (): AnimationEngine => {
    const eng = new AnimationEngine();
    const ids: Record<string, string> = { Title: 'a', Sub: 'b' };
    const texts: Record<string, SourceTextSample> = { a: sample('Hello'), b: sample('World') };
    eng.setLayerResolver((name) => ids[name] ?? null);
    eng.setSourceTextProvider((id) => texts[id]);
    return eng;
  };

  it('evaluateSourceText is null without an enabled expression', () => {
    const eng = make();
    expect(eng.hasSourceTextProvider()).toBe(true);
    expect(eng.evaluateSourceText('a', 0)).toBeNull();
    eng.setExpression('a', SOURCE_TEXT_PROP, 'value + "!"');
    expect(eng.evaluateSourceText('a', 0)?.text).toBe('Hello!');
    eng.setExpressionEnabled('a', SOURCE_TEXT_PROP, false);
    expect(eng.evaluateSourceText('a', 0)).toBeNull();
  });

  it('cross-layer reads see the OTHER layer’s post-expression text', () => {
    const eng = make();
    eng.setExpression('a', SOURCE_TEXT_PROP, 'value.style.setText("Hi").setFontSize(10)');
    eng.setExpression('b', SOURCE_TEXT_PROP, 'thisComp.layer("Title").text.sourceText + " " + value');
    expect(eng.evaluateSourceText('b', 0)?.text).toBe('Hi World');
    // …including its style.
    eng.setExpression('b', SOURCE_TEXT_PROP, 'thisComp.layer("Title").text.sourceText.style.fontSize');
    expect(eng.evaluateSourceText('b', 0)?.text).toBe('10');
  });

  it('a text cycle falls back to the un-expressed text instead of recursing', () => {
    const eng = make();
    eng.setExpression('a', SOURCE_TEXT_PROP, 'thisComp.layer("Sub").text.sourceText');
    eng.setExpression('b', SOURCE_TEXT_PROP, 'thisComp.layer("Title").text.sourceText');
    expect(eng.evaluateSourceText('a', 0)).toBeNull();
    const preview = eng.previewSourceTextExpression('b', 'thisComp.layer("Title").text.sourceText', 0);
    expect(preview.error).toMatch(/Cycle detected/);
  });

  it('a numeric property can read text; a Source Text expression never enters the numeric sampler', () => {
    const eng = make();
    eng.setExpression('a', 'x', 'text.sourceText.length * 10');
    expect(eng.sample('a', 'x', 0)).toBe(50);
    eng.setExpression('a', SOURCE_TEXT_PROP, '"a much longer string"');
    expect(eng.sample('a', 'x', 0)).toBe(200);
    expect(eng.sample('a', SOURCE_TEXT_PROP, 0)).toBeUndefined();
    expect(eng.evaluateNode('a', 0).has(SOURCE_TEXT_PROP)).toBe(false);
  });

  it('the preview reports errors the way playback resolves them', () => {
    const eng = make();
    expect(eng.previewSourceTextExpression('a', 'value.style.setFontSize(', 0).error).toBeTruthy();
    expect(eng.previewSourceTextExpression('zzz', 'value', 0).error).toMatch(/no Source Text/);
    expect(eng.previewSourceTextExpression('a', 'value.style.setFontSize(12)', 0).result?.style.fontSize).toBe(12);
  });
});
