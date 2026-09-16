/**
 * Strokes 2+ are described and listed like the first: `stroke.<i>.<param>`
 * resolves to a named, united property, and the timeline's Contents lists a
 * Stroke N group per enabled stroke — rows following the stroke's structure.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { buildStaticPropertyTree } from '@core/timeline/propertyTree';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const ID = 'stroke_rows_probe';
const base = { enabled: true, color: '#ffffff', opacity: 1, align: 'center', dash: [] as number[], cap: 'butt', join: 'miter' };

function seed(strokes: Array<Record<string, unknown>>, kind = 'shape'): void {
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode({
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${ID}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, width: 100, height: 80 } }],
  } as unknown as SceneNode);
  defaultSceneGraph.setStroke(ID, strokes[0] as never);
  defaultSceneGraph.setStrokes(ID, (strokes.length > 1 ? strokes : undefined) as never);
}

afterEach(() => {
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
});

describe('stroke track metadata', () => {
  it('strokes 2+ borrow the primary’s description, renumbered', () => {
    expect(resolvePropertyMeta('stroke.1.width')).toMatchObject({ label: 'Stroke 2 Width', unit: 'px', group: 'stroke' });
    expect(resolvePropertyMeta('stroke.2.dashOffset').label).toBe('Stroke 3 Dash Offset');
    expect(resolvePropertyMeta('stroke.1.opacity')).toMatchObject({ label: 'Stroke 2 Opacity', displayScale: 100, max: 1 });
    expect(resolvePropertyMeta('stroke.1.color_a').label).toBe('Stroke 2 Color Alpha');
  });

  it('the new primary tracks are registered with their ranges', () => {
    expect(resolvePropertyMeta('strokeMiterLimit')).toMatchObject({ min: 1, defaultValue: 4 });
    expect(resolvePropertyMeta('strokeDash2').unit).toBe('px');
    expect(resolvePropertyMeta('strokeTaperStartEase')).toMatchObject({ min: -1, max: 1 });
  });

  it('Length Units = Pixels makes a taper length a px property ON THAT LAYER', () => {
    seed([
      { ...base, width: 6 },
      { ...base, width: 6, taper: { startWidth: 0.2, endWidth: 1, startLength: 50, endLength: 0, startEase: 0, endEase: 0, lengthUnits: 'pixels' } },
    ]);
    expect(resolvePropertyMeta('strokeTaperStartLength', ID)).toMatchObject({ unit: '%', displayScale: 100 });
    const px = resolvePropertyMeta('stroke.1.taperStartLength', ID);
    expect(px.unit).toBe('px');
    expect(px.displayScale).toBeUndefined();
    expect(px.max).toBeUndefined();
  });

  it('Wave Units = Cycles relabels the wavelength', () => {
    seed([{ ...base, width: 6, wave: { amount: 4, wavelength: 5, phase: 0, units: 'cycles' } }]);
    expect(resolvePropertyMeta('strokeWaveWavelength', ID)).toMatchObject({ label: 'Cycles', unit: '' });
    expect(resolvePropertyMeta('strokeWaveWavelength').label).toBe('Wavelength');
  });
});

describe('Contents ▸ Stroke N rows', () => {
  it('every ENABLED stroke gets rows on its own paths, following its structure', () => {
    seed([
      { ...base, width: 6, join: 'round' },
      { ...base, width: 3, dash: [8, 4], join: 'miter' },
      { ...base, width: 3, enabled: false },
    ]);
    const props = buildStaticPropertyTree(ID).map((r) => r.prop);
    // Primary: colour/opacity/width, no miter row on a round join, no dashes.
    expect(props).toEqual(expect.arrayContaining(['stroke', 'strokeOpacity', 'strokeWidth']));
    expect(props).not.toContain('strokeMiterLimit');
    expect(props).not.toContain('strokeDashOffset');
    // Stroke 2: its own paths, a row per dash slot, the offset, the miter limit.
    expect(props).toEqual(expect.arrayContaining([
      'stroke.1.color', 'stroke.1.opacity', 'stroke.1.width', 'stroke.1.miterLimit',
      'stroke.1.dash1', 'stroke.1.gap1', 'stroke.1.dashOffset',
    ]));
    expect(props).not.toContain('stroke.1.dash2');
    // Stroke 3 is off: no rows.
    expect(props.some((p) => p.startsWith('stroke.2.'))).toBe(false);
  });

  it('a colour row keys all four channels of ITS stroke', () => {
    seed([{ ...base, width: 6 }, { ...base, width: 2 }]);
    const row = buildStaticPropertyTree(ID).find((r) => r.prop === 'stroke.1.color')!;
    expect(row.members).toEqual(['stroke.1.color_r', 'stroke.1.color_g', 'stroke.1.color_b', 'stroke.1.color_a']);
    expect(row.group).toBe('contents');
  });

  it('a text layer’s compiled outline gets no Stroke group', () => {
    seed([{ ...base, width: 6 }], 'text');
    expect(buildStaticPropertyTree(ID).some((r) => r.prop === 'strokeOpacity')).toBe(false);
  });
});
