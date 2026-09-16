/**
 * Where a plugin's UI shows up in the menus.
 *
 * Three things, each of which fails silently if it is wrong:
 *
 *   • A contributed TOOL is otherwise reachable only from the toolbar strip,
 *     which is icon-only — so it needs a named entry somewhere.
 *   • A plugin with a dozen commands turns the Plugins group into a list that
 *     runs off the bottom of the window. `submenu` lets the author fold it, and
 *     past the group's ceiling the host folds every plugin whether they asked
 *     or not.
 *   • A plugin PANEL belongs in `Window ▸ Panels`, because that is where a user
 *     looks for "what else can I dock" — the Plugins menu is where they look
 *     when they are thinking about plugins, which is a different moment.
 */

import { usePluginStore } from '@stores/pluginStore';
import { parseManifest } from '@core/plugins/manifest';
import { APP_MENU, type MenuItemModel } from './menuModel';
import { buildPluginsMenuGroup } from './pluginMenu';
import { pluginPanelMenuItems } from './pluginPanelsMenu';

/**
 * Install one plugin, LAZILY activated.
 *
 * `activationEvents` matters here: a plugin that says `onStartup` and has never
 * been started reads as `stopped`, and the menu draws it as one disabled line
 * with a reason — which is correct behaviour and not what these tests are
 * about. Every plugin an author would write for the menu is lazily activated,
 * because invoking one of its entries is what starts it.
 */
function install(
  id: string,
  name: string,
  contributes: Record<string, unknown>,
  activationEvents: string[] = ['onPanel:none'],
): void {
  const { manifest, errors } = parseManifest({
    id, name, version: '1.0.0', description: 'x', apiVersion: 7, main: 'main.js', contributes,
    activationEvents,
  });
  expect(errors).toEqual([]);
  usePluginStore.getState().put({
    manifest, granted: [], enabled: true, files: {}, binaries: {}, installedAt: 0, source: 'file',
  } as never);
}

const kids = (item: MenuItemModel): ReadonlyArray<MenuItemModel> => {
  const c = item.children;
  return typeof c === 'function' ? c() : c ?? [];
};

/** Every commandId in a list, submenus included. */
function allCommandIds(items: ReadonlyArray<MenuItemModel>): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.commandId) out.push(it.commandId);
    out.push(...allCommandIds(kids(it)));
  }
  return out;
}

beforeEach(async () => {
  await usePluginStore.getState().hydrate();
  for (const p of [...usePluginStore.getState().plugins]) usePluginStore.getState().remove(p.manifest.id);
});

describe('the Plugins group', () => {
  it('lists a contributed tool by name', () => {
    install('studio.acme.lab', 'Acme Lab', {
      tools: [{ id: 'place', label: 'Place pin', icon: 'crosshair' }],
    }, ['onTool:place']);
    expect(allCommandIds(buildPluginsMenuGroup().items))
      .toContain('plugin.studio.acme.lab.tool.place');
  });

  it('folds a plugin s commands under the heading the author declared', () => {
    install('studio.acme.lab', 'Acme Lab', {
      commands: [
        { id: 'bake', label: 'Bake' },
        { id: 'trim', label: 'Trim', submenu: 'Cleanup' },
        { id: 'weld', label: 'Weld', submenu: 'Cleanup' },
      ],
    }, ['onCommand:bake']);
    const items = buildPluginsMenuGroup().items;
    const cleanup = items.find((i) => i.label === 'Cleanup');
    expect(cleanup).toBeDefined();
    expect(kids(cleanup!).map((k) => k.commandId)).toEqual([
      'plugin.studio.acme.lab.trim',
      'plugin.studio.acme.lab.weld',
    ]);
    // The ungrouped one stays at the top level, where the author put it.
    expect(items.some((i) => i.commandId === 'plugin.studio.acme.lab.bake')).toBe(true);
  });

  it('stays inside the 14-entry ceiling by folding each plugin', () => {
    // The group's length is decided by the user's install list, not by us — so
    // the fold has to be automatic past the point a menu stops fitting.
    for (const vendor of ['a', 'b', 'c']) {
      install(`studio.${vendor}.lab`, `Vendor ${vendor.toUpperCase()}`, {
        commands: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, label: `C${i}` })),
      }, ['onCommand:c0']);
    }
    const items = buildPluginsMenuGroup().items;
    expect(items.filter((i) => !i.separator).length).toBeLessThanOrEqual(14);
    // Folded, not dropped: every command is still reachable.
    expect(allCommandIds(items)).toHaveLength(3 * 6 + 1);
  });

  it('keeps the flat shape for the ordinary one-plugin case', () => {
    install('studio.acme.lab', 'Acme Lab', { commands: [{ id: 'bake', label: 'Bake' }] }, ['onCommand:bake']);
    const items = buildPluginsMenuGroup().items;
    expect(items.some((i) => i.commandId === 'plugin.studio.acme.lab.bake')).toBe(true);
    expect(items.some((i) => i.children)).toBe(false);
  });
});

describe('Window ▸ Panels', () => {
  const panelsSubmenu = (): MenuItemModel => {
    const window = APP_MENU.find((g) => g.id === 'window')!;
    const panels = window.items.find((i) => i.label === 'Panels');
    expect(panels).toBeDefined();
    return panels!;
  };

  it('is empty of plugin entries when nothing declares a panel', () => {
    // An editor with no plugins has exactly the Window menu it had.
    expect(pluginPanelMenuItems()).toEqual([]);
  });

  it('offers each enabled plugin s panel, named after its plugin', () => {
    install('studio.acme.lab', 'Acme Lab', {
      panels: [{ id: 'mask', title: 'Masking', entry: 'panel.html' }],
    }, ['onPanel:mask']);
    expect(pluginPanelMenuItems()).toEqual([
      { commandId: 'plugin.studio.acme.lab.panel.mask', label: 'Acme Lab: Masking' },
    ]);
    // And it is really in the menu, through the submenu's thunk — the list is
    // re-evaluated per render precisely so an install appears without a reload.
    expect(kids(panelsSubmenu()).map((k) => k.commandId))
      .toContain('plugin.studio.acme.lab.panel.mask');
  });

  it('drops a disabled plugin s panel', () => {
    install('studio.acme.lab', 'Acme Lab', {
      panels: [{ id: 'mask', title: 'Masking', entry: 'panel.html' }],
    }, ['onPanel:mask']);
    const entry = usePluginStore.getState().get('studio.acme.lab')!;
    usePluginStore.getState().put({ ...entry, enabled: false });
    expect(pluginPanelMenuItems()).toEqual([]);
  });
});
