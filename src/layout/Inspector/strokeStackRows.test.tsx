/**
 * Strokes 2+ are full citizens in the Stroke panel.
 *
 * Before 2026-09-15 a second stroke got a width field and a colour swatch —
 * while the model carried cap, join, dashes, taper, wave and a gradient for it
 * that no control could reach, and its width could not be keyframed at all.
 *
 * The observable is the rendered controls, read back through `aria-label`, and
 * the stored stack / engine tracks they write. Two strokes with different
 * values, so a write landing on the wrong index is visible.
 */

import { render, cleanup, fireEvent } from '@testing-library/react';
import { AppearanceSection } from './AppearanceSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getNodeStrokes, setNodeStrokes, defaultStroke } from '@core/paint/stroke';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';

const ID = 'stroke_stack_rows';

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.clear();
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode({
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${ID}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 200, height: 120 } },
      { id: `${ID}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode);
  setNodeStrokes(ID, [
    { ...defaultStroke('#ff0000'), width: 8 },
    { ...defaultStroke('#00ff00'), width: 3 },
  ]);
  useSelectionStore.setState({ ids: [ID] } as never);
});
afterEach(cleanup);

const labels = (c: HTMLElement): string[] =>
  [...c.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') ?? '');

describe('stroke 2 offers the whole AE Stroke group', () => {
  it('composite, blend, align, cap, join, dashes and paint — the controls it never had', () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const found = labels(container);
    for (const want of [
      'Stroke 2 composite', 'Stroke 2 blend mode', 'Stroke 2 align', 'Stroke 2 cap', 'Stroke 2 join',
      'Add dash or gap to stroke 2', 'Stroke 2 paint type', 'Remove stroke 2',
    ]) {
      expect({ want, found: found.includes(want) }).toEqual({ want, found: true });
    }
  });

  it('its blend mode writes stroke 2 and leaves stroke 1 alone', () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const select = container.querySelector('[aria-label="Stroke 2 blend mode"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'screen' } });
    expect(getNodeStrokes(ID).map((s) => s.blendMode)).toEqual([undefined, 'screen']);
  });

  it('"+" adds a Dash, then a Gap; "−" removes the last', () => {
    const { container, rerender } = render(<AppearanceSection nodeId={ID} />);
    const click = (label: string): void => {
      fireEvent.click(container.querySelector(`[aria-label="${label}"]`) as HTMLElement);
      rerender(<AppearanceSection nodeId={ID} />);
    };
    click('Add dash or gap to stroke 2');
    expect(getNodeStrokes(ID)[1]!.dash).toEqual([10]);
    click('Add dash or gap to stroke 2');
    expect(getNodeStrokes(ID)[1]!.dash).toEqual([10, 10]);
    click('Remove last dash or gap from stroke 2');
    expect(getNodeStrokes(ID)[1]!.dash).toEqual([10]);
    // Stroke 1's pattern never moved.
    expect(getNodeStrokes(ID)[0]!.dash).toEqual([]);
  });

  it('its Width stopwatch keys stroke 2’s own track, not the primary’s', () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const toggles = [...container.querySelectorAll('[aria-label="Enable Width animation"]')] as HTMLElement[];
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(toggles[1]!);
    expect(defaultAnimation.isAnimated(ID, 'stroke.1.width')).toBe(true);
    expect(defaultAnimation.isAnimated(ID, 'strokeWidth')).toBe(false);
  });

  it('Remove stroke 2 removes it', () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    fireEvent.click(container.querySelector('[aria-label="Remove stroke 2"]') as HTMLElement);
    expect(getNodeStrokes(ID)).toHaveLength(1);
  });
});
