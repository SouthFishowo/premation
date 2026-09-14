/**
 * Swap Fill and Stroke (Shift+X) — the shortcut the Character panel advertised
 * long before it existed.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';

// The swap is one undo entry via runDocumentEdit, which needs a booted
// CommandSystem (the app does this at startup).
beforeAll(() => {
  const services: any = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
});
import {
  buildTextCommands,
  isTypingInField,
  selectedTextLayerIds,
  swapTextFillStroke,
  TEXT_SWAP_FILL_STROKE_COMMAND,
} from './textCommands';

function textNode(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { __kind: 'text', x: 0, y: 0 } },
      { id: `${id}_txt`, type: 'Text', props: { content: 'Hi', ...props } },
    ],
  } as unknown as SceneNode;
}

const textProps = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>;

beforeEach(() => {
  try { defaultSceneGraph.removeNode('sw1'); } catch { /* ignore */ }
  defaultSceneGraph.addNode(textNode('sw1', { fill: '#ff0000', stroke: '#00ff00', noFill: true }));
  useSelectionStore.setState({ ids: [] });
});

describe('text.swapFillStroke', () => {
  const command = buildTextCommands().find((c) => c.id === TEXT_SWAP_FILL_STROKE_COMMAND)!;

  it('is bound to Shift+X', () => {
    expect(command).toBeDefined();
    expect(command.shortcut).toEqual({ key: 'x', shift: true });
  });

  it('is enabled only with a text layer selected and nothing being typed into', () => {
    expect(command.enabled?.()).toBe(false);
    useSelectionStore.setState({ ids: ['sw1'] });
    expect(selectedTextLayerIds()).toEqual(['sw1']);
    expect(command.enabled?.()).toBe(true);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      expect(isTypingInField()).toBe(true);
      expect(command.enabled?.()).toBe(false);
    } finally {
      input.remove();
    }
  });

  it('swaps the colours and the none swatches, and gives a strokeless layer a visible stroke', () => {
    expect(swapTextFillStroke(['sw1'])).toBe(true);
    const p = textProps('sw1');
    expect(p.fill).toBe('#00ff00');
    expect(p.stroke).toBe('#ff0000');
    expect(p.noFill).toBe(false);
    expect(p.noStroke).toBe(true);
    expect(p.strokeWidth).toBe(2);
  });

  it('does nothing for non-text ids', () => {
    expect(swapTextFillStroke(['nope'])).toBe(false);
  });
});
