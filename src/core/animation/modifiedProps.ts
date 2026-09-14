/**
 * "Modified" properties — what AE's UU reveals.
 *
 * AE's U shows animated properties; UU shows every property whose value has
 * been CHANGED: animated, expression-driven, or simply set to something other
 * than its default. The timeline's UU used to reveal the animated set only
 * (App.tsx admitted as much), so a layer scaled to 50 % and rotated 30° with no
 * keyframes showed nothing at all under UU.
 *
 * `modifiedRowIds` is the rule, pure. `modifiedPropertyRows` reads one node out
 * of the scene and animation engine and feeds it. The ids returned are the
 * timeline's ROW ids (the reveal filter matches on those): each Transform group
 * contributes its static placeholder (`__static:<group>`), its raw member props
 * and, for Position, the merged Position pseudo-row — the same spread App.tsx's
 * P/S/R/T lists use, so a row is found whether or not it is keyframed yet.
 */

import { defaultAnimation, POSITION_PSEUDO_PROP } from '@motion/animation';
import { Matrix } from '@motion/scene';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { parentWorld2DAt } from '@core/scene/layerSpace';
import { groupPlaceholderPath, resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { staticOrDefaultValue } from '@core/inspector/propertyValue';
import { buildStaticPropertyTree, MASK_ANIM_PROP } from '@core/timeline/propertyTree';
import { readNodeMask, readNodeMaskAnim } from '@core/effects/mask';
import { useProjectStore } from '@stores/projectStore';

/** The Transform groups, keyed like the timeline's static placeholders. */
export const TRANSFORM_GROUPS: ReadonlyArray<{ key: string; members: ReadonlyArray<string> }> = [
  { key: 'anchor', members: ['anchorX', 'anchorY', 'anchorZ'] },
  { key: 'position', members: ['x', 'y', 'z'] },
  { key: 'scale', members: ['scaleX', 'scaleY', 'scaleZ', 'scale'] },
  { key: 'rotation', members: ['rotation', 'rotationX', 'rotationY'] },
  { key: 'orientation', members: ['orientationX', 'orientationY', 'orientationZ'] },
  { key: 'opacity', members: ['opacity'] },
];

/**
 * A transform prop's default, per the centred-origin convention new layers are
 * born with: position at the composition centre (in the layer's parent space),
 * scale 1 (100 %), opacity 100 %, everything else 0.
 */
export function transformDefault(prop: string, centre: { x: number; y: number }): number {
  if (prop === 'x') return centre.x;
  if (prop === 'y') return centre.y;
  if (prop === 'scaleX' || prop === 'scaleY' || prop === 'scaleZ' || prop === 'scale') return 1;
  if (prop === 'opacity') return 100;
  return 0;
}

const EPS = 1e-6;

export interface ModifiedInput {
  /** Static values the layer carries, by prop. Absent = never set = default. */
  values: Readonly<Record<string, number | undefined>>;
  /** Props that are keyframed or expression-driven. */
  animated: ReadonlySet<string>;
  /** The composition centre in the layer's parent space. */
  centre: { x: number; y: number };
}

/** Row ids AE's UU reveals for one layer's TRANSFORM group and animated rows. */
export function modifiedRowIds(input: ModifiedInput): string[] {
  const out = new Set<string>();
  const inGroups = new Set<string>();
  for (const group of TRANSFORM_GROUPS) {
    let modified = false;
    for (const m of group.members) {
      inGroups.add(m);
      if (input.animated.has(m)) { modified = true; continue; }
      const v = input.values[m];
      if (typeof v === 'number' && Math.abs(v - transformDefault(m, input.centre)) > EPS) modified = true;
    }
    if (!modified) continue;
    out.add(groupPlaceholderPath(group.key));
    for (const m of group.members) out.add(m);
    if (group.key === 'position') out.add(POSITION_PSEUDO_PROP);
  }
  // Every other animated / expressed property is its own row (effect params,
  // text animators, audio levels…).
  for (const p of input.animated) if (!inGroups.has(p)) out.add(p);
  return [...out];
}

function playheadCompTime(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

function activeCompCentre(): { x: number; y: number } {
  const s = useProjectStore.getState();
  const compId = s.tabs[s.activeTabId ?? '']?.compositionId ?? '';
  const c = s.comps[compId];
  return { x: (c?.width ?? 1920) / 2, y: (c?.height ?? 1080) / 2 };
}

/** The UU row ids for a node in the live scene. */
export function modifiedPropertyRows(nodeId: string): string[] {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return [];

  const values: Record<string, number | undefined> = {};
  const transform = node.components.find((c) => c.type === 'Transform');
  for (const group of TRANSFORM_GROUPS) {
    for (const m of group.members) {
      // Opacity lives on the Style / Text component, the rest on Transform.
      const home = m === 'opacity'
        ? node.components.find((c) => typeof (c.props as Record<string, unknown>).opacity === 'number')
        : transform;
      const v = home ? (home.props as Record<string, unknown>)[m] : undefined;
      if (typeof v === 'number') values[m] = v;
    }
  }

  const inv = Matrix.invert(parentWorld2DAt(nodeId, playheadCompTime()));
  const centre = Matrix.transformPoint(inv, activeCompCentre());
  const rows = new Set(modifiedRowIds({ values, animated: new Set(defaultAnimation.animatedProps(nodeId)), centre }));

  // Masks: any mask at all is a change from "no mask".
  if (readNodeMask(node) || readNodeMaskAnim(node).length > 0) rows.add(MASK_ANIM_PROP);

  // Effect / style / contents parameters set away from their defaults.
  for (const row of buildStaticPropertyTree(nodeId)) {
    if (row.group === 'transform' || row.group === 'masks') continue;
    const changed = row.members.some((m) => {
      const meta = resolvePropertyMeta(m, nodeId);
      if (typeof meta.defaultValue !== 'number') return false;
      return Math.abs(staticOrDefaultValue(nodeId, m) - meta.defaultValue) > EPS;
    });
    if (changed) rows.add(row.prop);
  }
  return [...rows];
}
