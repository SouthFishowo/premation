/**
 * 1.6.0 → 1.7.0 — Trim Multiple Shapes gets AE's meaning under a new key.
 *
 * The things this migration could get wrong, all silent:
 *
 *  1. It changes the PICTURE. The two words used to be swapped against AE, so
 *     each stored value must land on the word that NOW names the behaviour it
 *     had — asserted through `applyPathOpChain`, not only as data.
 *  2. It is not IDEMPOTENT. `captureDocument` stamps '1.1.0' (F31), so a
 *     document saved by this build runs through this step on every load. A
 *     value swap would flip the mode back on the first reopen.
 *  3. It leaves the old key behind, and `readPathOps` never reads it.
 */

import { v1_6_0_to_v1_7_0 } from './v1_6_0_to_v1_7_0';
import { migrateDocument, CURRENT_DOCUMENT_VERSION, MIGRATIONS } from './index';
import type { EditorDocument } from '@core/api/cloudDocument';
import SceneGraph from '@core/scene/SceneGraph';
import { readPathOps, applyPathOpChain, type PathOp } from '@core/scene/pathOps';
import type { SceneNode } from '@core/types';

/** A 1.6.0 document with three trims: legacy simultaneously, individually, absent. */
function legacyDoc(): EditorDocument {
  const trim = (id: string, extra: Record<string, unknown>) => ({
    id, type: 'trim', amount: 0, detail: 0, start: 0, end: 50, offset: 0, ...extra,
  });
  return {
    version: '1.6.0',
    scene: {
      nodes: [
        {
          id: 'a', name: 'a', parent: null, children: [], visible: true, locked: false,
          transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          components: [
            { id: 'a_fx', type: 'fx', props: { pathOps: [
              trim('seq', { trimMultiple: 'simultaneously' }),
              trim('same', { trimMultiple: 'individually' }),
              trim('bare', {}),
            ] } },
          ],
        },
      ],
    },
    animation: { tracks: {} },
  } as unknown as EditorDocument;
}

const opsOf = (doc: EditorDocument): Array<Record<string, unknown>> =>
  ((doc.scene as unknown as { nodes: Array<{ components: Array<{ props: { pathOps: Array<Record<string, unknown>> } }> }> })
    .nodes[0]!.components[0]!.props.pathOps);

describe('v1_6_0_to_v1_7_0 — shape', () => {
  it('translates each legacy word to the word that names the same behaviour now', () => {
    const ops = opsOf(v1_6_0_to_v1_7_0.migrate(legacyDoc()));
    // Old `simultaneously` walked the runs in sequence → AE's Individually.
    expect(ops[0]!.trimMultipleShapes).toBe('individually');
    // Old `individually` trimmed by the same percent → AE's Simultaneously.
    expect(ops[1]!.trimMultipleShapes).toBe('simultaneously');
    // Absent stays absent — and absent now reads as the same-percent default.
    expect('trimMultipleShapes' in ops[2]!).toBe(false);
  });

  it('DELETES the old key — no dual-shape reads', () => {
    for (const op of opsOf(v1_6_0_to_v1_7_0.migrate(legacyDoc()))) {
      expect('trimMultiple' in op).toBe(false);
    }
  });

  it('does not mutate its input', () => {
    const input = legacyDoc();
    v1_6_0_to_v1_7_0.migrate(input);
    expect(opsOf(input)[0]!.trimMultiple).toBe('simultaneously');
  });

  it('leaves a document with nothing to convert as the SAME object', () => {
    const doc = legacyDoc();
    for (const op of opsOf(doc)) delete op.trimMultiple;
    expect(v1_6_0_to_v1_7_0.migrate(doc)).toBe(doc);
  });

  it('is IDEMPOTENT — re-running on its own output changes nothing', () => {
    // The case every load takes (F31): a document written by this build.
    const once = v1_6_0_to_v1_7_0.migrate(legacyDoc());
    const twice = v1_6_0_to_v1_7_0.migrate(once);
    expect(twice).toBe(once);
    expect(opsOf(twice)[0]!.trimMultipleShapes).toBe('individually');
  });

  it('walks nested children too', () => {
    const doc = legacyDoc();
    const nodes = (doc.scene as unknown as { nodes: Array<Record<string, unknown>> }).nodes;
    const child = structuredClone(nodes[0]!);
    nodes[0]!.components = [];
    nodes[0]!.children = [child];
    const out = v1_6_0_to_v1_7_0.migrate(doc);
    const migrated = (out.scene as { nodes: Array<{ children: unknown[] }> }).nodes[0]!.children[0] as {
      components: Array<{ props: { pathOps: Array<Record<string, unknown>> } }>;
    };
    expect(migrated.components[0]!.props.pathOps[0]!.trimMultipleShapes).toBe('individually');
  });
});

describe('v1_6_0_to_v1_7_0 — the picture is unchanged', () => {
  const runs = [
    { pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false },
    { pts: [{ x: 0, y: 10 }, { x: 100, y: 10 }], closed: false },
  ];

  it('each migrated trim produces the geometry its legacy mode produced', () => {
    const g = new SceneGraph();
    for (const n of (migrateDocument(legacyDoc()).scene as { nodes: SceneNode[] }).nodes) g.addNode(structuredClone(n));
    const [seq, same, bare] = readPathOps(g.getNode('a')!) as [PathOp, PathOp, PathOp];
    // Legacy simultaneously = sequential: half the combined length is the first line only.
    expect(applyPathOpChain(runs, [seq])).toHaveLength(1);
    // Legacy individually and legacy absent = same percent: both lines half drawn.
    expect(applyPathOpChain(runs, [same])).toHaveLength(2);
    expect(applyPathOpChain(runs, [bare])).toHaveLength(2);
  });
});

describe('v1_6_0_to_v1_7_0 — registered in the chain', () => {
  it('steps 1.6.0 → 1.7.0 exactly once and reaches the current version', () => {
    expect(MIGRATIONS.filter((m) => m.to === '1.7.0').map((m) => m.from)).toEqual(['1.6.0']);
    expect(migrateDocument(legacyDoc()).version).toBe(CURRENT_DOCUMENT_VERSION);
  });
});
