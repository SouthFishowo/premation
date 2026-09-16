/**
 * A plugin asking for a chord, and the check that decides whether it gets one.
 *
 * The keyboard is a shared namespace with no owner. The command registry's
 * `byShortcut` map is last-write-wins and says nothing when two commands claim
 * the same chord, so without this a plugin could silently take Ctrl+K from the
 * app — the user's habit stops working and nothing anywhere reports why.
 *
 * The other half is the parser, and it is strict for a reason that only looks
 * pedantic: a chord that does not bind is indistinguishable from a keyboard
 * that is not working.
 */

import { getCommandRegistry } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';
import { clearAllShortcutOverrides } from '@core/commands/shortcutOverrides';
import { parseManifest } from './manifest';
import { describeClash, findShortcutClash, parseChord, parsePluginShortcuts } from './uiShortcuts';

const COMMANDS = new Set(['bake', 'reset']);

function errorsFor(raw: unknown): string[] {
  const errors: string[] = [];
  parsePluginShortcuts(raw, 'contributes.shortcuts', COMMANDS, errors);
  return errors;
}

describe('parsing a chord', () => {
  it('reads the spelling an author writes', () => {
    expect(parseChord('Ctrl+Alt+P')).toEqual({ key: 'p', ctrl: true, alt: true });
    expect(parseChord('Shift+F5')).toEqual({ key: 'F5', shift: true });
    expect(parseChord('Ctrl+Shift+ArrowLeft')).toEqual({ key: 'ArrowLeft', ctrl: true, shift: true });
  });

  it('accepts Mod, so one manifest works on both platforms', () => {
    // `meta` is what `resolveChord` folds to Ctrl off a Mac; without this an
    // author has to ship two manifests or pick a platform to disappoint.
    expect(parseChord('Mod+K')).toEqual({ key: 'k', meta: true });
  });

  it('refuses a bare key', () => {
    // A single letter takes it from every surface that might want it, and an
    // author writing "P" almost certainly meant a modified chord. Function keys
    // are the exception: they are chords already.
    expect(parseChord('P')).toBeNull();
    expect(parseChord('F5')).not.toBeNull();
  });

  it('refuses a chord it cannot bind, rather than binding something else', () => {
    expect(parseChord('Ctrl+Retrun')).toBeNull();
    expect(parseChord('Ctrl+a+b')).toBeNull();
    expect(parseChord('Ctrl+')).toBeNull();
  });
});

describe('the manifest block', () => {
  it('accepts a chord for a command the manifest declares', () => {
    const errors: string[] = [];
    const out = parsePluginShortcuts(
      [{ command: 'bake', chord: 'Ctrl+Alt+P' }], 'contributes.shortcuts', COMMANDS, errors,
    );
    expect(errors).toEqual([]);
    expect(out).toEqual([{ command: 'bake', chord: 'Ctrl+Alt+P', key: { key: 'p', ctrl: true, alt: true } }]);
  });

  it('refuses a chord for a command that does not exist', () => {
    expect(errorsFor([{ command: 'ghost', chord: 'Ctrl+Alt+P' }]))
      .toEqual([expect.stringContaining('not in "contributes.commands"')]);
  });

  it('refuses a manifest that claims one chord twice', () => {
    expect(errorsFor([
      { command: 'bake', chord: 'Ctrl+Alt+P' },
      { command: 'reset', chord: 'Ctrl+Alt+P' },
    ])).toEqual([expect.stringContaining('already claimed')]);
  });

  it('needs apiVersion 7', () => {
    const base = {
      id: 'studio.acme.lab', name: 'Acme Lab', version: '1.0.0', description: 'x', main: 'main.js',
      contributes: {
        commands: [{ id: 'bake', label: 'Bake' }],
        shortcuts: [{ command: 'bake', chord: 'Ctrl+Alt+P' }],
      },
    };
    expect(parseManifest({ ...base, apiVersion: 6 }).errors)
      .toEqual([expect.stringContaining('requires "apiVersion": 7')]);
    expect(parseManifest({ ...base, apiVersion: 7 }).errors).toEqual([]);
  });
});

describe('conflict detection', () => {
  beforeEach(() => {
    clearAllShortcutOverrides();
    getCommandRegistry().register({
      id: asCommandId('edit.duplicate'),
      label: 'Duplicate',
      shortcut: { key: 'd', ctrl: true },
      enabled: () => true,
      execute: () => {},
    });
  });

  afterEach(() => {
    // The registry is process-wide; leaving these behind would make a later
    // suite's chord look taken.
    getCommandRegistry().unregister(asCommandId('edit.duplicate'));
    getCommandRegistry().unregister(asCommandId('plugin.acme.bake'));
    clearAllShortcutOverrides();
  });

  it('names the command already holding the chord', () => {
    const clash = findShortcutClash({ key: 'd', ctrl: true }, 'plugin.acme.bake');
    expect(clash).toEqual({ commandId: 'edit.duplicate', label: 'Duplicate' });
    // The message has to say what happens next, not only that it failed.
    expect(describeClash('Ctrl+D', clash!)).toContain('Customize');
  });

  it('leaves a free chord free', () => {
    expect(findShortcutClash({ key: 'p', ctrl: true, alt: true }, 'plugin.acme.bake')).toBeNull();
  });

  it('never reports a command conflicting with itself', () => {
    // Re-checking on a restart or a re-enable would otherwise refuse the chord
    // the plugin held a moment ago.
    getCommandRegistry().register({
      id: asCommandId('plugin.acme.bake'),
      label: 'Acme: Bake',
      shortcut: { key: 'b', ctrl: true, alt: true },
      enabled: () => true,
      execute: () => {},
    });
    expect(findShortcutClash({ key: 'b', ctrl: true, alt: true }, 'plugin.acme.bake')).toBeNull();
  });

  it('ignores a command that has no chord at all', () => {
    // Most of the registry is chord-less, and a scan that treated "no shortcut"
    // as a match would report a conflict with the first command it met.
    getCommandRegistry().register({
      id: asCommandId('plugin.acme.bake'),
      label: 'Acme: Bake',
      enabled: () => true,
      execute: () => {},
    });
    expect(findShortcutClash({ key: 'q', ctrl: true, alt: true }, 'other')).toBeNull();
  });

  /*
    NOT asserted here: a chord the USER moved in Customize….

    `findShortcutClash` resolves every command through `resolveChord` against
    `getShortcutOverrides()`, so a rebind frees the old chord and claims the new
    one — which is the whole reason it reads the registry rather than a static
    table. Pinning it needs a booted settings manager (`getShortcutOverrides`
    falls back to the default preset and `setShortcutOverride` silently no-ops
    without one), and standing one up here would test the settings layer rather
    than this one.
  */
});
