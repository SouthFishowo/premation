/**
 * The host half of Source Text expressions: how the animation engine reads a
 * text layer's content and style.
 *
 * `packages/animation` owns the expression semantics but cannot see scene
 * components, so it asks a provider for a layer's PRE-expression Source Text
 * (`SourceTextProvider`). This module is that provider, plus the idempotent
 * install and the render-hook entry point the snapshot builder calls.
 *
 * ## Why it reads TRACKS, never `engine.sample`
 *
 * `sample` evaluates expressions. A Font Size expression that reads
 * `text.sourceText.length` would then re-enter this provider, which would
 * sample Font Size, which would run the expression… — unbounded recursion
 * through a path the engine's cycle guard cannot see (it spans two
 * evaluations). Keyframes only, exactly as the hold track is.
 *
 * ## Installed lazily, from every consumer
 *
 * The render hook, the expression editor and the text commands all call
 * `installSourceTextProvider`, so the feature works whichever of them runs
 * first — including the headless `premation render` CLI, which mounts no UI.
 */

import {
  defaultAnimation,
  sampleTrack,
  SOURCE_TEXT_PROP,
  type AnimationEngine,
  type SourceTextExpressionResult,
  type SourceTextSample,
  type SourceTextStyle,
} from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readRuns } from '@core/text/richText';
import { firstParagraphDirection } from '@core/text/textExtras';
import type { SceneNode } from '@core/types';

/** The one graph method this needs — keeps tests off the real graph. */
export interface NodeLookup {
  getNode(id: string): SceneNode | undefined | null;
}

type EngineReads = Pick<AnimationEngine, 'sampleData' | 'tracksFor'>;

const str = (v: unknown, fb: string): string => (typeof v === 'string' ? v : fb);
const numOr = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

/**
 * A text node's Source Text at layer time `t`: the hold track (when keyed) or
 * the static content, and the layer-wide style with keyframed numeric props
 * sampled. Undefined for anything that is not a text layer.
 */
export function readSourceTextSample(
  engine: EngineReads,
  graph: NodeLookup,
  nodeId: string,
  t: number,
): SourceTextSample | undefined {
  const node = graph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'text') return undefined;

  const props: Record<string, unknown> = {};
  for (const c of node.components) Object.assign(props, c.props as Record<string, unknown>);

  const tracks = new Map(engine.tracksFor(nodeId).map((tr) => [tr.prop, tr]));
  const animated = (prop: string, fb: number): number => {
    const tr = tracks.get(prop);
    const v = tr ? sampleTrack(tr, t) : undefined;
    return v !== undefined && Number.isFinite(v) ? v : fb;
  };

  const live = engine.sampleData(nodeId, SOURCE_TEXT_PROP, t);
  const text = typeof live === 'string' ? live : str(props.content, '');
  const fontSize = animated('fontSize', numOr(props.fontSize, 48));
  const weightTrack = tracks.get('fontWeight');
  const sampledWeight = weightTrack ? sampleTrack(weightTrack, t) : undefined;

  const style: SourceTextStyle = {
    fontFamily: str(props.fontFamily, 'Inter'),
    fontSize,
    fontWeight: sampledWeight !== undefined
      ? String(Math.round(sampledWeight))
      : typeof props.fontWeight === 'number' ? String(props.fontWeight) : str(props.fontWeight, '600'),
    fontStyle: str(props.fontStyle, 'normal'),
    fill: str(props.fill, '#ffffff'),
    ...(typeof props.stroke === 'string' ? { stroke: props.stroke }
      : typeof props.textStroke === 'string' ? { stroke: props.textStroke } : {}),
    strokeWidth: animated('strokeWidth', numOr(props.strokeWidth, numOr(props.textStrokeWidth, 0))),
    letterSpacing: animated('letterSpacing', numOr(props.letterSpacing, 0)),
    lineHeight: animated('lineHeight', numOr(props.lineHeight, 1.2)),
    baselineShift: animated('baselineShift', numOr(props.baselineShift, 0)),
    horizontalScale: animated('horizontalScale', numOr(props.horizontalScale, 100)),
    verticalScale: animated('verticalScale', numOr(props.verticalScale, 100)),
    textTransform: str(props.textTransform, 'none'),
    fontVariant: str(props.fontVariant, 'normal'),
    align: str(props.align, 'left'),
    paragraphSpacing: animated('paragraphSpacing', numOr(props.paragraphSpacing, 0)),
    firstLineIndent: numOr(props.firstLineIndent, 0),
    leftIndent: numOr(props.leftIndent, 0),
    rightIndent: numOr(props.rightIndent, 0),
    spaceBefore: numOr(props.spaceBefore, 0),
    // The style getter's `direction` reports the layer's own paragraph direction
    // ('auto' as its first paragraph resolves — the expression API has two values).
    ...(firstParagraphDirection(props.direction, text) === 'rtl' ? { direction: 'rtl' } : {}),
  };
  const runs = readRuns(node);
  return { text, style, ...(runs.length > 0 ? { runs } : {}) };
}

const installed = new WeakSet<object>();

/** Bind the provider to an engine (idempotent per engine). */
export function installSourceTextProvider(
  engine: AnimationEngine = defaultAnimation,
  graph: NodeLookup = defaultSceneGraph,
): void {
  if (installed.has(engine)) return;
  installed.add(engine);
  engine.setSourceTextProvider((id, t) => readSourceTextSample(engine, graph, id, t));
}

/**
 * THE RENDER HOOK. The Source Text expression result for `nodeId` at LAYER
 * time `t`, or null when it has no enabled Source Text expression (the cheap,
 * common case — one Map lookup).
 */
export function sourceTextExpressionResultFor(
  engine: AnimationEngine,
  nodeId: string,
  t: number,
  graph: NodeLookup = defaultSceneGraph,
): SourceTextExpressionResult | null {
  if (!engine.isExpressionEnabled(nodeId, SOURCE_TEXT_PROP)) return null;
  if (!engine.hasSourceTextProvider()) installSourceTextProvider(engine, graph);
  return engine.evaluateSourceText(nodeId, t);
}
