/**
 * The timeline's Collapse / Continuous Rasterize, Quality and Frame Blending
 * switches, and Select Label Group — the helpers, then the switches as the
 * track header renders them.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { useSelectionStore } from '@stores/selectionStore';
import { readContinuousRaster } from '@core/scene/continuousRaster';
import { readNodeQuality } from '@core/effects/layerQuality';
import { getNodeLayerTime } from '@core/scene/layerTime';
import type { SceneNode } from '@core/types';
import type { TimelineTrack } from './TimelineModel';
import {
  collapseSwitchKind,
  toggleCollapseSwitch,
  toggleQualitySwitch,
  frameBlendSwitchAvailable,
  toggleFrameBlendSwitch,
  selectLabelGroup,
} from './layerSwitches';
import { TrackHeader } from './TrackHeaderColumn';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function bootCommandSystem(): void {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) as never }));
}

function add(id: string, kind: string, color?: string): void {
  if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode(id);
  defaultSceneGraph.addChild('comp_root', {
    id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: kind } }],
  } as unknown as SceneNode);
  if (color) defaultSceneGraph.getNode(id)!.color = color;
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(() => {
  bootCommandSystem();
  if (!defaultSceneGraph.getNode('comp_root')) {
    defaultSceneGraph.addNode({
      id: 'comp_root', name: 'Composition', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
    } as unknown as SceneNode);
  }
  add('sw_text', 'text', '#d0705a');
  add('sw_video', 'video', '#d0705a');
  add('sw_null', 'null', '#5282b8');
});

describe('switch helpers', () => {
  it('the sunburst is Continuous Rasterize on vector layers and nothing on a null', () => {
    expect(collapseSwitchKind(defaultSceneGraph.getNode('sw_text'))).toBe('raster');
    expect(collapseSwitchKind(defaultSceneGraph.getNode('sw_null'))).toBeNull();
    toggleCollapseSwitch('sw_text');
    expect(readContinuousRaster(defaultSceneGraph.getNode('sw_text')!)).toBe(true);
  });

  it('quality cycles Best → Draft → Wireframe → Best, like AE', () => {
    expect(toggleQualitySwitch('sw_video')).toBe('draft');
    expect(readNodeQuality(defaultSceneGraph.getNode('sw_video')!)).toBe('draft');
    expect(toggleQualitySwitch('sw_video')).toBe('wireframe');
    expect(readNodeQuality(defaultSceneGraph.getNode('sw_video')!)).toBe('wireframe');
    expect(toggleQualitySwitch('sw_video')).toBe('best');
    expect(readNodeQuality(defaultSceneGraph.getNode('sw_video')!)).toBe('best');
  });

  it('frame blending only on layers with frames, Off ↔ Frame Mix', () => {
    expect(frameBlendSwitchAvailable(defaultSceneGraph.getNode('sw_text'))).toBe(false);
    expect(frameBlendSwitchAvailable(defaultSceneGraph.getNode('sw_video'))).toBe(true);
    toggleFrameBlendSwitch('sw_video');
    expect(getNodeLayerTime('sw_video').frameBlend).toBe('mix');
    toggleFrameBlendSwitch('sw_video');
    expect(getNodeLayerTime('sw_video').frameBlend).toBe('none');
  });

  it('Select Label Group selects every layer with the same label', () => {
    const ids = selectLabelGroup('sw_text');
    expect(ids).toEqual(expect.arrayContaining(['sw_text', 'sw_video']));
    expect(ids).not.toContain('sw_null');
    expect(useSelectionStore.getState().ids).toEqual(ids);
  });
});

describe('TrackHeader switches', () => {
  const track = (id: string): TimelineTrack => ({ id: id as never, name: id });
  const renderRow = (id: string): void => {
    render(
      <TrackHeader
        track={track(id)}
        index={1}
        selected={false}
        expanded={false}
        hasProps={false}
        extraColumns={[]}
        frameRate={30}
        active
        onRowFocus={() => {}}
        onToggleExpand={() => {}}
        onActivate={() => {}}
        onClick={() => {}}
        onToggleVisible={() => {}}
        onToggleLock={() => {}}
        onToggleSolo={() => {}}
        style={{}}
      />,
    );
  };

  it('a text layer shows Continuous Rasterize and Quality; clicking them writes the props', () => {
    renderRow('sw_text');
    const cr = screen.getByRole('button', { name: 'Continuous Rasterize' });
    expect(cr).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(cr);
    expect(readContinuousRaster(defaultSceneGraph.getNode('sw_text')!)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Quality: Best' }));
    expect(readNodeQuality(defaultSceneGraph.getNode('sw_text')!)).toBe('draft');
    // No frames, no frame-blend switch — a spacer holds the column.
    expect(screen.queryByRole('button', { name: 'Frame Blending' })).toBeNull();
  });

  it('a video layer shows Frame Blending and no sunburst', () => {
    renderRow('sw_video');
    expect(screen.getByRole('button', { name: 'Frame Blending' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Collapse Transformations|Continuous Rasterize/ })).toBeNull();
  });
});
