/**
 * The toolbar entry for tools plugins contribute.
 *
 * One flyout for all of them rather than a button each, for the reason the rail
 * has a budget in `pluginPanelDefs.ts`: the tool strip is the most contested
 * space in the editor, and four installed plugins each taking a slot would push
 * the app's own tools off it. Grouped, they cost one glyph however many there
 * are — and the flyout's icon becomes the ACTIVE plugin tool's, so the strip
 * still shows what is in your hand.
 *
 * Absent entirely when nothing contributes a tool, which is the overwhelmingly
 * common case: an editor with no plugins has exactly the toolbar it had.
 */

import { useEffect, useState } from 'react';
import type { IconName } from '@components/Icon';
import {
  activePluginTool,
  onPluginToolsChanged,
  pluginToolEntries,
  type PluginToolEntry,
} from '@core/plugins/uiTools';
import { activatePluginTool } from '@core/workspace/pluginToolBridge';
import { ToolFlyout } from './ToolFlyout';

/** The contributed tools and which one is active, kept in step with the host. */
function usePluginTools(): { entries: PluginToolEntry[]; active: PluginToolEntry | null } {
  const [state, setState] = useState(() => ({
    entries: pluginToolEntries(),
    active: activePluginTool(),
  }));
  useEffect(
    () => onPluginToolsChanged(() => {
      setState({ entries: pluginToolEntries(), active: activePluginTool() });
    }),
    [],
  );
  return state;
}

export function PluginToolsFlyout(): JSX.Element | null {
  const { entries, active } = usePluginTools();
  if (entries.length === 0) return null;

  const shown = active ?? entries[0]!;
  return (
    <ToolFlyout
      icon={shown.icon as IconName}
      // The plugin's name is in the label, always. A tool that reads as one of
      // the editor's own is a tool the user blames the editor for.
      label={`${shown.pluginName}: ${shown.tool.label}`}
      title={shown.tool.tooltip ?? `${shown.pluginName}: ${shown.tool.label}`}
      active={active !== null}
      items={entries.map((e) => ({
        id: e.id,
        label: `${e.pluginName}: ${e.tool.label}`,
        icon: e.icon as IconName,
        onSelect: () => activatePluginTool(e.pluginId, e.tool.id),
      }))}
    />
  );
}

export default PluginToolsFlyout;
