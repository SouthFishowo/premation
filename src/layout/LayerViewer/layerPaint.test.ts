/**
 * The Layer panel's paint samples. The stroke rules (eraser always erasing,
 * clone aiming, Duration…) moved to `core/paint/paintCommit`, tested there.
 */

import { appendPoint } from './layerPaint';

describe('Layer panel paint samples', () => {
  it('drops sub-pixel jitter', () => {
    expect(appendPoint([{ x: 0, y: 0 }], { x: 0.2, y: 0.1 })).toHaveLength(1);
    expect(appendPoint([{ x: 0, y: 0 }], { x: 3, y: 0 })).toHaveLength(2);
  });
});
