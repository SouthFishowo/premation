/**
 * SVG stroke geometry reaches the created stroke.
 *
 * The parser read `stroke`, `stroke-width` and `stroke-opacity` and nothing
 * else, and the insert path hard-coded butt caps, miter joins and no dashes —
 * so a rounded outline icon imported with square ends and every dashed line
 * imported solid.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { insertSvgShapeGroup } from './sceneInsert';
import { seedDefaultScene } from './seedDefaultScene';
import { readNodeStroke } from '@core/paint/stroke';
import { readTrimOp } from './pathOps';
import { parseSvgToShapes } from '@utils/svgParser';
import type { SceneNode } from '@core/types';

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${inner}</svg>`;

/** A pulse keeps the file on the animated-import path the other SVG suites use. */
const PULSE = '<animate attributeName="opacity" values="1;0.5;1" dur="1s" repeatCount="indefinite"/>';

function onlyPart(markup: string, name: string): SceneNode {
  const groupId = insertSvgShapeGroup(markup, name);
  if (!groupId) throw new Error('insert produced no group');
  const ids = defaultSceneGraph.getNode(groupId)?.children ?? [];
  if (ids.length !== 1) throw new Error(`expected 1 part, got ${ids.length}`);
  return defaultSceneGraph.getNode(ids[0]!)!;
}

beforeAll(() => {
  seedDefaultScene();
});

describe('SVG stroke attributes → created stroke', () => {
  it('carries round caps, round joins, miter limit, dashes and dash offset', () => {
    const node = onlyPart(wrap(`
      <path d="M10 50 L50 20 L90 50" fill="none" stroke="#123456" stroke-width="4"
        stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="8"
        stroke-dasharray="6 3" stroke-dashoffset="2">${PULSE}</path>`), 'round.svg');
    const s = readNodeStroke(node)!;
    expect(s.cap).toBe('round');
    expect(s.join).toBe('round');
    expect(s.miterLimit).toBe(8);
    // Scaled with the geometry exactly like the width.
    const k = s.width / 4;
    expect(k).toBeGreaterThan(0);
    expect(s.dash).toHaveLength(2);
    expect(s.dash[0]).toBeCloseTo(6 * k);
    expect(s.dash[1]).toBeCloseTo(3 * k);
    expect(s.dashOffset).toBeCloseTo(2 * k);
  });

  it('reads them from inline style and from a <style> class, and inherits them from a group', () => {
    const node = onlyPart(wrap(`
      <style>.s { stroke-linejoin: bevel; stroke-dasharray: 5, 5 }</style>
      <g stroke-linecap="square">
        <path class="s" d="M10 50 L90 50" fill="none" stroke="#000" stroke-width="2"
          style="stroke-opacity:0.5">${PULSE}</path>
      </g>`), 'css.svg');
    const s = readNodeStroke(node)!;
    expect(s.cap).toBe('square');
    expect(s.join).toBe('bevel');
    expect(s.dash).toHaveLength(2);
    expect(s.opacity).toBeCloseTo(0.5);
  });

  it('keeps defaults when nothing is declared (no miterLimit/dashOffset written)', () => {
    const node = onlyPart(wrap(`<path d="M10 50 L90 50" fill="none" stroke="#000" stroke-width="2">${PULSE}</path>`), 'plain.svg');
    const fx = node.components.find((c) => c.type === 'fx')!.props.stroke as Record<string, unknown>;
    expect(fx.cap).toBe('butt');
    expect(fx.join).toBe('miter');
    expect(fx.dash).toEqual([]);
    expect('miterLimit' in fx).toBe(false);
    expect('dashOffset' in fx).toBe(false);
  });

  it('vector-effect: non-scaling-stroke keeps the stated width', () => {
    const scaled = onlyPart(wrap(`<path d="M10 50 L90 50" fill="none" stroke="#000" stroke-width="3">${PULSE}</path>`), 'a.svg');
    const fixed = onlyPart(wrap(`<path d="M10 50 L90 50" fill="none" stroke="#000" stroke-width="3" vector-effect="non-scaling-stroke">${PULSE}</path>`), 'b.svg');
    expect(readNodeStroke(scaled)!.width).not.toBeCloseTo(3);
    expect(readNodeStroke(fixed)!.width).toBeCloseTo(3);
  });

  it('a draw-on dasharray still becomes Trim End, not a dash pattern', () => {
    const node = onlyPart(wrap(`
      <path d="M10 50 L90 50" fill="none" stroke="#000" stroke-width="2"
        stroke-dasharray="80" stroke-dashoffset="80">
        <animate attributeName="stroke-dashoffset" from="80" to="0" dur="2s" fill="freeze"/>
      </path>`), 'drawon.svg');
    expect(readTrimOp(node)).not.toBeNull();
    const s = readNodeStroke(node)!;
    expect(s.dash).toEqual([]);
    expect(s.dashOffset).toBeUndefined();
  });

  it('parser: none, percentages and pathLength do not produce a dash', () => {
    const shapes = parseSvgToShapes(wrap(`
      <path d="M0 10 L90 10" stroke="#000" stroke-dasharray="none"/>
      <path d="M0 20 L90 20" stroke="#000" stroke-dasharray="10%"/>
      <path d="M0 30 L90 30" stroke="#000" stroke-dasharray="1" pathLength="1"/>
      <path d="M0 40 L90 40" stroke="#000" stroke-dasharray="4,2" stroke-linejoin="miter-clip"/>`));
    expect(shapes.map((s) => s.strokeDash)).toEqual([undefined, undefined, undefined, [4, 2]]);
    expect(shapes[3]!.strokeJoin).toBeUndefined(); // miter-clip → miter, the default
  });
});
