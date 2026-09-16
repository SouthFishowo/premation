/**
 * Engine diagnostics → the person looking at the screen.
 *
 * The renderer states what it could not do (RenderDiagnostics, LayerError);
 * the export gate refuses those frames on its own. This module is the PREVIEW
 * half: say it once, where a user will see it, and never at 60 fps.
 *
 * ── Why this exists instead of `EngineError` ─────────────────────────────
 * Frame diagnostics used to be re-emitted as `EngineError` events. The only
 * listener, `renderBackendStore`, reads `EngineError` on the viewport as "this
 * GPU tier failed to initialise" — so a single offline image or an unhonoured
 * matte flipped the viewport badge to "Software rendering" on a perfectly
 * healthy GPU. A frame problem is not an engine problem, and routing it here
 * keeps the two apart.
 *
 * ── Rules ─────────────────────────────────────────────────────────────────
 *  • Deduplicated by the diagnostic's text, for the session (bounded): a layer
 *    that stays broken is reported once, not once per frame.
 *  • Rate-limited toasts: at most one per `TOAST_INTERVAL_MS`, collapsed into a
 *    single group, so a scene with twenty broken layers is one notice that
 *    counts them rather than twenty notices.
 *  • Console first, always — the dev log is the full record; the toast is the
 *    pointer to it.
 *  • Toasts only for the interactive viewport. Thumbnails, export previews and
 *    secondary panes render the same scene and would repeat the same notice.
 */

import { useUIStore } from '@stores/uiStore';

export type EngineRole = 'viewport' | 'auxiliary';

export interface FrameDiagnostic {
  code: string;
  detail: string;
  layerId?: string;
}

/** Remembered details. Bounded so a very long session cannot grow it forever. */
const MAX_REMEMBERED = 512;
const TOAST_INTERVAL_MS = 5000;

const reported = new Set<string>();
let lastToastAt = -Infinity;
let suppressedSinceToast = 0;

function remember(key: string): boolean {
  if (reported.has(key)) return false;
  if (reported.size >= MAX_REMEMBERED) reported.clear();
  reported.add(key);
  return true;
}

function toast(
  level: 'info' | 'success' | 'warning' | 'error',
  message: string,
  detail?: string,
  group = 'engine-diagnostics',
  sticky = false,
): void {
  try {
    useUIStore.getState().notify({
      level,
      message,
      durationMs: sticky ? 0 : level === 'error' ? 8000 : 5000,
      group,
      ...(sticky ? { sticky: true } : {}),
      ...(detail ? { detail } : {}),
    });
  } catch {
    /* no UI (tests, headless) — the console line already carries it */
  }
}

/**
 * Report one frame's diagnostics. Allocation-free when the list is empty,
 * which is every healthy frame.
 */
export function reportFrameDiagnostics(
  items: ReadonlyArray<FrameDiagnostic>,
  role: EngineRole,
  engine: string,
  now: number = Date.now(),
): void {
  if (items.length === 0) return;
  let fresh: FrameDiagnostic[] | null = null;
  for (const d of items) {
    if (!remember(`${d.code}|${d.detail}`)) continue;
    (fresh ??= []).push(d);

    console.warn(`[engine:${engine}:${role}] ${d.code}: ${d.detail}`);
  }
  if (!fresh || role !== 'viewport') return;
  if (now - lastToastAt < TOAST_INTERVAL_MS) {
    suppressedSinceToast += fresh.length;
    return;
  }
  const first = fresh[0]!;
  const more = fresh.length - 1 + suppressedSinceToast;
  suppressedSinceToast = 0;
  lastToastAt = now;
  toast(
    'warning',
    more > 0 ? `${first.detail} (+${more} more — see the console)` : first.detail,
    'Preview keeps the frame; export will refuse it until this is fixed.',
  );
}

/** "Graphics were reset — recovered." Viewport only; always logged. */
export function notifyGpuRecovered(role: EngineRole, engine: string, reason: string): void {
  console.warn(`[engine:${engine}:${role}] GPU ${reason ? `lost (${reason}) — ` : ''}recovered`);
  if (role !== 'viewport') return;
  toast('info', 'Graphics were reset — recovered', undefined, 'engine-gpu-loss');
}

/** Recovery stopped (loss loop, or no tier came back). Viewport only; always logged. */
export function notifyGpuRecoveryFailed(role: EngineRole, engine: string, message: string): void {
  console.error(`[engine:${engine}:${role}] GPU recovery stopped: ${message}`);
  if (role !== 'viewport') return;
  // Sticky: the preview stays down until the user acts, so a notice that
  // times out would leave a blank viewport with no explanation.
  toast('error', 'Graphics keep resetting', message, 'engine-gpu-loss', true);
}

/** Test seam: forget what was reported and reset the toast clock. */
export function resetEngineDiagnostics(): void {
  reported.clear();
  lastToastAt = -Infinity;
  suppressedSinceToast = 0;
}
