/**
 * The Paint tools' keyboard, as AE has it:
 *
 *   Ctrl/Cmd+B   cycle Brush → Clone Stamp → Eraser
 *   X            swap foreground / background colours
 *   D            default colours (black / white)
 *   3 – 7        Clone Stamp presets 1–5 (while cloning)
 *
 * Live ONLY while a paint tool is active, so every key keeps its usual meaning
 * everywhere else. Installed as a window capture listener rather than as
 * registry commands because two of these chords are context overloads of
 * existing ones (Ctrl+B is the Bone tool; Bone's command stands aside while a
 * paint tool is active) and the registry has no notion of "only while this
 * tool is up".
 */

import { useUIStore } from '@stores/uiStore';
import { usePaintStore } from '@stores/paintStore';

export type PaintToolKind = 'brush' | 'clone' | 'eraser';

/** Which of AE's three paint tools is current, or null when none is. */
export function currentPaintTool(): PaintToolKind | null {
  const tool = useUIStore.getState().activeTool as string;
  if (tool === 'eraser') return 'eraser';
  if (tool !== 'paint') return null;
  return usePaintStore.getState().mode === 'clone' ? 'clone' : 'brush';
}

export function setPaintTool(kind: PaintToolKind): void {
  const ui = useUIStore.getState();
  if (kind === 'eraser') {
    ui.setActiveTool('eraser');
    return;
  }
  usePaintStore.getState().set({ mode: kind === 'clone' ? 'clone' : 'paint' });
  ui.setActiveTool('paint');
}

/** Ctrl+B: Brush → Clone Stamp → Eraser → Brush. */
export function cyclePaintTool(): void {
  const cur = currentPaintTool();
  setPaintTool(cur === 'brush' ? 'clone' : cur === 'clone' ? 'eraser' : 'brush');
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** Handle one keydown; true when it was a paint key (the caller consumes it). */
export function handlePaintKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>): boolean {
  const kind = currentPaintTool();
  if (!kind || isEditable(e.target)) return false;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && !e.shiftKey && (k === 'b' || e.code === 'KeyB')) {
    cyclePaintTool();
    return true;
  }
  if (mod || e.altKey || e.shiftKey) return false;
  const paint = usePaintStore.getState();
  if (k === 'x') {
    paint.swapColors();
    return true;
  }
  if (k === 'd') {
    paint.resetColors();
    return true;
  }
  const digit = /^Digit([3-7])$/.exec(e.code);
  if (digit && kind === 'clone') {
    paint.selectClonePreset(Number(digit[1]) - 3);
    return true;
  }
  return false;
}

let installed = false;

/** Install the listener once per window (idempotent across HMR / double import). */
export function installPaintKeys(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(
    'keydown',
    (e) => {
      if (!handlePaintKey(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true },
  );
}
