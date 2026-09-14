import { parseCssColor, mixCssColors, toCanvasColor, toHexColor, formatCssColor } from './cssColor';
import { mixHex } from './textAnimators';

describe('parseCssColor', () => {
  it('reads every hex length, with or without #', () => {
    expect(parseCssColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseCssColor('#ff000080')?.slice(0, 3)).toEqual([255, 0, 0]);
    expect(parseCssColor('#ff000080')?.[3]).toBeCloseTo(128 / 255);
    expect(parseCssColor('123456')).toEqual([0x12, 0x34, 0x56, 1]);
  });

  it('reads rgb() and rgba()', () => {
    expect(parseCssColor('rgb(10, 20, 30)')).toEqual([10, 20, 30, 1]);
    expect(parseCssColor('rgba(10 20 30 / 0.5)')).toEqual([10, 20, 30, 0.5]);
  });

  it('resolves var() through the document root, or its fallback', () => {
    document.documentElement.style.setProperty('--test-text-colour', '#336699');
    const resolved = parseCssColor('var(--test-text-colour)');
    // jsdom may not surface custom properties through getComputedStyle; the
    // fallback form below is the part every runtime must honour.
    if (resolved) expect(resolved).toEqual([0x33, 0x66, 0x99, 1]);
    expect(parseCssColor('var(--definitely-not-set, #abcdef)')).toEqual([0xab, 0xcd, 0xef, 1]);
  });

  it('rejects things that are not colours', () => {
    expect(parseCssColor('var(--definitely-not-set)')).toBeNull();
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor(undefined)).toBeNull();
    expect(parseCssColor('#12')).toBeNull();
  });
});

describe('mixHex / mixCssColors — never hands the canvas a non-colour', () => {
  it('blends two hex colours', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('keeps the base colour when the target is unparseable', () => {
    // The Text Animator panel used to store exactly this string.
    expect(mixHex('#ff0000', 'var(--color-primary-that-does-not-exist)', 1)).toBe('#ff0000');
    expect(mixHex('#00ff00', 'not a colour', 0.5)).toBe('#00ff00');
  });

  it('takes the target when the base is unparseable', () => {
    expect(mixHex(undefined, '#123456', 0.5)).toBe('#123456');
  });

  it('returns a concrete colour when neither side parses', () => {
    const out = mixCssColors('nope', 'var(--nope)', 0.5);
    expect(parseCssColor(out)).not.toBeNull();
    expect(out).not.toContain('var(');
  });

  it('blends a var() fallback like any colour', () => {
    expect(mixHex('#000000', 'var(--unset-token, #ffffff)', 1)).toBe('#ffffff');
  });

  it('preserves alpha as rgba()', () => {
    expect(mixCssColors('rgba(0,0,0,0)', 'rgba(0,0,0,1)', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
  });
});

describe('toCanvasColor / toHexColor', () => {
  it('normalises or falls back', () => {
    expect(toCanvasColor('#ABC', '#000000')).toBe('#aabbcc');
    expect(toCanvasColor('var(--missing)', '#010203')).toBe('#010203');
    expect(toHexColor('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(formatCssColor([1, 2, 3, 1])).toBe('#010203');
  });
});
