/**
 * Create Shapes / Masks from Text on a VARIABLE font trace the instance the
 * layer draws — not the file's default instance.
 *
 * `outlineTextNode` is the seam both commands share. The Local Font Access API
 * is stubbed to hand back the committed Oswald[wght].ttf (SIL OFL 1.1), and
 * jsdom's missing 2D context is replaced with one that has metrics, so the
 * font path (not the trace fallback) runs end to end.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readMeasuredTextStyle } from '@core/text/measureText';
import type { SceneNode } from '@core/types';
import { drawnVariationOf, outlineTextNode } from './shapesFromText';

const file = readFileSync(join(__dirname, '..', 'text', '__fixtures__', 'variable', 'Oswald[wght].ttf'));
const bytes = (): ArrayBuffer => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;

function fakeContext(): CanvasRenderingContext2D {
  let font = '10px sans-serif';
  const size = (): number => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
  const ctx = {
    get font() { return font; },
    set font(v: string) { font = v; },
    textBaseline: 'middle', textAlign: 'center', letterSpacing: '0px', fontKerning: 'auto',
    measureText(t: string) {
      const s = size();
      const width = [...t].length * 0.5 * s;
      return {
        width,
        actualBoundingBoxLeft: 0, actualBoundingBoxRight: width,
        actualBoundingBoxAscent: 0.6 * s, actualBoundingBoxDescent: 0.2 * s,
        fontBoundingBoxAscent: 0.7 * s, fontBoundingBoxDescent: 0.3 * s,
        alphabeticBaseline: -0.25 * s,
      };
    },
    save() {}, restore() {}, scale() {}, translate() {}, setTransform() {}, fillText() {}, strokeText() {}, clearRect() {},
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function textNode(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0 } },
      { id: `${id}_c`, type: 'Text', props: { content: 'nob', fontSize: 100, fontFamily: 'Oswald', fontWeight: '400', opacity: 100, ...props } },
    ],
  };
}

type Runs = NonNullable<Awaited<ReturnType<typeof outlineTextNode>>>['runs'];
/** Ink area of layer-space runs: contour signed areas summed (counters subtract). */
const inkArea = (runs: Runs): number =>
  Math.abs(runs.reduce((sum, r) => {
    let a = 0;
    for (let i = 0; i < r.points.length; i++) {
      const p = r.points[i]!, q = r.points[(i + 1) % r.points.length]!;
      a += p.x * q.y - q.x * p.y;
    }
    return sum + a / 2;
  }, 0));

const g = globalThis as unknown as { queryLocalFonts?: () => Promise<unknown[]> };

beforeAll(() => {
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => fakeContext()) as never);
  g.queryLocalFonts = async () => [
    { family: 'Oswald', style: 'Regular', postscriptName: 'Oswald-VF-test', blob: async () => ({ arrayBuffer: async () => bytes() }) },
  ];
});

afterAll(() => {
  delete g.queryLocalFonts;
  jest.restoreAllMocks();
});

const added: string[] = [];
function add(node: SceneNode): SceneNode {
  defaultSceneGraph.addNode(node);
  added.push(node.id);
  return defaultSceneGraph.getNode(node.id)!;
}
afterEach(() => {
  for (const id of added.splice(0)) {
    defaultAnimation.setTrackKeyframes(id, 'fontWeight', null);
    defaultSceneGraph.removeNode(id);
  }
});

describe('Shapes / Masks from Text on a variable font', () => {
  it('outlines the static weight\'s instance: wght 700 is bolder than 400, which is bolder than 200', async () => {
    const at = async (w: string): Promise<number> => {
      const out = await outlineTextNode(add(textNode(`vf_static_${w}`, { fontWeight: w })));
      expect(out?.source).toBe('outlines');
      return inkArea(out!.runs);
    };
    const light = await at('200');
    const regular = await at('400');
    const bold = await at('700');
    expect(regular).toBeGreaterThan(light * 1.15);
    expect(bold).toBeGreaterThan(regular * 1.15);
  });

  it('samples keyframed weight at the command\'s time', async () => {
    const node = add(textNode('vf_keyed', { fontWeight: '400' }));
    defaultAnimation.setKeyframe(node.id, 'fontWeight', 0, 200);
    defaultAnimation.setKeyframe(node.id, 'fontWeight', 1, 700);
    const style = readMeasuredTextStyle(node)!;
    expect(drawnVariationOf(node, style).fontWeight).toBe('400');
    expect(drawnVariationOf(node, style, 1).fontWeight).toBe('700');
    const early = await outlineTextNode(node, 0);
    const late = await outlineTextNode(node, 1);
    expect(early?.source).toBe('outlines');
    expect(inkArea(late!.runs)).toBeGreaterThan(inkArea(early!.runs) * 1.3);
  });

  it('a width / slant on the layer no longer forces the trace', async () => {
    const out = await outlineTextNode(add(textNode('vf_wdth', { fontWidth: 80 })));
    // Oswald has no wdth axis: it draws (and outlines) at its only width.
    expect(out?.source).toBe('outlines');
  });
});
