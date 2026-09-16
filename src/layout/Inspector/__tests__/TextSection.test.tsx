/**
 * The Properties panel's Text section is the Text panel's body in its section
 * layout — not a second copy. Pinned: the everyday controls are in view, the
 * rarer ones wait behind the disclosure, and an edit writes the layer.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { TextSection, hasTextSection } from '../TextSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const ID = 'text_section_probe';

function textNode(id: string, textProps: Record<string, unknown>): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0, width: 200, height: 60, opacity: 100 } },
      { id: `${id}_txt`, type: 'Text', props: textProps },
    ],
  } as unknown as SceneNode;
}

afterEach(() => {
  cleanup();
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  useSelectionStore.setState({ ids: [] } as never);
});

it('applies to text layers only', () => {
  expect(hasTextSection('no_such_node')).toBe(false);
  defaultSceneGraph.addNode(textNode(ID, { content: 'Hi' }));
  expect(hasTextSection(ID)).toBe(true);
});

it('shows the font size and the everyday controls for a text layer', () => {
  defaultSceneGraph.addNode(textNode(ID, { content: 'Hello', fontSize: 48, letterSpacing: 5, fill: '#ff0000' }));
  render(<TextSection nodeId={ID} />);

  expect(screen.getByLabelText('Font Size')).toHaveValue(48);
  expect(screen.getByLabelText('Tracking (Letter Spacing)')).toHaveValue(5);
  expect(screen.getByLabelText('Character Fill Color')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Center Align' })).toBeInTheDocument();
  // No panel chrome: the section host draws the title.
  expect(screen.queryByText('Default Preset')).toBeNull();
});

it('keeps the rarer options behind "More text options"', () => {
  defaultSceneGraph.addNode(textNode(ID, { content: 'Hello', paragraphSpacing: 7 }));
  render(<TextSection nodeId={ID} />);

  expect(screen.queryByLabelText('Paragraph Spacing')).toBeNull();
  const more = screen.getByRole('button', { name: 'More text options' });
  expect(more).toHaveAttribute('aria-expanded', 'false');

  fireEvent.click(more);

  expect(more).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText('Paragraph Spacing')).toHaveValue(7);
  expect(screen.getByRole('button', { name: 'Faux Bold' })).toBeInTheDocument();
});

it('writes a size edit to the layer', () => {
  defaultSceneGraph.addNode(textNode(ID, { content: 'Hello', fontSize: 48 }));
  render(<TextSection nodeId={ID} />);

  act(() => {
    fireEvent.change(screen.getByLabelText('Font Size'), { target: { value: '64' } });
  });

  const comp = defaultSceneGraph.getNode(ID)?.components.find((c) => c.type === 'Text');
  expect(comp?.props.fontSize).toBe(64);
});

it('renders nothing for a layer that is not text', () => {
  const { container } = render(<TextSection nodeId="no_such_node" />);
  expect(container.firstChild).toBeNull();
});
