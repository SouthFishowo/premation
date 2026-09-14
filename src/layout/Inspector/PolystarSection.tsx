/**
 * Polystar — the parametric Polygon / Star section (AE's Polystar Path group).
 *
 * Every numeric row is keyframeable with the same stopwatch/AnimToggle
 * pattern the path-operator cards use: reads and writes ride the canonical
 * keyframe time (`compToKeyframeTime`), an animated row keyframes through
 * `runAnimEdit`, and a static edit is one undo entry through
 * `runDocumentEdit`. The TYPE is discrete (a dropdown, no stopwatch) —
 * interpolating polygon → star has no meaning.
 */

import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { Dropdown, type DropdownItem } from '@components/Dropdown';

import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { readNodeKind } from '@core/scene/sceneDerive';
import {
  getNodePolystar,
  polystarParamSpecs,
  polystarPropPath,
  readNodePolystar,
  updateNodePolystar,
  type Polystar,
  type PolystarParam,
  type PolystarType,
} from '@core/scene/polystar';
import styles from './TextAnimatorControls.module.css';
import { AnimToggle } from './AnimToggle';

const TYPES: { id: PolystarType; label: string }[] = [
  { id: 'star', label: 'Star' },
  { id: 'polygon', label: 'Polygon' },
];

function PolystarRow({
  nodeId,
  param,
  label,
  value,
  min,
  max,
  step,
  unit,
}: {
  nodeId: string;
  param: PolystarParam;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const path = polystarPropPath(param);
  const animated = defaultAnimation.isAnimated(nodeId, path);
  // ONE axis for reads and writes: the canonical keyframe time.
  const layerT = compToKeyframeTime(nodeId, time);
  const display = animated ? defaultAnimation.sample(nodeId, path, layerT) ?? value : value;

  const onChange = (v: number): void => {
    if (animated) {
      runAnimEdit(`Set ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, layerT, v), `polystar:${nodeId}:${path}:${layerT}`);
    } else {
      runDocumentEdit(`Set Polystar ${label}`, () => updateNodePolystar(nodeId, { [param]: v } as Partial<Polystar>));
    }
  };
  const toggle = (): void => {
    if (animated) runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, path));
    else runAnimEdit(`Animate ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, layerT, value));
  };

  return (
    <div className={styles.paramRow}>
      <span className={styles.rowToggle}>
        <AnimToggle nodeId={nodeId} tracks={[path]} label={label} animated={animated} onToggle={toggle} values={() => [display]} />
      </span>
      <span className={styles.paramLabel}>{label}</span>
      <ValueField value={display} onChange={onChange} min={min} max={max} step={step} unit={unit} aria-label={label} />
    </div>
  );
}

export function PolystarSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'shape') return null;
  const ps = getNodePolystar(nodeId);
  if (!ps) return null;

  const typeLabel = TYPES.find((t) => t.id === ps.starType)?.label ?? 'Star';
  const items: DropdownItem[] = TYPES.map((t) => ({
    type: 'item',
    id: t.id,
    label: t.label,
    icon: t.id === ps.starType ? 'check' : undefined,
    onSelect: () =>
      runDocumentEdit(`Set Polystar Type`, () => updateNodePolystar(nodeId, { starType: t.id })),
  }));

  return (
    <>
      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>Type</span>
        <Dropdown
          placement="left-start"
          trigger={
            <button type="button" className={styles.pick}>
              <span>{typeLabel}</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={items}
        />
      </div>
      {polystarParamSpecs(ps.starType).map((spec) => (
        <PolystarRow
          key={spec.param}
          nodeId={nodeId}
          param={spec.param}
          label={spec.label}
          value={ps[spec.param]}
          min={spec.min ?? (spec.signed ? undefined : 0)}
          max={spec.max}
          step={spec.step}
          unit={spec.unit}
        />
      ))}
    </>
  );
}

/** Whether the Polystar section belongs on this layer at all. Tolerant by
 *  design — the registry predicate must not throw on a node mid-update. */
export function hasPolystarSection(nodeId: string): boolean {
  try {
    const node = defaultSceneGraph.getNode(nodeId);
    return !!node && readNodeKind(node) === 'shape' && readNodePolystar(node) !== null;
  } catch {
    return false;
  }
}

export default PolystarSection;
