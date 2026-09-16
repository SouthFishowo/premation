/**
 * The Project panel's composition list shows the composition that is open.
 *
 * The bug: the list filtered out every `pristine` comp, and the comp a fresh
 * project boots with — "Main Comp", open in the tab strip and the timeline — is
 * pristine. So beside a timeline titled "Main Comp" the list read "None yet —
 * create one to start".
 */

import { listedCompositions } from './CompositionList';
import type { CompositionSettings, TabInfo } from '@stores/projectStore';

const comp = (id: string, extra: Partial<CompositionSettings> = {}): CompositionSettings => ({
  id, name: id, width: 1920, height: 1080, fps: 30, durationSeconds: 10,
  background: '#000000', transparent: false, startFrame: 0, ...extra,
} as CompositionSettings);

const tab = (id: string, compositionId: string): TabInfo => ({
  id, compositionId, breadcrumbPath: [compositionId], time: 0, frame: 0, playing: false, title: compositionId, dirty: false,
} as TabInfo);

const allReal = (): boolean => true;

describe('listedCompositions', () => {
  it('lists the pristine comp an open tab points at', () => {
    const comps = { comp_root: comp('comp_root', { name: 'Main Comp', pristine: true }) };
    const tabs = { t1: tab('t1', 'comp_root') };
    expect(listedCompositions(comps, tabs, allReal).map((c) => c.name)).toEqual(['Main Comp']);
  });

  it('still hides a pristine placeholder nothing has open', () => {
    const comps = {
      comp_root: comp('comp_root', { pristine: true }),
      c2: comp('c2'),
    };
    const tabs = { t2: tab('t2', 'c2') };
    expect(listedCompositions(comps, tabs, allReal).map((c) => c.id)).toEqual(['c2']);
  });

  it('lists a user comp whether or not it is open', () => {
    const comps = { c2: comp('c2'), c3: comp('c3') };
    expect(listedCompositions(comps, {}, allReal).map((c) => c.id)).toEqual(['c2', 'c3']);
  });

  it('never lists a group opened in its own tab', () => {
    const comps = { c2: comp('c2'), group_1: comp('group_1') };
    const tabs = { t: tab('t', 'group_1') };
    expect(listedCompositions(comps, tabs, (id) => id !== 'group_1').map((c) => c.id)).toEqual(['c2']);
  });
});
