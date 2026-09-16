/**
 * The component-thumbnail cache is bounded (LRU).
 *
 * Keys carry `createdAt`, so each re-save of a component used to add a new
 * data URL and keep the old one forever. The render path itself needs a GPU
 * and is exercised elsewhere; here the backend factory refuses, which the
 * thumbnail code already treats as "leave it uncached".
 */

jest.mock('./createRenderBackend', () => ({
  createRenderBackend: () => {
    throw new Error('no GPU in this test');
  },
}));

import { componentThumb, primeComponentThumb, componentThumbCacheSize, invalidateComponentThumb } from './componentThumbs';
import type { ComponentDef } from '@stores/componentStore';

const def = (i: number) => ({ id: `comp${i}`, createdAt: 1000 + i }) as unknown as ComponentDef;

describe('component thumbnail cache', () => {
  beforeEach(() => {
    for (let i = 0; i < 200; i++) invalidateComponentThumb(`comp${i}`);
  });

  it('holds at most 128 thumbnails, evicting the least recently used', () => {
    for (let i = 0; i < 128; i++) primeComponentThumb(def(i), `data:image/png;base64,${i}`);
    expect(componentThumbCacheSize()).toBe(128);
    // A hit refreshes recency: comp0 survives the next insert, comp1 does not.
    expect(componentThumb(def(0))).toBe('data:image/png;base64,0');
    primeComponentThumb(def(128), 'data:image/png;base64,128');
    expect(componentThumbCacheSize()).toBe(128);
    expect(componentThumb(def(0))).toBe('data:image/png;base64,0');
    expect(componentThumb(def(1))).toBeNull(); // evicted → miss (schedules a re-render)
  });

  it('invalidate still drops a component', () => {
    primeComponentThumb(def(5), 'data:x');
    invalidateComponentThumb('comp5');
    expect(componentThumb(def(5))).toBeNull();
  });
});
