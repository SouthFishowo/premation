/**
 * Static sealed-precomp cache — reuse a nested composition's snapshot across
 * frames while nothing inside it can change.
 *
 * A SEALED comp layer is rendered by a recursive `buildSnapshot` pass over the
 * referenced comp (`nestedCompLayers`). That pass used to run in full on every
 * frame, for every placement — so fifty title cards that never move inside
 * their own comps cost fifty full scene walks per frame of playback.
 *
 * ── What "static" means here, and why it is exact ───────────────────────────
 *
 * The nested pass is a function of (scene data, animation, clips, the comp
 * parameters it is handed, a handful of stores, time). This cache removes TIME
 * from that list only when the subtree provably does not read it:
 *
 *   • every node is a plain shape / text / group / null — no footage, audio,
 *     particles, lights, cameras, nested comps, meshes, models or extrusion;
 *   • no node has an animation track, a data track (path / stops / source
 *     text) or an expression — re-checked EVERY frame, because the animation
 *     engine has no revision counter to key on;
 *   • no node carries a time-dependent component feature: effects (Timecode,
 *     wiggles, echo, posterize…), paint, puppet / skeleton rigs, physics,
 *     cloners, audio waveforms, live booleans, text animators, masks (a
 *     tracked mask keyframes inside its component), point bindings, layer-time
 *     settings or auto-orient;
 *   • the CONTAINER is not retimed or remapped — a speed-changed or
 *     time-remapped comp is time-dependent by definition and always rebuilds;
 *   • which layers are live (in/out bars) is the same: the entry records the
 *     gate frame it was built at plus every clip boundary in the subtree, and
 *     is reused only while no boundary lies between that frame and the current
 *     one, with every clip's start / end / enabled unchanged.
 *
 * Everything else the pass reads is in the key: the scene mutation epoch
 * (component data, which is also every static prop above), the per-node
 * structure (parent / visibility / solo / name), the comp parameters, the
 * frame rate, the asset list and font state.
 *
 * Under those conditions two nested builds at different times produce the
 * same layers EXCEPT `sourceTime`, which records the sampling instant. For the
 * kinds admitted here nothing reads it for pixels — the texture feed consults
 * it only for particles, live SVG and video, and the content hash folds it in
 * only for image / video layers — so a reused entry renders identically.
 *
 * ── Ownership ───────────────────────────────────────────────────────────────
 *
 * Entries hold the nested pass's UNPREFIXED layers. The caller re-keys them per
 * placement (`prefixLayerIds`, which copies every layer object), so cached
 * layer objects never reach a snapshot; their sub-objects (effects, paints,
 * masks) are shared and, like everything in a RenderSnapshot, read-only.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import { renderComponentsOf, renderTransformOf } from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import type { AnimationEngine } from '@motion/animation';
import { sceneMutationEpoch } from '@motion/scene';
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { readNodeRenderEffects } from '@core/effects/effects';
import { readNodeMask } from '@core/effects/mask';
import { readNodePaint } from '@core/paint/paintStrokes';
import { readNodePuppet } from '../rig/puppet';
import { readNodeSkeleton } from '../rig/skeletonCommands';
import { readNodePhysics } from '@core/simulation/physicsBodies';
import { readNodeAudioWaveform } from '@core/audio/audioWaveformGen';
import { readLiveBoolean } from '@core/scene/mergePaths';
import { readNodeCloner, cloneOffsetOf } from '@core/scene/clonerExpand';
import { resolveAnimators } from '@core/text/textAnimators';
import { isPrimitiveMeshNode } from '@core/scene/primitiveLayer';
import { readNodeModelRef } from '@core/scene/modelMesh';
import { readNode3D } from '@core/scene/threeD';
import { readNodeMaterial } from '@core/scene/material';
import { readNodeLayerTime } from '@core/scene/layerTime';
import { readNodeAutoOrient } from '@core/scene/autoOrient';
import { readCompRef } from '@core/scene/compInstance';
import { useAssetStore } from '@stores/assetStore';
import { fontVariantEpoch, onFontVariantsChanged } from '@core/text/fontFaceVariants';
import type { RenderLayer } from './RenderBackend';
import type { SnapshotComp } from './buildSnapshot';

/** What a nested pass hands back to its container. */
export interface StaticPrecompValue {
  layers: ReadonlyArray<RenderLayer>;
  scene3d?: RenderLayer['precompScene3d'];
}

interface Entry {
  value: StaticPrecompValue;
  /** Clip start/end/enabled per subtree node, joined — any edit misses. */
  clipSig: string;
  /** Every clip start and end frame in the subtree. */
  boundaries: number[];
  /** The live-gate frame the entry was built at. */
  gateFrame: number;
}

/** A small LRU — one entry per (comp, parameters) pair actually on screen. */
const MAX_ENTRIES = 64;
const entries = new Map<string, Entry>();

let enabled = true;
const stats = { hits: 0, misses: 0, stores: 0, uncacheable: 0 };

/** Turn the cache off (tests, A/B comparisons). Clears it either way. */
export function setStaticPrecompCacheEnabled(on: boolean): void {
  enabled = on;
  clearStaticPrecompCache();
}

export function clearStaticPrecompCache(): void {
  entries.clear();
  predicateMemo.clear();
}

export function staticPrecompCacheStats(): Readonly<typeof stats> & { entries: number } {
  return { ...stats, entries: entries.size };
}

export function resetStaticPrecompCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.stores = 0;
  stats.uncacheable = 0;
}

// Font loads change text METRICS without any scene mutation (measureText
// invalidates its own cache on the same events), so a cached text layout
// must go too.
if (typeof document !== 'undefined' && typeof document.fonts !== 'undefined') {
  void document.fonts.ready.then(clearStaticPrecompCache);
  document.fonts.addEventListener?.('loadingdone', clearStaticPrecompCache);
}
onFontVariantsChanged(clearStaticPrecompCache);

/** Stable small ids for object identities that belong in a string key. */
const identityIds = new WeakMap<object, number>();
let nextIdentity = 1;
function identityOf(o: object): number {
  let id = identityIds.get(o);
  if (id === undefined) { id = nextIdentity++; identityIds.set(o, id); }
  return id;
}

const STATIC_KINDS: ReadonlySet<string> = new Set(['shape', 'text', 'group', 'null']);

/** A node's render-path view as a plain object, so the readers below don't rebuild `components`. */
function plain(n: SceneNode): SceneNode {
  return { ...n, id: n.id, name: n.name, parent: n.parent, visible: n.visible, solo: n.solo, components: renderComponentsOf(n), transform: renderTransformOf(n) } as SceneNode;
}

/**
 * True when nothing in the node's COMPONENTS makes its rendering depend on
 * time. Pure in the component data, so memoized per (ref, epoch).
 */
function componentsAreTimeless(n: SceneNode): boolean {
  if (!STATIC_KINDS.has(readNodeKind(n))) return false;
  if (readCompRef(n) !== null) return false;
  if (readNodeRenderEffects(n).length > 0) return false;
  if (readNodeMask(n)?.paths.length) return false;
  if (readNodePaint(n)) return false;
  if (readNodePuppet(n)?.pins?.length) return false;
  if (readNodeSkeleton(n)?.bones?.length) return false;
  if (readNodePhysics(n)) return false;
  if (readNodeAudioWaveform(n)) return false;
  if (readLiveBoolean(n)) return false;
  if (readNodeCloner(n) || cloneOffsetOf(n)) return false;
  if (resolveAnimators(n, undefined).length > 0) return false;
  if (isPrimitiveMeshNode(n) || readNodeModelRef(n)) return false;
  if (readNode3D(n).extrusionDepth > 0) return false;
  if (readNodeMaterial(n).displacement !== 0) return false;
  if (readNodeLayerTime(n)) return false;
  if (readNodeAutoOrient(n)) return false;
  const geom = n.components.find((c) => c.type === 'Geometry');
  const bindings = geom?.props.pointBindings as unknown[] | undefined;
  if (bindings && bindings.length > 0) return false;
  return true;
}

/** (graph, ref, epoch) → whether every subtree node's components are timeless. */
const predicateMemo = new Map<string, boolean>();

export interface StaticPrecompRequest {
  graph: SceneGraph;
  anim: AnimationEngine;
  /** The referenced comp's root id. */
  ref: string;
  /** The comp parameters the nested pass would be handed. */
  comp: SnapshotComp;
  /** The nested pass's time (the container's source time). */
  time: number;
  fps: number;
  /** The container itself is retimed / remapped / has layer-time settings. */
  containerTimeDependent: boolean;
  /** The clip bars of a node — the snapshot's own controller. */
  clipsOf: (id: string) => ReadonlyArray<{ start: number; end: number; enabled: boolean }>;
}

export interface StaticPrecompProbe {
  /** A reusable nested result, or null. */
  hit: StaticPrecompValue | null;
  /** Store a freshly built result — null when this request is not cacheable. */
  commit: ((value: StaticPrecompValue) => void) | null;
}

const MISS_UNCACHEABLE: StaticPrecompProbe = { hit: null, commit: null };

/** The frame `isLiveAt` gates on inside the nested pass — same arithmetic. */
function gateFrameOf(time: number, fps: number, durationSeconds: number | undefined): number {
  const rawFrame = Math.round(time * fps);
  return durationSeconds !== undefined
    ? Math.min(rawFrame, Math.max(0, Math.round(durationSeconds * fps) - 1))
    : rawFrame;
}

export function probeStaticPrecomp(req: StaticPrecompRequest): StaticPrecompProbe {
  if (!enabled) return MISS_UNCACHEABLE;
  const { graph, anim, ref, comp } = req;
  if (
    // A partial engine (test doubles) cannot prove the absence of animation.
    typeof anim.hasAnimation !== 'function'
    || typeof anim.dataTracksFor !== 'function'
    || typeof anim.allExpressions !== 'function'
    || req.containerTimeDependent
    || comp.layerView !== undefined
    || (comp.compOverrides !== undefined && comp.compOverrides.size > 0)
  ) {
    stats.uncacheable++;
    return MISS_UNCACHEABLE;
  }

  const epoch = sceneMutationEpoch();
  const graphId = identityOf(graph);
  const predKey = `${graphId}|${ref}|${epoch}`;
  const nodes = flattenComposition(graph, ref);
  let timeless = predicateMemo.get(predKey);
  if (timeless === undefined) {
    timeless = nodes.every((n) => componentsAreTimeless(plain(n)));
    if (predicateMemo.size > MAX_ENTRIES * 4) predicateMemo.clear();
    predicateMemo.set(predKey, timeless);
  }
  if (!timeless) {
    stats.uncacheable++;
    return MISS_UNCACHEABLE;
  }

  // Per-frame checks: animation (no revision counter to key on), structure and
  // clips. Expressions are looked up once for the whole engine.
  let exprIds: Set<string> | null = null;
  const structure: string[] = [];
  const clipParts: string[] = [];
  const boundaries: number[] = [];
  for (const n of nodes) {
    const id = n.id;
    if (anim.hasAnimation(id) || anim.dataTracksFor(id).length > 0) {
      stats.uncacheable++;
      return MISS_UNCACHEABLE;
    }
    exprIds ??= new Set(anim.allExpressions().map((e) => e.nodeId));
    if (exprIds.has(id)) {
      stats.uncacheable++;
      return MISS_UNCACHEABLE;
    }
    structure.push(`${id}<${n.parent ?? ''}${n.visible === false ? '!' : ''}${n.solo === true ? '*' : ''}:${n.name ?? ''}`);
    for (const c of req.clipsOf(id)) {
      clipParts.push(`${id}@${c.start}-${c.end}${c.enabled ? '' : 'x'}`);
      boundaries.push(c.start, c.end);
    }
  }

  const key = [
    graphId, identityOf(anim), ref, epoch, req.fps,
    comp.width, comp.height,
    comp.forExport === true ? 1 : 0, comp.draft3d === true ? 1 : 0,
    comp.wireframeLayers === true ? 1 : 0, comp.useProxies === true ? 1 : 0,
    comp.durationSeconds ?? '', comp.globalLightAngle ?? '', comp.globalLightAltitude ?? '',
    identityOf(useAssetStore.getState().assets), fontVariantEpoch(),
    structure.join('/'),
  ].join('|');
  const clipSig = clipParts.join(',');
  const gateFrame = gateFrameOf(req.time, req.fps, comp.durationSeconds);

  const entry = entries.get(key);
  if (entry && entry.clipSig === clipSig) {
    const lo = Math.min(entry.gateFrame, gateFrame);
    const hi = Math.max(entry.gateFrame, gateFrame);
    // Clip spans are [start, end): activity flips exactly AT a boundary, so a
    // boundary b with lo < b <= hi means some layer's liveness differs.
    if (!entry.boundaries.some((b) => b > lo && b <= hi)) {
      stats.hits++;
      entries.delete(key);
      entries.set(key, entry);
      return { hit: entry.value, commit: null };
    }
  }

  stats.misses++;
  return {
    hit: null,
    commit: (value) => {
      stats.stores++;
      entries.delete(key);
      entries.set(key, { value, clipSig, boundaries, gateFrame });
      while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
