/**
 * Tools a plugin contributes to the toolbar.
 *
 * A tool is the one UI contribution that takes over the viewport: while it is
 * active, every pointer and key event in the composition window belongs to it
 * rather than to Select. That is exactly what an author wants for a placement
 * gizmo, a custom paint mode or a rig picker — and exactly why it is DECLARED
 * rather than granted at runtime. The user has to be able to see, before the
 * plugin's worker has ever booted, that installing it puts a tool in their
 * toolbar; and the host has to be able to take the tool away the moment the
 * plugin is disabled, without asking it.
 *
 * ── The tool is a declaration, not a class ───────────────────────────────────
 *
 * A plugin does not implement `Tool` (see `packages/workspace/src/tools/Tool.ts`)
 * — it could not: that interface is synchronous, holds live scene handles and
 * returns overlay geometry, none of which crosses a `postMessage` boundary. The
 * host implements one adapter tool per declaration. While it is active it draws
 * the plugin's RETAINED DRAW LIST (`uiCanvas.ts`) and posts the pointer and key
 * events to the worker in LAYER space. So a plugin tool and plugin on-canvas UI
 * are the same mechanism seen from two ends, which is the reason they were
 * built together: a tool with no way to draw is a cursor that does nothing
 * visible, and a drawing with no events is a picture.
 *
 * ── Cursors are a fixed vocabulary ───────────────────────────────────────────
 *
 * From `CursorType`, never a URL. A plugin that could set an arbitrary cursor
 * image can draw a fake pointer a few pixels from the real one, which is the
 * oldest clickjacking trick there is and costs nothing to refuse here.
 */

import type { IconName } from '@components/Icon';

/**
 * The cursors a contributed tool may ask for.
 *
 * A subset of the engine's `CursorType`, chosen to be the ones that MEAN
 * something on an empty canvas. The resize and pen-state cursors are omitted
 * deliberately: they describe a gesture the host is in the middle of, and a
 * tool that sets `resize-nw` at rest is lying about what is under the pointer.
 */
export const PLUGIN_TOOL_CURSORS = [
  'default', 'crosshair', 'move', 'grab', 'text', 'rotate', 'pen',
] as const;

export type PluginToolCursor = (typeof PLUGIN_TOOL_CURSORS)[number];

export interface PluginToolContribution {
  /** Plugin-local; the host namespaces it as `plugin:<pluginId>:<id>`. */
  id: string;
  label: string;
  /** Required — the toolbar is icon-first, and a tool with no glyph is a gap. */
  icon: string;
  cursor: PluginToolCursor;
  /** The tooltip's second line. The first is always `label`. */
  tooltip?: string;
}

export const MAX_TOOLS_PER_PLUGIN = 4;

const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The engine/tool-registry id for one contributed tool. */
export function pluginToolId(pluginId: string, toolId: string): string {
  return `plugin:${pluginId}:${toolId}`;
}

/** The inverse. Null for anything that is not a plugin tool's id. */
export function parsePluginToolId(id: string): { pluginId: string; toolId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'plugin') return null;
  const [, pluginId, toolId] = parts;
  if (!pluginId || !toolId) return null;
  return { pluginId, toolId };
}

/** Validate `contributes.tools`, pushing messages rather than throwing. */
export function parsePluginTools(
  raw: unknown,
  at: string,
  icons: ReadonlySet<string>,
  errors: string[],
): PluginToolContribution[] {
  const out: PluginToolContribution[] = [];
  if (!Array.isArray(raw)) {
    errors.push(`"${at}" must be an array.`);
    return out;
  }
  if (raw.length > MAX_TOOLS_PER_PLUGIN) {
    // The toolbar is the scarcest surface in the editor — see `pluginPanelDefs`
    // for the same argument about the rail. Four is already a flyout.
    errors.push(`"${at}" declares ${raw.length} tools; the limit is ${MAX_TOOLS_PER_PLUGIN}.`);
    return out;
  }

  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`"${where}" must be an object.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : '';
    if (!LOCAL_ID_RE.test(id)) {
      errors.push(`"${where}.id" must be lowercase letters, digits and dashes (1–64 characters).`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`"${where}.id" duplicates an earlier tool id "${id}".`);
      return;
    }
    seen.add(id);

    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!label || label.length > 40) {
      errors.push(`"${where}.label" is required (1–40 characters) — it is the toolbar entry.`);
      return;
    }
    if (typeof e.icon !== 'string' || !icons.has(e.icon)) {
      // Required rather than defaulted, unlike a command's: a command is a row
      // with a name beside it, and a tool is a glyph on a strip of glyphs.
      errors.push(`"${where}.icon" is required and must be an icon this editor has.`);
      return;
    }
    const cursor = e.cursor === undefined ? 'crosshair' : e.cursor;
    if (typeof cursor !== 'string' || !(PLUGIN_TOOL_CURSORS as readonly string[]).includes(cursor)) {
      errors.push(`"${where}.cursor" must be one of ${PLUGIN_TOOL_CURSORS.join(', ')}.`);
      return;
    }
    if (e.tooltip !== undefined && (typeof e.tooltip !== 'string' || e.tooltip.length > 120)) {
      errors.push(`"${where}.tooltip", when present, is at most 120 characters.`);
      return;
    }

    out.push({
      id,
      label,
      icon: e.icon,
      cursor: cursor as PluginToolCursor,
      ...(typeof e.tooltip === 'string' && e.tooltip ? { tooltip: e.tooltip } : {}),
    });
  });

  return out;
}

// ── The live registry ────────────────────────────────────────────────

/** One contributed tool, as everything downstream sees it. */
export interface PluginToolEntry {
  pluginId: string;
  /** For the tooltip — "Acme Lab: Place pin". */
  pluginName: string;
  tool: PluginToolContribution;
  /** `plugin:<pluginId>:<toolId>` — the id the engine and the toolbar use. */
  id: string;
  icon: IconName;
}

const tools = new Map<string, PluginToolEntry[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) fn();
}

/**
 * Subscribe to the set of contributed tools.
 *
 * The toolbar and the engine bridge both need to know when a plugin is enabled
 * or removed, and neither can poll: a tool that stays on the strip after its
 * plugin is gone is a button that activates nothing.
 */
export function onPluginToolsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Put one plugin's declared tools in the registry, replacing any it had. */
export function registerPluginTools(
  pluginId: string,
  pluginName: string,
  contributions: readonly PluginToolContribution[],
): void {
  if (contributions.length === 0) {
    unregisterPluginTools(pluginId);
    return;
  }
  tools.set(
    pluginId,
    contributions.map((tool) => ({
      pluginId,
      pluginName,
      tool,
      id: pluginToolId(pluginId, tool.id),
      icon: tool.icon as IconName,
    })),
  );
  emit();
}

export function unregisterPluginTools(pluginId: string): void {
  if (!tools.delete(pluginId)) return;
  // A tool whose plugin has gone must not stay ACTIVE: it would keep claiming
  // every click in the viewport and answer none of them, which is strictly
  // worse than the plugin simply being absent.
  if (active?.pluginId === pluginId) active = null;
  emit();
}

/** Every contributed tool, in plugin-name order so the strip does not shuffle. */
export function pluginToolEntries(): PluginToolEntry[] {
  return [...tools.values()]
    .flat()
    .sort((a, b) => a.pluginName.localeCompare(b.pluginName) || a.tool.label.localeCompare(b.tool.label));
}

/** One entry by its namespaced id. */
export function pluginToolEntry(id: string): PluginToolEntry | undefined {
  const parsed = parsePluginToolId(id);
  if (!parsed) return undefined;
  return tools.get(parsed.pluginId)?.find((e) => e.tool.id === parsed.toolId);
}

// ── Which one is active ──────────────────────────────────────────────

/**
 * The contributed tool holding the viewport, or null.
 *
 * Kept HERE rather than in the UI store, and that is the seam that makes a
 * plugin tool possible at all: `uiStore.activeTool` is a closed union of the
 * editor's own tool ids, and a value that appears when a plugin is installed
 * cannot be a member of it. So the app's tool state stays exactly what it was,
 * and a plugin tool is a second, nullable piece of state beside it — set when
 * the user picks one, cleared the moment they pick anything built in.
 */
let active: PluginToolEntry | null = null;

/** Make one contributed tool active, or clear the active one with null. */
export function setActivePluginTool(id: string | null): PluginToolEntry | null {
  const next = id === null ? null : pluginToolEntry(id) ?? null;
  if (next?.id === active?.id) return active;
  active = next;
  emit();
  return active;
}

export function activePluginTool(): PluginToolEntry | null {
  return active;
}

/** Tests only — the registry is process-wide. */
export function resetPluginToolsForTests(): void {
  tools.clear();
  listeners.clear();
  active = null;
}
