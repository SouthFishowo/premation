/**
 * When an extruded TEXT layer must NOT grow (all of) its body:
 *   • while it is being edited in place — the body is traced from the
 *     layer's text, and showed the pre-edit string through the edit overlay;
 *   • per-character 3D — the glyph planes draw the front and each glyph grows
 *     its OWN body (`::ch<i>::ext-mesh`, 2026-09-14): no whole-string body at
 *     all, and no body may paint a front cap over the planes.
 */
import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useTextEditStore } from '@stores/textEditStore';
import { clearExtrusionMeshCaches } from '@core/scene/extrusionMesh';

const COMP = { width: 800, height: 600, background: '#101014' };

// Mesh path needs an outline; jsdom has no canvas, so hand the tracer a square.
const square = [
  { x: -10, y: -10, inX: -10, inY: -10, outX: -10, outY: -10 },
  { x: 10, y: -10, inX: 10, inY: -10, outX: 10, outY: -10 },
  { x: 10, y: 10, inX: 10, inY: 10, outX: 10, outY: 10 },
  { x: -10, y: 10, inX: -10, inY: 10, outX: -10, outY: 10 },
];
jest.mock('@core/scene/shapesFromText', () => ({
  traceTextSpec: () => [{ points: square, open: false }],
}));

function text3D(id: string, props: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 400, y: 300, rotation: 0, width: 400, height: 80, z: 0, extrusionDepth: 60, ...props } },
      { id: `${id}_x`, type: 'Text', props: { content: 'AB', fontSize: 40, fontFamily: 'Inter', align: 'center' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

const snap = (g: SceneGraph) => buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);

beforeEach(() => {
  clearExtrusionMeshCaches();
  useTextEditStore.getState().end();
});

describe('buildSnapshot — extruded text body gates', () => {
  it('grows a body normally', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t'));
    expect(snap(g).layers.some((l) => l.id.startsWith('t::ext-'))).toBe(true);
  });

  it('drops the body while the layer is being edited in place, and only that layer', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t'));
    g.addNode(text3D('u'));
    useTextEditStore.getState().begin('t');
    const ids = snap(g).layers.map((l) => l.id);
    expect(ids.some((id) => id.startsWith('t::ext-'))).toBe(false);
    expect(ids.some((id) => id.startsWith('u::ext-'))).toBe(true);
    expect(ids).toContain('t');
  });

  it('per-character 3D + bevel: per-glyph bodies, none with a front cap (the glyph planes are the front)', () => {
    // Until 2026-09-14 this pinned a whole-string mesh under the planes; the
    // per-glyph redesign replaced that body with one solid per glyph
    // (buildSnapshotPerGlyphExtrusion.test.ts pins the structure in full).
    const g = new SceneGraph();
    g.addNode(text3D('t', { perChar3D: true, bevelDepth: 4 }));
    const layers = snap(g).layers;
    expect(layers.some((l) => l.id.startsWith('t::ext-'))).toBe(false);
    const bodies = layers.filter((l) => /^t::ch\d+::ext-mesh$/.test(l.id));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.extrudedMesh).toBeDefined();
      expect(b.extrudedMesh!.ranges.some((r) => r.role === 'front')).toBe(false);
    }
    expect(layers.filter((l) => /^t::ch\d+$/.test(l.id))).toHaveLength(2);
  });

  it('per-character 3D in-place editing drops the per-glyph bodies too', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', { perChar3D: true }));
    useTextEditStore.getState().begin('t');
    expect(snap(g).layers.some((l) => l.id.includes('::ext-'))).toBe(false);
  });

  it('plain text + bevel: the mesh DOES own the front cap (control for the case above)', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', { bevelDepth: 4 }));
    const mesh = snap(g).layers.find((l) => l.id === 't::ext-mesh');
    expect(mesh!.extrudedMesh!.ranges.some((r) => r.role === 'front')).toBe(true);
  });
});
