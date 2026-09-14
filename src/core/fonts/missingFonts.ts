/**
 * Missing fonts — which font families a document uses that this machine cannot
 * draw, and which layers use each.
 *
 * AE's "The project uses fonts that are not available" check, split in two:
 *
 *   • the SCAN (`collectFontUsage` / `findMissingFonts`) is pure — nodes in,
 *     usages out, with availability injected — so it is testable without a
 *     DOM and cannot get the answer wrong by racing font loading;
 *   • AVAILABILITY (`fontAvailability.ts`) is the browser half.
 *
 * Both a layer's own `fontFamily` and every rich-text run's `fontFamily` count:
 * a run in a missing face is exactly as broken as a whole layer in one, and is
 * the case people miss because the rest of the layer looks right.
 *
 * A text layer with NO `fontFamily` prop uses the app default and is not
 * scanned — there is nothing in the document to replace.
 */

import type { SceneNode } from '@core/types';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readRuns } from '@core/text/richText';

/** CSS generic families — always drawable. */
export const GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'emoji', 'math', 'fangsong',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'unset',
]);

/** One missing (or used) family and the layers that reference it. */
export interface FontUsage {
  /** As written in the document (first spelling seen). */
  family: string;
  layers: Array<{ id: string; name: string; inRuns: boolean }>;
}

/** The first family of a CSS font stack, unquoted: `"Brand Sans", Arial` → `Brand Sans`. */
export function primaryFamily(fontFamily: string): string {
  const first = fontFamily.split(',')[0] ?? '';
  return first.trim().replace(/^["']|["']$/g, '').trim();
}

/** Case-insensitive identity for a family. */
export function familyKey(family: string): string {
  return primaryFamily(family).toLowerCase();
}

function textComponentProps(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'Text')?.props as Record<string, unknown> | undefined;
}

/** Every family text layers use, with the layers using it. Sorted by family. */
export function collectFontUsage(nodes: Iterable<SceneNode>): FontUsage[] {
  const byKey = new Map<string, FontUsage>();
  const note = (raw: unknown, node: SceneNode, inRuns: boolean): void => {
    if (typeof raw !== 'string') return;
    const family = primaryFamily(raw);
    if (!family) return;
    const key = family.toLowerCase();
    let usage = byKey.get(key);
    if (!usage) {
      usage = { family, layers: [] };
      byKey.set(key, usage);
    }
    const existing = usage.layers.find((l) => l.id === node.id);
    if (existing) existing.inRuns = existing.inRuns || inRuns;
    else usage.layers.push({ id: node.id, name: node.name || node.id, inRuns });
  };
  for (const node of nodes) {
    if (readNodeKind(node) !== 'text') continue;
    note(textComponentProps(node)?.fontFamily, node, false);
    for (const run of readRuns(node)) note(run.style.fontFamily, node, true);
  }
  return [...byKey.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * The used families `isAvailable` says cannot be drawn. Generic families are
 * never reported, whatever the checker says.
 */
export function findMissingFonts(
  nodes: Iterable<SceneNode>,
  isAvailable: (family: string) => boolean,
): FontUsage[] {
  return collectFontUsage(nodes).filter(
    (u) => !GENERIC_FONT_FAMILIES.has(u.family.toLowerCase()) && !isAvailable(u.family),
  );
}

/** "3 fonts missing" / "1 font missing". */
export function missingFontsMessage(count: number): string {
  return `${count} font${count === 1 ? '' : 's'} missing`;
}
