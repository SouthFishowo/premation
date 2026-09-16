/**
 * Making a plugin's contributed tool the active tool.
 *
 * ── Why the plugin tool is state BESIDE the app's, not inside it ─────────────
 *
 * `uiStore.activeTool` is a closed union of the editor's own tool ids, and it
 * has to stay closed: a dozen `switch` statements across the viewport, the
 * toolbar and the options bar are exhaustive over it, and a value that appears
 * when a plugin is installed would make every one of them silently fall to its
 * default. So a plugin tool is a second, nullable piece of state
 * (`uiTools.activePluginTool`), and while it is set the app's own tool is
 * parked on Select.
 *
 * That parking is not a workaround, it is the correct behaviour: the built-in
 * tool must be something inert, because the plugin owns the viewport. And
 * picking ANY built-in tool afterwards clears the plugin one, which is what
 * makes the toolbar behave the way a toolbar does — one tool at a time, and the
 * one you just clicked.
 *
 * ── The events a plugin tool receives ────────────────────────────────────────
 *
 * The same pointer and key events a built-in tool sees, routed in
 * `layout/Workspace/pluginDrawOverlay.ts` before any host gesture, and
 * delivered in LAYER space. The plugin answers by posting a new draw list and
 * by calling the ordinary scene verbs, so a tool is a drawing plus a
 * subscription rather than a new kind of object.
 */

import pluginHost from '@core/plugins/PluginHost';
import {
  activePluginTool,
  pluginToolId,
  setActivePluginTool,
  type PluginToolEntry,
} from '@core/plugins/uiTools';
import { clearPluginDrawList } from '@core/plugins/uiCanvas';
import { useUIStore } from '@stores/uiStore';
import { getWorkspaceController } from './WorkspaceController';

/**
 * True while WE are the ones changing `uiStore.activeTool`.
 *
 * Without it, parking the built-in tool on Select would immediately trip the
 * subscription below and clear the plugin tool we are in the middle of
 * activating — the activation would appear to do nothing at all.
 */
let parking = false;

/** Point the viewport cursor at what the tool declared. */
function applyCursor(entry: PluginToolEntry | null): void {
  try {
    const ws = getWorkspaceController().ws;
    ws.cursor.setBase(entry ? entry.tool.cursor : 'default');
  } catch {
    // No workspace yet (a pop-out window, a test). The cursor is chrome; the
    // tool itself is already active and must not fail to activate over it.
  }
}

/** Make one contributed tool active. Silently ignores an unknown id. */
export function activatePluginTool(pluginId: string, toolId: string): void {
  const id = pluginToolId(pluginId, toolId);
  const previous = activePluginTool();
  if (previous && previous.id !== id) {
    pluginHost.notifyToolChanged(previous.pluginId, previous.tool.id, false);
  }

  parking = true;
  try {
    useUIStore.getState().setActiveTool('select');
  } finally {
    parking = false;
  }

  const entry = setActivePluginTool(id);
  if (!entry) return;
  applyCursor(entry);
  // Last, because it may start the worker: `onTool:<id>` is an activation
  // event, and the tool has to be active by the time the plugin hears about it.
  pluginHost.notifyToolChanged(pluginId, toolId, true);
}

/** Leave whatever contributed tool is active, if any. */
export function deactivatePluginTool(): void {
  const entry = activePluginTool();
  if (!entry) return;
  setActivePluginTool(null);
  clearPluginDrawList(entry.pluginId);
  applyCursor(null);
  pluginHost.notifyToolChanged(entry.pluginId, entry.tool.id, false);
}

/**
 * Watch the app's own tool selection, and stand the plugin tool down when the
 * user picks a built-in one.
 *
 * Installed once at boot. Returns its unsubscribe so a test can take it back.
 */
export function installPluginToolBridge(): () => void {
  return useUIStore.subscribe(
    (s) => s.activeTool,
    () => {
      if (parking) return;
      deactivatePluginTool();
    },
  );
}
