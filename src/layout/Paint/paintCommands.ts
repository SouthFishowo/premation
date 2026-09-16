/**
 * AE's Ctrl+8 (Paint) and Ctrl+9 (Brushes) — the commands that open the two
 * on-demand paint panels, registered on load like the Transcript's (see
 * `layout/Transcript/index.ts` for why on load: a command that exists only
 * once you have found its panel cannot be how you find the panel). The Window
 * menu lists both.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { useLayoutStore } from '@stores/layoutStore';

export const PAINT_PANEL_ID = 'paint';
export const BRUSHES_PANEL_ID = 'brushes';

export function buildPaintCommands(): Command[] {
  return [
    {
      id: asCommandId('view.paint'),
      label: 'Paint',
      icon: 'brush',
      shortcut: { key: '8', ctrl: true },
      enabled: () => true,
      execute: () => useLayoutStore.getState().openPanel(PAINT_PANEL_ID),
    },
    {
      id: asCommandId('view.brushes'),
      label: 'Brushes',
      icon: 'circle',
      shortcut: { key: '9', ctrl: true },
      enabled: () => true,
      execute: () => useLayoutStore.getState().openPanel(BRUSHES_PANEL_ID),
    },
  ];
}

export function registerPaintCommands(): void {
  const registry = getCommandRegistry();
  for (const command of buildPaintCommands()) registry.register(command);
}
