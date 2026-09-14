/**
 * Replace font families across the document — the write behind "Replace
 * Fonts…" (missing-font warning) and Find and Replace Fonts.
 *
 * ONE undo entry for the whole substitution, however many layers and runs it
 * touches: to the user it is one act, and an undo that restored one layer at a
 * time would leave the document half in each font.
 *
 * Writes go through `defaultSceneGraph.writeProp` (the layer's Text
 * component) and `writeRuns` (rich-text runs, which also stamps the run index
 * space) — never through the components view, which is a throwaway.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readRuns, writeRuns } from '@core/text/richText';
import { runDocumentEdit } from '@core/commands/documentEdit';
import type { RichRun } from '@core/text/textLayout';
import type { SceneNode } from '@core/types';
import { familyKey } from './missingFonts';

/** `replacements` maps a lower-cased family key → the new family name. */
export function remapRunFonts(
  runs: ReadonlyArray<RichRun>,
  replacements: ReadonlyMap<string, string>,
): { runs: RichRun[]; changed: boolean } {
  let changed = false;
  const out = runs.map((r) => {
    const f = r.style.fontFamily;
    const next = typeof f === 'string' ? replacements.get(familyKey(f)) : undefined;
    if (next === undefined || next === f) return r;
    changed = true;
    return { ...r, style: { ...r.style, fontFamily: next } };
  });
  return { runs: out, changed };
}

/**
 * Substitute families on every text layer (and its runs). Keys of
 * `replacements` may be written in any case. Returns how many layers changed.
 */
export function replaceFontFamilies(replacements: ReadonlyMap<string, string>): { layers: number } {
  const map = new Map<string, string>();
  for (const [from, to] of replacements) {
    if (to.trim()) map.set(familyKey(from), to.trim());
  }
  if (map.size === 0) return { layers: 0 };
  return runDocumentEdit('Replace Fonts', () => {
    const texts: SceneNode[] = [];
    defaultSceneGraph.traverse((n) => { if (readNodeKind(n) === 'text') texts.push(n); });
    let layers = 0;
    for (const node of texts) {
      let touched = false;
      const comp = node.components.find((c) => c.type === 'Text');
      const family = (comp?.props as Record<string, unknown> | undefined)?.fontFamily;
      if (comp && typeof family === 'string') {
        const next = map.get(familyKey(family));
        if (next !== undefined && next !== family) {
          defaultSceneGraph.writeProp(node.id, comp.id, 'fontFamily', next);
          touched = true;
        }
      }
      const runs = remapRunFonts(readRuns(node), map);
      if (runs.changed) {
        writeRuns(node.id, runs.runs);
        touched = true;
      }
      if (touched) layers += 1;
    }
    return { layers };
  });
}
