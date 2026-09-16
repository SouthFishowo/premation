/**
 * buildSnapshot / snapshotToFrameScene benchmarks — `npm run bench`.
 *
 * NOT part of the default `jest` run (jest.config.cjs ignores `*.bench.test.ts`).
 *
 * The scenes are the shapes the engine audit named as the expensive ones:
 *
 *   flat-shapes-1000     1000 animated shape layers, every one a comp root —
 *                        the ~0.45 ms/root case (docs/VIEWPORT_WORKER_PLAN.md §3)
 *   text-200             200 text layers
 *   animated-paths-300   300 bezier path layers with animated x + rotation
 *   deep-chains-1000x8   1000 layers in 125 parent chains of depth 8
 *   deep-chain-200x50    200 layers in 4 chains of depth 50
 *   precomps-50x20       50 moving sealed comp layers over 50 STATIC comps of
 *                        20 layers — the static sealed-precomp cache; run
 *                        beside a `cache-off` twin for an in-process A/B
 *   text-feed-200-paused 200 text layers redrawn at a fixed time, each fed to
 *                        AppTextureProvider.setText (NullBackend) — the raster
 *                        reuse fast path; beside a `reuse-off` twin
 *
 * Each scenario reports ms per frame (mean, p50, p95) for the scene walk
 * (`buildSnapshot`) and the renderer-scene flatten (`snapshotToFrameScene`)
 * separately, at a moving playhead so the animation samplers do real work.
 *
 * ## Reading the numbers
 *
 * jsdom + ts-jest inflates tight-loop costs (see repo conventions), so these
 * are NOT production milliseconds. They are for A/B on one machine: run once
 * before a change, once after, compare `.artifacts/bench/buildSnapshot.latest.json`
 * with the timestamped copy the earlier run left beside it.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { COMP_REF_PROP } from '@core/scene/compInstance';
import { ResourceManager, NullBackend } from '@motion/renderer';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { snapshotToFrameScene } from '@core/rendering/snapshotToFrameScene';
import { setStaticPrecompCacheEnabled } from '@core/rendering/staticPrecompCache';
import { AppTextureProvider } from '@core/rendering/AppTextureProvider';

const W = 1920;
const H = 1080;
const FPS = 30;
const WARMUP = 5;
const RUNS = 30;

type Kind = 'shape' | 'text' | 'group';

function node(id: string, kind: Kind, parent: string | null, props: Record<string, unknown>, extra: SceneNode['components'] = []): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, ...props } },
      ...(kind === 'group' ? [] : [{ id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } }]),
      ...extra,
    ],
  } as unknown as SceneNode;
}

interface Scene {
  graph: SceneGraph;
  anim: AnimationEngine;
  layers: number;
  /** Extra comp fields (e.g. `compSizeOf` for sealed instances). */
  comp?: Record<string, unknown>;
}

function animateX(anim: AnimationEngine, id: string, from: number, to: number): void {
  anim.setKeyframes(id, 'x', [
    { t: 0, value: from, easing: 'linear' },
    { t: 4, value: to, easing: 'linear' },
  ] as never);
}

function flatShapes(n: number): Scene {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  graph.addNode(node('root', 'group', null, {}));
  for (let i = 0; i < n; i++) {
    const id = `s${i}`;
    const x = (i * 37) % W;
    graph.addChild('root', node(id, 'shape', 'root', { x, y: (i * 53) % H, width: 40, height: 40 }));
    animateX(anim, id, x, x + 200);
  }
  return { graph, anim, layers: n };
}

function texts(n: number): Scene {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  graph.addNode(node('root', 'group', null, {}));
  for (let i = 0; i < n; i++) {
    const id = `t${i}`;
    graph.addChild('root', node(id, 'text', 'root', { x: (i * 91) % W, y: (i * 29) % H, width: 320, height: 60 }, [
      { id: `${id}_x`, type: 'Text', props: { content: `Title ${i} — the quick brown fox`, fontSize: 32, fontFamily: 'Inter' } },
    ] as never));
  }
  return { graph, anim, layers: n };
}

/** A closed four-segment bezier blob, centred on the local origin. */
function blob(r: number): Array<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }> {
  const k = r * 0.5523;
  return [
    { x: 0, y: -r, inX: -k, inY: -r, outX: k, outY: -r },
    { x: r, y: 0, inX: r, inY: -k, outX: r, outY: k },
    { x: 0, y: r, inX: k, inY: r, outX: -k, outY: r },
    { x: -r, y: 0, inX: -r, inY: k, outX: -r, outY: -k },
  ];
}

function animatedPaths(n: number): Scene {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  graph.addNode(node('root', 'group', null, {}));
  for (let i = 0; i < n; i++) {
    const id = `p${i}`;
    const x = (i * 61) % W;
    graph.addChild('root', node(id, 'shape', 'root', { x, y: (i * 17) % H, width: 120, height: 120 }, [
      { id: `${id}_g`, type: 'Geometry', props: { points: blob(60), open: false } },
    ] as never));
    animateX(anim, id, x, x + 300);
    anim.setKeyframes(id, 'rotation', [
      { t: 0, value: 0, easing: 'linear' },
      { t: 4, value: 360, easing: 'linear' },
    ] as never);
  }
  return { graph, anim, layers: n };
}

function chains(total: number, depth: number): Scene {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  graph.addNode(node('root', 'group', null, {}));
  const chainCount = Math.ceil(total / depth);
  let made = 0;
  for (let c = 0; c < chainCount && made < total; c++) {
    let parent = 'root';
    for (let d = 0; d < depth && made < total; d++, made++) {
      const id = `c${c}_${d}`;
      graph.addChild(parent, node(id, 'shape', parent, { x: 4, y: 3, width: 20, height: 20 }));
      if (d === 0) animateX(anim, id, (c * 43) % W, ((c * 43) % W) + 100);
      parent = id;
    }
  }
  return { graph, anim, layers: made };
}

/**
 * 50 sealed placements of 50 different static comps, 20 layers each — the
 * "big comp of title cards" case the static sealed-precomp cache targets.
 * Every instance renders its referenced comp through its own nested pass.
 */
function staticPrecomps(comps: number, perComp: number): Scene & { comp: Record<string, unknown> } {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  for (let c = 0; c < comps; c++) {
    const ref = `pc${c}`;
    graph.addNode(node(ref, 'group', null, {}));
    for (let i = 0; i < perComp; i++) {
      const id = `${ref}_l${i}`;
      const isText = i % 4 === 3;
      graph.addChild(ref, node(id, isText ? 'text' : 'shape', ref, { x: 10 + (i % 5) * 36, y: 10 + Math.floor(i / 5) * 24, width: 30, height: 18 },
        isText ? [{ id: `${id}_x`, type: 'Text', props: { content: `Card ${c}.${i}`, fontSize: 14 } }] as never : []));
    }
  }
  graph.addNode(node('root', 'group', null, {}));
  for (let c = 0; c < comps; c++) {
    const id = `inst${c}`;
    graph.addChild('root', node(id, 'comp' as Kind, 'root', { x: 100 + (c % 10) * 180, y: 80 + Math.floor(c / 10) * 200 }, [
      { id: `${id}_fx`, type: 'fx', props: { precomp: true, [COMP_REF_PROP]: `pc${c}` } },
    ] as never));
    // The placements move; their contents do not.
    animateX(anim, id, 100 + (c % 10) * 180, 140 + (c % 10) * 180);
  }
  return {
    graph, anim, layers: comps * perComp,
    comp: { compSizeOf: (ref: string) => (ref.startsWith('pc') ? { width: 200, height: 120 } : undefined) },
  };
}

interface Stat { mean: number; p50: number; p95: number }

function stats(samples: number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return { mean: samples.reduce((a, b) => a + b, 0) / samples.length, p50: at(0.5), p95: at(0.95) };
}

interface ScenarioResult {
  id: string;
  layers: number;
  snapshotLayers: number;
  buildSnapshotMs: Stat;
  flattenMs: Stat;
  /** Texture-feed time (text-feed scenarios only). */
  feedMs?: Stat;
}

function run(id: string, make: () => Scene, opts: { precompCache?: boolean } = {}): ScenarioResult {
  const { graph, anim, layers, comp: extra } = make();
  const comp = { width: W, height: H, fps: FPS, background: '#101014', rootId: 'root', ...extra } as never;
  const snapMs: number[] = [];
  const flatMs: number[] = [];
  let snapshotLayers = 0;
  setStaticPrecompCacheEnabled(opts.precompCache ?? true);
  try {
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const t = (i / FPS) % 4;
      const a = performance.now();
      const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
      const b = performance.now();
      snapshotToFrameScene(snap);
      const c = performance.now();
      if (i >= WARMUP) {
        snapMs.push(b - a);
        flatMs.push(c - b);
      }
      snapshotLayers = snap.layers.length;
    }
  } finally {
    setStaticPrecompCacheEnabled(true);
  }
  return { id, layers, snapshotLayers, buildSnapshotMs: stats(snapMs), flattenMs: stats(flatMs) };
}

/**
 * A PAUSED comp redrawn over and over (selection change, overlay toggle, a
 * panel resize): the snapshot is rebuilt at the same time and every text layer
 * is fed to the texture provider, exactly as MotionRendererBackend does — the
 * signature built, the raster cache hit. `reuse` passes the layer's content
 * hash, which lets an unchanged text skip rebuilding its signature
 * (AppTextureProvider `RasterReuse`); off is the pre-reuse path.
 */
function runTextFeed(id: string, n: number, reuse: boolean): ScenarioResult {
  const { graph, anim, layers } = texts(n);
  const comp = { width: W, height: H, fps: FPS, background: '#101014', rootId: 'root' } as never;
  const resources = new ResourceManager(new NullBackend());
  const provider = new AppTextureProvider(resources, {});
  const snapMs: number[] = [];
  const flatMs: number[] = [];
  const feedMs: number[] = [];
  let snapshotLayers = 0;
  for (let i = 0; i < WARMUP + RUNS; i++) {
    resources.beginFrame(i + 1);
    const a = performance.now();
    const snap = buildSnapshot(graph, anim, 1, undefined, undefined, undefined, undefined, comp);
    const b = performance.now();
    snapshotToFrameScene(snap);
    const c = performance.now();
    for (const l of snap.layers) {
      if (l.kind !== 'text') continue;
      provider.setText(`text:${l.id}`, {
        text: l.text ?? 'Text', fontSize: l.fontSize ?? 48, color: l.fill ?? '#ffffff',
        width: l.width, height: l.height, scaleX: l.scaleX, scaleY: l.scaleY,
        continuousRaster: l.continuousRaster, fontFamily: l.fontFamily, fontWeight: l.fontWeight,
        fontWidth: l.fontWidth, fontSlant: l.fontSlant, fontStyle: l.fontStyle, align: l.align,
        letterSpacing: l.letterSpacing, lineHeight: l.lineHeight, paragraphSpacing: l.paragraphSpacing,
        strokeOverFill: l.strokeOverFill, textTransform: l.textTransform, fontVariant: l.fontVariant,
        verticalAlign: l.verticalAlign, verticalScale: l.verticalScale, horizontalScale: l.horizontalScale,
        baselineShift: l.baselineShift, textStroke: l.textStroke, textStrokeWidth: l.textStrokeWidth,
        textExtras: l.textExtras, runs: l.runs, glyphs: l.glyphs, textPath: l.textPath, fontAxes: l.fontAxes,
        fillPaint: l.fillPaint && l.fillPaint.type !== 'solid' ? l.fillPaint : undefined,
        strokePaint: l.textStrokePaint, effects: l.effects, mask: l.mask,
      }, reuse ? l.contentHash : undefined);
    }
    const d = performance.now();
    if (i >= WARMUP) {
      snapMs.push(b - a);
      flatMs.push(c - b);
      feedMs.push(d - c);
    }
    snapshotLayers = snap.layers.length;
  }
  return { id, layers, snapshotLayers, buildSnapshotMs: stats(snapMs), flattenMs: stats(flatMs), feedMs: stats(feedMs) };
}

function gitRev(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

const results: ScenarioResult[] = [];

describe('buildSnapshot bench', () => {
  const scenarios: Array<[string, () => Scene]> = [
    ['flat-shapes-1000', () => flatShapes(1000)],
    ['text-200', () => texts(200)],
    ['animated-paths-300', () => animatedPaths(300)],
    ['deep-chains-1000x8', () => chains(1000, 8)],
    ['deep-chain-200x50', () => chains(200, 50)],
  ];

  it.each(scenarios)('%s', (id, make) => {
    const r = run(id, make);
    results.push(r);
    // A sanity floor, not a threshold: the scene must actually have rendered.
    expect(r.snapshotLayers).toBeGreaterThan(0);
  });

  // In-run A/B pairs: the same scene with a cache off, so the comparison is
  // taken on one machine in one process rather than against an old JSON.
  it('precomps-50x20 (static precomp cache off / on)', () => {
    for (const [id, on] of [['precomps-50x20 cache-off', false], ['precomps-50x20', true]] as const) {
      const r = run(id, () => staticPrecomps(50, 20), { precompCache: on });
      results.push(r);
      expect(r.snapshotLayers).toBe(50);
    }
  });

  it('text-feed-200-paused (raster reuse off / on)', () => {
    for (const [id, on] of [['text-feed-200 reuse-off', false], ['text-feed-200-paused', true]] as const) {
      const r = runTextFeed(id, 200, on);
      results.push(r);
      expect(r.snapshotLayers).toBe(200);
    }
  });

  afterAll(() => {
    const f = (s: Stat): string => `${s.mean.toFixed(2).padStart(8)} ${s.p50.toFixed(2).padStart(8)} ${s.p95.toFixed(2).padStart(8)}`;
    const lines = [
      `buildSnapshot bench — ${RUNS} runs after ${WARMUP} warm-ups, ms/frame (jsdom: compare A/B only)`,
      `${'scenario'.padEnd(26)} ${'layers'.padStart(6)} │ ${'snap mean'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} │ ${'flat mean'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} │ ${'feed mean'.padStart(8)}`,
      ...results.map((r) => `${r.id.padEnd(26)} ${String(r.layers).padStart(6)} │ ${f(r.buildSnapshotMs)} │ ${f(r.flattenMs)} │ ${r.feedMs ? r.feedMs.mean.toFixed(2).padStart(8) : ''.padStart(8)}`),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    const out = {
      suite: 'buildSnapshot',
      at: new Date().toISOString(),
      rev: gitRev(),
      node: process.version,
      runs: RUNS,
      warmup: WARMUP,
      results,
    };
    const dir = join(process.cwd(), '.artifacts', 'bench');
    mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(out, null, 2);
    writeFileSync(join(dir, 'buildSnapshot.latest.json'), json);
    writeFileSync(join(dir, `buildSnapshot.${out.at.replace(/[:.]/g, '-')}.json`), json);
  });
});
