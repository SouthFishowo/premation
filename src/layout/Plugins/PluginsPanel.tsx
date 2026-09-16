/**
 * The Plugins sidebar panel.
 *
 * Thin on purpose. `PluginsList` is the one implementation of finding,
 * installing and managing plugins; this exists only so the left dock can mount
 * it beside Scene, Assets and Library. Anything that grows here rather than
 * there is the beginning of a second copy.
 *
 * There are no sections. Browse / Installed / My Plugins used to be tabs here,
 * and they made a user decide which container their answer lived in before they
 * could search for it — see the note in `PluginsList`. The sidebar is for
 * finding and running things.
 *
 * ── Getting a plugin IN happens on the dashboard — when there is one ─────────
 *
 * In the hosted build, adding a plugin from disk lives on the dashboard's
 * Plugins page, beside publishing: installing and publishing are the two halves
 * of putting a plugin into the world, and the dashboard has room to say what a
 * publish involves (a namespace, a signing key, who may see it) instead of a
 * button that starts something a dock column cannot finish.
 *
 * The local edition has no dashboard — the editor IS the app — so there the dock
 * is the only place a plugin can come in from, and it installs from a package or
 * a folder exactly as the dashboard would. Keyed on `cloudProjectsEnabled`
 * because that is the predicate that decides whether the dashboard route exists
 * (`AppRouter`); asking the edition directly would drift the day a third one
 * appears.
 *
 * The cost in the hosted build, stated because it falls on plugin AUTHORS:
 * iterating on a package you are writing means going to the dashboard to
 * reinstall it. The row's **Reload** still works from here and is the fast path
 * once a plugin is in, so the trip is once per plugin rather than once per edit.
 */

import { cloudProjectsEnabled } from '@core/config/edition';
import { PluginsList } from './PluginsList';
import { localPluginsAvailable } from '@core/plugins/localPlugins';
import { LocalPluginsSection } from './LocalPluginsSection';
import styles from './LocalPlugins.module.css';

export function PluginsPanel(): JSX.Element {
  /*
    `canInstall` gates the Add control AND the drop target together — see the
    prop's own note. A dock that still installed on drop while showing no way
    to install would have the affordance gone and the capability intact, which
    is not a smaller surface, only a less honest one.

    Read per render, not captured: the edition is set at boot, after this module
    is first imported.

    `compactActions` stays: it is about width, and it still governs any control
    the search row grows later.
  */
  /*
    The plugins FOLDER sits above the list, and renders nothing at all in a
    build with no filesystem (`LocalPluginsSection` returns null when the
    bridge is absent), so the browser build is unchanged.

    Above rather than below because it is the shorter, more volatile half — an
    author working on a plugin looks at it repeatedly, while the installed list
    is where a plugin goes to be used. It is a SECTION rather than rows merged
    into the list because these plugins have a different lifecycle: a mirror of
    something on disk that can change under us, not a copy this app owns.
  */
  const list = <PluginsList compactActions canInstall={!cloudProjectsEnabled()} />;

  /*
    No bridge, no folder — and then no wrapper either.

    The browser build has no filesystem, so there is nothing above the list and
    the panel's DOM stays exactly what it was. That is not only tidiness: the
    list is its own drop target and its own `height: 100%` root, and wrapping it
    for a sibling that will never render would move the panel's outermost
    element for no reason at all.

    On the desktop the wrapper IS load-bearing: two children, one of them
    `height: 100%`, need a column that can divide the space between them.
  */
  if (!localPluginsAvailable()) return list;

  return (
    <div className={styles.panel}>
      <LocalPluginsSection />
      {list}
    </div>
  );
}
