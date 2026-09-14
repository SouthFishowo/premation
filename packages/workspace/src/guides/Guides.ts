/**
 * Guides — user-placed and derived reference lines in world space. Supports
 * horizontal/vertical guides, per-guide locking, and computed helpers for the
 * composition frame: safe area, margins, and center guides. Snapping consumes
 * these; the renderer draws them.
 *
 * A guide with `axis: 'x'` is a *vertical* line at world-x = position; `axis:
 * 'y'` is a *horizontal* line at world-y = position (matches design-tool ruler
 * semantics — dragging from the left ruler makes a vertical guide).
 */

import { TypedEmitter } from '../events/Emitter';
import type { Rect } from '../math/Rect';

export type GuideAxis = 'x' | 'y';

export interface Guide {
  id: string;
  axis: GuideAxis;
  /** World coordinate along the perpendicular axis. */
  position: number;
  locked: boolean;
  /** Distinguishes user guides from derived (center/safe-area) guides. */
  kind: 'user' | 'center' | 'safe-area' | 'margin';
  /**
   * AE 26.5 guide metadata (all optional; absent = px / start / theme colour).
   * `position` stays the live world coordinate the engine snaps and draws with;
   * these say how the host re-resolves it when the composition is resized —
   * see the app's `guideGeometry`.
   */
  unit?: 'px' | '%';
  /** `end` pins the guide to the right (x) / bottom (y) edge of the comp. */
  edge?: 'start' | 'end';
  /** Per-guide stroke colour (CSS colour string). */
  color?: string;
}

/** The editable fields of a guide. */
export type GuidePatch = Partial<Pick<Guide, 'position' | 'unit' | 'edge' | 'color' | 'locked'>>;

interface GuideEvents {
  added: { guide: Guide };
  removed: { guideId: string };
  moved: { guide: Guide };
  changed: Record<string, never>;
}

let guideSeq = 0;
function nextGuideId(): string {
  guideSeq += 1;
  return `guide_${guideSeq}`;
}

export class Guides {
  readonly events = new TypedEmitter<GuideEvents>();
  private readonly guides = new Map<string, Guide>();

  /** Composition frame (world rect) used to derive center/safe-area guides. */
  private frame: Rect | null = null;
  private safeAreaInset = 0.1; // fraction of frame

  list(): Guide[] {
    return [...this.guides.values()];
  }

  get(id: string): Guide | undefined {
    return this.guides.get(id);
  }

  add(axis: GuideAxis, position: number, kind: Guide['kind'] = 'user'): Guide {
    const guide: Guide = { id: nextGuideId(), axis, position, locked: false, kind };
    this.guides.set(guide.id, guide);
    this.events.emit('added', { guide });
    this.events.emit('changed', {});
    return guide;
  }

  remove(id: string): boolean {
    const g = this.guides.get(id);
    if (!g || g.locked) return false;
    this.guides.delete(id);
    this.events.emit('removed', { guideId: id });
    this.events.emit('changed', {});
    return true;
  }

  /** Move a guide (no-op if locked). Returns false when blocked/unknown. */
  move(id: string, position: number): boolean {
    const g = this.guides.get(id);
    if (!g || g.locked) return false;
    g.position = position;
    this.events.emit('moved', { guide: g });
    this.events.emit('changed', {});
    return true;
  }

  /**
   * Edit a guide's position and/or metadata in one change. Unlike `move`, a
   * locked guide still takes a metadata edit (colour, unit, pin) — the lock is
   * about dragging it by accident, and the editor is a deliberate act. A
   * `color`/`unit`/`edge` of `undefined` in the patch clears that field.
   */
  update(id: string, patch: GuidePatch): boolean {
    const g = this.guides.get(id);
    if (!g) return false;
    if (patch.position !== undefined && Number.isFinite(patch.position)) g.position = patch.position;
    if ('unit' in patch) { if (patch.unit === undefined || patch.unit === 'px') delete g.unit; else g.unit = patch.unit; }
    if ('edge' in patch) { if (patch.edge === undefined || patch.edge === 'start') delete g.edge; else g.edge = patch.edge; }
    if ('color' in patch) { if (!patch.color) delete g.color; else g.color = patch.color; }
    if (patch.locked !== undefined) g.locked = patch.locked;
    this.events.emit('moved', { guide: g });
    this.events.emit('changed', {});
    return true;
  }

  /**
   * Replace every USER guide wholesale (document restore). Derived guides are
   * untouched; one `changed` event is emitted for the lot.
   */
  replaceUserGuides(
    list: ReadonlyArray<{ axis: GuideAxis; position: number; locked?: boolean; unit?: 'px' | '%'; edge?: 'start' | 'end'; color?: string }>,
  ): void {
    for (const [id, g] of [...this.guides]) {
      if (g.kind === 'user') this.guides.delete(id);
    }
    for (const item of list) {
      const guide: Guide = { id: nextGuideId(), axis: item.axis, position: item.position, locked: item.locked === true, kind: 'user' };
      if (item.unit === '%') guide.unit = '%';
      if (item.edge === 'end') guide.edge = 'end';
      if (item.color) guide.color = item.color;
      this.guides.set(guide.id, guide);
    }
    this.events.emit('changed', {});
  }

  setLocked(id: string, locked: boolean): boolean {
    const g = this.guides.get(id);
    if (!g) return false;
    g.locked = locked;
    this.events.emit('changed', {});
    return true;
  }

  /** The composition frame used to derive center/safe-area guides, if any. */
  get frameRect(): Rect | null {
    return this.frame;
  }

  clear(includeLocked = false): void {
    for (const [id, g] of [...this.guides]) {
      if (includeLocked || !g.locked) this.guides.delete(id);
    }
    this.events.emit('changed', {});
  }

  // ── Derived guides from the composition frame ────────────────────
  /** Set the composition frame and regenerate derived guides. */
  setFrame(frame: Rect | null, safeAreaInset = this.safeAreaInset): void {
    this.frame = frame;
    this.safeAreaInset = safeAreaInset;
    // Drop old derived guides.
    for (const [id, g] of [...this.guides]) {
      if (g.kind !== 'user') this.guides.delete(id);
    }
    if (frame) {
      const cx = frame.x + frame.width / 2;
      const cy = frame.y + frame.height / 2;
      this.internalAdd('x', cx, 'center');
      this.internalAdd('y', cy, 'center');
      const insetX = frame.width * safeAreaInset;
      const insetY = frame.height * safeAreaInset;
      this.internalAdd('x', frame.x + insetX, 'safe-area');
      this.internalAdd('x', frame.x + frame.width - insetX, 'safe-area');
      this.internalAdd('y', frame.y + insetY, 'safe-area');
      this.internalAdd('y', frame.y + frame.height - insetY, 'safe-area');
    }
    this.events.emit('changed', {});
  }

  /** All vertical-line (axis 'x') world positions. */
  verticalPositions(): number[] {
    return this.list()
      .filter((g) => g.axis === 'x')
      .map((g) => g.position);
  }

  /** All horizontal-line (axis 'y') world positions. */
  horizontalPositions(): number[] {
    return this.list()
      .filter((g) => g.axis === 'y')
      .map((g) => g.position);
  }

  private internalAdd(axis: GuideAxis, position: number, kind: Guide['kind']): void {
    const guide: Guide = { id: nextGuideId(), axis, position, locked: kind !== 'user', kind };
    this.guides.set(guide.id, guide);
  }
}
