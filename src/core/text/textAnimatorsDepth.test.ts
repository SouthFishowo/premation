/**
 * The animator properties AE has beyond the original set: Anchor Point, Skew
 * Axis, Line Anchor, Character Value / Range, Fill & Stroke HSB, Stroke
 * Opacity, Tracking Type and Font Axis — their per-glyph maths, and the promise
 * that an animator WITHOUT them evaluates to exactly the glyph list it always
 * did (the cache key is built from that list).
 */

import {
  evaluateTextAnimators,
  offsetCharacterFull,
  characterFromValue,
  normalizeAnimator,
  defaultRangeSelector,
  animatorAxisPropPath,
  axisTagOfParam,
  OPTIONAL_ANIMATOR_PROPERTIES,
  ANIMATOR_PARAMS,
  type ResolvedAnimator,
} from './textAnimators';
import { adjustHsb } from './cssColor';

function anim(patch: Partial<ResolvedAnimator> = {}): ResolvedAnimator {
  return {
    enabled: true,
    selectors: [{ ...defaultRangeSelector(), smoothness: 0 }],
    x: 0, y: 0, z: 0, scale: 100, scaleY: 100, rotation: 0, rotationX: 0, rotationY: 0,
    opacity: 100, fillOpacity: 100, tracking: 0, lineSpacing: 0, characterOffset: 0,
    blur: 0, skew: 0, strokeWidth: 0,
    ...patch,
  };
}

/** A selector covering only the first half of the string. */
const firstHalf = { ...defaultRangeSelector(), smoothness: 0, end: 50 };

describe('backward compatibility', () => {
  it('an animator with no optional properties adds no fields to any glyph', () => {
    const g = evaluateTextAnimators('Hey', [anim({ y: -10, tracking: 3 })]);
    for (const t of g) {
      expect(Object.keys(t).sort()).toEqual(
        ['blur', 'char', 'displayChar', 'dx', 'dy', 'fillOpacity', 'lineSpacing', 'opacity', 'rotation', 'scale', 'scaleY', 'skew', 'strokeWidth', 'tracking'].sort(),
      );
    }
  });

  it('every optional property is a keyframeable animator param', () => {
    for (const o of OPTIONAL_ANIMATOR_PROPERTIES) expect(ANIMATOR_PARAMS).toContain(o.param);
  });

  it('normalizing leaves absent optional properties absent', () => {
    const n = normalizeAnimator({ id: 'a', x: 0, y: 0, scale: 100, rotation: 0, opacity: 100, tracking: 0 });
    expect(n.anchorX).toBeUndefined();
    expect(n.axes).toBeUndefined();
  });
});

describe('Anchor Point / Skew Axis', () => {
  it('scale anchor and skew axis by the selector amount, per axis', () => {
    const g = evaluateTextAnimators('ab', [anim({ selectors: [firstHalf], anchorX: 10, anchorY: -6, skewAxis: 30 })]);
    expect(g[0]).toMatchObject({ anchorX: 10, anchorY: -6, skewAxis: 30 });
    expect(g[1]!.anchorX).toBeUndefined();
  });

  it('stacked animators add their anchors', () => {
    const g = evaluateTextAnimators('a', [anim({ anchorX: 4 }), anim({ anchorX: 6 })]);
    expect(g[0]!.anchorX).toBe(10);
  });
});

describe('Line Anchor + Tracking Type', () => {
  it('Line Anchor applies to every glyph whatever the selector says (it is a line property)', () => {
    const g = evaluateTextAnimators('ab', [anim({ selectors: [firstHalf], tracking: 8, lineAnchor: 50 })]);
    expect(g.map((t) => t.lineAnchor)).toEqual([0.5, 0.5]);
    expect(g.map((t) => t.tracking)).toEqual([8, 0]);
  });

  it('Before puts all of the tracking in front, Before & After half, After none', () => {
    const before = evaluateTextAnimators('a', [anim({ tracking: 10, trackingType: 'before' })])[0]!;
    const both = evaluateTextAnimators('a', [anim({ tracking: 10, trackingType: 'beforeAfter' })])[0]!;
    const after = evaluateTextAnimators('a', [anim({ tracking: 10, trackingType: 'after' })])[0]!;
    expect([before.trackingBefore, both.trackingBefore, after.trackingBefore]).toEqual([10, 5, undefined]);
    // The advance grows by the full amount in every case.
    expect([before.tracking, both.tracking, after.tracking]).toEqual([10, 10, 10]);
  });
});

describe('Character Value / Character Range', () => {
  it('Character Value replaces affected characters with the code point', () => {
    const g = evaluateTextAnimators('abcd', [anim({ selectors: [firstHalf], characterValue: 0x2a })]);
    expect(g.map((t) => t.displayChar)).toEqual(['*', '*', 'c', 'd']);
  });

  it('Character Offset walks from the replaced value', () => {
    const g = evaluateTextAnimators('a', [anim({ characterValue: 65, characterOffset: 2 })]);
    expect(g[0]!.displayChar).toBe('C');
  });

  it('Full Unicode walks past the alphabet where Preserve Case & Digits wraps', () => {
    expect(evaluateTextAnimators('Z', [anim({ characterOffset: 1 })])[0]!.displayChar).toBe('A');
    expect(evaluateTextAnimators('Z', [anim({ characterOffset: 1, characterRange: 'full' })])[0]!.displayChar).toBe('[');
    expect(evaluateTextAnimators('!', [anim({ characterOffset: 1, characterRange: 'full' })])[0]!.displayChar).toBe('"');
  });

  it('Full Unicode steps over surrogates and clamps to printable space', () => {
    expect(offsetCharacterFull('퟿', 1).codePointAt(0)).toBe(0xe000);
    expect(offsetCharacterFull(' ', -5)).toBe(' ');
    expect(characterFromValue(0xd800)).toBeNull();
    expect(characterFromValue(0x1f600)).toBe('😀');
  });
});

describe('Fill / Stroke HSB and Stroke Opacity', () => {
  it('HSB offsets accumulate weighted; stroke opacity multiplies like opacity', () => {
    const g = evaluateTextAnimators('ab', [
      anim({ selectors: [firstHalf], fillHue: 120, fillBrightness: -20, strokeOpacity: 50, strokeSaturation: 10 }),
    ]);
    expect(g[0]).toMatchObject({ fillHue: 120, fillBrightness: -20, strokeOpacity: 0.5, strokeSaturation: 10 });
    expect(g[1]!.strokeOpacity).toBeUndefined();
  });

  it('adjustHsb rotates hue and offsets saturation / brightness in HSV', () => {
    expect(adjustHsb('#ff0000', 120, 0, 0)).toBe('#00ff00');
    expect(adjustHsb('#ff0000', 0, -100, 0)).toBe('#ffffff');
    expect(adjustHsb('#ff0000', 0, 0, -50)).toBe('#800000');
    // Alpha survives.
    expect(adjustHsb('rgba(255, 0, 0, 0.5)', 240, 0, 0)).toBe('rgba(0, 0, 255, 0.5)');
    // No-op and unparseable inputs come back untouched.
    expect(adjustHsb('#123456', 0, 0, 0)).toBe('#123456');
    expect(adjustHsb('nope', 30, 0, 0)).toBe('nope');
  });
});

describe('Font Axis', () => {
  it('per-glyph axis offsets scale by the selector amount and add across animators', () => {
    const g = evaluateTextAnimators('ab', [
      anim({ selectors: [firstHalf], axes: { wdth: -20, GRAD: 50 } }),
      anim({ axes: { wdth: -10 } }),
    ]);
    expect(g[0]!.axes).toEqual({ wdth: -30, GRAD: 50 });
    expect(g[1]!.axes).toEqual({ wdth: -10 });
  });

  it('axis prop paths round-trip through the param grammar', () => {
    const path = animatorAxisPropPath(2, 'GRAD');
    expect(path).toBe('ta.2.axisGRAD');
    expect(axisTagOfParam(path.split('.')[2]!)).toBe('GRAD');
    expect(axisTagOfParam('axisTOOLONG')).toBeNull();
  });
});
