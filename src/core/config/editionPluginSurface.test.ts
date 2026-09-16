/**
 * Plugins exist in BOTH editions; only the registry is server-only.
 *
 * ── What changed, and why this file still asserts surfaces ──────────────────
 *
 * The local edition used to have no plugins at all. It now installs them from
 * local files — a `.zip`, a `.mplugin` or a folder — through the same manifest
 * parse, consent screen and Worker sandbox the hosted build uses. What needs
 * motion-back (browsing and downloading from the registry, update checks, the
 * revocation list, account sync, publishing) stays behind
 * `pluginRegistryEnabled()`.
 *
 * The assertions are still on the SURFACES, checked in both editions, because
 * the trap this file was written for has not gone away: most of these surfaces
 * are built from registries that are empty until something installs, so
 * "present" can pass vacuously if a surface is deleted. Checking a real
 * registered effect and the real panel table is what makes it a gate.
 *
 * `pluginsEnabled()` is still the one predicate every entry point reads, so a
 * future build that must ship without plugins is one line — and this file is
 * where that line's reach gets proven again.
 *
 * ── What is deliberately NOT gated ──────────────────────────────────────────
 *
 * Everything that reads plugin content out of a DOCUMENT. A project containing
 * a custom layer kind, a plugin effect or a proxy subtree must open, render and
 * re-save byte-identically with the plugin absent.
 * `uninstalledDocumentRoundTrip.test.ts` is that property.
 */

import { setEdition, pluginsEnabled, pluginRegistryEnabled } from './edition';
import { isPanelAvailable, PANEL_AVAILABILITY } from './panelAvailability';
import { availablePanelDefs, PANEL_DEFS, panelDef } from '@layout/EditorLayout/panelDefs';
import { getWorkspaceManager } from '@core/layout/workspaceManager';
import { pluginEffectDefs } from '@core/effects/pluginEffectDefs';
import { registerEffects, resetEffectsForTests } from '@core/plugins/pluginEffects';

/**
 * Panel ids that constitute a plugin surface.
 *
 * A list rather than a substring match: `marketplace` contains no plugin
 * substring and `plugins` would match nothing else, so a regex over ids would
 * miss one and prove nothing about the other.
 */
const PLUGIN_PANEL_IDS = ['marketplace', 'plugins'] as const;

const EFFECT = {
  id: 'tint',
  label: 'Tint',
  shader: '@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
  params: { amount: { type: 'number' as const, default: 1 } },
};

afterEach(() => {
  setEdition('server');
  resetEffectsForTests();
});

describe('the predicates', () => {
  it('ships plugins in both editions, read live rather than captured', () => {
    /*
      The trap `panelAvailability` documents still applies: its table is
      evaluated when first imported, BEFORE `main.tsx` calls `setEdition()`.
      Flipping twice against the same imported table proves nothing snapshots.
    */
    setEdition('server');
    expect(pluginsEnabled()).toBe(true);
    setEdition('local');
    expect(pluginsEnabled()).toBe(true);
  });

  it('★ keeps the REGISTRY server-only', () => {
    // `pluginRegistryEnabled` answers "may this build make a network request to
    // the marketplace", and is asked deep inside `registry.ts`, where the answer
    // must hold whatever the UI above it does. A local-file plugin never needs it.
    setEdition('server');
    expect(pluginRegistryEnabled()).toBe(true);
    setEdition('local');
    expect(pluginRegistryEnabled()).toBe(false);
  });
});

describe('the panel registry', () => {
  it.each(['server', 'local'] as const)('offers both plugin panels in the %s edition', (ed) => {
    setEdition(ed);
    const ids = availablePanelDefs().map((p) => p.id);
    for (const id of PLUGIN_PANEL_IDS) expect(ids).toContain(id);
  });

  it('resolves them by id, so a persisted layout renders a name not an id', () => {
    setEdition('local');
    expect(panelDef('marketplace')?.title).toBe('Plugins');
    expect(panelDef('plugins')?.title).toBe('Plugin Panels');
  });

  it('names only panels that actually exist', () => {
    // A typo'd key here would gate nothing and never be noticed, because the
    // absent-means-available rule makes an unknown id look fine.
    const known = new Set(PANEL_DEFS.map((p) => p.id));
    for (const id of Object.keys(PANEL_AVAILABILITY)) expect(known).toContain(id);
  });

  it('is still a predicate in the table, not a value', () => {
    // The gate stays wired: every plugin panel reads `pluginsEnabled` live, so
    // switching the feature off for a future build hides these panels.
    expect(PANEL_AVAILABILITY.marketplace).toBe(pluginsEnabled);
    expect(PANEL_AVAILABILITY.plugins).toBe(pluginsEnabled);
    setEdition('local');
    expect(isPanelAvailable('marketplace')).toBe(true);
  });
});

describe('the workspace presets', () => {
  it('are not stripped of plugin panels in the local edition', () => {
    // The presets filter through the same availability table; a local build
    // must not silently apply less of a workspace than the server build does.
    setEdition('server');
    const serverMentions = getWorkspaceManager().listWorkspaces().map((ws) => JSON.stringify(ws.panelOrder ?? {}));
    setEdition('local');
    const localMentions = getWorkspaceManager().listWorkspaces().map((ws) => JSON.stringify(ws.panelOrder ?? {}));
    expect(localMentions).toEqual(serverMentions);
  });
});

describe('the effects browser', () => {
  it.each(['server', 'local'] as const)('lists a registered plugin effect in the %s edition', (ed) => {
    // Registering one first is what distinguishes "shown" from "the registry
    // happens to be empty".
    setEdition(ed);
    registerEffects('studio.acme.lab', 'Acme Lab', [EFFECT]);
    expect(pluginEffectDefs().map((d) => d.type)).toContain('studio.acme.lab.tint');
  });
});
