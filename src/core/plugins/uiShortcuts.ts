/**
 * Keyboard shortcuts a plugin asks for, and the conflict check that decides
 * whether it gets them.
 *
 * ── Why a plugin may ask, and why it may be refused ──────────────────────────
 *
 * A command buried in a menu is a command power users do not use, so a plugin
 * that contributes real verbs has a real claim on a chord. But the keyboard is
 * a SHARED namespace with no owner: Ctrl+K is the app's, and the first plugin
 * to take it silently breaks a habit the user built before the plugin existed.
 * A last-write-wins registry — which is what the command registry's
 * `byShortcut` map is — makes that failure invisible from both sides.
 *
 * So a declared chord is a REQUEST. It is granted when nothing else holds it,
 * and refused with a message naming the holder when something does. Refusing is
 * not a failure of the install: the command is still in the Plugins menu and
 * the palette, and the user can bind their own chord to it in Customize…, which
 * walks the command registry and therefore sees plugin commands already.
 *
 * ── The chord is a string here, and a `KeyChord` everywhere else ─────────────
 *
 * `"Ctrl+Alt+P"` is what an author writes; `{ key: 'p', ctrl: true, alt: true }`
 * is what the app dispatches on. The translation lives here, in one direction
 * only, and it is strict: an unparseable chord is an install error, because a
 * shortcut that silently does not bind is indistinguishable from a keyboard
 * that is not working.
 *
 * `Mod` is accepted and means Cmd on macOS, Ctrl elsewhere — spelled as `meta`,
 * which `resolveChord` already folds to `ctrl` off Mac. Without it every author
 * would have to ship two manifests or pick a platform.
 */

import type { KeyChord } from '@app-types/common';
import { chordKey, getCommandRegistry } from '@core/commands/Command';
import { getShortcutOverrides, resolveChord } from '@core/commands/shortcutOverrides';

export interface PluginShortcutContribution {
  /** The plugin-local command id this chord runs. */
  command: string;
  /** As written in the manifest — kept for messages and the manager. */
  chord: string;
  /** The parsed form the app dispatches on. */
  key: KeyChord;
}

export const MAX_SHORTCUTS_PER_PLUGIN = 8;

/**
 * Key names a chord may end on.
 *
 * A closed list rather than "any single token", because the failure of an open
 * one is silent: `"Ctrl+Retrun"` parses, binds to a key no keyboard emits, and
 * the author's only symptom is a shortcut that does nothing.
 */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  'enter', 'escape', 'space', 'tab', 'backspace', 'delete', 'insert', 'home', 'end',
  'pageup', 'pagedown', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/** How a named key is spelled in a `KeyboardEvent.key`. */
const KEY_CASE: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Escape', space: 'Space', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
};

/**
 * `"Ctrl+Alt+P"` → `{ key: 'p', ctrl: true, alt: true }`, or null.
 *
 * Exported because the same string form is what a manager UI would show back to
 * the user, and round-tripping it is the only way to be sure the two agree.
 */
export function parseChord(raw: string): KeyChord | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 40) return null;
  const parts = raw.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  let ctrl = false;
  let meta = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') { ctrl = true; continue; }
    if (lower === 'cmd' || lower === 'command' || lower === 'meta') { meta = true; continue; }
    if (lower === 'mod') { meta = true; continue; }
    if (lower === 'alt' || lower === 'option' || lower === 'opt') { alt = true; continue; }
    if (lower === 'shift') { shift = true; continue; }
    // Two keys in one chord is not a chord — it is a typo, and accepting the
    // last one would bind something the author did not write.
    if (key !== null) return null;
    if (lower.length === 1 && /[a-z0-9`\-=[\]\\;',./]/.test(lower)) { key = lower; continue; }
    if (NAMED_KEYS.has(lower)) { key = KEY_CASE[lower] ?? lower.toUpperCase(); continue; }
    return null;
  }
  if (key === null) return null;

  /*
    A bare key is refused.

    "P" as a global shortcut takes a letter away from every surface that might
    want it and from the plugin's own author, who almost certainly meant a
    modified chord. The app's own single-letter chords are TOOLS, which are
    host-owned and mutually exclusive; nothing else in the editor claims one.
  */
  if (!ctrl && !meta && !alt && !/^f\d+$/i.test(key)) return null;

  return {
    key,
    ...(ctrl ? { ctrl: true } : {}),
    ...(meta ? { meta: true } : {}),
    ...(alt ? { alt: true } : {}),
    ...(shift ? { shift: true } : {}),
  };
}

/** Validate `contributes.shortcuts` against the commands the same manifest declares. */
export function parsePluginShortcuts(
  raw: unknown,
  at: string,
  commandIds: ReadonlySet<string>,
  errors: string[],
): PluginShortcutContribution[] {
  const out: PluginShortcutContribution[] = [];
  if (!Array.isArray(raw)) {
    errors.push(`"${at}" must be an array.`);
    return out;
  }
  if (raw.length > MAX_SHORTCUTS_PER_PLUGIN) {
    errors.push(`"${at}" declares ${raw.length} shortcuts; the limit is ${MAX_SHORTCUTS_PER_PLUGIN}.`);
    return out;
  }

  const seenCommand = new Set<string>();
  const seenChord = new Set<string>();
  raw.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`"${where}" must be an object.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const command = typeof e.command === 'string' ? e.command : '';
    if (!commandIds.has(command)) {
      errors.push(`"${where}.command" names "${command}", which is not in "contributes.commands".`);
      return;
    }
    if (seenCommand.has(command)) {
      errors.push(`"${where}.command" already has a shortcut in this manifest.`);
      return;
    }
    const chord = typeof e.chord === 'string' ? e.chord.trim() : '';
    const key = parseChord(chord);
    if (!key) {
      errors.push(
        `"${where}.chord" is not a chord this editor can bind. Write it like "Ctrl+Alt+P" `
        + '("Mod" for Cmd on macOS and Ctrl elsewhere); a chord needs at least one modifier.',
      );
      return;
    }
    const canonical = chordKey(key);
    if (seenChord.has(canonical)) {
      errors.push(`"${where}.chord" (${chord}) is already claimed by another entry in this manifest.`);
      return;
    }
    seenCommand.add(command);
    seenChord.add(canonical);
    out.push({ command, chord, key });
  });

  return out;
}

// ── Conflict detection ───────────────────────────────────────────────

export interface ShortcutClash {
  /** The command already holding the chord. */
  commandId: string;
  label: string;
}

/**
 * Who currently holds `chord`, if anybody.
 *
 * Reads the command registry through `resolveChord`, so a chord the USER moved
 * in Customize… counts as held where it now is and free where it used to be —
 * which is the whole reason this is not a lookup in a static table.
 *
 * `exclude` is the command about to be given the chord; without it, re-checking
 * a plugin that already holds its own chord (a restart, a re-enable) reports a
 * conflict with itself and refuses the binding it had a moment ago.
 */
export function findShortcutClash(chord: KeyChord, exclude: string): ShortcutClash | null {
  const wanted = chordKey(chord);
  const overrides = getShortcutOverrides();
  for (const cmd of getCommandRegistry().all()) {
    const id = cmd.id as unknown as string;
    if (id === exclude) continue;
    const resolved = resolveChord(id, cmd.shortcut, overrides);
    if (!resolved) continue;
    if (chordKey(resolved) === wanted) return { commandId: id, label: cmd.label };
  }
  return null;
}

/** One line for the plugin's log when a chord could not be granted. */
export function describeClash(chord: string, clash: ShortcutClash): string {
  return (
    `the shortcut "${chord}" is already ${clash.label} (${clash.commandId}), so it was not bound. `
    + 'The command is still in the Plugins menu and the palette, and a chord can be assigned in Customize….'
  );
}
