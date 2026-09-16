/**
 * The Paint tool's commit rules — one undo step per stroke, and AE's stroke
 * semantics (Duration, Write On, Shift-continue, replace selected Path, erase
 * modes, clone aiming) decided in one place for both viewers.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { usePaintStore } from '@stores/paintStore';
import type { SceneNode } from '@core/types';
import { commitPaintDrag, type PaintDrag } from './paintCommit';
import { getNodePaint, toggleStrokePathAnimation } from './paintStrokes';
import { paintPathProp, paintPropPath } from './paintProps';

const ID = 'paint_commit_layer';
const OTHER = 'paint_commit_other';
const initial = usePaintStore.getState();

const makeNode = (id: string): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [{ id: `${id}_fx`, type: 'fx', props: {} }],
} as unknown as SceneNode);

const drag = (over: Partial<PaintDrag> = {}): PaintDrag => ({
  nodeId: ID,
  mode: 'paint',
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
  times: [0, 50, 100],
  pen: [null, null, null],
  size: 12,
  compTime: 1,
  ...over,
});

beforeAll(() => {
  // runDocumentEdit records on the command system's history — boot a bare one.
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
  defaultSceneGraph.addNode(makeNode(ID));
  defaultSceneGraph.addNode(makeNode(OTHER));
  usePaintStore.setState(initial, true);
});

const strokes = () => getNodePaint(ID)?.strokes ?? [];

test('a stroke is one undo step, a v2 dab brush living from the current time', () => {
  const history = getCommandSystem().getHistory();
  const depth = (): number => (history as unknown as { undoStack: unknown[] }).undoStack.length;
  const before = depth();
  const r = commitPaintDrag(drag());
  expect(r.ok).toBe(true);
  expect(depth()).toBe(before + 1);
  const s = strokes()[0]!;
  expect(s.spacing).toBe(0.25);
  expect(s.size).toBe(12);
  // Constant: from the layer time it was drawn at, to the layer's end.
  expect(s.inPoint).toBeCloseTo(getRemappedTime(ID, 1));
  expect(s.outPoint).toBeUndefined();
});

test('Single Frame and Write On', () => {
  usePaintStore.getState().set({ duration: 'single' });
  commitPaintDrag(drag());
  const s = strokes()[0]!;
  expect(s.outPoint! - s.inPoint!).toBeGreaterThan(0);
  usePaintStore.getState().set({ duration: 'writeOn' });
  const r = commitPaintDrag(drag());
  const id = (r as { strokeId: string }).strokeId;
  const keys = defaultAnimation.getTrackKeyframes(ID, paintPropPath(id, 'end')) ?? [];
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(keys[0]!.value).toBe(0);
  expect(keys[keys.length - 1]!.value).toBe(100);
});

test('pen pressure is recorded only when every sample came from a pen', () => {
  commitPaintDrag(drag({ pen: [{ pressure: 0.2, tiltX: 0, tiltY: 0 }, null, null] }));
  expect(strokes()[0]!.pressure).toBeUndefined();
  const p = { pressure: 0.7, tiltX: 5, tiltY: 0 };
  commitPaintDrag(drag({ pen: [p, p, p] }));
  expect(strokes()[1]!.pressure).toEqual([0.7, 0.7, 0.7]);
});

test('Shift continues the previous stroke of the same kind', () => {
  commitPaintDrag(drag());
  commitPaintDrag(drag({ points: [{ x: 30, y: 0 }], times: [0], pen: [null], continueStroke: true }));
  expect(strokes()).toHaveLength(1);
  expect(strokes()[0]!.points).toHaveLength(4);
});

test('a selected stroke has its Path replaced (keyed when animated)', () => {
  const id = (commitPaintDrag(drag()) as { strokeId: string }).strokeId;
  usePaintStore.getState().set({ selectedStroke: { nodeId: ID, strokeId: id } });
  commitPaintDrag(drag({ points: [{ x: 5, y: 5 }], times: [0], pen: [null] }));
  expect(strokes()).toHaveLength(1);
  expect(strokes()[0]!.points).toEqual([{ x: 5, y: 5 }]);
  toggleStrokePathAnimation(ID, id, 0);
  commitPaintDrag(drag({ points: [{ x: 7, y: 7 }], times: [0], pen: [null], compTime: 2 }));
  expect(defaultAnimation.getDataTrack(ID, paintPathProp(id))!.keyframes.length).toBe(2);
});

test('Eraser modes: Paint Only is stored; Last Stroke Only targets the previous paint stroke', () => {
  const b = (commitPaintDrag(drag()) as { strokeId: string }).strokeId;
  usePaintStore.getState().set({ eraseMode: 'paintOnly' });
  commitPaintDrag(drag({ mode: 'erase' }));
  expect(strokes()[1]!.eraseMode).toBe('paintOnly');
  commitPaintDrag(drag({ mode: 'erase', lastStrokeOnly: true }));
  expect(strokes()[2]).toMatchObject({ eraseMode: 'lastStroke', eraseTargetId: b });
});

describe('clone', () => {
  test('refuses without a source on this layer (or a named Source layer)', () => {
    expect(commitPaintDrag(drag({ mode: 'clone' })).ok).toBe(false);
    usePaintStore.getState().set({ cloneSource: { nodeId: OTHER, x: 0, y: 0 } });
    expect(commitPaintDrag(drag({ mode: 'clone' })).ok).toBe(false);
  });

  test('Aligned keeps the first offset; a named Source layer clones across layers', () => {
    usePaintStore.getState().set({ cloneSource: { nodeId: ID, x: 100, y: 0 }, cloneAligned: true });
    commitPaintDrag(drag({ mode: 'clone' }));
    commitPaintDrag(drag({ mode: 'clone', points: [{ x: 50, y: 0 }], times: [0], pen: [null] }));
    expect(strokes().map((s) => s.cloneOffsetX)).toEqual([100, 100]);

    usePaintStore.getState().set({ cloneSource: { nodeId: OTHER, x: 10, y: 0 }, cloneSourceLayerId: OTHER, cloneTimeShift: -0.5, alignedOffset: null });
    commitPaintDrag(drag({ mode: 'clone' }));
    expect(strokes()[2]).toMatchObject({ cloneSourceId: OTHER, cloneOffsetX: 10, cloneTimeShift: -0.5 });
  });
});
