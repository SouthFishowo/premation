/**
 * The axis prefix ("X", "W") inside a field.
 *
 * In a two-field inspector row the letter is where people grab to scrub, so
 * the one behaviour worth pinning is that a press-drag STARTING on the prefix
 * is a scrub like any other — not a dead zone, not a text selection. The
 * prefix is decorative for assistive tech: the field keeps its own name.
 */

import { render, screen, act, cleanup } from '@testing-library/react';
import { ValueField } from './ValueField';
import { SCRUB_DEAD_ZONE_PX } from './scrubMath';

afterEach(cleanup);

const pointer = (type: string, x: number): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  });

describe('ValueField prefix', () => {
  it('draws the tag, hidden from assistive tech, without renaming the field', () => {
    const { container } = render(<ValueField value={10} onChange={() => {}} prefix="X" aria-label="Position X" />);
    const tag = container.querySelector('[data-value-prefix]');
    expect(tag?.textContent).toBe('X');
    expect(tag?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('spinbutton', { name: 'Position X' })).toBeInTheDocument();
  });

  it('renders no tag when none is given — existing callers are unchanged', () => {
    const { container } = render(<ValueField value={10} onChange={() => {}} aria-label="Opacity" />);
    expect(container.querySelector('[data-value-prefix]')).toBeNull();
  });

  it('a press-drag that starts on the prefix scrubs the value', () => {
    const onChange = jest.fn();
    const { container } = render(<ValueField value={10} onChange={onChange} step={1} prefix="W" aria-label="Scale X" />);
    const tag = container.querySelector('[data-value-prefix]')!;
    act(() => { tag.dispatchEvent(pointer('pointerdown', 100)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 100 + SCRUB_DEAD_ZONE_PX + 20)); });
    act(() => { window.dispatchEvent(pointer('pointerup', 100 + SCRUB_DEAD_ZONE_PX + 20)); });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as number;
    expect(last).toBeGreaterThan(10);
    // A drag is not a click: the field did not open its text input.
    expect(container.querySelector('input')).toBeNull();
  });
});
