/**
 * The Paint and Brushes panels' settings (AE's two paint panels) — everything a
 * new paint stroke records that the freehand-shape brush does not have.
 *
 * Diameter and foreground colour are SHARED with the freehand brush and live on
 * the engine's `drawToolOptions` (`brushSize` / `brushColor`), so the one Tool
 * Options bar, the Brushes panel and the freehand brush all drive the same two
 * values — no duplicate size/colour source. Everything else is here.
 */

import { create } from 'zustand';
import { drawToolOptions } from '@motion/workspace';
import type {
  BrushDynamics,
  DynamicsSource,
  EraseMode,
  PaintBlend,
  PaintChannels,
  PaintMode,
} from '@core/paint/paintStrokes';
import type { PaintDuration } from '@core/paint/paintCapture';

/** A Brushes panel tip preset. */
export interface BrushPreset {
  name: string;
  diameter: number;
  angle: number;
  roundness: number; // 0..1
  hardness: number; // 0..1
  spacing: number; // 0..1 of diameter
}

/** One of AE's five Clone Stamp presets (keys 3–7). */
export interface ClonePreset {
  sourceLayerId: string | null;
  aligned: boolean;
  lockTime: boolean;
  sourceTime: number;
  timeShift: number;
}

/** AE's default tip list: hard rounds, then soft rounds. */
export const DEFAULT_BRUSH_PRESETS: ReadonlyArray<BrushPreset> = [
  ...[1, 3, 5, 9, 13, 19].map((d) => ({ name: `Hard ${d}`, diameter: d, angle: 0, roundness: 1, hardness: 1, spacing: 0.25 })),
  ...[5, 9, 13, 17, 21, 27, 35, 45, 65, 100].map((d) => ({ name: `Soft ${d}`, diameter: d, angle: 0, roundness: 1, hardness: 0, spacing: 0.25 })),
];

const defaultClonePreset = (): ClonePreset => ({ sourceLayerId: null, aligned: true, lockTime: false, sourceTime: 0, timeShift: 0 });

export interface PaintSettings {
  // ── Paint panel ────────────────────────────────────────────────────
  opacity: number; // 0..1
  flow: number; // 0..1
  blend: PaintBlend;
  channels: PaintChannels;
  duration: PaintDuration;
  customFrames: number;
  /** The Paint tool's kind (brush / clone); the Eraser tool always erases. */
  mode: PaintMode;
  eraseMode: EraseMode;
  /** AE's background colour (X swaps, D resets). The foreground is `drawToolOptions.brushColor`. */
  backgroundColor: string;

  // ── Brushes panel ──────────────────────────────────────────────────
  hardness: number; // 0..1 — 1 = hard edge
  angle: number; // degrees
  roundness: number; // 0..1
  spacing: number; // 0..1 of diameter
  dynamics: Required<Pick<BrushDynamics, 'size' | 'angle' | 'roundness' | 'opacity' | 'flow'>> & { minSize: number };
  /** Input smoothing 0..1. */
  smoothing: number;
  brushPresets: BrushPreset[];

  // ── Clone Options ──────────────────────────────────────────────────
  /**
   * Clone stamp source — set by Alt-click, consumed at each stroke. Stored in
   * the aimed LAYER's own local px and tagged with its id (plus the comp point,
   * for the viewer's source overlay).
   *
   * A source aimed on one layer used to be reinterpreted on whichever layer was
   * selected next. It now only means something on the layer it was taken from
   * — or, when the Paint panel's Source names that layer, on any target, which
   * is AE's cross-layer clone.
   */
  cloneSource: { nodeId: string; x: number; y: number; compX?: number; compY?: number } | null;
  /** Paint panel ▸ Source; null = the layer being painted. */
  cloneSourceLayerId: string | null;
  cloneAligned: boolean;
  cloneLockTime: boolean;
  cloneSourceTime: number;
  cloneTimeShift: number;
  /** The fixed offset Aligned carries between strokes, per target layer. */
  alignedOffset: { nodeId: string; x: number; y: number } | null;
  clonePresets: ClonePreset[];
  activeClonePreset: number;
  cloneOverlay: boolean;
  cloneOverlayOpacity: number; // 0..1
  cloneOverlayDifference: boolean;

  /** A stroke selected in the Paint panel: drawing replaces its Path. */
  selectedStroke: { nodeId: string; strokeId: string } | null;
}

interface PaintStore extends PaintSettings {
  set: (patch: Partial<PaintSettings>) => void;
  setDynamics: (key: keyof PaintSettings['dynamics'], value: DynamicsSource | number) => void;
  /** X — swap foreground and background colours. */
  swapColors: () => void;
  /** D — AE's default colours: black foreground, white background. */
  resetColors: () => void;
  applyBrushPreset: (p: BrushPreset) => void;
  saveBrushPreset: (name: string) => void;
  /** Keys 3–7: make preset `i` current, loading its clone options. */
  selectClonePreset: (i: number) => void;
}

/** The clone options a preset slot holds, from the live settings. */
function clonePresetOf(s: PaintSettings): ClonePreset {
  return {
    sourceLayerId: s.cloneSourceLayerId,
    aligned: s.cloneAligned,
    lockTime: s.cloneLockTime,
    sourceTime: s.cloneSourceTime,
    timeShift: s.cloneTimeShift,
  };
}

const CLONE_KEYS: ReadonlyArray<keyof PaintSettings> = ['cloneSourceLayerId', 'cloneAligned', 'cloneLockTime', 'cloneSourceTime', 'cloneTimeShift'];

export const usePaintStore = create<PaintStore>((set, get) => ({
  opacity: 1,
  flow: 1,
  blend: 'normal',
  channels: 'rgba',
  duration: 'constant',
  customFrames: 1,
  mode: 'paint',
  eraseMode: 'layerAndPaint',
  backgroundColor: '#000000',
  hardness: 1,
  angle: 0,
  roundness: 1,
  spacing: 0.25,
  dynamics: { size: 'off', angle: 'off', roundness: 'off', opacity: 'off', flow: 'off', minSize: 0 },
  smoothing: 0,
  brushPresets: [...DEFAULT_BRUSH_PRESETS],
  cloneSource: null,
  cloneSourceLayerId: null,
  cloneAligned: true,
  cloneLockTime: false,
  cloneSourceTime: 0,
  cloneTimeShift: 0,
  alignedOffset: null,
  clonePresets: Array.from({ length: 5 }, defaultClonePreset),
  activeClonePreset: 0,
  cloneOverlay: false,
  cloneOverlayOpacity: 0.5,
  cloneOverlayDifference: false,
  selectedStroke: null,
  set: (patch) => {
    set(patch);
    // Clone options edit the ACTIVE preset, as AE's panel does.
    if (CLONE_KEYS.some((k) => k in patch)) {
      const s = get();
      const presets = s.clonePresets.slice();
      presets[s.activeClonePreset] = clonePresetOf(s);
      set({ clonePresets: presets });
    }
  },
  setDynamics: (key, value) => set((s) => ({ dynamics: { ...s.dynamics, [key]: value } })),
  swapColors: () => {
    const fg = drawToolOptions.brushColor;
    drawToolOptions.brushColor = get().backgroundColor;
    set({ backgroundColor: fg });
  },
  resetColors: () => {
    drawToolOptions.brushColor = '#000000';
    set({ backgroundColor: '#ffffff' });
  },
  applyBrushPreset: (p) => {
    drawToolOptions.brushSize = p.diameter;
    set({ angle: p.angle, roundness: p.roundness, hardness: p.hardness, spacing: p.spacing });
  },
  saveBrushPreset: (name) => {
    const s = get();
    set({
      brushPresets: [
        ...s.brushPresets,
        { name, diameter: drawToolOptions.brushSize, angle: s.angle, roundness: s.roundness, hardness: s.hardness, spacing: s.spacing },
      ],
    });
  },
  selectClonePreset: (i) => {
    const s = get();
    if (i < 0 || i >= s.clonePresets.length) return;
    const p = s.clonePresets[i]!;
    set({
      activeClonePreset: i,
      cloneSourceLayerId: p.sourceLayerId,
      cloneAligned: p.aligned,
      cloneLockTime: p.lockTime,
      cloneSourceTime: p.sourceTime,
      cloneTimeShift: p.timeShift,
      alignedOffset: null,
    });
  },
}));
