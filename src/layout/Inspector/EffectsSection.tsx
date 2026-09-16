/**
 * Effects — the selected layer's applied effect stack, in the Properties panel.
 *
 * The Properties panel is the one home for the selected layer, and a layer's
 * effects are part of the layer: editing them used to mean switching the left
 * rail to Effect Controls and back. The body IS Effect Controls'
 * (`EffectControlsBody`: effect cards, path operators, Cloner, Physics), so the
 * two surfaces cannot drift; the header "+" adds from the same catalogue the
 * Library's Effects browser lists.
 *
 * Empty is one line, not an empty state: most layers carry no effects, and a
 * call-to-action card on every one of them would push the rest of the panel
 * down for nothing. The "+" is the call to action.
 */

import { memo } from 'react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { getNodeEffects } from '@core/effects/effects';
import { readPathOps } from '@core/scene/pathOps';
import { nodeHasCloner } from '@core/scene/clonerExpand';
import { nodeHasPhysics } from '@core/simulation/physicsBodies';
import { useSceneRevision } from '@stores/sceneStore';
import { EffectControlsBody } from '@layout/Effects/EffectControlsPanel';
import { AddEffectMenu } from '@layout/Effects/AddEffectMenu';
import { useInspectorSelection } from './inspectorSelection';
import styles from './EffectsSection.module.css';

/**
 * Kinds with no pixels of their own for an effect to process. A camera, light
 * or audio layer (and a null) takes none — Effect Controls never refused them,
 * but a Gaussian Blur on a light is a control that changes nothing.
 */
const NO_PIXEL_KINDS: ReadonlySet<string> = new Set(['camera', 'light', 'audio', 'null']);

/**
 * Whether the Effects section belongs on this layer: any layer with pixels —
 * with or without effects yet, so the "+" is reachable on a fresh layer — and
 * any layer that already carries something to edit, whatever its kind.
 * Tolerant by design: a registry predicate must not throw mid-update.
 */
export function hasEffectsSection(nodeId: string): boolean {
  try {
    const node = defaultSceneGraph.getNode(nodeId);
    if (!node) return false;
    if (getNodeEffects(nodeId).length > 0) return true;
    if (readPathOps(node).length > 0 || nodeHasCloner(node) || nodeHasPhysics(node)) return true;
    return !NO_PIXEL_KINDS.has(readNodeKind(node));
  } catch {
    return false;
  }
}

function EffectsSectionInner({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  if (!defaultSceneGraph.getNode(nodeId)) return null;
  return (
    <div className={styles.root}>
      <EffectControlsBody
        nodeId={nodeId}
        empty={<p className={styles.hint}>No effects. Use + to add one.</p>}
      />
    </div>
  );
}

/*
 * Memoized like every registry section: the Properties panel re-renders for
 * its own reasons and hands the section the same `nodeId`; without this the
 * whole stack — every effect card and param row — rebuilds each time. Pinned
 * by `inspectorRenderScope.test.tsx`.
 */
export const EffectsSection = memo(EffectsSectionInner);

/**
 * The section header's "+". Adds to every selected layer that can take an
 * effect (primary first), in one undo step; the stack below still shows the
 * primary's.
 */
export function EffectsSectionActions({
  nodeId,
  nodeIds,
}: {
  nodeId: string;
  nodeIds?: ReadonlyArray<string>;
}): JSX.Element {
  const selection = useInspectorSelection(nodeId);
  const targets = (nodeIds && nodeIds.length > 0 ? nodeIds : selection).filter(hasEffectsSection);
  return <AddEffectMenu nodeIds={targets} />;
}

export default EffectsSection;
