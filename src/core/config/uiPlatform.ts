/**
 * Which desktop chrome the renderer draws — the macOS unified toolbar, or the
 * Windows / Linux title bar over a tool row — and whether the window's controls
 * (traffic lights, caption buttons) are the OS's or ours to draw.
 *
 * ── Where the answer comes from ────────────────────────────────────────────
 *
 *  1. The Electron shell, on the page URL (`?uiPlatform=mac&windowControls=native`).
 *     Main already shaped the window from this answer (`electron/uiPlatform.ts`),
 *     so the renderer takes it rather than working it out again: a Windows bar
 *     drawn inside a window that has native traffic lights is the bug.
 *  2. In a browser dev build only, `PREMATION_UI_PLATFORM` (Vite exposes the
 *     `PREMATION_UI_` prefix). Setting it — or opening the dev server at
 *     `/?uiPlatform=mac` — also turns the desktop chrome ON in the browser, with
 *     drawn controls, so either design can be checked without launching
 *     Electron.
 *  3. The OS: the bridge's `platform`, else the navigator.
 *
 * Only the CHROME follows the override. Keyboard behaviour (⌘ vs Ctrl) keeps
 * following the real OS — a Mac-looking bar on Windows still answers to Ctrl.
 *
 * Set once at boot by `configureUiPlatform` from `main.tsx`, which owns the
 * `import.meta.env` read — `import.meta` trips Jest here, the same reason as
 * `./edition`. Tests use `__setUiPlatformForTests`.
 */

export type UiPlatform = 'mac' | 'windows' | 'linux';
export type WindowControls = 'native' | 'drawn';

interface UiPlatformState {
  platform: UiPlatform;
  windowControls: WindowControls;
  /** A browser dev build previewing the desktop chrome. */
  forcedDesktopChrome: boolean;
}

let state: UiPlatformState | null = null;

/**
 * Parse an env string. Unrecognised (including empty) means "no override".
 * Kept identical to `parseUiPlatform` in `electron/uiPlatform.ts`.
 */
export function parseUiPlatform(raw: string | undefined | null): UiPlatform | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'mac' || v === 'macos' || v === 'darwin' || v === 'osx') return 'mac';
  if (v === 'windows' || v === 'win' || v === 'win32') return 'windows';
  if (v === 'linux') return 'linux';
  return null;
}

function parseWindowControls(raw: string | null): WindowControls | null {
  return raw === 'native' || raw === 'drawn' ? raw : null;
}

function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && (!!window.motionEditor || !!window.electronAPI);
}

function detectPlatform(): UiPlatform {
  const bridge = typeof window !== 'undefined' ? window.motionEditor?.platform : undefined;
  if (bridge === 'darwin') return 'mac';
  if (bridge === 'win32') return 'windows';
  if (bridge === 'linux') return 'linux';
  const nav = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '';
  if (/Mac|iPhone|iPad|iPod/.test(nav)) return 'mac';
  if (/Linux|X11/.test(nav)) return 'linux';
  return 'windows';
}

export interface UiPlatformBoot {
  /** `window.location.search`. */
  search: string;
  /** `import.meta.env.PREMATION_UI_PLATFORM`. */
  devOverride?: string;
  /** `import.meta.env.DEV`. The override is ignored outside development. */
  isDev: boolean;
}

export function configureUiPlatform({ search, devOverride, isDev }: UiPlatformBoot): void {
  const params = new URLSearchParams(search);
  const fromShell = parseUiPlatform(params.get('uiPlatform'));
  const fromEnv = isDev ? parseUiPlatform(devOverride) : null;
  const electron = isElectronRuntime();
  state = {
    platform: fromShell ?? fromEnv ?? detectPlatform(),
    // No query means a shell that predates it — a frameless window, which is
    // exactly what drawn controls assume.
    windowControls: parseWindowControls(params.get('windowControls')) ?? 'drawn',
    // A browser dev build previews the desktop chrome when asked — by the env,
    // or by the same query the shell sends (`/?uiPlatform=mac`), so two tabs
    // can show both designs side by side. Never in a production web build.
    forcedDesktopChrome: !electron && isDev && (fromEnv !== null || fromShell !== null),
  };
  if (typeof document !== 'undefined') document.documentElement.dataset.platform = state.platform;
}

export function getUiPlatform(): UiPlatform {
  return state?.platform ?? detectPlatform();
}

export function getWindowControls(): WindowControls {
  return state?.windowControls ?? 'drawn';
}

/** Draw the desktop title bar at all: in Electron, or in a browser previewing it. */
export function hasDesktopChrome(): boolean {
  return isElectronRuntime() || state?.forcedDesktopChrome === true;
}

/** Test seam. `null` returns to "not configured" (OS detection). */
export function __setUiPlatformForTests(next: Partial<UiPlatformState> | null): void {
  state = next ? { platform: 'windows', windowControls: 'drawn', forcedDesktopChrome: false, ...next } : null;
}
