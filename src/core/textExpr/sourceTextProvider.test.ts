/**
 * The host provider: what `text.sourceText` actually reads off a text node —
 * and the render hook that installs it on first use.
 */

import { AnimationEngine, SOURCE_TEXT_PROP } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readSourceTextSample, sourceTextExpressionResultFor, type NodeLookup } from './sourceTextProvider';

function textNode(id: string, name: string, props: Record<string, unknown>): SceneNode {
  return {
    id,
    name,
    parent: 'comp_root',
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0 } },
      { id: `${id}_c`, type: 'Text', props },
    ],
  } as unknown as SceneNode;
}

const nodes = new Map<string, SceneNode>([
  ['a', textNode('a', 'Title', { content: 'Hello', fontSize: 40, fill: '#ff0000', fontWeight: 700 })],
  ['s', { ...textNode('s', 'Shape', {}), components: [{ id: 's_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape' } }] } as SceneNode],
]);
const graph: NodeLookup = { getNode: (id) => nodes.get(id) };

describe('readSourceTextSample', () => {
  it('reads content and the layer-wide style off the components', () => {
    const eng = new AnimationEngine();
    const s = readSourceTextSample(eng, graph, 'a', 0)!;
    expect(s.text).toBe('Hello');
    expect(s.style).toMatchObject({ fontSize: 40, fill: '#ff0000', fontWeight: '700', fontFamily: 'Inter', horizontalScale: 100 });
  });

  it('Source Text HOLD keyframes win over the static content', () => {
    const eng = new AnimationEngine();
    eng.setDataKeyframe('a', SOURCE_TEXT_PROP, 'text', 0, 'One');
    eng.setDataKeyframe('a', SOURCE_TEXT_PROP, 'text', 2, 'Two');
    expect(readSourceTextSample(eng, graph, 'a', 1)?.text).toBe('One');
    expect(readSourceTextSample(eng, graph, 'a', 2.5)?.text).toBe('Two');
  });

  it('keyframed numeric props are sampled from TRACKS — expressions are never run (no recursion)', () => {
    const eng = new AnimationEngine();
    eng.setKeyframe('a', 'fontSize', 0, 10);
    eng.setKeyframe('a', 'fontSize', 2, 30);
    // An expression on fontSize that reads text would recurse if the provider sampled it.
    eng.setExpression('a', 'fontSize', 'text.sourceText.length');
    expect(readSourceTextSample(eng, graph, 'a', 1)?.style.fontSize).toBe(20);
  });

  it('is undefined for a layer that is not text', () => {
    expect(readSourceTextSample(new AnimationEngine(), graph, 's', 0)).toBeUndefined();
    expect(readSourceTextSample(new AnimationEngine(), graph, 'missing', 0)).toBeUndefined();
  });
});

describe('sourceTextExpressionResultFor — the render hook', () => {
  it('null without an enabled Source Text expression; installs the provider on first real use', () => {
    const eng = new AnimationEngine();
    eng.setLayerResolver((n) => (n === 'Title' ? 'a' : null));
    expect(sourceTextExpressionResultFor(eng, 'a', 0, graph)).toBeNull();
    expect(eng.hasSourceTextProvider()).toBe(false);

    eng.setExpression('a', SOURCE_TEXT_PROP, 'value.style.setText(value + " " + Math.round(time)).setFontSize(12, 0, 1)');
    const r = sourceTextExpressionResultFor(eng, 'a', 3, graph);
    expect(eng.hasSourceTextProvider()).toBe(true);
    expect(r).toEqual({ text: 'Hello 3', style: {}, ranges: [{ start: 0, count: 1, style: { fontSize: 12 } }] });

    // A font-size expression on the same layer reads the text without recursing.
    eng.setExpression('a', 'fontSize', 'text.sourceText.length');
    expect(eng.sample('a', 'fontSize', 3)).toBe(7);
  });
});
