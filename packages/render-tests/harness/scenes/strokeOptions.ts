/**
 * AE Stroke options — Composite, per-paint blend, taper Length Units, wave
 * Cycles, taper ease sign, dash pairs and the Gradient Stroke's free points.
 *
 * ## New goldens, not re-blesses
 *
 * Every scene here uses a feature that did not exist before 2026-09-15, so each
 * needs a FIRST bless; none of them can move an existing reference. Rasterized
 * on the CPU into a texture like `strokeProfile.ts`, hence `expect-pass`.
 *
 * ## What each fixture is built to make visible
 *
 *   • composite — a stroke WIDER than it is tall at the fill edge, so "fill over
 *     the stroke's inner half" is a visibly thinner ring, not a 1px change;
 *   • blend — two overlapping strokes of saturated, different hues, so Multiply
 *     darkens their overlap to a colour neither has;
 *   • taper px — the SAME 60px ramp on a path whose length would make a 60%
 *     taper look completely different;
 *   • wave cycles — a CLOSED ellipse, where only a whole cycle count meets itself
 *     at the seam;
 *   • ease — opposite signs at the two ends, so a swapped sign convention is a
 *     mirror image, not a subtle change;
 *   • dash pairs — three pairs of DIFFERENT lengths, so a slot written to the
 *     wrong index moves a visible dash;
 *   • gradient points — a diagonal ramp the angle model could not express at
 *     that length, and a radial highlight pushed off-centre.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 360, height: 280, background: '#101014' };
const SIZE = { w: 360, h: 280 };
const CENTER = { x: 180, y: 140 };

const STROKE = {
  enabled: true, color: '#ffcf33', width: 18, opacity: 1,
  align: 'center', dash: [], cap: 'butt', join: 'miter',
};

/** An open S-curve — the `strokeProfile.ts` fixture, for the profile scenes. */
const CURVE = [
  { x: -130, y: 50, inX: -130, inY: 50, outX: -80, outY: -70 },
  { x: 0, y: 0, inX: -60, inY: -60, outX: 60, outY: 60 },
  { x: 130, y: -50, inX: 80, inY: 70, outX: 130, outY: -50 },
];

function scene(
  id: string,
  description: string,
  build: Parameters<typeof defineScene>[0]['build'],
): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], gpuParity: 'expect-pass', build });
}

const rect = (fill = '#1f4f8f') => node('s', {
  kind: 'shape', position: CENTER, transform: { width: 220, height: 150, shapeType: 'rect' }, style: { fill },
});

export const strokeOptionScenes: Scene[] = [
  scene('stroke-composite-fill-above', 'Fill set Composite = Above Previous: the fill covers the 28px stroke’s inner half.', (graph) => {
    graph.addNode(rect());
    graph.setFill('s', { type: 'solid', color: '#1f4f8f', composite: 'above' } as never);
    graph.setStroke('s', { ...STROKE, width: 28 } as never);
  }),
  scene('stroke-blend-multiply', 'Two strokes; the top one blends Multiply over the wide one beneath it.', (graph) => {
    graph.addNode(rect('transparent'));
    graph.setStrokes('s', [
      { ...STROKE, color: '#33c3ff', width: 34 },
      { ...STROKE, color: '#ff4f9a', width: 14, dash: [30, 12], blendMode: 'multiply' },
    ] as never);
  }),
  scene('stroke-taper-pixels', 'Open curve tapered over the first 60 PIXELS (Length Units = Pixels).', (graph) => {
    graph.addNode(node('s', {
      kind: 'shape', position: CENTER, style: { fill: 'transparent' },
      components: [{ id: 'p_g', type: 'Geometry', props: { points: CURVE, open: true } }],
    }));
    graph.setStroke('s', {
      ...STROKE, color: '#66e0ff',
      taper: { startWidth: 0.1, endWidth: 1, startLength: 60, endLength: 0, startEase: 0, endEase: 0, lengthUnits: 'pixels' },
    } as never);
  }),
  scene('stroke-taper-ease-signs', 'Round ease (+100%) at the start, pointy ease (−100%) at the end.', (graph) => {
    graph.addNode(node('s', {
      kind: 'shape', position: CENTER, style: { fill: 'transparent' },
      components: [{ id: 'p_g', type: 'Geometry', props: { points: CURVE, open: true } }],
    }));
    graph.setStroke('s', {
      ...STROKE, color: '#66e0ff', width: 22,
      taper: { startWidth: 0, endWidth: 0, startLength: 0.4, endLength: 0.4, startEase: 1, endEase: -1 },
    } as never);
  }),
  scene('stroke-wave-cycles-closed', 'Closed ellipse with an 8-cycle wave (Units = Cycles) — it meets itself at the seam.', (graph) => {
    graph.addNode(node('s', {
      kind: 'shape', position: CENTER, transform: { width: 220, height: 160, shapeType: 'ellipse' }, style: { fill: 'transparent' },
    }));
    graph.setStroke('s', { ...STROKE, width: 8, color: '#9dff6b', wave: { amount: 7, wavelength: 8, phase: 0, units: 'cycles' } } as never);
  }),
  scene('stroke-dash-three-pairs', 'Three Dash/Gap pairs of different lengths plus an offset.', (graph) => {
    graph.addNode(rect());
    graph.setStroke('s', { ...STROKE, width: 10, cap: 'round', dash: [34, 10, 6, 10, 16, 22], dashOffset: 12 } as never);
  }),
  scene('stroke-gradient-points', 'Linear gradient stroke on free Start/End points, corner to corner.', (graph) => {
    graph.addNode(rect());
    graph.setStroke('s', {
      ...STROKE, width: 20,
      paint: { type: 'linear', angle: 0, stops: [{ id: 'a', offset: 0, color: '#ff3d6e' }, { id: 'b', offset: 1, color: '#3dd7ff' }] },
      gradient: { startX: 0, startY: 0, endX: 1, endY: 1 },
    } as never);
  }),
  scene('stroke-gradient-radial-highlight', 'Radial gradient stroke with its highlight pushed 60% along 45°.', (graph) => {
    graph.addNode(rect());
    graph.setStroke('s', {
      ...STROKE, width: 26,
      paint: { type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops: [{ id: 'a', offset: 0, color: '#ffffff' }, { id: 'b', offset: 1, color: '#6a2bff' }] },
      gradient: { startX: 0.5, startY: 0.5, endX: 1, endY: 0.5, highlightLength: 0.6, highlightAngle: 45 },
    } as never);
  }),
];
