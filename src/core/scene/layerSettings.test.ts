/**
 * Layer / Solid Settings (AE Ctrl+Shift+Y; Layer ▸ New ▸ Solid).
 */

import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertSolid } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeFill } from '@core/paint/fill';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import {
  applyLayerSettings,
  createSolidLayer,
  layerSettingsKind,
  readLayerSettings,
  sanitizeLayerSize,
} from './layerSettings';

beforeAll(() => {
  // runDocumentEdit records through the command system's history — boot a
  // minimal one, the same way the AI transaction tests do.
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) } as unknown as ConstructorParameters<typeof CommandSystem>[0]));
  seedDefaultScene();
});

function sizeOf(id: string): { w: unknown; h: unknown } {
  const t = defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!;
  return { w: t.props.width, h: t.props.height };
}

describe('Solid Settings', () => {
  it('reads a solid as a solid, with its size and colour', () => {
    insertSolid('#112233');
    const id = useSelectionStore.getState().ids[0]!;
    const read = readLayerSettings(id)!;
    expect(read.kind).toBe('solid');
    expect(read.values.color).toBe('#112233');
    expect(typeof read.values.width).toBe('number');
  });

  it('applies name, size, colour and label colour — as ONE undo step', () => {
    insertSolid();
    const id = useSelectionStore.getState().ids[0]!;
    const history = getCommandSystem().getHistory();
    const before = history.getEntries().length;
    applyLayerSettings(id, { name: 'Backdrop', width: 640, height: 360, color: '#ff0000', labelColor: '#5282b8' });
    const node = defaultSceneGraph.getNode(id)!;
    expect(node.name).toBe('Backdrop');
    expect(sizeOf(id)).toEqual({ w: 640, h: 360 });
    const fill = readNodeFill(node);
    expect(fill && fill.type === 'solid' ? fill.color : null).toBe('#ff0000');
    expect(node.color).toBe('#5282b8');
    expect(history.getEntries().length - before).toBe(1);
  });

  it('New Solid creates the configured solid and selects it', () => {
    const id = createSolidLayer({ name: 'Matte', width: 100, height: 50, color: '#00ff00' })!;
    expect(id).toBeTruthy();
    expect(useSelectionStore.getState().ids).toEqual([id]);
    const node = defaultSceneGraph.getNode(id)!;
    expect(node.name).toBe('Matte');
    expect(layerSettingsKind(node)).toBe('solid');
    expect(sizeOf(id)).toEqual({ w: 100, h: 50 });
  });

  it('clamps and rounds a typed size into AE’s range', () => {
    expect(sanitizeLayerSize(0)).toBe(1);
    expect(sanitizeLayerSize(99999)).toBe(30000);
    expect(sanitizeLayerSize(12.6)).toBe(13);
    expect(sanitizeLayerSize(Number('abc'))).toBeNull();
  });
});
