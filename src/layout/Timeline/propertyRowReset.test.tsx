/**
 * The timeline's AE-style Reset: the Transform group heading's inline "Reset"
 * link (and its right-click), and a property row's right-click menu.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { useContextMenuStore } from '@stores/contextMenuStore';
import { PropertyHeader, TrackCategoryHeader } from './TrackHeaderColumn';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(() => useContextMenuStore.getState().close());

describe('Transform group heading', () => {
  it('renders an inline Reset that resets without toggling the section', () => {
    const onReset = jest.fn();
    const onToggle = jest.fn();
    render(
      <TrackCategoryHeader label="Transform" icon="sliders-h" expanded count={5} style={{}} onToggle={onToggle} onReset={onReset} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset Transform' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('offers Reset on right-click', () => {
    const onReset = jest.fn();
    const { container } = render(
      <TrackCategoryHeader label="Transform" icon="sliders-h" expanded count={5} style={{}} onToggle={() => {}} onReset={onReset} />,
    );
    fireEvent.contextMenu(container.firstChild as Element, { clientX: 40, clientY: 60 });
    const s = useContextMenuStore.getState();
    expect(s.open).toBe(true);
    expect(s.items.map((i) => i.label)).toEqual(['Reset']);
    s.items[0]!.onSelect?.();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('other headings have no Reset', () => {
    render(<TrackCategoryHeader label="Effects" icon="sparkles" expanded count={1} style={{}} onToggle={() => {}} />);
    expect(screen.queryByRole('button', { name: /Reset/ })).toBeNull();
  });
});

describe('property row right-click', () => {
  it('opens the row menu built on demand, at the pointer', () => {
    const onReset = jest.fn();
    const build = jest.fn(() => [{ id: 'reset', label: 'Reset', onSelect: onReset }]);
    const { container } = render(
      <PropertyHeader label="Rotation" style={{}} keyframes={[]} currentTime={0} animated={false} contextMenuItems={build} />,
    );
    expect(build).not.toHaveBeenCalled();
    fireEvent.contextMenu(container.firstChild as Element, { clientX: 120, clientY: 80 });
    const s = useContextMenuStore.getState();
    expect(build).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ open: true, x: 120, y: 80 });
    s.items[0]!.onSelect?.();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('a row without a menu leaves the native context menu alone', () => {
    const { container } = render(<PropertyHeader label="Rotation" style={{}} keyframes={[]} currentTime={0} />);
    fireEvent.contextMenu(container.firstChild as Element, { clientX: 1, clientY: 1 });
    expect(useContextMenuStore.getState().open).toBe(false);
  });
});
