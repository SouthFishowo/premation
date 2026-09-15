/**
 * Text family: basic, multi-line, rich runs, per-glyph animator, text-on-path.
 *
 * Uses a widely-available font ('Arial'); glyph rasterisation is machine-font
 * dependent, so these references are valid under the "same machine + same
 * driver" determinism promise (the oracle re-render guards it).
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { ellipseMask } from '@core/effects/mask';

const COMP = { width: 480, height: 200, background: '#0c0c12' };
const SIZE = { w: 480, h: 200 };

function textNode(id: string, content: string, extraTextProps: Record<string, unknown> = {}) {
  return node(id, {
    kind: 'text',
    position: { x: 240, y: 100 },
    components: [
      {
        id: `${id}_c`,
        type: 'Text',
        props: { content, fontSize: 56, opacity: 100, fontFamily: 'Arial', align: 'center', fill: '#f4f4f8', ...extraTextProps },
      },
    ],
  });
}

function scene(
  id: string,
  description: string,
  build: Scene['build'],
  gpuParity: Scene['gpuParity'] = 'expect-pass',
  /** Per-scene diff tolerance when the 0.5% default is too tight (see effects.ts). */
  tolerance?: number,
): Scene {
  return defineScene({
    id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], gpuParity, build,
    ...(tolerance !== undefined ? { tolerance } : {}),
  });
}

export const textScenes: Scene[] = [
  scene('text-basic', 'Single-line centred text.', (graph) => {
    graph.addNode(textNode('t', 'Motion'));
  }),

  scene('text-multiline', 'Multi-line text with line height + paragraph spacing.', (graph) => {
    graph.addNode(textNode('t', 'Hello\nWorld', { fontSize: 44, lineHeight: 1.1, paragraphSpacing: 6 }));
  }),

  scene('text-rich-runs', 'Per-character styled runs (colour + weight spans).', (graph) => {
    graph.addNode(
      textNode('t', 'ABCDE', {
        __runs: [
          { start: 0, end: 2, style: { fill: '#ff5d73', fontWeight: '700' } },
          { start: 2, end: 5, style: { fill: '#5db4ff' } },
        ],
      }),
    );
  }),

  scene('text-glyph-animator', 'Per-glyph animator (triangle selector, vertical offset).', (graph) => {
    graph.addNode(
      textNode('t', 'BOUNCE', {
        fontSize: 52,
        __animators: [
          {
            id: 'a1', basedOn: 'characters', shape: 'triangle', start: 0, end: 100, offset: 0,
            x: 0, y: -34, scale: 120, rotation: 0, opacity: 100, tracking: 0, skew: 0, mode: 'range', wiggleFreq: 2,
          },
        ],
      }),
    );
    // Was 'known-divergent' on two counts, both now fixed: glyph transforms
    // were dropped between buildSnapshot and the rasterizer so this rendered
    // un-animated text, and once it DID animate the lifted glyphs were clipped
    // at the texture edge because text raster padding ignored animator extents.
    // With both fixed it matches, so it is GATED — a regression in either goes
    // red rather than being quietly tolerated.
  }, 'expect-pass'),

  scene('text-paragraph-box', 'Paragraph box text: fixed box clipping its overflow (top), centred and bottom-aligned in tall boxes.', (graph) => {
    const box = (id: string, x: number, content: string, props: Record<string, unknown>) =>
      node(id, {
        kind: 'text',
        position: { x, y: 100 },
        components: [
          {
            id: `${id}_c`,
            type: 'Text',
            props: { content, fontSize: 20, opacity: 100, fontFamily: 'Arial', align: 'left', fill: '#f4f4f8', boxWidth: 140, ...props },
          },
        ],
      });
    // 6+ wrapped lines in a 72px box: only the lines that fully fit are drawn.
    graph.addNode(box('clip', 80, 'Paragraph text wraps inside its box and lines that do not fit are clipped', { boxHeight: 72 }));
    graph.addNode(box('mid', 240, 'Centred in a tall box', { boxHeight: 170, boxVerticalAlign: 'center', align: 'center', fill: '#5db4ff' }));
    graph.addNode(box('low', 400, 'Bottom aligned', { boxHeight: 170, boxVerticalAlign: 'bottom', align: 'right', fill: '#ff5d73' }));
    // Tolerance: dense text is all edge pixels, and glyph AA differs between
    // the hardware adapter the reference was blessed on and CI's SwiftShader —
    // measured 0.574% on CI vs the 0.5% default gate (v0.8.3).
  }, 'expect-pass', 0.009),

  scene('text-optical-kerning', 'Kerning Metrics (top) vs Optical (bottom): shape-based pair spacing tucks AV, To, Ly, Wa.', (graph) => {
    const line = (id: string, y: number, kerningMode: 'metrics' | 'optical', fill: string) =>
      node(id, {
        kind: 'text',
        position: { x: 240, y },
        components: [
          {
            id: `${id}_c`,
            type: 'Text',
            props: { content: 'AVATAR To Ly Wave', fontSize: 40, opacity: 100, fontFamily: 'Arial', align: 'center', fill, kerningMode },
          },
        ],
      });
    graph.addNode(line('metrics', 62, 'metrics', '#f4f4f8'));
    graph.addNode(line('optical', 138, 'optical', '#5db4ff'));
  }),

  scene('text-word-grouping-gradient', 'Word anchor grouping (each word turns about its own centre) + a linear gradient across the block.', (graph) => {
    graph.addNode(
      textNode('t', 'TWO WORDS', {
        fontSize: 48,
        anchorGrouping: 'word',
        __animators: [
          {
            id: 'a1', basedOn: 'characters', shape: 'square', start: 0, end: 100, offset: 0,
            x: 0, y: 0, scale: 100, rotation: 10, opacity: 100, tracking: 0, skew: 0, mode: 'range', wiggleFreq: 2,
          },
        ],
      }),
    );
    graph.setFill('t', {
      type: 'linear',
      angle: 0,
      stops: [
        { id: 's0', offset: 0, color: '#ff5d73' },
        { id: 's1', offset: 1, color: '#5db4ff' },
      ],
    });
  }),

  scene('text-on-path', 'Text riding an ellipse mask path.', (graph) => {
    graph.addNode(textNode('t', 'ORBITING TEXT', { fontSize: 34 }));
    graph.setMask('t', { paths: [ellipseMask(360, 150)] });
    graph.setTextPath('t', { pathId: '', firstMargin: 0, reversed: false, perpendicular: true });
    // Was 'known-divergent' because `layer.textPath` died at the same seam as
    // the animator glyphs — buildSnapshot resolved the path placement and
    // nothing forwarded it, so this rendered a straight line of text. With the
    // seam wired it matches the reference exactly, so it is GATED now: if the
    // forwarding regresses, this goes red instead of being quietly tolerated.
  }, 'expect-pass'),

  // ── Non-Latin scripts (bundled Noto subsets, pinned in renderEntry) ──
  // Strings are \u-escaped: bidi and CJK literals are invisible or ambiguous in
  // an editor, and the escapes say exactly which characters the subsets hold.

  scene('text-rtl-bidi', 'Right-to-left paragraph box: Arabic (joined) + Hebrew + Latin + digits + brackets, soft-wrapped, start (right) aligned.', (graph) => {
    // مرحبا بالعالم (Premation 2026) שלום עולם 42!
    const content = 'مرحبا بالعالم (Premation 2026) שלום עולם 42!';
    graph.addNode(node('rtl', {
      kind: 'text',
      position: { x: 240, y: 100 },
      components: [{
        id: 'rtl_c',
        type: 'Text',
        props: { content, fontSize: 30, fontWeight: '400', opacity: 100, fontFamily: 'Arial', fill: '#f4f4f8', boxWidth: 300, direction: 'rtl' },
      }],
    }));
  }),

  scene('text-vertical-cjk', 'Vertical paragraph box: kinsoku (。 never starts a column), vertical 、。「」ー, auto tate-chu-yoko 2026, a sideways Latin word, justified columns.', (graph) => {
    // 縦書きの組版。「かぎ括弧」、長音ラーメン2026年にPremationで組む
    const content = '縦書きの組版。「かぎ括弧」、長音ラーメン'
      + '2026年にPremationで組む';
    graph.addNode(node('vert', {
      kind: 'text',
      position: { x: 240, y: 100 },
      components: [{
        id: 'vert_c',
        type: 'Text',
        props: {
          content, fontSize: 24, fontWeight: '400', opacity: 100, fontFamily: 'Arial', fill: '#f4f4f8',
          orientation: 'vertical', boxWidth: 320, boxHeight: 150, align: 'justify-left',
          tateChuYokoAuto: true, tateChuYokoDigits: 4,
        },
      }],
    }));
    // Tolerance: same cross-adapter glyph-AA drift as text-paragraph-box, and
    // worst here — vertical CJK is the densest ink of the suite; 0.897% on CI.
  }, 'expect-pass', 0.013),

  scene('text-vertical-path', 'Vertical Japanese riding a curved (open) mask path.', (graph) => {
    // 縦書きの道、ゆっくり進む。
    const content = '縦書きの道、ゆっくり進む。';
    graph.addNode(node('vpath', {
      kind: 'text',
      position: { x: 240, y: 100 },
      components: [{
        id: 'vpath_c',
        type: 'Text',
        props: { content, fontSize: 24, fontWeight: '400', opacity: 100, fontFamily: 'Arial', fill: '#f4f4f8', orientation: 'vertical' },
      }],
    }));
    // A gentle arch, left to right (open: a path to ride, not a clip).
    const pt = (x: number, y: number, inX: number, inY: number, outX: number, outY: number) => ({ x, y, inX, inY, outX, outY });
    graph.setMask('vpath', {
      paths: [{
        id: 'arch', mode: 'none', closed: false, feather: 0, opacity: 1, expansion: 0, inverted: false,
        points: [pt(-190, 40, -190, 40, -110, -70), pt(190, 40, 110, -70, 190, 40)],
      }],
    });
    graph.setTextPath('vpath', { pathId: 'arch', firstMargin: 20, reversed: false, perpendicular: true });
    // Tolerance: cross-adapter glyph-AA drift (see text-paragraph-box); every
    // glyph here is also rotated along the arch — 0.592% on CI.
  }, 'expect-pass', 0.009),
];
