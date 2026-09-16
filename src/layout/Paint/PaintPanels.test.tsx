/**
 * The Paint and Brushes panels drive the same stores the viewers read, and
 * every document edit they make is one undo step.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { drawToolOptions } from '@motion/workspace';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { addPaintStroke, getNodePaint } from '@core/paint/paintStrokes';
import { useSelectionStore } from '@stores/selectionStore';
import { usePaintStore } from '@stores/paintStore';
import { useUIStore } from '@stores/uiStore';
import type { SceneNode } from '@core/types';
import { PaintPanel } from './PaintPanel';
import { BrushesPanel } from './BrushesPanel';

const ID = 'paint_panel_layer';
const initial = usePaintStore.getState();

beforeAll(() => {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services: services as never, getState: () => ({}) }));
});

beforeEach(() => {
  defaultSceneGraph.clear();
  defaultAnimation.clear();
  usePaintStore.setState(initial, true);
  useSelectionStore.getState().set([]);
  useUIStore.getState().setActiveTool('paint');
});

describe('PaintPanel', () => {
  test('the tool switch picks Clone Stamp and shows Clone Options', () => {
    render(<PaintPanel />);
    expect(screen.getByText('Select one layer to see its paint.')).toBeTruthy();
    expect(screen.queryByText('Clone Options')).toBeNull();
    fireEvent.click(screen.getByText('Clone'));
    expect(usePaintStore.getState().mode).toBe('clone');
    expect(useUIStore.getState().activeTool).toBe('paint');
    expect(screen.getByText('Clone Options')).toBeTruthy();
    fireEvent.click(screen.getByText('Eraser'));
    expect(useUIStore.getState().activeTool).toBe('eraser');
    expect(screen.getByLabelText('Erase')).toBeTruthy();
  });

  test('lists the selected layer\'s strokes; hide, select and delete them', () => {
    defaultSceneGraph.addNode({
      id: ID, name: 'Plate', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: `${ID}_fx`, type: 'fx', props: {} }],
    } as unknown as SceneNode);
    const b = addPaintStroke(ID, { points: [{ x: 0, y: 0 }] });
    addPaintStroke(ID, { points: [{ x: 1, y: 1 }], mode: 'erase' });
    act(() => useSelectionStore.getState().set([ID]));
    render(<PaintPanel />);
    expect(screen.getByText('Brush 1')).toBeTruthy();
    expect(screen.getByText('Eraser 1')).toBeTruthy();

    fireEvent.click(screen.getAllByLabelText('Hide stroke')[0]!);
    expect(getNodePaint(ID)!.strokes[0]!.visible).toBe(false);

    fireEvent.click(screen.getByText('Brush 1'));
    expect(usePaintStore.getState().selectedStroke).toEqual({ nodeId: ID, strokeId: b });

    fireEvent.click(screen.getAllByLabelText('Delete stroke')[1]!);
    expect(getNodePaint(ID)!.strokes.map((s) => s.id)).toEqual([b]);
  });
});

describe('BrushesPanel', () => {
  test('a tip preset sets Diameter, Hardness and Spacing; dynamics bind to the pen', () => {
    render(<BrushesPanel />);
    fireEvent.click(screen.getByTitle(/^Soft 13 /));
    expect(drawToolOptions.brushSize).toBe(13);
    expect(usePaintStore.getState().hardness).toBe(0);
    expect(usePaintStore.getState().spacing).toBe(0.25);
    fireEvent.change(screen.getByLabelText('Size dynamics'), { target: { value: 'pressure' } });
    expect(usePaintStore.getState().dynamics.size).toBe('pressure');
  });
});
