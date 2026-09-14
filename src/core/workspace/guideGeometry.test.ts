/**
 * AE 26.5 guides: unit (px / %), pin edge (start / end), colour — geometry,
 * resize behaviour, engine edits and the document round-trip.
 */

import { Guides } from '@motion/workspace';
import { useGuidesStore } from '@stores/guidesStore';
import {
  guidePositionFromValue,
  guideValueFromPosition,
  resolveGuideOnResize,
  sanitizeStoredGuides,
  toStoredGuide,
} from './guideGeometry';

const HD = { w: 1920, h: 1080 };
const UHD = { w: 3840, h: 2160 };

describe('guide geometry', () => {
  it('px/start is the plain world coordinate', () => {
    expect(guideValueFromPosition(300, 'x', 'px', 'start', HD)).toBe(300);
    expect(guidePositionFromValue(300, 'x', 'px', 'start', HD)).toBe(300);
  });

  it('% measures a fraction of the axis the guide sits on', () => {
    expect(guideValueFromPosition(960, 'x', '%', 'start', HD)).toBe(50);
    expect(guidePositionFromValue(25, 'y', '%', 'start', HD)).toBe(270);
  });

  it('end measures from the right / bottom edge', () => {
    expect(guideValueFromPosition(1820, 'x', 'px', 'end', HD)).toBe(100);
    expect(guidePositionFromValue(100, 'y', 'px', 'end', HD)).toBe(980);
  });

  it('a px guide pinned to the END keeps its distance from that edge on resize', () => {
    expect(resolveGuideOnResize(1820, 'x', 'px', 'end', HD, UHD)).toBe(3740);
  });

  it('a % guide keeps its fraction on resize; px/start never moves', () => {
    expect(resolveGuideOnResize(960, 'x', '%', 'start', HD, UHD)).toBe(1920);
    expect(resolveGuideOnResize(960, 'x', 'px', 'start', HD, UHD)).toBe(960);
  });
});

describe('document form', () => {
  it('round-trips through the guides store settings with every field', () => {
    const stored = [
      toStoredGuide({ axis: 'x', position: 1820, unit: 'px', edge: 'end', color: '#e5484d' }, HD),
      toStoredGuide({ axis: 'y', position: 540, unit: '%', locked: true }, HD),
    ];
    useGuidesStore.getState().setUserGuides(stored);
    const doc = JSON.parse(JSON.stringify(useGuidesStore.getState().settings()));
    useGuidesStore.getState().setUserGuides([]);
    useGuidesStore.getState().restore(doc);
    expect(useGuidesStore.getState().userGuides).toEqual([
      { axis: 'x', value: 100, unit: 'px', edge: 'end', color: '#e5484d' },
      { axis: 'y', value: 50, unit: '%', edge: 'start', locked: true },
    ]);
  });

  it('a document without userGuides restores none and writes none', () => {
    useGuidesStore.getState().setUserGuides([{ axis: 'x', value: 1, unit: 'px', edge: 'start' }]);
    useGuidesStore.getState().restore({});
    expect(useGuidesStore.getState().userGuides).toEqual([]);
    expect('userGuides' in useGuidesStore.getState().settings()).toBe(false);
  });

  it('sanitizes untrusted input — missing fields default to px / start', () => {
    expect(
      sanitizeStoredGuides([
        { axis: 'x', value: 10 },
        { axis: 'y', position: 20, unit: 'furlong', edge: 'middle', color: 'javascript:alert(1)' },
        { axis: 'z', value: 1 },
        null,
        { axis: 'x', value: 'NaN' },
      ]),
    ).toEqual([
      { axis: 'x', value: 10, unit: 'px', edge: 'start' },
      { axis: 'y', value: 20, unit: 'px', edge: 'start' },
    ]);
  });
});

describe('engine Guides metadata', () => {
  it('update() edits position + metadata, even on a locked guide; clears with undefined', () => {
    const g = new Guides();
    const guide = g.add('x', 100);
    g.setLocked(guide.id, true);
    expect(g.move(guide.id, 5)).toBe(false); // drag lock still holds
    g.update(guide.id, { position: 200, unit: '%', edge: 'end', color: '#3e63dd' });
    expect(g.get(guide.id)).toMatchObject({ position: 200, unit: '%', edge: 'end', color: '#3e63dd' });
    g.update(guide.id, { unit: 'px', edge: 'start', color: undefined });
    const after = g.get(guide.id)!;
    expect(after.unit).toBeUndefined();
    expect(after.edge).toBeUndefined();
    expect(after.color).toBeUndefined();
  });

  it('replaceUserGuides swaps user guides and keeps derived ones', () => {
    const g = new Guides();
    g.add('x', 1);
    g.setFrame({ x: 0, y: 0, width: 100, height: 100 });
    g.replaceUserGuides([{ axis: 'y', position: 42, edge: 'end', color: '#46a758' }]);
    const users = g.list().filter((x) => x.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ axis: 'y', position: 42, edge: 'end', color: '#46a758' });
    expect(g.list().some((x) => x.kind === 'center')).toBe(true);
  });
});
