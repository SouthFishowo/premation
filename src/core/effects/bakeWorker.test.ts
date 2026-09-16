/**
 * Bake-worker DETERMINISM: one job, one output, wherever it runs.
 *
 * Three routes over the same prepared pixels must agree byte for byte:
 *
 *   direct   applyEffectChain over a canvas seeded with putImageData — what the
 *            main-thread bake computes
 *   local    runBakeJob, the pool's no-worker fallback
 *   worker   handleBakeRequest, the worker's message handler verbatim, fed a
 *            structured copy of the job (what postMessage delivers)
 *
 * The canvas here is jest.setup.ts's Skia, so this proves the ROUTES agree on
 * one rasterizer — which is the property the pool adds. Whether Chromium's
 * worker canvas matches its main-thread canvas is the golden gate's question.
 */

import type { Effect } from './effects';
import { EFFECT_DEFS, defaultParams } from './effects';
import { applyEffectChain } from './effectBake';
import {
  runBakeJob, handleBakeRequest, bakeJobWorkerSafe, textDrawingEffects,
  type BakeJobInput, type BakeResponseMessage,
} from './bakeWorkerCore';
import { hasCanvas } from './__testHelpers__/canvasFidelity';
import { readSource } from '@/__testHelpers__/readSource';

const W = 48;
const H = 32;

const canvas = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** A layer with colour, soft alpha and a hole — enough for every kernel to bite. */
function prepared(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inside = x > 6 && x < W - 6 && y > 4 && y < H - 4;
      const hole = (x - 24) ** 2 + (y - 16) ** 2 < 25;
      px[i] = (x * 5) & 255;
      px[i + 1] = (y * 7) & 255;
      px[i + 2] = ((x + y) * 3) & 255;
      px[i + 3] = inside && !hole ? 255 : inside ? 90 : 0;
    }
  }
  return px;
}

function fx(type: string, over: Record<string, unknown> = {}, extra: Partial<Effect> = {}): Effect {
  const def = EFFECT_DEFS.find((d) => d.type === type)!;
  return { id: `e-${type}`, type, params: { ...defaultParams(def), ...over }, ...extra } as Effect;
}

function direct(job: BakeJobInput): Uint8ClampedArray {
  const c = canvas(job.w, job.h);
  const ctx = c.getContext('2d')!;
  const seed = ctx.createImageData(job.w, job.h);
  seed.data.set(job.pixels);
  ctx.putImageData(seed, 0, 0);
  applyEffectChain(ctx, job.w, job.h, job.effects, canvas, job.fillOpacity, job.mask);
  return ctx.getImageData(0, 0, job.w, job.h).data;
}

function viaWorkerHandler(job: BakeJobInput): Uint8ClampedArray {
  // What postMessage delivers: a structured copy (params JSON-safe, pixels copied).
  const copy: BakeJobInput = {
    ...JSON.parse(JSON.stringify({ ...job, pixels: undefined })) as BakeJobInput,
    pixels: new Uint8ClampedArray(job.pixels),
  };
  let reply: BakeResponseMessage | null = null;
  let transferred: Transferable[] = [];
  handleBakeRequest({ id: 1, job: copy }, canvas, (r, t) => { reply = r; transferred = t; });
  const r = reply as BakeResponseMessage | null;
  if (!r || !r.ok) throw new Error(`worker handler failed: ${r && !r.ok ? r.error : 'no reply'}`);
  expect(transferred).toEqual([r.pixels.buffer]);
  return r.pixels;
}

const STACKS: Array<[string, () => BakeJobInput]> = [
  ['pure pixel kernels (median → add-grain → turbulent-displace)', () => ({
    w: W, h: H, pixels: prepared(), fillOpacity: 1,
    effects: [fx('median', { radius: 2 }), fx('add-grain', { intensity: 40 }), fx('turbulent-displace', { amount: 12 })],
  })],
  ['a drawn effect between pixel passes (vegas reads the contour, then strokes)', () => ({
    w: W, h: H, pixels: prepared(), fillOpacity: 1,
    effects: [fx('cartoon'), fx('vegas'), fx('mirror')],
  })],
  ['CSS filter + Compositing opacity + fill opacity', () => ({
    w: W, h: H, pixels: prepared(), fillOpacity: 0.4,
    effects: [fx('blur', { amount: 3 }), fx('gaussian-blur', { blurriness: 4 }, { opacity: 35 }), fx('stroke', { width: 2, color: '#ff0000', opacity: 100 })],
  })],
];

(hasCanvas ? describe : describe.skip)('bake job determinism', () => {
  it.each(STACKS)('%s: worker handler = local job = direct chain, byte for byte', (_name, make) => {
    const d = direct(make());
    const l = runBakeJob(make(), canvas);
    const w = viaWorkerHandler(make());
    expect(Buffer.from(l).equals(Buffer.from(d))).toBe(true);
    expect(Buffer.from(w).equals(Buffer.from(d))).toBe(true);
  });

  it('actually changes pixels (a no-op chain would pass the equality trivially)', () => {
    const [, make] = STACKS[0]!;
    const out = runBakeJob(make(), canvas);
    expect(Buffer.from(out).equals(Buffer.from(prepared()))).toBe(false);
  });

  it('reports a failing job as an error reply rather than throwing out of the worker', () => {
    let reply: BakeResponseMessage | null = null;
    handleBakeRequest(
      { id: 9, job: { w: W, h: H, pixels: prepared(), fillOpacity: 1, effects: [] } },
      () => { throw new Error('no canvas'); },
      (r) => { reply = r; },
    );
    expect(reply).toEqual({ id: 9, ok: false, error: 'no canvas' });
  });
});

describe('what may bake in a worker', () => {
  it('keeps text readouts on the main thread (fonts are not visible in workers)', () => {
    expect(bakeJobWorkerSafe([fx('numbers')])).toBe(false);
    expect(bakeJobWorkerSafe([fx('median'), fx('timecode')])).toBe(false);
    // Disabled text effects draw nothing, so they do not pin the stack.
    expect(bakeJobWorkerSafe([fx('median'), { ...fx('timecode'), enabled: false }])).toBe(true);
    expect(bakeJobWorkerSafe([fx('vegas'), fx('plexus'), fx('lightning')])).toBe(true);
    expect(bakeJobWorkerSafe(undefined)).toBe(true);
  });

  it('the text classification covers every effect that reaches fillText', () => {
    // fillText lives in generateText.ts alone, behind drawTextReadout…
    const effectsDir = ['generateText.ts', 'canvas2dEffects.ts', 'generatePatterns.ts', 'generateAdvanced.ts', 'generateRoundFive.ts', 'vegas.ts', 'plexus.ts', 'scribble.ts', 'pathStroke.ts'];
    const withFillText = effectsDir.filter((f) => /\.fillText\(|\.strokeText\(/.test(readSource(`core/effects/${f}`)));
    expect(withFillText).toEqual(['generateText.ts']);
    // …and drawTextReadout is called by exactly the dispatch functions of the
    // classified types.
    const src = readSource('core/effects/canvas2dEffects.ts');
    const callers = [...src.matchAll(/function (apply\w+)\([^)]*\)[^{]*\{(?:(?!\nfunction )[\s\S])*?drawTextReadout\(/g)].map((m) => m[1]);
    expect(callers.sort()).toEqual(['applyNumbers', 'applyTimecode']);
    expect([...textDrawingEffects()].sort()).toEqual(['numbers', 'timecode']);
  });
});
