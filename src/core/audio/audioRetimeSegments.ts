/**
 * Piecewise-constant audio retimes for video layers with time remap.
 *
 * Picture samples `timeRemap` every frame; audio cannot do that with one
 * BufferSource. We sample the same source-time curve at the comp frame rate,
 * turn Δsource/Δcomp into short varispeed segments, and schedule each as its
 * own voice — the same `playbackRate` path stretch already uses. Freeze stays
 * silent (held picture has no continuous soundtrack). Preview and mixdown
 * both consume the expanded voice list from {@link readVideoAudioVoices}.
 *
 * Ancestor precomp remaps fold outermost → innermost before the node's own
 * remap / stretch / reverse — matching `buildSnapshot` / `compToKeyframeTime`.
 *
 * Both retime modes resolve through `retimedChainTime`, so a Speed % curve is
 * heard exactly as it is seen. The bar's own offset (`inSec − startSec`) is
 * applied to the retimed value the way the renderer's clip map applies it:
 * reading the buffer at the raw remap value played the wrong stretch of sound
 * for any bar that was trimmed or not placed at comp 0.
 */

import type { SceneNode } from '@core/types';
import { defaultAnimation } from '@motion/animation';
import { readNodeLayerTime, remapTime, DEFAULT_LAYER_TIME } from '@core/scene/layerTime';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isPrecomp } from '@core/scene/precomp';
import { getTimelineController } from '@core/timeline/TimelineController';
import { hasRetime, pickRetimeBar, retimeClipOf, retimedChainTime, type RetimeClip } from '@core/animation/retime';
import type { AudioClipTiming } from './audioScene';

export interface AudioRateSegment {
  /** Comp time where this segment begins. */
  startSec: number;
  /** Wall-clock length (seconds). */
  durationSec: number;
  /** Buffer read position at segment start. */
  inSec: number;
  /** Absolute playback rate (> 0). */
  rate: number;
  /** Play the buffer window backwards. */
  reverse: boolean;
}

const RATE_EPS = 0.02;
const MIN_SEG = 1 / 120;

function hasTimeRemap(nodeId: string): boolean {
  return hasRetime(defaultAnimation, nodeId);
}

/** The retime clip of an ancestor precomp at chain time `t`, from its own bar. */
function ancestorClip(id: string, t: number): RetimeClip | null {
  try {
    const c = getTimelineController();
    const fps = c.fpsForNode(id) || 30;
    return retimeClipOf(pickRetimeBar(c.getLayersForNode(id), Math.round(t * fps)), fps);
  } catch {
    return null;
  }
}

/**
 * Precomp-group ancestor ids, OUTERMOST first (excludes `node` itself).
 * Pure when `ancestorIds` is supplied; otherwise walks the live scene graph.
 */
export function precompAncestorIdsOuterFirst(
  node: SceneNode,
  ancestorIds?: readonly string[],
): string[] {
  if (ancestorIds) return [...ancestorIds];
  const chain: string[] = [];
  let parentId = node.parent ?? null;
  while (parentId) {
    const parent = defaultSceneGraph.getNode(parentId);
    if (!parent) break;
    if (isPrecomp(parent)) chain.push(parent.id);
    parentId = parent.parent ?? null;
  }
  chain.reverse();
  return chain;
}

/** Fold ancestor remaps over comp time (outermost → innermost). */
export function foldAncestorRemapTime(
  compT: number,
  ancestorIdsOuterFirst: readonly string[],
): number {
  let time = compT;
  for (const id of ancestorIdsOuterFirst) {
    if (!hasTimeRemap(id)) continue;
    time = retimedChainTime(defaultAnimation, id, time, ancestorClip(id, time)) ?? time;
  }
  return time;
}

/**
 * Source time the picture would show at `compT` for this node's own remap /
 * stretch / reverse / freeze, after folding ancestor precomp remaps.
 *
 * Without `clip`, bars are applied by the caller via timing (the identity
 * path). With it, the retimed value is carried through the bar's offset here,
 * because only a retimed value can leave the bar's range.
 */
export function videoSourceTimeAt(
  node: SceneNode,
  compT: number,
  opts?: { ancestorIds?: readonly string[]; clip?: RetimeClip },
): number {
  const cfg = readNodeLayerTime(node) ?? DEFAULT_LAYER_TIME;
  if (cfg.freeze) return cfg.freezeTime;
  const afterAncestors = foldAncestorRemapTime(
    compT,
    precompAncestorIdsOuterFirst(node, opts?.ancestorIds),
  );
  const retimed = retimedChainTime(defaultAnimation, node.id, afterAncestors, opts?.clip ?? null);
  const base = (retimed !== undefined ? retimed : afterAncestors) + (opts?.clip?.offsetSec ?? 0);
  const span = defaultAnimation.timeSpan(node.id) ?? { start: 0, end: Math.max(base, 1) };
  return remapTime(base, { ...cfg, freeze: false }, span);
}

function needsPiecewiseRetime(node: SceneNode, ancestorIds: readonly string[]): boolean {
  if (hasTimeRemap(node.id)) return true;
  return ancestorIds.some((id) => hasTimeRemap(id));
}

/**
 * Build varispeed segments for a clip bar, or `null` when the simple single-rate
 * path is enough (no time-remap on the node or its precomp ancestors).
 * Empty array = silence (freeze).
 */
export function buildAudioRetimeSegments(
  node: SceneNode,
  timing: AudioClipTiming,
  fps: number,
  opts?: { ancestorIds?: readonly string[] },
): AudioRateSegment[] | null {
  const cfg = readNodeLayerTime(node) ?? DEFAULT_LAYER_TIME;
  if (cfg.freeze) return [];
  const ancestors = precompAncestorIdsOuterFirst(node, opts?.ancestorIds);
  if (!needsPiecewiseRetime(node, ancestors)) return null;

  const step = 1 / Math.max(1, fps);
  const barLen = Math.max(0, timing.outSec - timing.inSec);
  if (barLen <= 0) return [];

  // This bar's clip map, in the renderer's terms: source = chain + offset.
  const clip: RetimeClip = { offsetSec: timing.inSec - timing.startSec, inSec: timing.startSec };
  const t0 = timing.startSec;
  const tEnd = timing.startSec + barLen;
  const samples: Array<{ t: number; s: number }> = [];
  for (let t = t0; t < tEnd - 1e-9; t += step) {
    samples.push({ t, s: videoSourceTimeAt(node, t, { ancestorIds: ancestors, clip }) });
  }
  samples.push({ t: tEnd, s: videoSourceTimeAt(node, tEnd, { ancestorIds: ancestors, clip }) });

  const raw: AudioRateSegment[] = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    const dt = b.t - a.t;
    if (dt < 1e-9) continue;
    const ds = b.s - a.s;
    const signedRate = ds / dt;
    if (Math.abs(signedRate) < RATE_EPS) continue; // hold → silence
    raw.push({
      startSec: a.t,
      durationSec: dt,
      inSec: Math.max(0, signedRate >= 0 ? a.s : b.s),
      rate: Math.min(16, Math.max(0.01, Math.abs(signedRate))),
      reverse: signedRate < 0,
    });
  }

  // Merge neighbors with matching rate/reverse within ε.
  const merged: AudioRateSegment[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (
      last
      && last.reverse === seg.reverse
      && Math.abs(last.rate - seg.rate) < RATE_EPS
      && Math.abs((last.startSec + last.durationSec) - seg.startSec) < 1e-6
    ) {
      last.durationSec += seg.durationSec;
    } else if (seg.durationSec >= MIN_SEG) {
      merged.push({ ...seg });
    }
  }
  return merged;
}
