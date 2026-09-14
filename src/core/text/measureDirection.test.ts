/**
 * Measurement for this wave: variable-axis alias faces, vertical type, and the
 * auto-height box that keeps its top edge — against a fake 2D context whose
 * widths depend on the family actually named in `ctx.font`.
 */

import type { SceneNode } from '@core/types';

const ALIAS_SCALE = 0.5;

class FakeCtx {
  font = '10px "Inter"';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  letterSpacing = '0px';
  measureText(text: string) {
    const m = /(\d+(?:\.\d+)?)px\s+"([^"]+)"/.exec(this.font);
    const size = m ? Number(m[1]) : 10;
    const family = m ? m[2]! : 'Inter';
    let w = 0;
    for (const ch of text) w += /[぀-鿿]/.test(ch) ? size : size * 0.55 * (family === 'AliasFam' ? ALIAS_SCALE : 1);
    return {
      width: w,
      actualBoundingBoxAscent: size * 0.5, actualBoundingBoxDescent: size * 0.2,
      actualBoundingBoxLeft: 0, actualBoundingBoxRight: w,
      fontBoundingBoxAscent: size * 0.6, fontBoundingBoxDescent: size * 0.3,
    };
  }
}

let aliasReady = false;
let aliasListener: (() => void) | null = null;
const variantCalls: Array<string | undefined> = [];

function loadMeasure(): typeof import('./measureText') {
  let mod!: typeof import('./measureText');
  jest.isolateModules(() => {
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function getContext() {
      return new FakeCtx() as unknown as CanvasRenderingContext2D;
    };
    jest.doMock('./fontFaceVariants', () => ({
      variantFamily: (_s: unknown, variation: string | undefined) => {
        variantCalls.push(variation);
        return aliasReady ? 'AliasFam' : null;
      },
      onFontVariantsChanged: (cb: () => void) => {
        aliasListener = cb;
        return () => {};
      },
    }));
    mod = require('./measureText') as typeof import('./measureText');
  });
  return mod;
}

const style = (over: Partial<import('./measureText').MeasuredTextStyle> = {}) => ({
  content: 'WIDTH',
  fontSize: 40,
  fontFamily: 'Inter',
  fontWeight: '400',
  fontStyle: 'normal',
  letterSpacing: 0,
  lineHeight: 1.2,
  paragraphSpacing: 0,
  ...over,
});

beforeEach(() => {
  aliasReady = false;
  aliasListener = null;
  variantCalls.length = 0;
});

describe('variable-axis layer measure', () => {
  it('measures with the registered alias face once it has loaded, and re-measures when it lands', () => {
    const M = loadMeasure();
    const s = style({ fontWidth: 75 });
    const before = M.measureTextSize(s)!;
    expect(variantCalls).toContain("'wght' 400, 'wdth' 75");
    // The alias arrives asynchronously: the listener the module registered
    // drops its caches, and the same call now measures the alias.
    aliasReady = true;
    expect(aliasListener).not.toBeNull();
    aliasListener!();
    const after = M.measureTextSize(s)!;
    expect(after.w).toBeLessThan(before.w);
    // 5 glyphs at the alias's width (55px, give or take float noise) + padding.
    expect(after.w - 24).toBeGreaterThanOrEqual(55);
    expect(after.w - 24).toBeLessThanOrEqual(56);
    expect(before.w - 24).toBeGreaterThanOrEqual(110);
  });

  it('a layer without axes never asks for an alias', () => {
    const M = loadMeasure();
    M.measureTextSize(style());
    expect(variantCalls).toEqual([]);
  });
});

describe('vertical type measure', () => {
  it('sizes the render box as columns (width = leading × columns, height = longest column)', () => {
    const M = loadMeasure();
    const s = style({ content: '日本語\n日', fontSize: 20, orientation: 'vertical' });
    expect(M.measureTextSize(s)).toEqual({ w: 48 + 24, h: 60 + 16 });
    const boxes = M.measureTextBoxes(s)!;
    expect(boxes.font.width).toBe(48);
    expect(boxes.font.height).toBe(60);
  });

  it('never wraps vertical box text into the content', () => {
    const M = loadMeasure();
    const s = style({ content: '日本語漢字', fontSize: 20, orientation: 'vertical', boxWidth: 100, boxHeight: 40 });
    expect(M.wrapText(s)).not.toContain('\n');
    const box = M.measureParagraphBox(s)!;
    expect(box.lineCount).toBe(3);
    expect(box.overflow).toBe(false);
    expect(M.measureParagraphBox({ ...s, boxWidth: 30 })!.overflow).toBe(true);
  });
});

describe('auto-height box keeps its top edge', () => {
  const node = (props: Record<string, unknown>): SceneNode => ({
    id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'c', type: 'Text', props: { fontSize: 20, fontFamily: 'Inter', lineHeight: 1.2, boxWidth: 300, ...props } }],
  }) as unknown as SceneNode;

  it('offsets the centred line block so the top stays at −authored height / 2', () => {
    const M = loadMeasure();
    for (const content of ['a', 'a\nb\nc', 'a\nb\nc\nd\ne']) {
      const s = M.readMeasuredTextStyle(node({ content, boxHeight: 40, boxAutoSize: 'height' }))!;
      expect(s.boxAnchorHeight).toBe(40);
      const box = M.measureParagraphBox(s)!;
      expect(box.fixedHeight).toBe(false);
      expect(-box.contentHeight / 2 + box.lineOffsetY).toBeCloseTo(-20, 9);
    }
  });

  it('grows the render texture by twice the offset; a box with no height is unchanged', () => {
    const M = loadMeasure();
    const content = 'a\nb\nc';
    const legacy = M.readMeasuredTextStyle(node({ content }))!;
    expect(legacy.boxAnchorHeight).toBeUndefined();
    expect(M.measureParagraphBox(legacy)!.lineOffsetY).toBe(0);
    const anchored = M.readMeasuredTextStyle(node({ content, boxHeight: 40, boxAutoSize: 'height' }))!;
    // 3 lines × 24px = 72px of content under a 40px authored box: 16px down.
    expect(M.measureParagraphBox(anchored)!.lineOffsetY).toBe(16);
    expect(M.measureTextSize(anchored)!.h - M.measureTextSize(legacy)!.h).toBe(32);
  });

  it('rides to the painter as textExtras.boxOffsetY, only for auto-height boxes', () => {
    const { textExtrasForNode } = require('./textExtras') as typeof import('./textExtras');
    expect(textExtrasForNode(node({ content: 'a', boxHeight: 40, boxAutoSize: 'height' }), undefined, { boxOffsetY: -8 }))
      .toEqual({ boxOffsetY: -8 });
    expect(textExtrasForNode(node({ content: 'a', boxHeight: 40, boxAutoSize: 'off' }), undefined, { boxOffsetY: -8 }))
      .toEqual({ boxHeight: 40 });
    expect(textExtrasForNode(node({ content: 'a' }), undefined, { boxOffsetY: 5 })).toBeUndefined();
  });
});
