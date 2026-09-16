/**
 * The inspector vocabulary — parameter panels a plugin contributes to the
 * Properties panel of layers it does not own.
 *
 * ── Why this is separate from `layerKindSchema` ──────────────────────────────
 *
 * A layer KIND's props describe a layer the plugin invented: they exist because
 * the layer exists, and they disappear with it. These describe a plugin's
 * controls on SOMEBODY ELSE'S layer — a colour tool on a shape, a rig helper on
 * a text layer — which is the other half of what After Effects gives a plugin
 * author and the half this host had no word for. The two vocabularies overlap
 * (both are "declare a type, the host draws it") and they are deliberately not
 * merged: a kind's schema is versioned with the kind and stored in every
 * document that uses it, while a panel is presentation and may be re-declared
 * freely between plugin versions.
 *
 * ── Still no plugin markup, and still no escape hatch ────────────────────────
 *
 * The rule `CustomLayerSection.tsx` opens with holds here word for word: a
 * plugin that could render into the inspector could draw a convincing
 * permission prompt, and every plugin's panel would age differently from the app
 * around it. So the answer to a missing control is another entry in this table,
 * never a callback that returns markup. What this version adds over the layer
 * vocabulary is the set After Effects has had since `PF_ADD_*`: a slider that
 * knows its unit and can be logarithmic, an enum whose values carry LABELS, a
 * colour with alpha, a 2-D and a 3-D point, a button that runs one of the
 * plugin's own commands, and a read-only status line the plugin can write to.
 *
 * ── Where the values live ────────────────────────────────────────────────────
 *
 * On the layer, in a component of this panel's own type, exactly the way a
 * custom layer's props live on its component. Numeric params are ordinary
 * animatable properties addressed by `pluginParamPath(...)`, so keyframes,
 * easing, expressions and the graph editor come from the engine rather than
 * from anything here. Nothing in the render path reads them: they are the
 * plugin's inputs, sampled by the plugin through `animation.sample`, which is
 * the same contract a layer kind's props already have.
 */

import type { PluginCommandContribution } from './manifest';

/** What a declared parameter may be. */
export type PluginParamType =
  | 'slider'
  | 'number'
  | 'angle'
  | 'checkbox'
  | 'enum'
  | 'color'
  | 'point'
  | 'point3d'
  | 'button'
  | 'status';

export const PLUGIN_PARAM_TYPES: readonly PluginParamType[] = [
  'slider', 'number', 'angle', 'checkbox', 'enum', 'color', 'point', 'point3d', 'button', 'status',
];

/** Types that carry a number the animation engine can interpolate. */
const NUMERIC_TYPES: readonly PluginParamType[] = ['slider', 'number', 'angle'];

/** Types stored as several numeric axes on one row. */
const POINT_AXES: Readonly<Partial<Record<PluginParamType, readonly string[]>>> = {
  point: ['x', 'y'],
  point3d: ['x', 'y', 'z'],
};

/** Types that may declare `animatable`. */
const ANIMATABLE_TYPES: readonly PluginParamType[] = ['slider', 'number', 'angle', 'point', 'point3d'];

/** Types that hold no value at all — they act, or they report. */
const VALUELESS_TYPES: readonly PluginParamType[] = ['button', 'status'];

/** One option of an `enum`, with the label the user reads. */
export interface PluginParamOption {
  value: string;
  /** Required. The whole point of the type over a bare string list. */
  label: string;
}

export interface PluginParamSchema {
  /** camelCase, unique within its panel. Becomes the storage key. */
  name: string;
  type: PluginParamType;
  /** Falls back to a humanised `name`. */
  label?: string;
  /** Required for every type that holds a value; forbidden for the rest. */
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** Suffix drawn inside the field — `%`, `px`, `°`. `slider`/`number` only. */
  unit?: string;
  /**
   * Drag and slide the parameter on a log axis. `slider` only, and only with a
   * `min` above zero: a logarithmic axis through zero has no meaning, and
   * accepting one would produce a field whose drag silently does nothing near
   * the bottom of its range.
   */
  logarithmic?: boolean;
  /** Required for `enum`, forbidden otherwise. */
  options?: PluginParamOption[];
  /** `color` only: the swatch edits alpha too and the value carries `#rrggbbaa`. */
  alpha?: boolean;
  /** Numeric and point types only. */
  animatable?: boolean;
  /** Flat section heading. Not nested — see `layerKindSchema`. */
  group?: string;
  /** Show only while a SIBLING parameter has a value. */
  showIf?: { param: string; equals: string | number | boolean };
  /** `button` only: the plugin command it invokes, by its local id. */
  command?: string;
  /** `status` only: the line shown until the plugin sets one at runtime. */
  text?: string;
}

/**
 * Which layers a panel belongs on.
 *
 * A list of layer kinds (`shape`, `text`, `image`, a namespaced plugin kind),
 * or absent for every layer. Declared rather than a predicate because the
 * inspector has to decide whether to draw the section BEFORE the plugin's
 * worker is running — the same reason `contributes` exists at all.
 */
export interface PluginInspectorPanelContribution {
  id: string;
  title: string;
  icon?: string;
  /** Empty = every layer. */
  appliesTo: string[];
  params: PluginParamSchema[];
}

/*
  Caps.

  Every parameter is an inspector row on a layer the plugin did not create, so
  the cost of a careless declaration lands on somebody else's document. Eight
  panels of thirty-two is already a Properties panel nobody can scroll.
*/
export const MAX_INSPECTOR_PANELS = 8;
export const MAX_PARAMS_PER_PANEL = 32;
export const MAX_ENUM_OPTIONS = 64;

const PANEL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PARAM_NAME_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;
/** `shape`, `text`, or a plugin kind's namespaced `vendor.pkg.kind`. */
const LAYER_KIND_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z0-9][a-zA-Z0-9-]*)*$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// ── Paths and storage ────────────────────────────────────────────────

/**
 * The prefix every contributed parameter's track key carries.
 *
 * Deliberately NOT `plugin.`, which `customLayers.ts` owns: a plugin layer can
 * also carry a contributed panel, and one prefix for both would make
 * `plugin.amount` mean the kind's prop on one layer and a panel's parameter on
 * the next. Nothing native starts with either.
 */
export const PLUGIN_PARAM_PREFIX = 'pluginUi.';

/**
 * A plugin id with its dots flattened, so a track key parses on dots.
 *
 * One-way on purpose. Every consumer computes the path FORWARD from a declared
 * panel it already holds; nothing needs to read a plugin id back out of a
 * track key, and pretending the mapping were reversible (plugin ids may contain
 * dashes as well as dots) would be a bug waiting for its first hyphenated
 * vendor name.
 */
export function pluginParamSlug(pluginId: string): string {
  return pluginId.replace(/\./g, '-');
}

/** The animation track key for one parameter — or one axis of a point. */
export function pluginParamPath(
  pluginId: string,
  panelId: string,
  name: string,
  axis?: string,
): string {
  return `${PLUGIN_PARAM_PREFIX}${pluginParamSlug(pluginId)}.${panelId}.${pluginParamKey(name, axis)}`;
}

/** The key one parameter (or one axis of a point) has on the component. */
export function pluginParamKey(name: string, axis?: string): string {
  return axis ? `${name}.${axis}` : name;
}

/** Is this property path one of ours? Used to keep native names off it. */
export function isPluginParamPath(path: string): boolean {
  return path.startsWith(PLUGIN_PARAM_PREFIX);
}

/** The component type that carries one panel's values on a layer. */
export function pluginParamComponentType(pluginId: string, panelId: string): string {
  return `PluginParams.${pluginParamSlug(pluginId)}.${panelId}`;
}

/** The component id. Stable, so a second write finds the first one's component. */
export function pluginParamComponentId(pluginId: string, panelId: string): string {
  return `pluginui_${pluginParamSlug(pluginId)}_${panelId}`;
}

/** The axes a point-shaped parameter is stored as; empty for a scalar. */
export function paramAxes(schema: PluginParamSchema): readonly string[] {
  return POINT_AXES[schema.type] ?? [];
}

/** Does this parameter hold a value at all? */
export function paramHoldsValue(schema: PluginParamSchema): boolean {
  return !VALUELESS_TYPES.includes(schema.type);
}

/** Is this parameter one the animation engine can key? */
export function paramIsAnimatable(schema: PluginParamSchema): boolean {
  return schema.animatable === true && ANIMATABLE_TYPES.includes(schema.type);
}

/**
 * The component props a freshly-seeded panel has on a layer.
 *
 * Every value-carrying parameter, at its declared default — including each axis
 * of a point, which is stored as separate numbers so each one is an ordinary
 * animatable property rather than an object the interpolator would have to
 * learn about.
 */
export function defaultParamProps(panel: PluginInspectorPanelContribution): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of panel.params) {
    if (!paramHoldsValue(p)) continue;
    const axes = paramAxes(p);
    if (axes.length > 0) {
      const d = isPlainObject(p.default) ? p.default : {};
      for (const axis of axes) out[pluginParamKey(p.name, axis)] = typeof d[axis] === 'number' ? d[axis] : 0;
      continue;
    }
    out[p.name] = p.default;
  }
  return out;
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Validate `contributes.inspector`, pushing messages rather than throwing.
 *
 * `commands` is taken so a `button` can be checked against the commands the
 * same manifest declares. A button wired to a command that does not exist is a
 * control the user presses and nothing happens to — the single worst outcome
 * for a widget whose entire purpose is that it does something.
 *
 * Idempotent, like every other parser here: the store persists the NORMALISED
 * manifest and re-parses it at every boot, so anything this emits it must also
 * accept (`manifestRoundTrip.test.ts`).
 */
export function parseInspectorPanels(
  raw: unknown,
  at: string,
  commands: readonly PluginCommandContribution[],
  icons: ReadonlySet<string>,
  errors: string[],
): PluginInspectorPanelContribution[] {
  const out: PluginInspectorPanelContribution[] = [];
  if (!Array.isArray(raw)) {
    errors.push(`"${at}" must be an array.`);
    return out;
  }
  if (raw.length > MAX_INSPECTOR_PANELS) {
    errors.push(`"${at}" declares ${raw.length} panels; the limit is ${MAX_INSPECTOR_PANELS}.`);
    return out;
  }

  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`"${where}" must be an object.`);
      return;
    }
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!PANEL_ID_RE.test(id)) {
      errors.push(`"${where}.id" must be lowercase letters, digits and dashes (1–64 characters).`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`"${where}.id" duplicates an earlier inspector panel id "${id}".`);
      return;
    }
    seen.add(id);

    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title || title.length > 60) {
      errors.push(`"${where}.title" is required (1–60 characters) — it is the section heading.`);
      return;
    }
    if (entry.icon !== undefined && (typeof entry.icon !== 'string' || !icons.has(entry.icon))) {
      errors.push(`"${where}.icon" is not an icon this editor has. Omit it to use the plugin glyph.`);
      return;
    }

    const appliesTo: string[] = [];
    if (entry.appliesTo !== undefined) {
      if (!Array.isArray(entry.appliesTo)) {
        errors.push(`"${where}.appliesTo" must be an array of layer kinds. Omit it for every layer.`);
        return;
      }
      for (const kind of entry.appliesTo) {
        if (typeof kind !== 'string' || !LAYER_KIND_RE.test(kind)) {
          errors.push(`"${where}.appliesTo" contains ${JSON.stringify(kind)}, which is not a layer kind.`);
          return;
        }
        if (!appliesTo.includes(kind)) appliesTo.push(kind);
      }
    }

    const params = parseParams(entry.params, `${where}.params`, commands, errors);
    if (params === null) return;

    out.push({
      id,
      title,
      ...(typeof entry.icon === 'string' ? { icon: entry.icon } : {}),
      appliesTo,
      params,
    });
  });

  return out;
}

/** One panel's parameter list, or null when anything in it was refused. */
function parseParams(
  raw: unknown,
  at: string,
  commands: readonly PluginCommandContribution[],
  errors: string[],
): PluginParamSchema[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`"${at}" must be a non-empty array — a panel with no parameters is an empty section.`);
    return null;
  }
  if (raw.length > MAX_PARAMS_PER_PANEL) {
    errors.push(`"${at}" declares ${raw.length} parameters; the limit is ${MAX_PARAMS_PER_PANEL}.`);
    return null;
  }

  const out: PluginParamSchema[] = [];
  const names = new Set<string>();
  let ok = true;

  raw.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`"${where}" must be an object.`);
      ok = false;
      return;
    }
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!PARAM_NAME_RE.test(name)) {
      errors.push(`"${where}.name" must be camelCase letters and digits (1–32 characters).`);
      ok = false;
      return;
    }
    if (names.has(name)) {
      errors.push(`"${where}.name" duplicates an earlier parameter "${name}".`);
      ok = false;
      return;
    }
    names.add(name);

    const type = entry.type as PluginParamType;
    if (typeof type !== 'string' || !PLUGIN_PARAM_TYPES.includes(type)) {
      errors.push(`"${where}.type" must be one of ${PLUGIN_PARAM_TYPES.join(', ')}.`);
      ok = false;
      return;
    }

    const schema: PluginParamSchema = { name, type };
    if (entry.label !== undefined) {
      if (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 60) {
        errors.push(`"${where}.label", when present, is 1–60 characters.`);
        ok = false;
        return;
      }
      schema.label = entry.label.trim();
    }
    if (entry.group !== undefined) {
      if (typeof entry.group !== 'string' || !entry.group.trim() || entry.group.length > 40) {
        errors.push(`"${where}.group", when present, is 1–40 characters.`);
        ok = false;
        return;
      }
      schema.group = entry.group.trim();
    }

    if (!checkTypeFields(entry, schema, where, commands, errors)) {
      ok = false;
      return;
    }
    out.push(schema);
  });

  if (!ok) return null;

  // `showIf` last, because it names a SIBLING and the siblings are only all
  // known once the list is parsed. A forward reference is legal — the author
  // orders the panel for the reader, not for the validator.
  for (let i = 0; i < out.length; i += 1) {
    const entry = raw[i] as Record<string, unknown>;
    if (entry.showIf === undefined) continue;
    const cond = entry.showIf;
    const where = `${at}[${i}].showIf`;
    if (!isPlainObject(cond) || typeof cond.param !== 'string') {
      errors.push(`"${where}" must be { "param": "<name>", "equals": <value> }.`);
      ok = false;
      continue;
    }
    if (cond.param === out[i]!.name) {
      errors.push(`"${where}.param" refers to the parameter itself, which can never be false.`);
      ok = false;
      continue;
    }
    if (!names.has(cond.param)) {
      errors.push(`"${where}.param" refers to "${cond.param}", which this panel does not declare.`);
      ok = false;
      continue;
    }
    const eq = cond.equals;
    if (typeof eq !== 'string' && typeof eq !== 'number' && typeof eq !== 'boolean') {
      errors.push(`"${where}.equals" must be a string, number or boolean.`);
      ok = false;
      continue;
    }
    out[i]!.showIf = { param: cond.param, equals: eq };
  }

  return ok ? out : null;
}

/**
 * The per-type half of the check: the fields a type requires, and the fields it
 * must not carry.
 *
 * Refused rather than ignored, both ways round. An author who writes
 * `"logarithmic": true` on a checkbox has a wrong mental model of the
 * vocabulary, and silently dropping the key leaves them with it.
 */
function checkTypeFields(
  entry: Record<string, unknown>,
  schema: PluginParamSchema,
  where: string,
  commands: readonly PluginCommandContribution[],
  errors: string[],
): boolean {
  const { type } = schema;
  const numeric = NUMERIC_TYPES.includes(type);
  const axes = POINT_AXES[type] ?? [];

  if (entry.unit !== undefined) {
    if (type !== 'slider' && type !== 'number') {
      errors.push(`"${where}.unit" is only for "slider" and "number" — an angle is always degrees.`);
      return false;
    }
    if (typeof entry.unit !== 'string' || entry.unit.length > 8) {
      errors.push(`"${where}.unit" must be a short suffix such as "%" or "px".`);
      return false;
    }
    schema.unit = entry.unit;
  }

  for (const key of ['min', 'max', 'step'] as const) {
    if (entry[key] === undefined) continue;
    if (!numeric && axes.length === 0) {
      errors.push(`"${where}.${key}" is only for numeric and point parameters.`);
      return false;
    }
    if (typeof entry[key] !== 'number' || !Number.isFinite(entry[key])) {
      errors.push(`"${where}.${key}" must be a finite number.`);
      return false;
    }
    schema[key] = entry[key] as number;
  }
  if (schema.min !== undefined && schema.max !== undefined && schema.min >= schema.max) {
    errors.push(`"${where}.min" must be below "${where}.max".`);
    return false;
  }

  if (entry.logarithmic !== undefined) {
    if (type !== 'slider') {
      errors.push(`"${where}.logarithmic" is only for "slider".`);
      return false;
    }
    if (entry.logarithmic !== true && entry.logarithmic !== false) {
      errors.push(`"${where}.logarithmic" must be true or false.`);
      return false;
    }
    if (entry.logarithmic === true && !(typeof schema.min === 'number' && schema.min > 0)) {
      // A log axis through zero is not a range with a rough edge, it is not a
      // range: the drag would do nothing at all over the bottom of it.
      errors.push(`"${where}.logarithmic" needs a "min" above zero.`);
      return false;
    }
    if (entry.logarithmic === true) schema.logarithmic = true;
  }

  if (entry.animatable !== undefined) {
    if (entry.animatable !== true && entry.animatable !== false) {
      errors.push(`"${where}.animatable" must be true or false.`);
      return false;
    }
    if (entry.animatable === true && !ANIMATABLE_TYPES.includes(type)) {
      errors.push(
        `"${where}.animatable" is only for ${ANIMATABLE_TYPES.join(', ')} — nothing interpolates a ${type}.`,
      );
      return false;
    }
    if (entry.animatable === true) schema.animatable = true;
  }

  if (entry.alpha !== undefined) {
    if (type !== 'color') {
      errors.push(`"${where}.alpha" is only for "color".`);
      return false;
    }
    if (entry.alpha !== true && entry.alpha !== false) {
      errors.push(`"${where}.alpha" must be true or false.`);
      return false;
    }
    if (entry.alpha === true) schema.alpha = true;
  }

  if (type === 'enum') {
    const opts = entry.options;
    if (!Array.isArray(opts) || opts.length === 0 || opts.length > MAX_ENUM_OPTIONS) {
      errors.push(`"${where}.options" must be 1–${MAX_ENUM_OPTIONS} { "value", "label" } entries.`);
      return false;
    }
    const values = new Set<string>();
    const parsed: PluginParamOption[] = [];
    for (const opt of opts) {
      if (!isPlainObject(opt) || typeof opt.value !== 'string' || typeof opt.label !== 'string') {
        errors.push(`"${where}.options" entries must be { "value": "…", "label": "…" }.`);
        return false;
      }
      if (!opt.value || opt.value.length > 64 || !opt.label.trim() || opt.label.length > 60) {
        errors.push(`"${where}.options" entries need a 1–64 character value and a 1–60 character label.`);
        return false;
      }
      if (values.has(opt.value)) {
        errors.push(`"${where}.options" repeats the value "${opt.value}".`);
        return false;
      }
      values.add(opt.value);
      parsed.push({ value: opt.value, label: opt.label.trim() });
    }
    schema.options = parsed;
  } else if (entry.options !== undefined) {
    errors.push(`"${where}.options" is only for "enum".`);
    return false;
  }

  if (type === 'button') {
    const command = typeof entry.command === 'string' ? entry.command : '';
    if (!command) {
      errors.push(`"${where}.command" is required for a "button" — name one of this plugin's commands.`);
      return false;
    }
    if (!commands.some((c) => c.id === command)) {
      // The one failure that cannot be seen from the running app: the button
      // draws, the user presses it, and nothing at all happens.
      errors.push(
        `"${where}.command" names "${command}", which is not in "contributes.commands".`,
      );
      return false;
    }
    schema.command = command;
  } else if (entry.command !== undefined) {
    errors.push(`"${where}.command" is only for "button".`);
    return false;
  }

  if (type === 'status') {
    if (entry.text !== undefined) {
      if (typeof entry.text !== 'string' || entry.text.length > 200) {
        errors.push(`"${where}.text" must be a string of at most 200 characters.`);
        return false;
      }
      schema.text = entry.text;
    }
  } else if (entry.text !== undefined) {
    errors.push(`"${where}.text" is only for "status".`);
    return false;
  }

  if (!paramHoldsValue(schema)) {
    if (entry.default !== undefined) {
      errors.push(`"${where}.default" means nothing for a "${type}" — it holds no value.`);
      return false;
    }
    return true;
  }

  return checkDefault(entry.default, schema, where, errors);
}

/**
 * The default, checked against the parameter's own constraints.
 *
 * The check that earns its place, for the reason `layerKindSchema` gives: a
 * default outside its own range, or absent from its own enum, produces a
 * control that is invalid the moment it is drawn — and the author never finds
 * out, because nothing reads the value until a user touches it.
 */
function checkDefault(
  value: unknown,
  schema: PluginParamSchema,
  where: string,
  errors: string[],
): boolean {
  const inRange = (n: number): boolean =>
    (schema.min === undefined || n >= schema.min) && (schema.max === undefined || n <= schema.max);

  switch (schema.type) {
    case 'slider':
    case 'number':
    case 'angle': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`"${where}.default" must be a finite number.`);
        return false;
      }
      if (!inRange(value)) {
        errors.push(`"${where}.default" (${value}) is outside this parameter's own min/max.`);
        return false;
      }
      schema.default = value;
      return true;
    }
    case 'checkbox': {
      if (typeof value !== 'boolean') {
        errors.push(`"${where}.default" must be true or false.`);
        return false;
      }
      schema.default = value;
      return true;
    }
    case 'enum': {
      if (typeof value !== 'string' || !schema.options?.some((o) => o.value === value)) {
        errors.push(`"${where}.default" must be one of this parameter's own option values.`);
        return false;
      }
      schema.default = value;
      return true;
    }
    case 'color': {
      if (typeof value !== 'string' || !HEX_RE.test(value)) {
        errors.push(`"${where}.default" must be a hex colour such as "#ff8800".`);
        return false;
      }
      if (!schema.alpha && value.length === 9) {
        errors.push(`"${where}.default" carries alpha, so the parameter needs "alpha": true.`);
        return false;
      }
      schema.default = value;
      return true;
    }
    case 'point':
    case 'point3d': {
      const axes = POINT_AXES[schema.type]!;
      if (!isPlainObject(value)) {
        errors.push(`"${where}.default" must be { ${axes.map((a) => `"${a}"`).join(', ')} }.`);
        return false;
      }
      const out: Record<string, number> = {};
      for (const axis of axes) {
        const n = value[axis];
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          errors.push(`"${where}.default.${axis}" must be a finite number.`);
          return false;
        }
        if (!inRange(n)) {
          errors.push(`"${where}.default.${axis}" (${n}) is outside this parameter's own min/max.`);
          return false;
        }
        out[axis] = n;
      }
      schema.default = out;
      return true;
    }
    default:
      return true;
  }
}

/** `focalLength` → "Focal length". The label when the schema declares none. */
export function humaniseParamName(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
