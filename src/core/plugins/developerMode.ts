/**
 * Developer mode — the switch that lets UNSIGNED code run.
 *
 * ── What it is for ───────────────────────────────────────────────────────────
 *
 * A plugin from the registry is signed, and its signature is checked on this
 * machine over the exact bytes about to be installed. A folder on someone's
 * disk has no signature and cannot have one: the author is editing the files.
 * So the folder tier needs a different answer to "why should this be allowed to
 * run", and the honest one is "because you said so, once, knowing what it
 * means" — which is a persisted switch with a warning on it, not a prompt per
 * package that everyone learns to click through.
 *
 * Every host that supports local plugins draws this line somewhere: VS Code has
 * an extension development host, Blender warns on unpacked add-ons, Chrome's
 * "Load unpacked" lives behind a Developer mode toggle and nags while it is on.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────
 *
 * It does not widen the sandbox. A plugin loaded from an unsigned folder runs
 * in the same Worker, behind the same permission gate, with the same consent
 * screen as one from the registry. What it changes is WHOSE code is allowed to
 * get that far. It also does not touch the native tier: `runtime: "native"` has
 * its own trust record (`runtimeTier.ts`) and is not reachable by turning this
 * on.
 *
 * Persisted in `localStorage` rather than in the settings store, because it is
 * read during plugin scanning — before React, and from modules that must not
 * import a store to answer a boolean.
 */

const KEY = 'motion-editor.plugins.developerMode';

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    // Private mode, or a storage-blocked origin. Off is the safe answer: the
    // failure mode is "my folder plugin will not load", which is visible and
    // fixable, rather than "unsigned code ran because storage threw".
    return false;
  }
}

let enabled = read();

export function developerModeEnabled(): boolean {
  return enabled;
}

export function setDeveloperMode(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  try {
    if (next) localStorage.setItem(KEY, 'true');
    else localStorage.removeItem(KEY);
  } catch { /* the session still behaves; only the survival is lost */ }
  for (const fn of [...listeners]) fn();
}

export function subscribeDeveloperMode(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test seam. Never called by the app. */
export function resetDeveloperModeForTests(): void {
  enabled = false;
  listeners.clear();
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
