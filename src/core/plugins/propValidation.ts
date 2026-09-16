/**
 * Refusing names that do not exist, loudly, with the name that does.
 *
 * ── The failure this closes ──────────────────────────────────────────────────
 *
 * Three verbs accepted any string and reported success:
 *
 *   • `scene.setProperty(id, 'blurr', 4)` found no component holding `blurr`
 *     and wrote it onto the Transform — a key that renders nothing, animates
 *     nothing, and is saved into the user's document forever.
 *   • `animation.setKeyframes(id, 'opactiy', …)` created a track nothing reads.
 *   • `effects.setParam(id, fx, 'blur', 0.5)` on a Drop Shadow stored a param
 *     the shader never samples, beside the real one (`softness`, 0–100).
 *
 * Each returned `true`. The plugin author saw nothing, the user saw a layer that
 * did not change, and the only evidence was a document carrying junk keys. The
 * real plugins that hit this guessed names from other applications — `blur` for
 * `softness`, 0–1 for a 0–100 range — which is exactly the guess a refusal
 * naming the right key turns into a one-line fix.
 *
 * ── What counts as known ─────────────────────────────────────────────────────
 *
 * Deliberately generous, because a false refusal breaks a working plugin and a
 * false acceptance is only the status quo. A name is known when ANY of these
 * says so: the layer already holds it, the layer already has a track for it,
 * the property-metadata registry describes it (`hasPropertyMeta` — the same
 * registry the timeline labels rows from), or it is one of the structured
 * props. Effect params are checked against the effect's own definition, which
 * is exact, so they are held to it exactly.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { hasPropertyMeta, staticPropertyPaths } from '@core/inspector/propertyMeta';
import {
  EFFECT_DEFS,
  EFFECT_OPACITY_KEY,
  effectDefFor,
  getNodeEffects,
  type EffectDef,
  type EffectParamDef,
} from '@core/effects/effects';
import { pluginEffectDefs } from '@core/effects/pluginEffectDefs';
import { styleKeyFromEffectId } from '@core/effects/layerStyles';
import { CUSTOM_PROP_PREFIX, customLayerComponent } from './customLayers';
import { STRUCTURED_PROP_NAMES } from './structuredProps';

type SceneNodeView = NonNullable<ReturnType<typeof defaultSceneGraph.getNode>>;

// ── Suggestions ──────────────────────────────────────────────────────────────

/** Levenshtein distance. Inputs here are property names, so O(n·m) is nothing. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The candidate closest to `input`, or null when nothing is close enough to be
 * a plausible typo.
 *
 * Case-insensitive, because `RotationX` for `rotationX` is the commonest miss.
 * The threshold grows with the name — two edits for short names, a third of
 * the length for long ones — so `opactiy` finds `opacity` without `x` being
 * "corrected" to `y`.
 */
export function closestName(input: string, candidates: Iterable<string>): string | null {
  const needle = input.toLowerCase();
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const c of new Set(candidates)) {
    if (c === input) continue;
    const d = editDistance(needle, c.toLowerCase());
    if (d < bestDistance) { best = c; bestDistance = d; }
  }
  const limit = Math.max(2, Math.floor(input.length / 3));
  return best !== null && bestDistance <= limit && bestDistance < input.length ? best : null;
}

const didYouMean = (s: string | null): string => (s ? ` Did you mean "${s}"?` : '');

// ── What a layer already has ─────────────────────────────────────────────────

/** Every prop name stored on the layer, minus the host's reserved `__` keys. */
function componentPropNames(node: SceneNodeView): Set<string> {
  const out = new Set<string>();
  for (const c of node.components) {
    for (const k of Object.keys((c.props ?? {}) as Record<string, unknown>)) {
      if (!k.startsWith('__')) out.add(k);
    }
  }
  return out;
}

function hasTrack(node: SceneNodeView, path: string): boolean {
  return defaultAnimation.tracksFor(node.id).some((t) => t.prop === path);
}

const COLOR_STRING = /^(?:#[0-9a-fA-F]{3,8}|rgba?\()/;

/**
 * Is `base` a colour whose `_r/_g/_b/_a` channel tracks the renderer reads?
 *
 * The list is the set of prefixes `ColorKfRow` writes — fill, stroke (and the
 * later strokes of a stack), an explicit `color`, a paint op's colour, a
 * particle colour — plus an effect's `color`-typed params and any prop the
 * layer holds as a colour string, which is how a plugin layer's colour reads.
 */
export function isColorBase(node: SceneNodeView, base: string): boolean {
  if (base === 'fill' || base === 'stroke' || base === 'color') return true;
  if (/^stroke\.\d+\.color$/.test(base) || /^paint\.[^.]+\.color$/.test(base)) return true;
  if (/^particle\.[A-Za-z0-9]*[cC]olor[A-Za-z0-9]*$/.test(base)) return true;
  const fx = /^effect\.([^.]+)\.(.+)$/.exec(base);
  if (fx) {
    const param = effectParamFor(node, fx[1]!, fx[2]!);
    return param?.type === 'color';
  }
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown> | undefined)?.[base];
    if (typeof v === 'string' && COLOR_STRING.test(v)) return true;
  }
  return false;
}

/** The def of the effect `effectId` on this layer, including synthesised layer styles. */
function effectDefOnNode(node: SceneNodeView, effectId: string): EffectDef | undefined | null {
  const fx = getNodeEffects(node.id).find((e) => e.id === effectId);
  if (fx) return effectDefFor(fx.type);
  return null;
}

function effectParamFor(node: SceneNodeView, effectId: string, key: string): EffectParamDef | undefined {
  const def = effectDefOnNode(node, effectId);
  return def ? def.params.find((p) => p.key === key) : undefined;
}

// ── Tracks ───────────────────────────────────────────────────────────────────

function effectTrackProblem(node: SceneNodeView, path: string): string | null {
  const m = /^effect\.([^.]+)(?:\.(.+))?$/.exec(path);
  if (!m) return `"${path}" is not an effect track. Effect tracks are "effect.<effectId>.<param>".`;
  const [, effectId, rawKey] = m;
  // A layer style's effect is synthesised per frame and never stored on the
  // node, so it cannot be looked up here — the metadata registry resolves it.
  if (styleKeyFromEffectId(effectId!)) return hasPropertyMeta(path, node.id) ? null : `"${path}" is not a layer-style property.`;

  const def = effectDefOnNode(node, effectId!);
  if (def === null) {
    const ids = getNodeEffects(node.id).map((e) => e.id);
    return `"${node.name}" has no effect "${effectId}".`
      + (ids.length ? ` Its effects: ${ids.join(', ')}.` : ' It has no effects — add one with effects.add first.');
  }
  // The legacy primary-param track, or an effect whose definition is not
  // loaded (a plugin effect with its plugin stopped) — nothing to check against.
  if (rawKey === undefined || def === undefined) return null;
  if (rawKey === EFFECT_OPACITY_KEY) return null;

  const channel = /^(.+)_[rgba]$/.exec(rawKey);
  if (channel && def.params.some((p) => p.key === channel[1] && p.type === 'color')) return null;
  if (def.params.some((p) => p.key === rawKey)) return null;
  return unknownParamMessage(def, rawKey);
}

/**
 * Why `path` is not a track this layer can animate, or null when it is.
 *
 * Order matters only for speed and for the message: an existing track or a
 * stored prop short-circuits everything, and the prefixed families each get a
 * refusal that names what they expected.
 */
export function trackProblem(node: SceneNodeView, path: string): string | null {
  if (hasTrack(node, path)) return null;

  if (path.startsWith(CUSTOM_PROP_PREFIX)) {
    const name = path.slice(CUSTOM_PROP_PREFIX.length);
    const comp = customLayerComponent(node as never);
    if (!comp) return `"${node.name}" is not a plugin layer, so it has no "${path}" track.`;
    const declared = Object.keys((comp.props ?? {}) as Record<string, unknown>).filter((k) => !k.startsWith('__'));
    if (declared.includes(name)) return null;
    return `"${node.name}" declares no property "${name}".`
      + didYouMean(closestName(name, declared))
      + (declared.length ? ` Declared: ${declared.join(', ')}.` : '');
  }

  if (path.startsWith('effect.')) return effectTrackProblem(node, path);

  const props = componentPropNames(node);
  if (props.has(path)) return null;

  const channel = /^(.+)_[rgba]$/.exec(path);
  if (channel && !path.startsWith('ctrl_')) {
    return isColorBase(node, channel[1]!)
      ? null
      : `"${path}" is a colour channel of "${channel[1]}", which is not a colour property of "${node.name}".`;
  }

  if (hasPropertyMeta(path, node.id)) return null;

  const candidates = [...staticPropertyPaths(), ...props, ...defaultAnimation.tracksFor(node.id).map((t) => t.prop)];
  return `"${path}" is not an animatable property of "${node.name}".${didYouMean(closestName(path, candidates))}`;
}

// ── setProperty ──────────────────────────────────────────────────────────────

/**
 * Why a scalar `setProperty` of `prop` would write junk, or null when it would not.
 *
 * Two families get a refusal of their own rather than a suggestion, because the
 * name is RIGHT and the verb is wrong: an effect path belongs to
 * `effects.setParam`, and a colour channel is a keyframe track, not a stored
 * value — writing either here put a key on the Transform that nothing read.
 */
export function propertyProblem(node: SceneNodeView, prop: string): string | null {
  const props = componentPropNames(node);
  if (props.has(prop)) return null;
  if (STRUCTURED_PROP_NAMES.includes(prop)) return null;

  if (prop.startsWith('effect.')) {
    return `"${prop}" is an effect parameter. Set it with effects.setParam(layerId, effectId, key, value).`;
  }
  const channel = /^(.+)_[rgba]$/.exec(prop);
  if (channel && isColorBase(node, channel[1]!)) {
    return `"${prop}" is a keyframe channel, not a stored value. Set "${channel[1]}" to a colour, `
      + `or keyframe the colour with animation.setKeyframes(layerId, "${channel[1]}", [{ t, value: "#rrggbb" }]).`;
  }
  if (hasPropertyMeta(prop, node.id)) return null;

  const candidates = [...staticPropertyPaths(), ...props, ...STRUCTURED_PROP_NAMES];
  return `"${prop}" is not a property of "${node.name}".${didYouMean(closestName(prop, candidates))}`;
}

// ── Effects ──────────────────────────────────────────────────────────────────

function unknownParamMessage(def: EffectDef, key: string): string {
  const keys = def.params.map((p) => p.key);
  return `"${key}" is not a parameter of ${def.label} ("${def.type}").${didYouMean(closestName(key, keys))} `
    + `Its parameters: ${keys.join(', ')}. effects.describe("${def.type}") lists their types and ranges.`;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Why `effects.setParam(…, key, value)` would store something the effect does
 * not read, or null when it is fine.
 *
 * Ranges are refusals, matching the Effect Controls field, which clamps to the
 * same `min`/`max`. Silently clamping here instead would hand the plugin a
 * value it did not send — the 0–1 versus 0–100 confusion stays invisible — and
 * storing it unclamped would render differently from what the panel shows.
 */
export function effectParamProblem(def: EffectDef, key: string, value: unknown): string | null {
  if (key === EFFECT_OPACITY_KEY) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      ? null
      : `"${EFFECT_OPACITY_KEY}" (Effect Opacity) must be a number between 0 and 100.`;
  }
  const p = def.params.find((d) => d.key === key);
  if (!p) return unknownParamMessage(def, key);
  const at = `${def.label} "${key}"`;

  switch (p.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a finite number.`;
      if ((p.min !== undefined && value < p.min) || (p.max !== undefined && value > p.max)) {
        const lo = p.min ?? '-∞';
        const hi = p.max ?? '∞';
        return `${at} must be between ${lo} and ${hi}${p.unit ? ` (${p.unit})` : ''}; got ${value}.`;
      }
      return null;
    }
    case 'enum': {
      const values = (p.options ?? []).map((o) => o.value);
      if (typeof value === 'number' && values.includes(value)) return null;
      return `${at} must be one of: ${(p.options ?? []).map((o) => `${o.value} (${o.label})`).join(', ')}.`;
    }
    case 'color':
      return typeof value === 'string' && (HEX.test(value) || /^rgba?\(/.test(value))
        ? null
        : `${at} must be a colour string: "#rrggbb", "#rrggbbaa" or "rgba(r, g, b, a)".`;
    case 'checkbox':
      return typeof value === 'boolean' ? null : `${at} must be true or false.`;
    case 'layer':
    case 'maskPath':
      return typeof value === 'string' ? null : `${at} must be a ${p.type === 'layer' ? 'layer id' : 'mask path id'} string ('' for none).`;
    case 'curve':
      return `${at} is a curve, which effects.setParam cannot carry.`;
    case 'resolved':
      return `${at} is filled in by the renderer every frame and cannot be set.`;
    default:
      return null;
  }
}

/** Every effect type a plugin could add right now, for suggestions. */
function knownEffectTypes(): string[] {
  return [...EFFECT_DEFS.map((d) => d.type as string), ...pluginEffectDefs().map((d) => d.type as string)];
}

export interface EffectParamDescription {
  /** The key `effects.setParam` and `effect.<effectId>.<id>` tracks take. */
  id: string;
  label: string;
  /** `boolean` is what the inspector calls a checkbox. */
  type: 'number' | 'color' | 'boolean' | 'enum' | 'curve' | 'layer' | 'maskPath' | 'resolved';
  default: unknown;
  min?: number;
  max?: number;
  unit?: string;
  precision?: number;
  group?: string;
  options?: Array<{ value: number; label: string }>;
  /** False for params setParam refuses: curves and renderer-resolved values. */
  settable: boolean;
  /** True when the param can take keyframes through `animation.setKeyframes`. */
  animatable: boolean;
}

export interface EffectDescription {
  type: string;
  label: string;
  params: EffectParamDescription[];
}

/**
 * An effect's parameters as a plugin needs them: the exact key, the type, and
 * the range the host will enforce.
 *
 * Built from the same `EffectDef` the Effect Controls panel draws, so it cannot
 * disagree with what the user sees. Effect Opacity is appended because it is a
 * real, keyframeable dial every effect has and it is not in `params`.
 *
 * Returns null for a type the host does not have; the caller turns that into a
 * refusal with a suggestion (see `unknownEffectTypeMessage`).
 */
export function describeEffect(type: string): EffectDescription | null {
  const def = effectDefFor(type);
  if (!def) return null;
  const params: EffectParamDescription[] = def.params.map((p) => ({
    id: p.key,
    label: p.label,
    type: p.type === 'checkbox' ? 'boolean' : p.type,
    default: p.default,
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.unit ? { unit: p.unit } : {}),
    ...(p.precision !== undefined ? { precision: p.precision } : {}),
    ...(p.group ? { group: p.group } : {}),
    ...(p.options ? { options: p.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
    settable: p.type !== 'curve' && p.type !== 'resolved',
    animatable: p.type === 'number' || p.type === 'enum' || p.type === 'color',
  }));
  params.push({
    id: EFFECT_OPACITY_KEY,
    label: 'Effect Opacity',
    type: 'number',
    default: 100,
    min: 0,
    max: 100,
    unit: '%',
    settable: true,
    animatable: true,
  });
  return { type: def.type, label: def.label, params };
}

export function unknownEffectTypeMessage(type: string): string {
  return `"${type}" is not an effect this editor has.${didYouMean(closestName(type, knownEffectTypes()))} `
    + 'A plugin\'s own effect is addressed as "<pluginId>.<effectId>", and only once that plugin is running.';
}
