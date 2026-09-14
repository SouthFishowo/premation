/**
 * A dialog owns Escape and Enter.
 *
 * `ShortcutManager` listens on `window` in the capture phase, so a global chord
 * reaches its command before the dialog sees the key. Escape is bound to
 * Deselect: with focus on a dialog BUTTON (not a field, which the manager
 * already skips) pressing Escape deselected the layer the dialog was acting on
 * and left the dialog open — found on the Auto-Orient dialog, which has no
 * text field at all. The dialog content now claims both chords.
 */

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { claimsChord } from '@core/commands/ShortcutManager';
import { TooltipProvider } from '@components/Tooltip/Tooltip';
import { Modal } from './Modal';

beforeAll(() => {
  // Radix / measured-geometry code paths may observe size in jsdom.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

/** The header's close IconButton renders a tooltip, which needs its provider. */
function renderModal(children: ReactNode): void {
  render(
    <TooltipProvider>
      <Modal open onClose={() => {}} title="Auto-Orient">
        {children}
      </Modal>
    </TooltipProvider>,
  );
}

describe('Modal shortcut claim', () => {
  it('claims Escape and Enter for everything inside the dialog', () => {
    renderModal(<button type="button">Orient Along Path</button>);
    const button = screen.getByRole('button', { name: 'Orient Along Path' });
    expect(claimsChord(button, 'escape')).toBe(true);
    expect(claimsChord(button, 'enter')).toBe(true);
  });

  it('does not claim unrelated chords, so global shortcuts still work around it', () => {
    renderModal(<button type="button">Off</button>);
    expect(claimsChord(screen.getByRole('button', { name: 'Off' }), 'space')).toBe(false);
  });
});
