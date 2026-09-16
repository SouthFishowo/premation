/**
 * The inspector vocabulary a plugin declares.
 *
 * Every check here is one an author would otherwise meet as a control that
 * looks right and behaves wrong — which is the expensive kind, because the
 * symptom appears in a user's project rather than at install:
 *
 *   • a `default` outside its own range, or absent from its own enum;
 *   • a `button` wired to a command the manifest does not declare — it draws,
 *     it is pressed, and nothing happens;
 *   • `logarithmic` on a range through zero, whose drag does nothing at the
 *     bottom of the slider;
 *   • a `showIf` naming a sibling that does not exist, so the row never appears.
 */

import { parseManifest } from './manifest';
import {
  MAX_PARAMS_PER_PANEL,
  parseInspectorPanels,
  pluginParamPath,
  pluginParamComponentType,
  defaultParamProps,
  paramAxes,
  paramIsAnimatable,
} from './uiParams';

const ICONS: ReadonlySet<string> = new Set(['plugin', 'cube']);
const COMMANDS = [{ id: 'bake', label: 'Bake' }];

/** Parse one panel, returning the errors so a test can read them. */
function parseOne(panel: unknown): { panels: ReturnType<typeof parseInspectorPanels>; errors: string[] } {
  const errors: string[] = [];
  const panels = parseInspectorPanels([panel], 'contributes.inspector', COMMANDS, ICONS, errors);
  return { panels, errors };
}

const panelWith = (...params: unknown[]): unknown => ({ id: 'lift', title: '3D Lift', params });

describe('the widget vocabulary', () => {
  it('accepts one of every type, with labels, groups and units', () => {
    const { panels, errors } = parseOne(panelWith(
      { name: 'amount', type: 'slider', default: 50, min: 0, max: 100, unit: '%', animatable: true },
      { name: 'radius', type: 'slider', default: 4, min: 0.1, max: 500, logarithmic: true, unit: 'px' },
      { name: 'spin', type: 'angle', default: 0, animatable: true },
      { name: 'soft', type: 'checkbox', default: true },
      { name: 'mode', type: 'enum', default: 'hard', options: [{ value: 'hard', label: 'Hard Light' }] },
      { name: 'tint', type: 'color', default: '#ff880080', alpha: true },
      { name: 'centre', type: 'point', default: { x: 0, y: 0 }, animatable: true },
      { name: 'origin', type: 'point3d', default: { x: 0, y: 0, z: 0 } },
      { name: 'bake', type: 'button', label: 'Bake now', command: 'bake' },
      { name: 'state', type: 'status', text: 'Idle', group: 'Diagnostics' },
    ));

    expect(errors).toEqual([]);
    expect(panels[0]!.params).toHaveLength(10);
    // The enum keeps its LABEL, which is the whole reason it is not a string list.
    expect(panels[0]!.params.find((p) => p.name === 'mode')!.options)
      .toEqual([{ value: 'hard', label: 'Hard Light' }]);
    expect(panels[0]!.params.find((p) => p.name === 'state')!.group).toBe('Diagnostics');
  });

  it('refuses a default that breaks the parameter s own rules', () => {
    expect(parseOne(panelWith({ name: 'a', type: 'slider', default: 120, min: 0, max: 100 })).errors)
      .toEqual([expect.stringContaining('outside this parameter')]);
    expect(parseOne(panelWith({
      name: 'a', type: 'enum', default: 'nope', options: [{ value: 'yes', label: 'Yes' }],
    })).errors).toEqual([expect.stringContaining('option values')]);
    expect(parseOne(panelWith({ name: 'a', type: 'color', default: 'red' })).errors)
      .toEqual([expect.stringContaining('hex colour')]);
  });

  it('refuses alpha in a colour that did not ask for it', () => {
    // A plugin reading `#ff8800` and handed `#ff8800cc` renders the wrong
    // colour and never finds out, so the manifest has to agree with itself.
    expect(parseOne(panelWith({ name: 'a', type: 'color', default: '#ff8800cc' })).errors)
      .toEqual([expect.stringContaining('"alpha": true')]);
  });

  it('refuses a logarithmic slider whose range reaches zero', () => {
    expect(parseOne(panelWith({
      name: 'a', type: 'slider', default: 1, min: 0, max: 100, logarithmic: true,
    })).errors).toEqual([expect.stringContaining('"min" above zero')]);
  });

  it('refuses a button whose command the manifest does not declare', () => {
    expect(parseOne(panelWith({ name: 'a', type: 'button', command: 'nope' })).errors)
      .toEqual([expect.stringContaining('not in "contributes.commands"')]);
  });

  it('refuses a field on a type that has no use for it, rather than ignoring it', () => {
    // Silently dropping the key leaves the author with a wrong mental model of
    // the vocabulary, which is the thing that produces the NEXT bug.
    expect(parseOne(panelWith({ name: 'a', type: 'checkbox', default: true, unit: 'px' })).errors)
      .toEqual([expect.stringContaining('.unit" is only for')]);
    expect(parseOne(panelWith({ name: 'a', type: 'checkbox', default: true, animatable: true })).errors)
      .toEqual([expect.stringContaining('.animatable" is only for')]);
    expect(parseOne(panelWith({ name: 'a', type: 'status', default: 3 })).errors)
      .toEqual([expect.stringContaining('holds no value')]);
  });

  it('resolves showIf against a sibling, in either declaration order', () => {
    const forward = parseOne(panelWith(
      { name: 'soft', type: 'checkbox', default: false },
      { name: 'feather', type: 'slider', default: 0, showIf: { param: 'soft', equals: true } },
    ));
    expect(forward.errors).toEqual([]);
    expect(forward.panels[0]!.params[1]!.showIf).toEqual({ param: 'soft', equals: true });

    // A forward reference is legal: the author orders the panel for the reader.
    const backward = parseOne(panelWith(
      { name: 'feather', type: 'slider', default: 0, showIf: { param: 'soft', equals: true } },
      { name: 'soft', type: 'checkbox', default: false },
    ));
    expect(backward.errors).toEqual([]);

    expect(parseOne(panelWith(
      { name: 'feather', type: 'slider', default: 0, showIf: { param: 'ghost', equals: true } },
    )).errors).toEqual([expect.stringContaining('which this panel does not declare')]);
    expect(parseOne(panelWith(
      { name: 'feather', type: 'slider', default: 0, showIf: { param: 'feather', equals: 1 } },
    )).errors).toEqual([expect.stringContaining('itself')]);
  });

  it('caps the parameters in one panel', () => {
    const many = Array.from({ length: MAX_PARAMS_PER_PANEL + 1 }, (_, i) => ({
      name: `p${i}`, type: 'slider', default: 0,
    }));
    expect(parseOne(panelWith(...many)).errors).toEqual([expect.stringContaining('the limit is')]);
  });
});

describe('storage keys', () => {
  it('flattens the plugin id so a track key parses on dots', () => {
    expect(pluginParamPath('studio.acme-lab', 'lift', 'amount'))
      .toBe('pluginUi.studio-acme-lab.lift.amount');
    expect(pluginParamPath('studio.acme-lab', 'lift', 'centre', 'x'))
      .toBe('pluginUi.studio-acme-lab.lift.centre.x');
    expect(pluginParamComponentType('studio.acme-lab', 'lift'))
      .toBe('PluginParams.studio-acme-lab.lift');
  });

  it('stores a point as separate numbers, one per axis', () => {
    // Each axis is then an ORDINARY animatable property. An object would have
    // to teach the interpolator a new shape for no gain.
    const { panels } = parseOne(panelWith(
      { name: 'centre', type: 'point', default: { x: 3, y: 4 }, animatable: true },
      { name: 'depth', type: 'slider', default: 2 },
      { name: 'go', type: 'button', command: 'bake' },
    ));
    expect(paramAxes(panels[0]!.params[0]!)).toEqual(['x', 'y']);
    expect(paramIsAnimatable(panels[0]!.params[0]!)).toBe(true);
    expect(defaultParamProps(panels[0]!)).toEqual({ 'centre.x': 3, 'centre.y': 4, depth: 2 });
  });
});

describe('the manifest gate', () => {
  const base = {
    id: 'studio.acme.lab',
    name: 'Acme Lab',
    version: '1.0.0',
    description: 'Adds a lift.',
    main: 'main.js',
  };
  const panel = {
    id: 'lift',
    title: 'Lift',
    params: [{ name: 'amount', type: 'slider', default: 1 }],
  };

  it('needs apiVersion 7', () => {
    const old = parseManifest({ ...base, apiVersion: 6, contributes: { inspector: [panel] } });
    expect(old.errors).toEqual([expect.stringContaining('requires "apiVersion": 7')]);

    const current = parseManifest({ ...base, apiVersion: 7, contributes: { inspector: [panel] } });
    expect(current.errors).toEqual([]);
    expect(current.manifest!.contributes.inspector[0]!.id).toBe('lift');
  });

  it('keeps an EMPTY block valid on an older grammar', () => {
    // The rule every gated key here follows: a block that declares nothing is
    // not using the feature, and refusing it would break packages that spelled
    // the key out before it meant anything.
    expect(parseManifest({ ...base, apiVersion: 4, contributes: { inspector: [] } }).errors).toEqual([]);
  });

  it('normalises to a block every reader can index without a fallback', () => {
    const { manifest } = parseManifest({ ...base, apiVersion: 1 });
    expect(manifest!.contributes.inspector).toEqual([]);
    expect(manifest!.contributes.tools).toEqual([]);
    expect(manifest!.contributes.shortcuts).toEqual([]);
    expect(manifest!.contributes.expressions).toEqual([]);
  });
});
