/* eslint-disable no-restricted-syntax -- SAFE, verified.
 * Mutates a `structuredClone(doc)` — migrations must be pure, and the clone is
 * taken precisely so the caller's document is untouched. Never a graph node. */
/**
 * 1.6.0 → 1.7.0 — Trim Paths' "Trim Multiple Shapes" gets AE's meaning.
 *
 * Before: `trimMultiple`, whose two words were SWAPPED against AE and
 *         lottie-web — `individually` (and absent) trimmed every run by the same
 *         percentages, `simultaneously` walked the runs one after another.
 * After:  `trimMultipleShapes`, where `simultaneously` (and absent) is the
 *         same-percentages trim and `individually` is the sequential one.
 *
 * ── WHY A NEW KEY, NOT SWAPPED VALUES ───────────────────────────────────────
 *
 * `captureDocument` stamps every document it writes `version: '1.1.0'` (see
 * F31), so a project saved by THIS build is walked through this step on every
 * load. A step that swapped the two values in place could not tell an old
 * value from a new one and would flip the mode on every reopen. Converting the
 * OLD key and deleting it is idempotent by construction: a document written by
 * this build has no `trimMultiple` left to convert.
 *
 * ── WHAT THIS MIGRATION CLAIMS ──────────────────────────────────────────────
 *
 * Every 1.6.0 document renders IDENTICALLY: each stored value is translated to
 * the word that now names the behaviour it had.
 *
 * ── NO DUAL-SHAPE READS ─────────────────────────────────────────────────────
 *
 * `readPathOps` reads `trimMultipleShapes` only. Same precedent as `fx.pathOp`
 * (1.3.0) and `fx.trim` (1.4.0).
 *
 * ── VERSION BUMP IS EXCLUSIVELY THIS CHANGE ─────────────────────────────────
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { DocumentMigration } from './index';

interface NodeLike {
  components?: Array<{ type?: string; props?: Record<string, unknown> }>;
  children?: NodeLike[];
}

/** Old stored word → the word that names the same behaviour now. */
function translate(legacy: unknown): 'simultaneously' | 'individually' {
  // Old `simultaneously` was the sequential walk (AE's Individually); old
  // `individually`, and anything unrecognised (read as individually before),
  // was the same-percent trim (AE's Simultaneously).
  return legacy === 'simultaneously' ? 'individually' : 'simultaneously';
}

function hasLegacy(nodes: readonly NodeLike[]): boolean {
  for (const node of nodes) {
    for (const c of node.components ?? []) {
      if (c.type !== 'fx' || !Array.isArray(c.props?.pathOps)) continue;
      for (const op of c.props.pathOps as unknown[]) {
        if (op && typeof op === 'object' && 'trimMultiple' in op) return true;
      }
    }
    if (node.children && hasLegacy(node.children)) return true;
  }
  return false;
}

function migrateNodes(nodes: NodeLike[]): void {
  for (const node of nodes) {
    for (const c of node.components ?? []) {
      if (c.type !== 'fx' || !Array.isArray(c.props?.pathOps)) continue;
      for (const op of c.props.pathOps as unknown[]) {
        if (!op || typeof op !== 'object' || !('trimMultiple' in op)) continue;
        const o = op as Record<string, unknown>;
        // Only a TRIM carries the field meaningfully; any other operator just
        // loses a key nothing ever read.
        if (o.type === 'trim') o.trimMultipleShapes = translate(o.trimMultiple);
        delete o.trimMultiple;
      }
    }
    if (node.children) migrateNodes(node.children);
  }
}

export const v1_6_0_to_v1_7_0: DocumentMigration = {
  from: '1.6.0',
  to: '1.7.0',
  description:
    'Trim Paths: `trimMultiple` (words swapped vs AE) → `trimMultipleShapes` with ' +
    'AE meaning. Renders identically.',
  migrate(doc: EditorDocument): EditorDocument {
    const nodes = (doc.scene as { nodes?: NodeLike[] } | undefined)?.nodes;
    // Only clone when there is something to change — `migrateDocument` callers
    // rely on an untouched document coming back as the same object.
    if (!Array.isArray(nodes) || !hasLegacy(nodes)) return doc;
    const cloned = structuredClone(doc);
    migrateNodes((cloned.scene as { nodes: NodeLike[] }).nodes);
    return cloned;
  },
};
