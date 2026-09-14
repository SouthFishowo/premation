/**
 * The timeline switches that write through core helpers rather than through
 * App's `onTrackToggleFlag` handler: Collapse Transformations / Continuous
 * Rasterize, Quality, and Frame Blending — plus Select Label Group.
 *
 * ── One sunburst, two meanings ─────────────────────────────────────────────
 * AE draws a single switch in this column and gives it one meaning per layer
 * type: on a placed composition it is Collapse Transformations, on a vector
 * layer (text, shapes, SVG) it is Continuous Rasterization. The inspector's
 * PrecompControl already models it exactly so; this reads and writes the same
 * props, so the two surfaces cannot disagree. Layers where neither means
 * anything (bitmaps, solids, nulls) get no switch.
 *
 * ── Quality ────────────────────────────────────────────────────────────────
 * Best → Draft → Wireframe → Best, AE's cycle. Draft is honoured end to end
 * (`RenderLayer.quality` → nearest-neighbour sampling, see `layerQuality.ts`).
 * Wireframe is viewport-only: the interactive hosts pass
 * `SnapshotComp.wireframeLayers`, which hides the layer's pixels, and the
 * overlay painter strokes its oriented box. Output paths never pass the flag,
 * so export renders a wireframe layer as Best.
 *
 * Every write is one undo step (`runDocumentEdit`).
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { isPrecomp, setCompCollapse } from '@core/scene/precomp';
import { readCompCollapse } from '@core/scene/compInstance';
import { readContinuousRaster, setContinuousRaster, supportsContinuousRaster } from '@core/scene/continuousRaster';
import { nextQuality, readNodeQuality, setNodeQuality, type LayerQuality } from '@core/effects/layerQuality';
import { getNodeLayerTime, updateNodeLayerTime } from '@core/scene/layerTime';
import { nodesWithLabelColor } from '@core/scene/labelColor';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { useSelectionStore } from '@stores/selectionStore';

export type CollapseSwitchKind = 'collapse' | 'raster';

/** What the sunburst means on this layer, or null when it means nothing. */
export function collapseSwitchKind(node: SceneNode | undefined): CollapseSwitchKind | null {
  if (!node) return null;
  if (readNodeKind(node) === 'comp') return 'collapse';
  if (supportsContinuousRaster(node)) return 'raster';
  return null;
}

export function readCollapseSwitch(node: SceneNode): boolean {
  const kind = collapseSwitchKind(node);
  if (kind === 'collapse') return readCompCollapse(node);
  if (kind === 'raster') return readContinuousRaster(node);
  return false;
}

export function toggleCollapseSwitch(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const kind = collapseSwitchKind(node);
  if (!node || !kind) return;
  const next = !readCollapseSwitch(node);
  runDocumentEdit(kind === 'collapse' ? 'Collapse Transformations' : 'Continuous Rasterization', () => {
    if (kind === 'collapse') setCompCollapse(nodeId, next);
    else setContinuousRaster(nodeId, next);
  });
}

/** Layers with pixels to sample: everything but the chrome-only kinds. */
export function qualitySwitchAvailable(node: SceneNode | undefined): boolean {
  if (!node) return false;
  return !['null', 'camera', 'light', 'audio', 'group'].includes(readNodeKind(node)) || isPrecomp(node);
}

const QUALITY_LABEL: Readonly<Record<LayerQuality, string>> = {
  best: 'Best Quality',
  draft: 'Draft Quality',
  wireframe: 'Wireframe Quality',
};

/** Advance the Quality switch one position: Best → Draft → Wireframe → Best. */
export function toggleQualitySwitch(nodeId: string): LayerQuality | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const next = nextQuality(readNodeQuality(node));
  runDocumentEdit(QUALITY_LABEL[next], () => setNodeQuality(nodeId, next));
  return next;
}

/** Frame blending only means something on a layer with source frames. */
export function frameBlendSwitchAvailable(node: SceneNode | undefined): boolean {
  if (!node) return false;
  return readNodeKind(node) === 'video' || isPrecomp(node);
}

export function readFrameBlendSwitch(nodeId: string): boolean {
  return getNodeLayerTime(nodeId).frameBlend !== 'none';
}

/** Off → Frame Mix; any mode → Off (AE's switch cycles the same way). */
export function toggleFrameBlendSwitch(nodeId: string): void {
  const on = readFrameBlendSwitch(nodeId);
  runDocumentEdit(on ? 'Frame Blending Off' : 'Frame Blending', () =>
    updateNodeLayerTime(nodeId, { frameBlend: on ? 'none' : 'mix' }),
  );
}

/** AE's label menu "Select Label Group": every layer carrying this label. */
export function selectLabelGroup(nodeId: string): string[] {
  const ids = nodesWithLabelColor(nodeId);
  if (ids.length > 0) useSelectionStore.getState().set(ids);
  return ids;
}
