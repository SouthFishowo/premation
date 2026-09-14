/**
 * The Knife cuts the outline the renderer is actually drawing — radii included.
 *
 * A primitive that has never been converted to a path has no stored points, so
 * `readCutRuns` seeds the cut from `shapeOutline`. That call passed no corner
 * radii, so a rounded rect was cut as if it were sharp: the halves came back
 * with square corners the screen had never shown. Same class of bug as the
 * path-op chain's seed (`cornerRadiusPathOps.test.ts`) and the boolean's
 * operand seed (`mergePaths.test.ts`), and the same observable: the outline's
 * closest approach to the sharp corner it replaced is the arc's true r(√2−1).
 *
 * Driven through `createCommandPort` — the way the tool itself commits — so
 * the whole write path is covered: seed, world→local line mapping, subpath
 * write, shapeType flip.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { commands } from '@motion/workspace';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode, ID } from '@core/types';
import { createCommandPort } from './ports';

const W = 160;
const H = 120;
const R = 40;
/** The rounded outline's closest approach to the sharp corner it replaced. */
const STAND_OFF = R * (Math.SQRT2 - 1); // ≈ 16.57
const CX = 200;
const CY = 150;

function shapeNode(id: string, radiusProps: Record<string, number>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: CX, y: CY }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', shapeType: 'rect',
          x: CX, y: CY, rotation: 0, width: W, height: H,
          ...radiusProps,
        },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#1f4f8f' } },
    ],
  } as unknown as SceneNode;
}

/** Cut the layer with a vertical world line through its centre; return every
 *  written anchor in LOCAL space (how the runs are stored). */
function cutVertically(id: string): Array<{ x: number; y: number }> {
  createCommandPort().execute(
    commands.cutPaths([id], { x: CX, y: CY - 400 }, { x: CX, y: CY + 400 }),
  );
  const node = defaultSceneGraph.getNode(id as ID)!;
  const geom = node.components.find((c) => c.type === 'Geometry');
  const subs = geom?.props.subpaths as
    | Array<{ points: Array<{ x: number; y: number }>; open?: boolean }>
    | undefined;
  // The line crossed the ring, so the cut committed: two closed halves, and
  // the primitive is gone. Without this guard the stand-off assertions below
  // could pass against geometry the knife never wrote.
  expect(Array.isArray(subs)).toBe(true);
  expect(subs!.length).toBe(2);
  expect((node.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown>).shapeType).toBe('path');
  return subs!.flatMap((r) => r.points.map((p) => ({ x: p.x, y: p.y })));
}

// The runs are LOCAL, centred on the layer's origin.
const CORNERS = [
  { x: -W / 2, y: -H / 2 }, // TL
  { x: W / 2, y: -H / 2 },  // TR
  { x: W / 2, y: H / 2 },   // BR
  { x: -W / 2, y: H / 2 },  // BL
];

const minDistTo = (
  pts: ReadonlyArray<{ x: number; y: number }>,
  c: { x: number; y: number },
): number => Math.min(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));

beforeAll(() => {
  // The knife records one history entry per gesture; recording needs the boot
  // singleton. Same stub `mergePaths.test.ts` uses for its bakes.
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

const ids: string[] = [];
function addNode(node: SceneNode): void {
  defaultSceneGraph.addNode(node);
  ids.push(node.id as string);
}

afterEach(() => {
  for (const id of ids.splice(0)) defaultSceneGraph.removeNode(id as ID);
});

describe('Knife on a rounded-rect primitive', () => {
  it('SHARP CONTROL: without radii the halves keep a vertex AT each corner', () => {
    addNode(shapeNode('knife_sharp', {}));
    const pts = cutVertically('knife_sharp');
    for (const c of CORNERS) expect(minDistTo(pts, c)).toBeLessThan(0.75);
  });

  it('a uniform radius survives the cut: every corner stood off by r(√2−1)', () => {
    addNode(shapeNode('knife_round', { cornerRadius: R }));
    const pts = cutVertically('knife_round');
    for (const c of CORNERS) {
      const d = minDistTo(pts, c);
      expect(d).toBeGreaterThan(STAND_OFF - 1.5);
      expect(d).toBeLessThan(STAND_OFF + 1.5);
    }
  });

  it('per-corner radii survive: only the corner that asked is rounded', () => {
    addNode(shapeNode('knife_tl', { cornerRadiusTL: R }));
    const pts = cutVertically('knife_tl');
    const dTL = minDistTo(pts, CORNERS[0]!);
    expect(dTL).toBeGreaterThan(STAND_OFF - 1.5);
    expect(dTL).toBeLessThan(STAND_OFF + 1.5);
    // TR stays the sharp vertex it authored.
    expect(minDistTo(pts, CORNERS[1]!)).toBeLessThan(0.75);
  });
});
