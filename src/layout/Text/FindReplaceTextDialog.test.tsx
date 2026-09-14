/**
 * Find and Replace Text — live count, Replace All across content, runs and
 * Source Text keyframes, one undo.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { defaultAnimation, SOURCE_TEXT_PROP } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { readRuns } from '@core/text/richText';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';
import { FindReplaceTextBody } from './FindReplaceTextDialog';
import { countInScope } from '@core/textTools/textFindReplace';

function textLayer(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0 } },
      { id: `${id}_c`, type: 'Text', props },
    ],
  } as unknown as SceneNode;
}

const content = (id: string): unknown =>
  (defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>).content;

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  getCommandSystem().getHistory().clear();
  useSelectionStore.getState().set([]);
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', textLayer('t1', {
    content: 'red cat, blue cat',
    __runs: [{ start: 9, end: 13, style: { fill: '#0000ff' } }],
    __runsIndex: 'grapheme',
  }) as never);
  defaultSceneGraph.addChild('comp_root', textLayer('t2', { content: 'Concatenate' }) as never);
  defaultAnimation.setDataKeyframe('t2', SOURCE_TEXT_PROP, 'text', 0, 'one cat');
  defaultAnimation.setDataKeyframe('t2', SOURCE_TEXT_PROP, 'text', 1, 'two cats');
});

afterEach(cleanup);

describe('scope counting', () => {
  it('counts content and Source Text keyframes; whole word and selection scope narrow it', () => {
    expect(countInScope('all', 'cat', {})).toEqual({ matches: 5, layers: 2 });
    expect(countInScope('all', 'cat', { wholeWord: true })).toEqual({ matches: 3, layers: 2 });
    useSelectionStore.getState().set(['t1']);
    expect(countInScope('selected', 'cat', {})).toEqual({ matches: 2, layers: 1 });
  });
});

describe('FindReplaceTextBody', () => {
  it('shows a live count and Replace All rewrites content, runs and keyframes in one undo', async () => {
    render(<FindReplaceTextBody close={() => {}} initialScope="all" />);
    const replaceAll = screen.getByRole('button', { name: 'Replace All' });
    expect(replaceAll).toBeDisabled();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'cat' } });
      fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: 'tiger' } });
      fireEvent.click(screen.getByLabelText('Whole word'));
    });
    expect(screen.getByRole('status').textContent).toBe('3 matches in 2 layers');

    await act(async () => { fireEvent.click(replaceAll); });
    expect(screen.getByRole('status').textContent).toBe('Replaced 3 matches in 2 layers.');
    expect(content('t1')).toBe('red tiger, blue tiger');
    expect(content('t2')).toBe('Concatenate'); // not a whole word
    // "blue" stays styled: 9..13 → 11..15 after the first "cat" grew by 2.
    expect(readRuns(defaultSceneGraph.getNode('t1')!)).toEqual([{ start: 11, end: 15, style: { fill: '#0000ff' } }]);
    expect(defaultAnimation.getDataTrack('t2', SOURCE_TEXT_PROP)!.keyframes.map((k) => k.value)).toEqual(['one tiger', 'two cats']);

    getCommandSystem().undo();
    expect(content('t1')).toBe('red cat, blue cat');
    expect(defaultAnimation.getDataTrack('t2', SOURCE_TEXT_PROP)!.keyframes.map((k) => k.value)).toEqual(['one cat', 'two cats']);
  });

  it('Match case narrows the count', async () => {
    render(<FindReplaceTextBody close={() => {}} initialScope="all" />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'CAT' } });
    });
    expect(screen.getByRole('status').textContent).toBe('5 matches in 2 layers');
    await act(async () => { fireEvent.click(screen.getByLabelText('Match case')); });
    expect(screen.getByRole('status').textContent).toBe('No matches.');
    expect(screen.getByRole('button', { name: 'Replace All' })).toBeDisabled();
  });
});
