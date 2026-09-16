import { useUIStore } from '@stores/uiStore';
import { usePaintStore } from '@stores/paintStore';
import { drawToolOptions } from '@motion/workspace';
import { currentPaintTool, cyclePaintTool, handlePaintKey } from './paintTool';

const key = (over: Partial<KeyboardEvent> = {}): Parameters<typeof handlePaintKey>[0] => ({
  key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, ...over,
});

beforeEach(() => {
  useUIStore.getState().setActiveTool('paint');
  usePaintStore.getState().set({ mode: 'paint' });
});

test('Ctrl+B cycles Brush → Clone Stamp → Eraser → Brush', () => {
  expect(currentPaintTool()).toBe('brush');
  cyclePaintTool();
  expect(currentPaintTool()).toBe('clone');
  expect(handlePaintKey(key({ key: 'b', code: 'KeyB', ctrlKey: true }))).toBe(true);
  expect(currentPaintTool()).toBe('eraser');
  expect(useUIStore.getState().activeTool).toBe('eraser');
  cyclePaintTool();
  expect(currentPaintTool()).toBe('brush');
});

test('X swaps and D resets the colours', () => {
  drawToolOptions.brushColor = '#ff0000';
  usePaintStore.getState().set({ backgroundColor: '#00ff00' });
  expect(handlePaintKey(key({ key: 'x', code: 'KeyX' }))).toBe(true);
  expect(drawToolOptions.brushColor).toBe('#00ff00');
  expect(usePaintStore.getState().backgroundColor).toBe('#ff0000');
  handlePaintKey(key({ key: 'd', code: 'KeyD' }));
  expect([drawToolOptions.brushColor, usePaintStore.getState().backgroundColor]).toEqual(['#000000', '#ffffff']);
});

test('3–7 pick clone presets only while cloning; nothing fires outside paint tools', () => {
  expect(handlePaintKey(key({ key: '5', code: 'Digit5' }))).toBe(false);
  usePaintStore.getState().set({ mode: 'clone' });
  usePaintStore.getState().set({ cloneTimeShift: 2 }); // edits preset 1
  expect(handlePaintKey(key({ key: '5', code: 'Digit5' }))).toBe(true);
  expect(usePaintStore.getState().activeClonePreset).toBe(2);
  expect(usePaintStore.getState().cloneTimeShift).toBe(0);
  handlePaintKey(key({ key: '3', code: 'Digit3' }));
  expect(usePaintStore.getState().cloneTimeShift).toBe(2);

  useUIStore.getState().setActiveTool('select');
  expect(handlePaintKey(key({ key: 'x', code: 'KeyX' }))).toBe(false);
  expect(handlePaintKey(key({ key: 'b', code: 'KeyB', ctrlKey: true }))).toBe(false);
});

test('typing in a field is never a paint key', () => {
  const input = document.createElement('input');
  expect(handlePaintKey(key({ key: 'x', code: 'KeyX', target: input }))).toBe(false);
});
