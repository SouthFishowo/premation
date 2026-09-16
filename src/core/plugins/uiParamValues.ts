/**
 * Reading and writing a contributed parameter's value on a layer.
 *
 * `uiParams.ts` is the grammar; this is the storage. They are split because the
 * grammar is read by the registry's publish-time validator, which has no scene
 * graph, no stores and no DOM — and dragging those in would mean a manifest
 * could only be validated inside a running editor.
 *
 * ── The component is created on first write, not on selection ────────────────
 *
 * A layer gains a plugin's component the moment somebody actually sets one of
 * its parameters. Seeding every layer the panel APPLIES to would write the
 * plugin's defaults into a document just because the user clicked a layer while
 * the plugin happened to be installed — and then the values would persist after
 * an uninstall, in a document that never used the plugin for anything.
 *
 * So a parameter that has never been touched reads as its declared default and
 * stores nothing, which is also what makes `appliesTo` cheap: showing the
 * section is free.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { usePluginStore } from '@stores/pluginStore';
import type { Component } from '../types';
import {
  defaultParamProps,
  isPluginParamPath,
  paramAxes,
  paramHoldsValue,
  pluginParamComponentId,
  pluginParamComponentType,
  pluginParamKey,
  pluginParamPath,
  type PluginInspectorPanelContribution,
  type PluginParamSchema,
} from './uiParams';

/** What a contributed parameter's track key points at. */
export interface PluginParamRef {
  pluginId: string;
  pluginName: string;
  panel: PluginInspectorPanelContribution;
  schema: PluginParamSchema;
  /** `x` / `y` / `z` for one axis of a point, absent for a scalar. */
  axis?: string;
}

/*
  A path → declaration index, rebuilt when the installed set changes.

  `resolvePropertyMeta` is called for every row of every property surface, so a
  linear scan of every installed plugin's every parameter would run thousands of
  times a second. Keyed on the plugins ARRAY IDENTITY, which the store replaces
  on every change — a revision counter would be a second thing to remember to
  bump.
*/
let indexSource: unknown = null;
let pathIndex: Map<string, PluginParamRef> | null = null;

/** The declaration a `pluginUi.…` track key belongs to, or null. */
export function findPluginParamByPath(path: string): PluginParamRef | null {
  if (!isPluginParamPath(path)) return null;
  const plugins = usePluginStore.getState().plugins;
  if (pathIndex === null || indexSource !== plugins) {
    const next = new Map<string, PluginParamRef>();
    for (const entry of plugins) {
      if (!entry.enabled) continue;
      const { id, name } = entry.manifest;
      for (const panel of entry.manifest.contributes.inspector) {
        for (const schema of panel.params) {
          if (!paramHoldsValue(schema)) continue;
          const axes = paramAxes(schema);
          if (axes.length === 0) {
            next.set(pluginParamPath(id, panel.id, schema.name), {
              pluginId: id, pluginName: name, panel, schema,
            });
            continue;
          }
          for (const axis of axes) {
            next.set(pluginParamPath(id, panel.id, schema.name, axis), {
              pluginId: id, pluginName: name, panel, schema, axis,
            });
          }
        }
      }
    }
    pathIndex = next;
    indexSource = plugins;
  }
  return pathIndex.get(path) ?? null;
}

/** The component carrying one panel's values on a node, or null. */
export function pluginParamComponent(
  nodeId: string,
  pluginId: string,
  panelId: string,
): Component | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const type = pluginParamComponentType(pluginId, panelId);
  return (node.components ?? []).find((c) => c.type === type) ?? null;
}

/**
 * The component id to write through, creating the component if it is absent.
 *
 * Seeded with every declared default rather than with the one key being
 * written: a half-populated component would make `params.get` answer
 * `undefined` for a parameter the schema says has a value, and every reader
 * would have to carry the same fallback.
 */
export function ensurePluginParamComponent(
  nodeId: string,
  pluginId: string,
  panel: PluginInspectorPanelContribution,
): string | null {
  const existing = pluginParamComponent(nodeId, pluginId, panel.id);
  if (existing) return existing.id;
  if (!defaultSceneGraph.getNode(nodeId)) return null;

  const id = pluginParamComponentId(pluginId, panel.id);
  const ok = defaultSceneGraph.addComponent(nodeId, {
    id,
    type: pluginParamComponentType(pluginId, panel.id),
    props: defaultParamProps(panel),
  });
  return ok ? id : null;
}

/** One parameter's value — stored if it has been set, declared default if not. */
export function readPluginParam(
  nodeId: string,
  pluginId: string,
  panelId: string,
  schema: PluginParamSchema,
  axis?: string,
): unknown {
  if (!paramHoldsValue(schema)) return undefined;
  const comp = pluginParamComponent(nodeId, pluginId, panelId);
  const key = pluginParamKey(schema.name, axis);
  const stored = comp ? (comp.props as Record<string, unknown> | undefined)?.[key] : undefined;
  if (stored !== undefined) return stored;
  if (axis) {
    const d = schema.default as Record<string, number> | undefined;
    return typeof d?.[axis] === 'number' ? d[axis] : 0;
  }
  return schema.default;
}

/** Every value of one panel on one layer, keyed as the plugin declared them. */
export function readPluginPanelValues(
  nodeId: string,
  pluginId: string,
  panel: PluginInspectorPanelContribution,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of panel.params) {
    if (!paramHoldsValue(p)) continue;
    const axes = paramAxes(p);
    if (axes.length === 0) {
      out[p.name] = readPluginParam(nodeId, pluginId, panel.id, p);
      continue;
    }
    const point: Record<string, unknown> = {};
    for (const axis of axes) point[axis] = readPluginParam(nodeId, pluginId, panel.id, p, axis);
    out[p.name] = point;
  }
  return out;
}

/**
 * Write one parameter. Returns false when the layer or the component is gone.
 *
 * `undoLabel` is optional so a DRAG can pass none: the row components already
 * bracket a gesture with their own history entry, and a second one per pointer
 * move is the fifty-undos-per-drag behaviour every native row here avoids.
 */
export function writePluginParam(
  nodeId: string,
  pluginId: string,
  panel: PluginInspectorPanelContribution,
  schema: PluginParamSchema,
  value: unknown,
  axis?: string,
  undoLabel?: string,
): boolean {
  if (!paramHoldsValue(schema)) return false;
  const componentId = ensurePluginParamComponent(nodeId, pluginId, panel);
  if (!componentId) return false;
  const key = pluginParamKey(schema.name, axis);

  const apply = (): boolean =>
    updateNodeComponentProp(defaultSceneGraph, nodeId, componentId, key, value);

  return undoLabel ? runDocumentEdit(undoLabel, apply) : apply();
}
