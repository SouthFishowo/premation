/**
 * Which desktop chrome the window wears — macOS, or Windows / Linux — and
 * whether its window controls are the OS's own or drawn by the renderer.
 *
 * ── Normally: the OS ────────────────────────────────────────────────────────
 *
 *  • macOS — `titleBarStyle: 'hidden'` with the real traffic lights placed
 *    inside the renderer's 44px unified toolbar.
 *  • Windows / Linux — `titleBarStyle: 'hidden'` with a Window Controls Overlay:
 *    the OS's own minimize / maximize / close, which is the only way to get the
 *    Windows 11 Snap Layouts flyout on the maximize button. HTML look-alikes
 *    cannot have it.
 *
 * ── In development: `PREMATION_UI_PLATFORM` ─────────────────────────────────
 *
 * `mac`, `windows` or `linux` (empty = this OS), from the shell or from the
 * same dotenv files Vite reads, so one line in `.env.local` switches both
 * processes. Restart `npm run electron:dev` after changing it: the window's
 * shape is fixed when it is created. A packaged build ignores the override.
 *
 * When the override names a different OS from the one running, that OS cannot
 * supply the other's controls (there are no traffic lights on Windows), so the
 * window goes frameless and the renderer draws them: `windowControls: 'drawn'`.
 *
 * ── How the renderer learns the answer ──────────────────────────────────────
 *
 * On the page URL, `?uiPlatform=…&windowControls=…` — not through the preload,
 * which may not read `process.argv` or `process.env` under the sandbox (see
 * `sandboxSupport.test.ts`), and not over async IPC, because the first paint
 * already has to draw the right bar. HashRouter keeps the query across routes.
 *
 * `parseUiPlatform` is duplicated in `src/core/config/uiPlatform.ts` rather than
 * imported, for the same reason `edition.ts` duplicates `parseEdition`: this
 * directory compiles alone. `uiPlatformParity.test.ts` keeps the two equal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindowConstructorOptions } from 'electron';

export type UiPlatform = 'mac' | 'windows' | 'linux';
export type WindowControls = 'native' | 'drawn';

export interface UiChrome {
  platform: UiPlatform;
  windowControls: WindowControls;
  /** True when a dev override picked a different chrome from this OS's. */
  overridden: boolean;
}

export const UI_PLATFORM_ENV = 'PREMATION_UI_PLATFORM';

/** The renderer's bar heights. The native controls are placed to match them. */
export const MAC_TOOLBAR_HEIGHT = 44;
export const WINDOWS_TITLEBAR_HEIGHT = 32;

/**
 * The overlay's first colours, before the renderer reports its theme — the dark
 * title bar surface, so a dark-theme boot never flashes a light strip.
 */
export const DEFAULT_OVERLAY_COLORS = { color: '#141416', symbolColor: '#a1a1aa' } as const;

/** Parse an env string. Unrecognised (including empty) means "no override". */
export function parseUiPlatform(raw: string | undefined | null): UiPlatform | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'mac' || v === 'macos' || v === 'darwin' || v === 'osx') return 'mac';
  if (v === 'windows' || v === 'win' || v === 'win32') return 'windows';
  if (v === 'linux') return 'linux';
  return null;
}

export function osUiPlatform(platform: string): UiPlatform {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * One `KEY=value` out of dotenv text — only what this module needs, not a dotenv
 * implementation. Quotes are stripped; an unquoted trailing `# comment` is
 * dropped; the last assignment wins.
 */
export function readEnvFileValue(text: string, key: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== key) continue;
    const raw = m[2]!.trim();
    const quoted = /^(['"])(.*)\1$/.exec(raw);
    found = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '');
  }
  return found;
}

/**
 * The override as the Vite dev server sees it, so both processes agree: the
 * shell first, then `.env.development.local`, `.env.development`, `.env.local`,
 * `.env` — Vite's precedence for `mode === 'development'`.
 */
export function devUiPlatformOverride(
  env: NodeJS.ProcessEnv,
  root: string,
  read: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): string | undefined {
  if (env[UI_PLATFORM_ENV] !== undefined) return env[UI_PLATFORM_ENV];
  for (const name of ['.env.development.local', '.env.development', '.env.local', '.env']) {
    let text: string;
    try {
      text = read(join(root, name));
    } catch {
      continue; // absent file
    }
    const value = readEnvFileValue(text, UI_PLATFORM_ENV);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function resolveUiChrome(input: { osPlatform: string; isDev: boolean; override?: string }): UiChrome {
  const os = osUiPlatform(input.osPlatform);
  const requested = input.isDev ? parseUiPlatform(input.override) : null;
  const platform = requested ?? os;
  // The Windows and Linux controls are one mechanism (the overlay), so either
  // chrome gets native controls on either OS. Only the Mac is its own world.
  const nativeHere = (platform === 'mac') === (os === 'mac');
  return {
    platform,
    windowControls: nativeHere ? 'native' : 'drawn',
    overridden: requested !== null && requested !== os,
  };
}

/** The `BrowserWindow` options that give the window this chrome. */
export function windowChromeOptions(chrome: UiChrome): BrowserWindowConstructorOptions {
  if (chrome.windowControls === 'drawn') return { frame: false };
  if (chrome.platform === 'mac') {
    // The buttons are ~14px tall; centre them in the toolbar. x matches the
    // inset `MacWindowControls` reserves.
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: Math.round((MAC_TOOLBAR_HEIGHT - 14) / 2) },
    };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...DEFAULT_OVERLAY_COLORS, height: WINDOWS_TITLEBAR_HEIGHT },
  };
}

/** Whether a window built from `chrome` has an overlay `setTitleBarOverlay` can restyle. */
export function hasTitleBarOverlay(chrome: UiChrome): boolean {
  return chrome.windowControls === 'native' && chrome.platform !== 'mac';
}

/** The query the renderer reads at boot (`src/core/config/uiPlatform.ts`). */
export function uiChromeQuery(chrome: UiChrome): Record<string, string> {
  return { uiPlatform: chrome.platform, windowControls: chrome.windowControls };
}

/** `window:setTitleBarOverlay` input: two `#rrggbb` colours and nothing else. */
export function sanitizeOverlayColors(raw: unknown): { color: string; symbolColor: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { color, symbolColor } = raw as Record<string, unknown>;
  const hex = /^#[0-9a-f]{6}$/i;
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return null;
  return hex.test(color) && hex.test(symbolColor) ? { color, symbolColor } : null;
}
