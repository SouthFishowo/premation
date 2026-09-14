/**
 * The new text options reach the timeline and the stopwatch seam:
 *
 *   • rows exist (before anything is keyed) for Path Options, variable-font
 *     axes, Grouping Alignment, and an animator's ADDED optional properties
 *     and Font Axis properties — and not for properties it has not added;
 *   • every such row's path reads its static value and writes it back through
 *     `propertyValue` (what a stopwatch keys, what the value field edits);
 *   • labels resolve to readable names rather than the raw-path fallback.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { buildStaticPropertyTree } from '@core/timeline/propertyTree';
import {
  readStaticPropertyValue,
  writeStaticPropertyValue,
  canWriteStaticPropertyValue,
} from '@core/inspector/propertyValue';
import { propertyLabel, hasPropertyMeta } from '@core/inspector/propertyMeta';
import {
  addTextAnimator,
  addAnimatorProperties,
  addAnimatorAxis,
  removeAnimatorProperty,
  readAnimatorData,
  ALL_TRANSFORM_OPTIONAL,
} from './textAnimators';
import { setTextPath, readTextPathConfig, defaultTextPath } from './textPath';
import { readFontAxesProp, MAX_ANIMATED_AXES } from './fontAxes';

function textNode(id: string, textProps: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0 } },
      { id: `${id}_c`, type: 'Text', props: { content: 'Hi', fontSize: 32, opacity: 100, ...textProps } },
    ],
  };
}

const props = (nodeId: string): string[] => buildStaticPropertyTree(nodeId).map((r) => r.prop);

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultAnimation.clear();
});

describe('Path Options rows', () => {
  it('appear only once the layer rides a path, one per option, all keyframeable', () => {
    defaultSceneGraph.addNode(textNode('t'));
    expect(props('t').filter((p) => p.startsWith('textPath.'))).toEqual([]);
    setTextPath('t', defaultTextPath());
    const rows = buildStaticPropertyTree('t').filter((r) => r.prop.startsWith('textPath.'));
    expect(rows.map((r) => r.prop)).toEqual([
      'textPath.firstMargin', 'textPath.lastMargin', 'textPath.reversed', 'textPath.perpendicular', 'textPath.forceAlignment',
    ]);
    expect(rows.every((r) => r.members.length === 1 && r.group === 'text')).toBe(true);
    expect(rows.map((r) => r.label)).toContain('Path Options Force Alignment');
  });

  it('read and write through the static seam (switches as 0/1)', () => {
    defaultSceneGraph.addNode(textNode('t'));
    setTextPath('t', { ...defaultTextPath(), firstMargin: 6 });
    expect(readStaticPropertyValue('t', 'textPath.firstMargin')).toBe(6);
    expect(readStaticPropertyValue('t', 'textPath.perpendicular')).toBe(1);
    expect(writeStaticPropertyValue('t', 'textPath.lastMargin', -14)).toBe(true);
    expect(writeStaticPropertyValue('t', 'textPath.forceAlignment', 1)).toBe(true);
    expect(writeStaticPropertyValue('t', 'textPath.reversed', 0.2)).toBe(true);
    const cfg = readTextPathConfig(defaultSceneGraph.getNode('t')!)!;
    expect({ last: cfg.lastMargin, force: cfg.forceAlignment, rev: cfg.reversed }).toEqual({ last: -14, force: true, rev: false });
  });

  it('a layer with no path has nowhere to write one', () => {
    defaultSceneGraph.addNode(textNode('t'));
    expect(canWriteStaticPropertyValue('t', 'textPath.lastMargin')).toBe(false);
  });
});

describe('variable-font axis rows', () => {
  it('list every stored non-legacy axis as text.axis.<tag>, readable and writable', () => {
    defaultSceneGraph.addNode(textNode('t', { fontAxes: { GRAD: 25, opsz: 18 } }));
    expect(props('t')).toEqual(expect.arrayContaining(['text.axis.GRAD', 'text.axis.opsz']));
    expect(propertyLabel('text.axis.GRAD')).toBe('Font Axis GRAD');
    expect(readStaticPropertyValue('t', 'text.axis.GRAD')).toBe(25);
    expect(writeStaticPropertyValue('t', 'text.axis.GRAD', -40)).toBe(true);
    expect(readFontAxesProp(defaultSceneGraph.getNode('t')!)).toEqual({ GRAD: -40, opsz: 18 });
  });
});

describe('animator optional properties', () => {
  it('get rows only once added; All Transform Properties adds anchor + skew axis', () => {
    defaultSceneGraph.addNode(textNode('t'));
    addTextAnimator('t');
    expect(props('t')).not.toContain('ta.0.anchorX');
    addAnimatorProperties('t', 0, ALL_TRANSFORM_OPTIONAL);
    expect(props('t')).toEqual(expect.arrayContaining(['ta.0.anchorX', 'ta.0.anchorY', 'ta.0.skewAxis']));
    // Anchor Z is a 3D-only row.
    expect(props('t')).not.toContain('ta.0.anchorZ');
    expect(propertyLabel('ta.0.skewAxis', 't')).toBe('Animator 1 Skew Axis');
    removeAnimatorProperty('t', 0, 'skewAxis');
    expect(props('t')).not.toContain('ta.0.skewAxis');
  });

  it('Grouping Alignment rows appear with the first animator and are registered', () => {
    defaultSceneGraph.addNode(textNode('t'));
    expect(props('t')).not.toContain('groupingAlignX');
    addTextAnimator('t');
    expect(props('t')).toEqual(expect.arrayContaining(['groupingAlignX', 'groupingAlignY']));
    expect(hasPropertyMeta('groupingAlignY')).toBe(true);
  });

  it('Font Axis properties: rows, labels, static read/write, and the per-layer limit of eight', () => {
    defaultSceneGraph.addNode(textNode('t'));
    addTextAnimator('t');
    expect(addAnimatorAxis('t', 0, 'wdth')).toBe(true);
    expect(props('t')).toContain('ta.0.axiswdth');
    expect(propertyLabel('ta.0.axiswdth', 't')).toBe('Animator 1 Font Axis wdth');
    expect(writeStaticPropertyValue('t', 'ta.0.axiswdth', -30)).toBe(true);
    expect(readStaticPropertyValue('t', 'ta.0.axiswdth')).toBe(-30);
    expect(readAnimatorData(defaultSceneGraph.getNode('t')!)[0]!.axes).toEqual({ wdth: -30 });

    const tags = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF', 'GGGG'];
    for (const tag of tags) expect(addAnimatorAxis('t', 0, tag)).toBe(true);
    expect(Object.keys(readAnimatorData(defaultSceneGraph.getNode('t')!)[0]!.axes ?? {})).toHaveLength(MAX_ANIMATED_AXES);
    expect(addAnimatorAxis('t', 0, 'HHHH')).toBe(false);
    // Re-adding an axis already in use is not a new one.
    expect(addAnimatorAxis('t', 0, 'wdth')).toBe(true);
  });
});
