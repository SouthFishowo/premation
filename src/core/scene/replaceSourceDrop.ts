/**
 * AE's Alt-drag REPLACE LAYER SOURCE: drop an asset from the Assets panel onto
 * a layer with Alt held and the layer's footage is swapped, keeping its
 * transform, keyframes, effects and masks.
 *
 * The swap itself is `retargetLayerSource` — the same one "Use as Source for …"
 * in the Assets panel menu uses. This adds the two things a DROP needs: which
 * layer the drop means (the one under the pointer, else the selected one) and
 * an undo entry.
 *
 * Scope matches `retargetLayerSource`: image and video layers, image and video
 * assets. Anything else is refused with a notice rather than silently ignored.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { retargetLayerSource, replaceableSelectedLayer } from '@core/scene/footageWorkflow';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { useAssetStore } from '@stores/assetStore';
import { useUIStore } from '@stores/uiStore';

/** True when `nodeId` is a layer whose source an asset drop can replace. */
export function isReplaceableLayer(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const kind = readNodeKind(node);
  return kind === 'image' || kind === 'video';
}

/**
 * The layer an Alt-drop means: the one under the pointer when it can take a
 * new source, otherwise the single selected replaceable layer (AE also
 * replaces the selection when the drop lands on empty canvas / the panel).
 */
export function resolveReplaceTarget(hitNodeId: string | null | undefined): string | null {
  if (isReplaceableLayer(hitNodeId)) return hitNodeId ?? null;
  return replaceableSelectedLayer();
}

/**
 * Replace `nodeId`'s source with asset `assetId`, as ONE undo step.
 * Returns false (and tells the user why) when the pair cannot be swapped.
 */
export function replaceLayerSourceWithAsset(nodeId: string | null, assetId: string): boolean {
  const notify = useUIStore.getState().notify;
  const asset = useAssetStore.getState().assets.find((a) => a.id === assetId);
  if (!nodeId || !isReplaceableLayer(nodeId)) {
    notify({ level: 'info', message: 'Alt-drop onto an image or video layer (or select one) to replace its source.', durationMs: 3200 });
    return false;
  }
  if (!asset || (asset.type !== 'image' && asset.type !== 'video')) {
    notify({ level: 'info', message: 'Only image and video footage can replace a layer’s source.', durationMs: 3200 });
    return false;
  }
  const name = defaultSceneGraph.getNode(nodeId)?.name ?? 'layer';
  const ok = runDocumentEdit(`Replace Source of “${name}”`, () => retargetLayerSource(nodeId, asset));
  if (ok) notify({ level: 'info', message: `Replaced the source of “${name}” with “${asset.name}”.`, durationMs: 2600 });
  return ok;
}
