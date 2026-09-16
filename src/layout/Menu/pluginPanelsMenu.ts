/**
 * Plugin panels in `Window ▸ Panels`.
 *
 * Its own module, and a small one, because `menuModel` imports it: the model is
 * evaluated on /login and /dashboard, where the editor core has not booted, so
 * anything it pulls in has to be free of the plugin HOST. Reading the installed
 * list is a store lookup and costs nothing; constructing the host would start
 * its `postMessage` bridge on a page with no editor in it.
 */

import { usePluginStore } from '@stores/pluginStore';
import type { MenuItemModel } from './menuModel';

/**
 * Plugin panels, for `Window ▸ Panels`.
 *
 * The Window menu is where a user looks for "what else can I dock", and a
 * plugin's panel is exactly that — it was reachable only from the Plugins menu
 * and the manager, which are both places you go when you are thinking ABOUT
 * plugins rather than about your layout.
 *
 * Every declared panel of every ENABLED plugin, whether it won a rail tab or was
 * demoted to the shared host — the command behind each one is the host's own
 * `showPanel`, which knows where that panel actually landed. Listing only the
 * ones with their own tab would hide exactly the panels that are hardest to
 * find.
 */
export function pluginPanelMenuItems(): MenuItemModel[] {
  const out: MenuItemModel[] = [];
  const installed = [...usePluginStore.getState().plugins].sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  );
  for (const entry of installed) {
    if (!entry.enabled) continue;
    for (const panel of entry.manifest.contributes.panels) {
      out.push({
        commandId: `plugin.${entry.manifest.id}.panel.${panel.id}`,
        // The plugin's name first, so the alphabetical list groups a vendor's
        // panels together rather than scattering them by panel title.
        label: `${entry.manifest.name}: ${panel.title}`,
      });
    }
  }
  return out;
}
