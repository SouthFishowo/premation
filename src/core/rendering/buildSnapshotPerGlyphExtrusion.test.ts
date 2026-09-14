/**
 * Per-GLYPH extrusion bodies (AE 26): a per-character 3D text layer with
 * Extrusion Depth > 0 extrudes EACH character as its own solid, carried by the
 * same world matrix as its front plane — so an animator scattering glyphs in Z
 * or tumbling them keeps every front attached to its body. The whole-string
 * body must be GONE in that mode (it is what the planes used to detach from).
 *
 * The silhouette trace is mocked with a fixed square — the same seam
 * extrusionMeshText.test.ts uses — so these pins are about the EMISSION
 * structure (ids, sharing, ordering, ranges), not Skia's tracing.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { clearExtrusionMeshCaches } from '@core/scene/extrusionMesh';

const traceTextSpec = jest.fn();
jest.mock('@core/scene/shapesFromText', () => ({
  traceTextSpec: (spec: unknown, oversample?: number) => traceTextSpec(spec, oversample),
}));

const square = [
  { x: -10, y: -10, inX: -10, inY: -10, outX: -10, outY: -10 },
  { x: 10, y: -10, inX: 10, inY: -10, outX: 10, outY: -10 },
  { x: 10, y: 10, inX: 10, inY: 10, outX: 10, outY: 10 },
  { x: -10, y: 10, inX: -10, inY: 10, outX: -10, outY: 10 },
];

const COMP = { width: 800, height: 600, background: '#101014' };

function text3D(id: string, text: string, props: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'text', x: 400, y: 300, rotation: 0, width: 400, height: 80, z: 0, ...props },
      },
      { id: `${id}_x`, type: 'Text', props: { content: text, fontSize: 40, fontFamily: 'Inter', align: 'center' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

function snap(graph: SceneGraph, anim = new AnimationEngine(), t = 0) {
  return buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, COMP);
}

beforeEach(() => {
  clearExtrusionMeshCaches();
  traceTextSpec.mockReset();
  traceTextSpec.mockReturnValue([{ points: square, open: false }]);
});

describe('buildSnapshot — per-glyph extrusion bodies', () => {
  it('per-character 3D + depth: one body mesh per glyph, NO whole-string body', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'AB', { perChar3D: true, extrusionDepth: 60 }));
    const s = snap(g);
    const bodies = s.layers.filter((l) => /^t::ch\d+::ext-mesh$/.test(l.id));
    expect(bodies.map((l) => l.id)).toEqual(['t::ch0::ext-mesh', 't::ch1::ext-mesh']);
    for (const b of bodies) expect(b.extrudedMesh).toBeDefined();
    // The single shared solid — mesh or slice stack — is gone, replaced.
    expect(s.layers.some((l) => l.id === 't::ext-mesh')).toBe(false);
    expect(s.layers.some((l) => /^t::ext-/.test(l.id))).toBe(false);
    // The glyph planes are still the fronts.
    expect(s.layers.filter((l) => /^t::ch\d+$/.test(l.id))).toHaveLength(2);
  });

  it('each body rides its own glyph plane\'s world matrix (front stays attached)', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'AB', { perChar3D: true, extrusionDepth: 60 }));
    const s = snap(g);
    for (const i of [0, 1]) {
      const plane = s.layers.find((l) => l.id === `t::ch${i}`)!;
      const body = s.layers.find((l) => l.id === `t::ch${i}::ext-mesh`)!;
      expect(body.world3d).toEqual(plane.world3d);
      expect(body.width).toBe(plane.width);
      expect(body.height).toBe(plane.height);
    }
  });

  it('repeated characters share ONE mesh (same silhouette key, cached)', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'AAB', { perChar3D: true, extrusionDepth: 40 }));
    const s = snap(g);
    const key = (i: number) => s.layers.find((l) => l.id === `t::ch${i}::ext-mesh`)!.extrudedMesh!.key;
    expect(key(0)).toBe(key(1));
    expect(key(0)).not.toBe(key(2));
    // Two distinct silhouettes ⇒ two traces (plus none for the probe, which
    // hits the same LRU as glyph 0).
    expect(traceTextSpec.mock.calls.length).toBe(2);
  });

  it('bodies are body-only: no front range (the plane IS the front)', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'A', { perChar3D: true, extrusionDepth: 60 }));
    const s = snap(g);
    const body = s.layers.find((l) => l.id === 't::ch0::ext-mesh')!;
    const roles = body.extrudedMesh!.ranges.map((r) => r.role);
    expect(roles).not.toContain('front');
    expect(roles).toContain('side');
    expect(roles).toContain('back');
  });

  it('whitespace gets no body, matching its missing plane', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'A B', { perChar3D: true, extrusionDepth: 60 }));
    const s = snap(g);
    expect(s.layers.filter((l) => /::ext-mesh$/.test(l.id))).toHaveLength(2);
  });

  it('body emits BEFORE its plane, so the front\'s AA edge blends over the wall', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'A', { perChar3D: true, extrusionDepth: 60 }));
    const ids = snap(g).layers.map((l) => l.id);
    expect(ids.indexOf('t::ch0::ext-mesh')).toBeLessThan(ids.indexOf('t::ch0'));
  });

  it('REGRESSION: non-per-char extruded text keeps the single whole-string mesh', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'AB', { extrusionDepth: 60 }));
    const s = snap(g);
    expect(s.layers.some((l) => l.id === 't::ext-mesh')).toBe(true);
    expect(s.layers.some((l) => l.id.includes('::ch'))).toBe(false);
    // The string plane is still the front face.
    expect(s.layers.some((l) => l.id === 't')).toBe(true);
  });

  it('per-character 3D WITHOUT depth emits planes only (no bodies)', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'AB', { perChar3D: true }));
    const s = snap(g);
    expect(s.layers.filter((l) => /^t::ch\d+$/.test(l.id))).toHaveLength(2);
    expect(s.layers.some((l) => l.id.includes('::ext-'))).toBe(false);
  });
});
