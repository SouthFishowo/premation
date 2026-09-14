/**
 * Layer ▸ Time — the footage verbs as COMMANDS: Time-Reverse Layer, Freeze
 * Frame at playhead, Freeze On Last Frame, Time Stretch…, Enable/Remove Time
 * Remapping, and the frame-blend modes.
 *
 * Every one of these already existed as a switch somewhere — the Compositing
 * section's Time group, the viewport's right-click Video submenu — but the
 * application menu's Time entry listed two speed ramps and nothing else, so
 * the menu (and the command palette that reads it) said the editor could not
 * reverse or freeze footage. After Effects keeps all of these under
 * Layer ▸ Time; so does this. The writes go through the same
 * `updateNodeLayerTime` / time-remap track the switches use, so the two
 * surfaces cannot disagree.
 *
 * ── TIME STRETCH AND THE CLIP BAR ──────────────────────────────────────────
 * Stretch used to change the playback rate and nothing else: the bar kept its
 * length, so a 200 % layer ran out of bar half-way through its footage, and
 * there was no way to say WHICH moment should stay put. AE's dialog asks for
 * a Hold in Place point (in-point, current frame, out-point); the bar scales
 * about that frame and the source frame showing there is unchanged. See
 * `stretchClipGeometry` for the derivation — clip bars are FRAMES, the stretch
 * is applied on top of the clip map in SOURCE seconds, anchored at the
 * keyframe span start, exactly as `compToKeyframeTime` composes them.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { defaultAnimation, type BezierHandles } from '@motion/animation';
import { customPrompt } from '@components/Modal';
import { getEventBus } from '@core/events/EventBus';
import { readNodeMaskAnim } from '@core/effects/mask';
import { useUIStore } from '@stores/uiStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isPrecomp } from '@core/scene/precomp';
import { readNodeKind } from '@core/scene/sceneDerive';
import { getNodeLayerTime, updateNodeLayerTime, type FrameBlend } from '@core/scene/layerTime';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import { runAnimEdit } from './animationCommands';
import { runAsOneHistoryEntrySync } from '@core/composition/compositeEdit';

/** Same prop names PrecompControl writes — one track, two surfaces. */
const REMAP = 'timeRemap';
const LEGACY_REMAP = 'precompTime';

function playhead(): number {
  const project = useProjectStore.getState();
  return (project.activeTabId ? project.tabs[project.activeTabId]?.time : 0) ?? 0;
}

/** Layers whose source has a time axis to retime: footage, audio, precomps. */
function retimable(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const kind = readNodeKind(node);
  return kind === 'video' || kind === 'audio' || isPrecomp(node);
}

/** For the dialog and the inspector: footage stretches its playback rate, everything else bakes. */
export function isRetimableLayer(nodeId: string): boolean {
  return retimable(nodeId);
}

/**
 * What Time Stretch applies to: EVERY layer, as in After Effects. A solid,
 * shape, text, null, camera or light has no source to resample, so the stretch
 * scales its bar and its keyframes instead (`bakeLayerStretch`). Only the comp
 * root — no parent — is not a layer.
 */
function stretchable(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && node.parent !== null && node.parent !== undefined;
}

/** Reverse, Freeze, Time Remap and Frame Blend: footage-like layers only. */
export function timeTargets(): string[] {
  return useSelectionStore.getState().ids.filter(retimable);
}

/** Time Stretch: any selected layer. */
export function stretchTargets(): string[] {
  return useSelectionStore.getState().ids.filter(stretchable);
}

function notify(message: string): void {
  useUIStore.getState().notify({ level: 'info', message, durationMs: 3500 });
}

/** Reverse (or un-reverse) every selected footage layer. */
export function toggleReverse(ids: ReadonlyArray<string>): void {
  const anyForward = ids.some((id) => !getNodeLayerTime(id).reverse);
  for (const id of ids) updateNodeLayerTime(id, { reverse: anyForward });
}

/** Freeze every selected layer on the frame under the playhead (or unfreeze). */
export function toggleFreeze(ids: ReadonlyArray<string>, compTime: number): void {
  const anyLive = ids.some((id) => !getNodeLayerTime(id).freeze);
  for (const id of ids) {
    updateNodeLayerTime(id, anyLive ? { freeze: true, freezeTime: compTime } : { freeze: false });
  }
}

/** Clamp a stretch percentage to what `layerTime` stores (1…1000, whole %). */
export function clampStretch(percent: number): number {
  return Math.max(1, Math.min(1000, Math.round(percent)));
}

/** Time stretch as a percentage of the original duration (100 = as shot). */
export function applyStretch(ids: ReadonlyArray<string>, percent: number): void {
  const stretch = clampStretch(percent);
  for (const id of ids) updateNodeLayerTime(id, { stretch });
}

export function setFrameBlend(ids: ReadonlyArray<string>, frameBlend: FrameBlend): void {
  for (const id of ids) updateNodeLayerTime(id, { frameBlend });
}

export function hasTimeRemap(nodeId: string): boolean {
  return defaultAnimation.isAnimated(nodeId, REMAP) || defaultAnimation.isAnimated(nodeId, LEGACY_REMAP);
}

/**
 * Enable time remapping: one keyframe at the playhead holding the current
 * source time (the identity — nothing moves until a second keyframe does),
 * exactly what PrecompControl's switch writes. Remove drops both tracks.
 */
export function toggleTimeRemap(ids: ReadonlyArray<string>, compTime: number): void {
  const anyOff = ids.some((id) => !hasTimeRemap(id));
  runAnimEdit(anyOff ? 'Enable time remap' : 'Remove time remap', () => defaultAnimation.batch(() => {
    for (const id of ids) {
      if (anyOff) {
        if (hasTimeRemap(id)) continue;
        const remapT = compToKeyframeTime(id, compTime, REMAP);
        defaultAnimation.setKeyframe(id, REMAP, remapT, compTime);
      } else {
        defaultAnimation.removeTrack(id, REMAP);
        defaultAnimation.removeTrack(id, LEGACY_REMAP);
      }
    }
  }));
}

// ── Time Stretch with Hold in Place ─────────────────────────────────────────

export type StretchHold = 'in' | 'current' | 'out';

/** A clip bar in FRAMES (end exclusive), plus the source frame it starts on. */
export interface ClipGeometry {
  start: number;
  duration: number;
  sourceIn: number;
}

/** The comp frame a stretch holds in place, given the layer's span (frames). */
export function holdFrameFor(
  span: { start: number; end: number },
  hold: StretchHold,
  currentFrame: number,
): number {
  if (hold === 'in') return span.start;
  if (hold === 'out') return span.end;
  return currentFrame;
}

/**
 * The bar after changing the stretch from `oldStretch` to `newStretch` %,
 * holding comp frame `holdFrame` in place.
 *
 * The renderer maps comp frame f to source seconds in two steps:
 *   c = (sourceIn + f − start) / fps          (the clip map)
 *   s = a + (c − a) · 100 / stretch           (`layerTime.remapTime`, a = span start)
 *
 * Holding frame H means s(H) is unchanged. With r = new / old, the bar scales
 * about H (start' = H − (H − start)·r, duration' = duration·r) and the clip map
 * must satisfy c'(H) − a = (c(H) − a)·r, which fixes sourceIn'. Keyframes live
 * on the source axis, so they follow automatically — the same composition
 * `compToKeyframeTime` / `keyframeToCompTime` use to place the diamonds.
 *
 * A bar cannot start before frame 0; when it would, the start clamps and
 * sourceIn is recomputed from the clamped start so the held frame still shows
 * the same source frame.
 */
export function stretchClipGeometry(
  clip: ClipGeometry,
  oldStretch: number,
  newStretch: number,
  holdFrame: number,
  fps: number,
  spanStartSec = 0,
  bounded = false,
): ClipGeometry {
  const r = newStretch / (oldStretch > 0 ? oldStretch : 100);
  if (!Number.isFinite(r) || r <= 0 || r === 1) return { ...clip };
  const H = holdFrame;
  const duration = Math.max(1, Math.round(clip.duration * r));
  const start = Math.max(0, Math.round(H - (H - clip.start) * r));
  const c0 = (clip.sourceIn + H - clip.start) / fps;
  const a = spanStartSec;
  let sourceIn = Math.round(fps * (a + (c0 - a) * r) - H + start);
  if (bounded) sourceIn = Math.max(0, sourceIn);
  return { start, duration, sourceIn };
}

/**
 * Stretch `ids` to `percent`, scaling each bar about its Hold in Place frame.
 * The bar geometry is ONE timeline history entry for the whole selection.
 */
export function applyTimeStretch(
  ids: ReadonlyArray<string>,
  percent: number,
  hold: StretchHold,
  compTime = playhead(),
): Promise<void> {
  // ONE undo entry. The bar lengths live in the engine's clip history and the
  // stretch factor on the scene (the app's snapshot history), so writing each
  // through its own history left two Ctrl+Z presses for one dialog OK — the
  // first undid the bar and left the footage playing at the new rate.
  // A document-level entry captures both domains around the whole edit — and a
  // non-footage stretch adds keyframes to that list. The edit is synchronous,
  // so the SYNC variant: the async one re-enables history recording only a
  // microtask later, and a control edited in the same turn (the inspector's
  // Time Stretch field, then the next field) recorded nothing.
  try {
    runAsOneHistoryEntrySync('Time Stretch', () => applyTimeStretchNow(ids, percent, hold, compTime));
    return Promise.resolve();
  } catch (err) {
    return Promise.reject(err);
  }
}

function applyTimeStretchNow(
  ids: ReadonlyArray<string>,
  percent: number,
  hold: StretchHold,
  compTime: number,
): void {
  const signed = clampSignedStretch(percent);
  // A layer with no source (solid, shape, text, null, camera, light) has
  // nothing to resample: AE stretches its bar, keyframes and markers. `signed`
  // is the ABSOLUTE value the layer should end at; the bake applies the
  // relative factor from the value it stores. See `bakeLayerStretch`.
  const baked = ids.filter((id) => stretchable(id) && !retimable(id));
  if (baked.length > 0) bakeLayerStretch(baked, signed, hold, compTime);
  // Footage keeps its playback-rate path. A negative factor means "reverse the
  // keyframes", which footage expresses with Time-Reverse Layer instead.
  const footage = signed > 0 ? ids.filter(retimable) : [];
  if (footage.length === 0) return;

  const stretch = clampStretch(signed);
  const c = getTimelineController();
  const fps = c.timeline.getFrameRate().fps;
  const currentFrame = Math.round(compTime * fps);

  type Edit = { layer: ReturnType<typeof c.getLayersForNode>[number]; prev: ClipGeometry; next: ClipGeometry };
  const edits: Edit[] = [];
  const markerMoves: Array<{ id: string; anchor: number; place: (f: number) => number; scale: number }> = [];
  for (const id of footage) {
    const old = getNodeLayerTime(id).stretch;
    if (old === stretch) continue;
    const layers = c.getLayersForNode(id).filter((l) => !l.locked);
    if (layers.length === 0) continue;
    const span = {
      start: Math.min(...layers.map((l) => l.start)),
      end: Math.max(...layers.map((l) => l.start + l.duration)),
    };
    const H = holdFrameFor(span, hold, currentFrame);
    const a = defaultAnimation.timeSpan(id)?.start ?? 0;
    const r = stretch / (old > 0 ? old : 100);
    let shift: number | null = null;
    for (const layer of layers) {
      const prev = { start: layer.clip.start, duration: layer.clip.duration, sourceIn: layer.clip.sourceIn };
      const next = stretchClipGeometry(prev, old, stretch, H, fps, a, layer.clip.sourceDuration !== null);
      // A bar clamped at frame 0 slid right; its markers slide with it.
      shift ??= next.start - (H - (H - prev.start) * r);
      edits.push({ layer, prev, next });
    }
    const s = shift ?? 0;
    markerMoves.push({
      id,
      anchor: c.getLayersForNode(id)[0]?.start ?? 0,
      place: (f) => H + (f - H) * r + s,
      scale: r,
    });
  }

  if (edits.length > 0) {
    // Silently: the caller's single document-level entry is the undo step. A
    // recorded engine command would also sit on the engine's own stack.
    c.timeline.history.silently(() => {
      for (const e of edits) {
        e.layer.clip.start = e.next.start;
        e.layer.clip.duration = e.next.duration;
        e.layer.clip.sourceIn = e.next.sourceIn;
        c.timeline.events.emit('LayerUpdated', { layer: e.layer, changed: 'clip' });
      }
      for (const m of markerMoves) moveLayerMarkers(m.id, m.anchor, m.place, m.scale, false);
    });
  }
  // Footage ONLY: the stored rate is what the renderer time-scales by, and a
  // non-footage layer in the same selection has already been baked.
  for (const id of footage) updateNodeLayerTime(id, { stretch });
}

// ── The stretch value a layer shows ─────────────────────────────────────────

/** Where a non-footage layer keeps its stretch — bookkeeping only (see `stretchValueOf`). */
const BAKED_STRETCH_KEY = 'bakedStretch';

/**
 * A non-footage layer's current stretch %, signed (−100 = reversed), default
 * 100. Stored on `fx.bakedStretch` — NOT `fx.time.stretch`, which the renderer
 * time-scales by: the bake has already moved the bar, keyframes and markers,
 * so this value only records where the layer stands. It is saved with the
 * scene, restored by undo, and nothing re-applies it on load.
 */
export function readBakedStretch(nodeId: string): number {
  const fx = defaultSceneGraph.getNode(nodeId)?.components.find((c) => c.type === 'fx');
  const v = (fx?.props as Record<string, unknown> | undefined)?.[BAKED_STRETCH_KEY];
  return typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : 100;
}

function writeBakedStretch(nodeId: string, value: number): void {
  defaultSceneGraph.setFxKey(nodeId, BAKED_STRETCH_KEY, value === 100 ? undefined : value);
  getEventBus().emit('AnimationChanged', { nodeId });
}

/** The absolute stretch % the dialog, the inspector and any Stretch column show. */
export function stretchValueOf(nodeId: string): number {
  return retimable(nodeId) ? getNodeLayerTime(nodeId).stretch : readBakedStretch(nodeId);
}

/**
 * Move a layer's markers with its stretched bar.
 *
 * A layer marker's frame is relative to the node's FIRST bar (`getLayerMarkers`
 * reads it through `toAbsoluteTime`), so: to comp frames with the anchor from
 * BEFORE the edit, through `place` (the same comp-frame map the bar took), back
 * with the anchor AFTER it. A span scales by `scale`; reversed, its END lands
 * where its start was mirrored to. Call inside the edit's `history.silently`.
 */
function moveLayerMarkers(
  nodeId: string,
  anchorBefore: number,
  place: (frame: number) => number,
  scale: number,
  reversed: boolean,
): void {
  const c = getTimelineController();
  const layers = c.getLayersForNode(nodeId);
  const anchorAfter = layers[0]?.start ?? anchorBefore;
  for (const layer of layers) {
    const markers = layer.markers.list();
    if (markers.length === 0) continue;
    for (const m of markers) {
      const from = anchorBefore + m.frame;
      const start = reversed ? place(from + m.duration) : place(from);
      m.frame = Math.max(0, Math.round(start) - anchorAfter);
      m.duration = Math.max(0, Math.round(m.duration * Math.abs(scale)));
      c.timeline.events.emit('MarkerUpdated', { marker: m });
    }
    layer.markers.reindex();
  }
}

// ── Time Stretch on layers with no source ───────────────────────────────────

/**
 * A signed stretch factor, clamped to what the dialog accepts: ±1…1000 %, whole
 * percent. Negative is AE's backwards stretch (−100 % = same length, reversed).
 * Zero and garbage mean "no change" (100).
 */
export function clampSignedStretch(percent: number): number {
  if (!Number.isFinite(percent) || Math.round(percent) === 0) return 100;
  return percent < 0 ? -clampStretch(-percent) : clampStretch(percent);
}

const REMAP_TRACKS: ReadonlySet<string> = new Set([REMAP, LEGACY_REMAP]);

/** A baked stretch: the new bars, and the affine map every keyframe time takes. */
export interface StretchBake {
  bars: ClipGeometry[];
  /** New keyframe time = keyOffset + keyScale · old keyframe time (seconds). */
  keyScale: number;
  keyOffset: number;
  /** Old comp frame → new comp frame (continuous) — how markers move with the bar. */
  place: (frame: number) => number;
}

/**
 * Time Stretch for a layer with no source (solid, shape, text, null, camera,
 * light), which AE implements by scaling the bar AND the keyframes about the
 * Hold in Place frame — there is no footage to play slower.
 *
 * Keyframe k (seconds) shows at comp frame f = D + k·fps on a bar with
 * D = start − sourceIn (the clip map `compToKeyframeTime` inverts). The stretch
 * moves every comp frame to G(f) = H + (f − H)·|r| (plus a shift when the bar
 * would start before frame 0), and a negative factor then mirrors the result
 * within the new bar: F(f) = S + E − G(f). Both are affine in f, so the keyframe
 * map is affine too: k' = keyOffset + sign(r)·|r|·k, fixed by keeping the
 * earliest bar's `sourceIn` (F(D + k·fps) = D' + k'·fps). Every other bar of a
 * split layer takes the `sourceIn` that makes the same k' land at the same F —
 * so the composition of bars and keys is exactly the stretched picture.
 *
 * Bar edges round to whole frames; keyframe times do not, so a key on a
 * sub-frame stays where the maths puts it. Null for no bars or a zero factor.
 */
export function bakeStretchGeometry(
  bars: ReadonlyArray<ClipGeometry>,
  factor: number,
  holdFrame: number,
  fps: number,
): StretchBake | null {
  if (bars.length === 0 || !Number.isFinite(factor) || factor === 0 || !(fps > 0)) return null;
  if (factor === 1) return { bars: bars.map((b) => ({ ...b })), keyScale: 1, keyOffset: 0, place: (f) => f };
  const H = holdFrame;
  const ra = Math.abs(factor);
  const reversed = factor < 0;
  const scaled = bars.map((b) => ({
    start: Math.round(H + (b.start - H) * ra),
    duration: Math.max(1, Math.round(b.duration * ra)),
  }));
  const shift = Math.max(0, -Math.min(...scaled.map((s) => s.start)));
  for (const s of scaled) s.start += shift;
  const S = Math.min(...scaled.map((s) => s.start));
  const E = Math.max(...scaled.map((s) => s.start + s.duration));
  const G = (f: number): number => H + (f - H) * ra + shift;
  const place = (f: number): number => (reversed ? S + E - G(f) : G(f));
  const starts = scaled.map((s) => (reversed ? S + E - (s.start + s.duration) : s.start));

  let p = 0;
  bars.forEach((b, i) => {
    if (b.start < bars[p]!.start) p = i;
  });
  const primary = bars[p]!;
  const alphaFrames = place(primary.start - primary.sourceIn) - starts[p]! + primary.sourceIn;
  const out = bars.map((b, i): ClipGeometry => {
    const start = starts[i]!;
    const duration = scaled[i]!.duration;
    if (i === p) return { start, duration, sourceIn: b.sourceIn };
    const D = place(b.start - b.sourceIn) - alphaFrames;
    return { start, duration, sourceIn: Math.round(start - D) };
  });
  return { bars: out, keyScale: reversed ? -ra : ra, keyOffset: alphaFrames / fps, place };
}

const EASE_MIRROR: Readonly<Record<string, string>> = { easeIn: 'easeOut', easeOut: 'easeIn' };

/**
 * Keyframes after `t → offset + scale·t`, in time order.
 *
 * A NEGATIVE scale reverses the track, and a key's easing describes the
 * segment that STARTS at it — so each key takes over the easing of the key
 * that now follows it (its old predecessor), bezier handles mirrored in time
 * and Ease In / Ease Out swapped, and its spatial in/out tangents trade places.
 * Works for scalar and data keyframes alike (same `easing`/`bezier`/`si`/`so`).
 */
export function retimeKeys<K extends { t: number }>(keys: ReadonlyArray<K>, scale: number, offset: number): K[] {
  const moved = [...keys]
    .sort((a, b) => a.t - b.t)
    .map((k) => ({ ...k, t: offset + scale * k.t }))
    .sort((a, b) => a.t - b.t);
  if (scale >= 0) return moved;
  return moved.map((k, j) => {
    const out = { ...k } as Record<string, unknown>;
    const src = k as Record<string, unknown>;
    delete out.si;
    delete out.so;
    if (src.so !== undefined) out.si = src.so;
    if (src.si !== undefined) out.so = src.si;
    const owner = moved[j + 1] as Record<string, unknown> | undefined;
    if (owner) {
      delete out.easing;
      delete out.bezier;
      delete out.continuous;
      if (typeof owner.easing === 'string') out.easing = EASE_MIRROR[owner.easing] ?? owner.easing;
      const b = owner.bezier as BezierHandles | undefined;
      if (b) out.bezier = [1 - b[2], 1 - b[3], 1 - b[0], 1 - b[1]];
      if (owner.continuous !== undefined) out.continuous = owner.continuous;
    }
    return out as K;
  });
}

/**
 * Retime every keyframe the layer owns: scalar tracks (transform, effects,
 * masks' feather/opacity/expansion, text animators, …), data tracks (Source
 * Text holds, gradient stops, mask paths) and the whole-mask shape track.
 * Expressions are untouched — they are not keyframes. The time-remap track is
 * skipped: a non-footage layer has none, and it lives on a different axis.
 */
export function retimeLayerKeyframes(nodeId: string, keyScale: number, keyOffset: number): void {
  if (keyScale === 1 && keyOffset === 0) return;
  defaultAnimation.batch(() => {
    for (const prop of defaultAnimation.getAnimatedPropPaths(nodeId)) {
      if (REMAP_TRACKS.has(prop)) continue;
      const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
      if (!kfs || kfs.length === 0) continue;
      defaultAnimation.setTrackKeyframes(nodeId, prop, retimeKeys(kfs, keyScale, keyOffset));
    }
    for (const prop of defaultAnimation.getDataAnimatedPropPaths(nodeId)) {
      const track = defaultAnimation.getDataTrack(nodeId, prop);
      if (!track || track.keyframes.length === 0) continue;
      defaultAnimation.setDataTrack(nodeId, prop, { ...track, keyframes: retimeKeys(track.keyframes, keyScale, keyOffset) });
    }
  });
  const node = defaultSceneGraph.getNode(nodeId);
  const maskKeys = node ? readNodeMaskAnim(node) : [];
  if (maskKeys.length > 0) {
    defaultSceneGraph.setMaskAnim(nodeId, retimeKeys(maskKeys, keyScale, keyOffset));
    getEventBus().emit('AnimationChanged', { nodeId });
  }
}

/**
 * Take each layer from its STORED stretch to `target` (absolute, signed %): the
 * relative factor target / current scales its bar(s), keyframes and markers
 * about its hold frame (a sign change reverses them), then `target` is
 * recorded. 200 → 100 therefore puts a layer back exactly where it started.
 */
function bakeLayerStretch(
  ids: ReadonlyArray<string>,
  target: number,
  hold: StretchHold,
  compTime: number,
): void {
  const c = getTimelineController();
  for (const id of ids) {
    const factor = target / readBakedStretch(id);
    if (!Number.isFinite(factor) || factor === 0 || factor === 1) continue;
    const all = c.getLayersForNode(id);
    const layers = all.filter((l) => !l.locked);
    // No bar, no hold frame to stretch about — and nothing on screen to scale.
    if (layers.length === 0) continue;
    // Markers are stored relative to the node's first bar, as it is NOW.
    const markerAnchor = all[0]?.start ?? 0;
    const fps = c.fpsForNode(id);
    const span = {
      start: Math.min(...layers.map((l) => l.start)),
      end: Math.max(...layers.map((l) => l.start + l.duration)),
    };
    const H = holdFrameFor(span, hold, Math.round(compTime * fps));
    const plan = bakeStretchGeometry(
      layers.map((l) => ({ start: l.clip.start, duration: l.clip.duration, sourceIn: l.clip.sourceIn })),
      factor,
      H,
      fps,
    );
    if (!plan) continue;
    // Silently: `applyTimeStretch`'s document-level entry is the undo step.
    c.timeline.history.silently(() => {
      layers.forEach((layer, i) => {
        const next = plan.bars[i];
        if (!next) return;
        layer.clip.start = next.start;
        layer.clip.duration = next.duration;
        layer.clip.sourceIn = next.sourceIn;
        c.timeline.events.emit('LayerUpdated', { layer, changed: 'clip' });
      });
    });
    c.invalidateLayerIndex();
    // After the index rebuild: a reversal can change which bar is first.
    moveLayerMarkers(id, markerAnchor, plan.place, factor, factor < 0);
    retimeLayerKeyframes(id, plan.keyScale, plan.keyOffset);
    writeBakedStretch(id, target);
  }
}

// ── Freeze On Last Frame ────────────────────────────────────────────────────

/**
 * AE's Freeze On Last Frame, as keyframe times: identity from the layer's
 * in-point to its last frame, then a HOLD on that frame. `span` is in frames,
 * end exclusive, so the last visible frame is `end − 1`.
 */
export function lastFrameHoldKeys(span: { start: number; end: number }, fps: number): { inSec: number; lastSec: number } {
  const lastFrame = Math.max(span.start, span.end - 1);
  return { inSec: span.start / fps, lastSec: lastFrame / fps };
}

/**
 * Enable time remapping with a hold on each layer's last frame and extend the
 * bar to the end of the composition, so the final frame holds from there on.
 */
export function freezeOnLastFrame(ids: ReadonlyArray<string>): number {
  const c = getTimelineController();
  const fps = c.timeline.getFrameRate().fps;
  const compEnd = c.timeline.duration;
  const plans: Array<{ id: string; inSec: number; lastSec: number }> = [];
  const extensions: Array<{ layer: ReturnType<typeof c.getLayersForNode>[number]; prev: number; next: number }> = [];

  for (const id of ids) {
    const layers = c.getLayersForNode(id);
    if (layers.length === 0) continue;
    const first = layers[0]!;
    const last = layers[layers.length - 1]!;
    const { inSec, lastSec } = lastFrameHoldKeys({ start: first.start, end: last.start + last.duration }, fps);
    plans.push({ id, inSec, lastSec });
    const wanted = compEnd - last.clip.start;
    if (!last.locked && wanted > last.clip.duration) {
      extensions.push({ layer: last, prev: last.clip.duration, next: wanted });
    }
  }
  if (plans.length === 0) return 0;

  // Keys are written BEFORE the bar grows: the remap track lives on chain time,
  // which the bar does not move, but reading the times first keeps the plan
  // independent of the extension.
  runAnimEdit('Freeze On Last Frame', () => defaultAnimation.batch(() => {
    for (const { id, inSec, lastSec } of plans) {
      defaultAnimation.removeTrack(id, REMAP);
      defaultAnimation.removeTrack(id, LEGACY_REMAP);
      defaultAnimation.setKeyframe(id, REMAP, compToKeyframeTime(id, inSec, REMAP), inSec, 'linear');
      defaultAnimation.setKeyframe(id, REMAP, compToKeyframeTime(id, lastSec, REMAP), lastSec, 'step');
    }
  }));

  if (extensions.length > 0) {
    const set = (pick: 'prev' | 'next'): void => {
      for (const e of extensions) {
        e.layer.clip.duration = e[pick];
        c.timeline.events.emit('LayerUpdated', { layer: e.layer, changed: 'clip' });
      }
    };
    c.timeline.history.run({ label: 'Freeze On Last Frame', do: () => set('next'), undo: () => set('prev') });
  }
  return plans.length;
}

export interface LayerTimeCommandDeps {
  /** Opens the Time Stretch dialog. Injected: core cannot import the layout layer. */
  openTimeStretch?: (ids: ReadonlyArray<string>) => void;
}

export function buildLayerTimeCommands(deps: LayerTimeCommandDeps = {}): ReadonlyArray<Command> {
  const enabled = (): boolean => timeTargets().length > 0;
  return [
    {
      id: asCommandId('time.reverseLayer'),
      label: 'Time-Reverse Layer',
      description: 'Play the selected footage backwards (toggle)',
      icon: 'clock',
      // AE's chord for Time-Reverse LAYER. It used to sit on Time-Reverse
      // Keyframes, which AE ships with no default shortcut.
      shortcut: { key: 'r', meta: true, alt: true },
      enabled,
      execute: () => toggleReverse(timeTargets()),
    },
    {
      id: asCommandId('time.freezeFrame'),
      label: 'Freeze Frame',
      description: 'Hold the selected footage on the frame under the playhead (toggle)',
      icon: 'clock',
      enabled,
      execute: () => toggleFreeze(timeTargets(), playhead()),
    },
    {
      id: asCommandId('time.freezeOnLastFrame'),
      label: 'Freeze On Last Frame',
      description: 'Time-remap the selected footage to hold its last frame to the end of the composition',
      icon: 'clock',
      enabled,
      execute: () => {
        const n = freezeOnLastFrame(timeTargets());
        if (n === 0) notify('Nothing to freeze — the selected layers have no clip on the timeline.');
      },
    },
    {
      id: asCommandId('time.timeStretch'),
      label: 'Time Stretch…',
      description: 'Stretch the selected layers, holding the in-point, out-point or current frame in place (footage changes speed; other layers stretch their keyframes)',
      icon: 'clock',
      // Every layer, as in AE — not just footage.
      enabled: () => stretchTargets().length > 0,
      execute: async () => {
        const ids = stretchTargets();
        if (ids.length === 0) return;
        if (deps.openTimeStretch) { deps.openTimeStretch(ids); return; }
        // Headless fallback (no dialog host): the old one-field prompt.
        const current = stretchValueOf(ids[0]!);
        const raw = await customPrompt('Time Stretch', 'Stretch factor (% of original duration — 200 = half speed, 50 = double speed)', String(current));
        if (raw === null) return;
        const pct = Number(raw);
        // Negative (reverse) only when no footage is selected — footage reverses with Time-Reverse Layer.
        const footage = ids.some(retimable);
        if (!Number.isFinite(pct) || pct === 0 || (footage && pct < 0)) {
          notify(footage ? 'Enter a percentage above 0.' : 'Enter a percentage other than 0.');
          return;
        }
        await applyTimeStretch(ids, pct, 'in');
      },
    },
    {
      id: asCommandId('time.enableTimeRemap'),
      label: 'Enable Time Remapping',
      description: 'Keyframe the source time of the selected footage (toggle)',
      icon: 'clock',
      enabled,
      execute: () => toggleTimeRemap(timeTargets(), playhead()),
    },
    ...([
      ['none', 'Frame Blend: Off'],
      ['mix', 'Frame Blend: Frame Mix'],
      ['pixelMotion', 'Frame Blend: Pixel Motion'],
    ] as ReadonlyArray<[FrameBlend, string]>).map(([mode, label]) => ({
      id: asCommandId(`time.frameBlend.${mode}`),
      label,
      description: 'Frame blending for slowed or stretched footage',
      icon: 'clock',
      enabled,
      execute: () => setFrameBlend(timeTargets(), mode),
    })),
  ];
}
