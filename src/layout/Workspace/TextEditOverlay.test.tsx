/**
 * TextEditOverlay — on-canvas text editing.
 *
 * The bug: text was edited via `window.prompt`, which Electron's Chromium
 * refuses — so double-clicking a text layer did NOTHING in the desktop build
 * the product ships as. These tests exercise the replacement in a real render.
 */

import { render, act, fireEvent } from '@testing-library/react';
import { TextEditOverlay, insideKeepZone } from './TextEditOverlay';
import { ColorPicker } from '@components/ColorPicker';
import { useTextEditStore } from '@stores/textEditStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';


// The overlay only needs a placement to position itself; the scene graph is real.
jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    getNodeScreenPlacement: () => ({ x: 400, y: 300, zoom: 1, rotationDeg: 0, scaleX: 1, scaleY: 1 }),
    requestRender: () => {},
  }),
}));

function textNode(id: string, content: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { __kind: 'text', x: 400, y: 300, fontSize: 48, align: 'center', color: '#00ff88' } },
      { id: `${id}_txt`, type: 'Text', props: { content } },
    ],
  } as unknown as SceneNode;
}

function contentOf(id: string): string {
  return defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props.content as string;
}

beforeEach(() => {
  for (const id of ['t1']) { try { defaultSceneGraph.removeNode(id); } catch { /* ignore */ } }
  defaultSceneGraph.addNode(textNode('t1', 'Hello'));
  useTextEditStore.getState().end();
});

describe('TextEditOverlay', () => {
  it('renders nothing until a text layer is being edited', () => {
    const { container, queryByRole } = render(<TextEditOverlay />);
    expect(queryByRole('textbox')).toBeNull();
    expect(container.querySelector('[contenteditable]')).toBeNull();
  });

  it('opens an editable box seeded with the layer text — not a window.prompt', () => {
    const promptSpy = jest.spyOn(window, 'prompt');
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));

    const box = getByRole('textbox');
    expect(box.getAttribute('contenteditable')).toBe('true');
    expect(box.textContent).toBe('Hello');
    // The whole point: no prompt — that's what Electron refuses.
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('matches the layer style (colour, alignment)', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox') as HTMLElement;
    expect(box.style.textAlign).toBe('center');
    expect(box.style.color).toContain('0, 255, 136'); // #00ff88 (browsers normalise to rgb)
    expect(box.style.fontSize).toBe('48px');
  });

  it('commits on Ctrl+Enter and closes', () => {
    const { getByRole, queryByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));

    const box = getByRole('textbox');
    box.innerText = 'Goodbye';
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    });

    expect(contentOf('t1')).toBe('Goodbye');
    expect(useTextEditStore.getState().nodeId).toBeNull();
    expect(queryByRole('textbox')).toBeNull();
  });

  it('emits NodeUpdated so the history snapshot records the edit', () => {
    // Text content is a plain node prop, so undo rides the same scene-snapshot
    // path as every canvas edit — driven by this event (wired in Providers).
    const events: unknown[] = [];
    const sub = getEventBus().on('NodeUpdated', (e) => events.push(e));

    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');
    box.innerText = 'Recorded';
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));

    sub.dispose();
    expect(contentOf('t1')).toBe('Recorded');
    expect(events).toContainEqual(
      expect.objectContaining({ nodeId: 't1', propName: 'content', value: 'Recorded' }),
    );
  });

  it('commits on Escape — After Effects keeps the edits', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');
    box.innerText = 'Kept';
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    expect(contentOf('t1')).toBe('Kept');
    expect(useTextEditStore.getState().nodeId).toBeNull();
  });

  it('discards edits only on the explicit Shift+Escape', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');
    box.innerText = 'Should not stick';
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true })));

    expect(contentOf('t1')).toBe('Hello');
    expect(useTextEditStore.getState().nodeId).toBeNull();
  });

  it('commits on the numeric keypad Enter', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');
    box.innerText = 'Keypad';
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'NumpadEnter', bubbles: true, cancelable: true })));

    expect(contentOf('t1')).toBe('Keypad');
    expect(useTextEditStore.getState().nodeId).toBeNull();
  });

  it('keeps editing when focus moves into the Character panel, and commits on an outside click', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');

    // Created AFTER the lookup: the panel's input is a textbox too.
    const panel = document.createElement('div');
    panel.setAttribute('data-text-edit-keep', '');
    const field = document.createElement('input');
    panel.appendChild(field);
    document.body.appendChild(panel);
    try {
      box.innerText = 'Styled';
      act(() => box.dispatchEvent(new FocusEvent('blur', { relatedTarget: field })));
      act(() => box.dispatchEvent(new FocusEvent('focusout', { relatedTarget: field, bubbles: true })));
      expect(useTextEditStore.getState().nodeId).toBe('t1');

      act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(contentOf('t1')).toBe('Styled');
      expect(useTextEditStore.getState().nodeId).toBeNull();
    } finally {
      panel.remove();
    }
  });

  it('Enter does not commit — it is a newline, like After Effects', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));

    expect(useTextEditStore.getState().nodeId).toBe('t1');
    expect(contentOf('t1')).toBe('Hello');
  });

  it('keeps editing through clicks inside a PORTALLED popover opened from the panel (colour picker)', () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    render(<TextEditOverlay />);
    // The Character panel is a keep zone; the picker lives inside it.
    const panel = render(
      <div data-text-edit-keep="">
        <ColorPicker value="#ff0000" onChange={() => {}} />
      </div>,
    );
    act(() => useTextEditStore.getState().begin('t1'));
    const trigger = panel.getByRole('button', { name: /pick a color/i });
    act(() => {
      fireEvent.pointerDown(trigger);
      fireEvent.click(trigger);
    });
    expect(useTextEditStore.getState().nodeId).toBe('t1');

    const content = document.querySelector('[role="dialog"]');
    expect(content).not.toBeNull();
    // Really portalled out of the panel — the case the attribute exists for.
    expect(panel.container.contains(content)).toBe(false);
    const inner = content!.querySelector('input') ?? content!;
    act(() => {
      inner.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(useTextEditStore.getState().nodeId).toBe('t1');

    // A genuine outside click still commits.
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(useTextEditStore.getState().nodeId).toBeNull();
  });

  it('treats a text node inside a keep zone (font picker list row) as inside', () => {
    const pop = document.createElement('div');
    pop.setAttribute('data-text-edit-keep', '');
    const label = document.createTextNode('Inter');
    pop.appendChild(label);
    document.body.appendChild(pop);
    try {
      expect(insideKeepZone(label)).toBe(true);
      expect(insideKeepZone(document.body)).toBe(false);
    } finally {
      pop.remove();
    }
  });

  it('a fixed paragraph box clips, aligns like the painter, and flags overflow live', () => {
    const put = (props: Record<string, unknown>) => {
      try { defaultSceneGraph.removeNode('t1'); } catch { /* ignore */ }
      const n = textNode('t1', 'Hi');
      Object.assign(n.components[1]!.props, { fontSize: 20, lineHeight: 1.2, fontFamily: 'Arial', boxWidth: 300, boxAutoSize: 'off', ...props });
      defaultSceneGraph.addNode(n);
    };
    // Centred in a 300px box: the 24px line block starts 138px down, as drawn.
    put({ boxHeight: 300, boxVerticalAlign: 'center' });
    const { getByRole, unmount } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    let box = getByRole('textbox') as HTMLElement;
    expect(box.style.overflow).toBe('hidden');
    expect(parseFloat(box.style.paddingTop)).toBeCloseTo(138, 3);
    expect(box.getAttribute('data-overflow')).toBeNull();
    act(() => useTextEditStore.getState().end());
    unmount();

    // Bottom-aligned but overflowing: yields to top, and typing a line that
    // does not fit raises the overflow flag before anything is committed.
    put({ boxHeight: 30, boxVerticalAlign: 'bottom' });
    const again = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    box = again.getByRole('textbox') as HTMLElement;
    expect(parseFloat(box.style.paddingTop || '0')).toBeCloseTo(6, 3);
    act(() => {
      box.innerText = 'Hi\nthere';
      fireEvent.input(box);
    });
    expect(box.getAttribute('data-overflow')).toBe('true');
    expect(parseFloat(box.style.paddingTop || '0')).toBe(0);
    expect(contentOf('t1')).toBe('Hi');
  });

  it('Shift+Enter does not commit (newline in multi-line text)', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })));

    // Still open — Shift+Enter is a newline, not a commit.
    expect(useTextEditStore.getState().nodeId).toBe('t1');
  });
});
