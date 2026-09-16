/**
 * A tool a plugin contributes — the one UI contribution that takes the whole
 * viewport while it is active.
 *
 * What is worth pinning: the declaration is checked before anything can be
 * activated (an icon-less tool on an icon-only strip is a glyph nobody can tell
 * apart, and an arbitrary cursor is a fake pointer a few pixels from the real
 * one), and the ACTIVE tool cannot outlive its plugin — a tool left active
 * after an uninstall would claim every click in the viewport and answer none.
 */

import { parseManifest } from './manifest';
import {
  MAX_TOOLS_PER_PLUGIN,
  activePluginTool,
  onPluginToolsChanged,
  parsePluginTools,
  parsePluginToolId,
  pluginToolEntries,
  pluginToolId,
  registerPluginTools,
  resetPluginToolsForTests,
  setActivePluginTool,
  unregisterPluginTools,
} from './uiTools';

const ICONS: ReadonlySet<string> = new Set(['plugin', 'crosshair', 'cube']);
const PLUGIN = 'studio.acme.lab';

function parseOne(tool: unknown): { tools: ReturnType<typeof parsePluginTools>; errors: string[] } {
  const errors: string[] = [];
  const tools = parsePluginTools([tool], 'contributes.tools', ICONS, errors);
  return { tools, errors };
}

beforeEach(() => resetPluginToolsForTests());

describe('the declaration', () => {
  it('accepts a tool with an icon and a cursor, defaulting the cursor', () => {
    const { tools, errors } = parseOne({ id: 'place', label: 'Place pin', icon: 'crosshair' });
    expect(errors).toEqual([]);
    expect(tools[0]).toEqual({ id: 'place', label: 'Place pin', icon: 'crosshair', cursor: 'crosshair' });
  });

  it('requires an icon, because the strip is glyphs', () => {
    // Unlike a command, which is a row with a name beside it.
    expect(parseOne({ id: 'place', label: 'Place pin' }).errors)
      .toEqual([expect.stringContaining('.icon" is required')]);
    expect(parseOne({ id: 'place', label: 'Place pin', icon: 'nope' }).errors)
      .toEqual([expect.stringContaining('.icon" is required')]);
  });

  it('refuses a cursor outside the fixed vocabulary', () => {
    // Never a URL: an arbitrary cursor image is a fake pointer drawn a few
    // pixels from the real one, which is the oldest clickjacking trick there is.
    expect(parseOne({ id: 'p', label: 'P', icon: 'plugin', cursor: 'url(evil.png)' }).errors)
      .toEqual([expect.stringContaining('.cursor" must be one of')]);
  });

  it('caps how much of the toolbar one plugin may take', () => {
    const many = Array.from({ length: MAX_TOOLS_PER_PLUGIN + 1 }, (_, i) => ({
      id: `t${i}`, label: `T${i}`, icon: 'plugin',
    }));
    const errors: string[] = [];
    parsePluginTools(many, 'contributes.tools', ICONS, errors);
    expect(errors).toEqual([expect.stringContaining('the limit is')]);
  });

  it('needs apiVersion 7, and implies its own activation event', () => {
    const base = {
      id: PLUGIN, name: 'Acme Lab', version: '1.0.0', description: 'x', main: 'main.js',
      contributes: { tools: [{ id: 'place', label: 'Place', icon: 'crosshair' }] },
      activationEvents: ['onTool:place'],
    };
    // `arrayContaining`: refusing the block also orphans the activation event
    // that names a tool, and both messages are worth having.
    expect(parseManifest({ ...base, apiVersion: 6 }).errors)
      .toEqual(expect.arrayContaining([expect.stringContaining('requires "apiVersion": 7')]));

    const ok = parseManifest({ ...base, apiVersion: 7 });
    expect(ok.errors).toEqual([]);
    expect(ok.manifest!.activationEvents).toContain('onTool:place');

    // An activation event naming a tool that does not exist can never fire,
    // which presents as a plugin that simply never starts.
    expect(parseManifest({ ...base, apiVersion: 7, activationEvents: ['onTool:ghost'] }).errors)
      .toEqual([expect.stringContaining('not in "contributes.tools"')]);
  });
});

describe('the registry', () => {
  const TOOLS = [{ id: 'place', label: 'Place pin', icon: 'crosshair', cursor: 'crosshair' as const }];

  it('namespaces the id so two vendors cannot collide', () => {
    expect(pluginToolId(PLUGIN, 'place')).toBe(`plugin:${PLUGIN}:place`);
    expect(parsePluginToolId(`plugin:${PLUGIN}:place`)).toEqual({ pluginId: PLUGIN, toolId: 'place' });
    expect(parsePluginToolId('select')).toBeNull();
  });

  it('announces a change, so the toolbar does not have to poll', () => {
    let beats = 0;
    const stop = onPluginToolsChanged(() => { beats += 1; });
    registerPluginTools(PLUGIN, 'Acme Lab', TOOLS);
    expect(beats).toBe(1);
    expect(pluginToolEntries()).toHaveLength(1);
    unregisterPluginTools(PLUGIN);
    expect(beats).toBe(2);
    stop();
  });

  it('activates by id and reports which one is in hand', () => {
    registerPluginTools(PLUGIN, 'Acme Lab', TOOLS);
    expect(setActivePluginTool(pluginToolId(PLUGIN, 'place'))?.tool.label).toBe('Place pin');
    expect(activePluginTool()?.pluginId).toBe(PLUGIN);
    expect(setActivePluginTool(null)).toBeNull();
  });

  it('ignores an id no plugin declares', () => {
    expect(setActivePluginTool('plugin:ghost.vendor:nope')).toBeNull();
  });

  it('stands the active tool down when its plugin goes', () => {
    // The failure this prevents: a tool that keeps claiming every click in the
    // viewport for a plugin that is no longer there to answer.
    registerPluginTools(PLUGIN, 'Acme Lab', TOOLS);
    setActivePluginTool(pluginToolId(PLUGIN, 'place'));
    unregisterPluginTools(PLUGIN);
    expect(activePluginTool()).toBeNull();
    expect(pluginToolEntries()).toEqual([]);
  });
});
