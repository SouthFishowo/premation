/**
 * AE's UU: a property is "modified" when it is animated, expression-driven, or
 * set away from its default — not only when it has keyframes.
 */

import { POSITION_PSEUDO_PROP } from '@motion/animation';
import { groupPlaceholderPath } from '@core/inspector/propertyMeta';
import { modifiedRowIds, transformDefault } from './modifiedProps';

const centre = { x: 960, y: 540 };
const atDefaults = { x: 960, y: 540, anchorX: 0, anchorY: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 100 };

describe('modifiedRowIds', () => {
  it('a layer at its birth defaults has nothing modified', () => {
    expect(modifiedRowIds({ values: atDefaults, animated: new Set(), centre })).toEqual([]);
  });

  it('an un-keyed 50 % scale IS modified (the case U cannot show)', () => {
    const rows = modifiedRowIds({ values: { ...atDefaults, scaleX: 0.5, scaleY: 0.5 }, animated: new Set(), centre });
    expect(rows).toEqual(expect.arrayContaining([groupPlaceholderPath('scale'), 'scaleX', 'scaleY']));
    expect(rows).not.toContain(groupPlaceholderPath('position'));
  });

  it('a moved layer reveals every spelling of the Position row', () => {
    const rows = modifiedRowIds({ values: { ...atDefaults, x: 100 }, animated: new Set(), centre });
    expect(rows).toEqual(expect.arrayContaining([groupPlaceholderPath('position'), POSITION_PSEUDO_PROP, 'x', 'y']));
  });

  it('animated or expressed props count even when their static value is the default', () => {
    const rows = modifiedRowIds({
      values: atDefaults,
      animated: new Set(['rotation', 'effect.fx1.radius']),
      centre,
    });
    expect(rows).toEqual(expect.arrayContaining([groupPlaceholderPath('rotation'), 'rotation', 'effect.fx1.radius']));
    expect(rows).not.toContain(groupPlaceholderPath('opacity'));
  });

  it('an unset prop is its default, and opacity defaults to 100 %', () => {
    expect(modifiedRowIds({ values: {}, animated: new Set(), centre })).toEqual([]);
    const faded = modifiedRowIds({ values: { opacity: 40 }, animated: new Set(), centre });
    expect(faded).toContain(groupPlaceholderPath('opacity'));
  });

  it('defaults follow the centred-origin convention', () => {
    expect(transformDefault('x', centre)).toBe(960);
    expect(transformDefault('scaleY', centre)).toBe(1);
    expect(transformDefault('anchorX', centre)).toBe(0);
    expect(transformDefault('opacity', centre)).toBe(100);
  });
});
