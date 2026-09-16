/**
 * Keyframe values that are not a single number — colours and points.
 *
 * ── The ceiling this removes ─────────────────────────────────────────────────
 *
 * `animation.setKeyframes` took `value: number` and refused everything else, so
 * a plugin could not animate a colour at all: `{ t: 0, value: '#ff0055' }` was
 * "must be a finite number", and there was no documented way round it. The
 * renderer has always animated colours — just not as one track. A colour is
 * FOUR tracks, `<base>_r/_g/_b/_a`, each 0..1, and a position is two or three
 * (`x`/`y`/`z`). The inspector's `ColorKfRow` writes exactly that; this module
 * writes the same thing so a plugin's colour animation is indistinguishable
 * from one the user keyed by hand.
 *
 * ── Mapping ──────────────────────────────────────────────────────────────────
 *
 *   • number             → the track itself, as before.
 *   • colour             → `<prop>_r/_g/_b/_a`, 0..1, when `<prop>` is a colour
 *                          the renderer resolves channels for (`isColorBase`).
 *                          Accepted as `'#rgb'`, `'#rrggbb'`, `'#rrggbbaa'`, or
 *                          `{ r, g, b, a? }` with r/g/b 0–255 and a 0–1 — the
 *                          CSS `rgba()` convention, which is what an author
 *                          writing one by hand reaches for.
 *   • point `{ x, y, z? }` → `x/y/z` for `position`, `anchorX/Y/Z` for
 *                          `anchor`, `scaleX/Y/Z` for `scale`, `poiX/Y/Z` for
 *                          `pointOfInterest`, or `<prop>X/<prop>Y/<prop>Z`
 *                          whenever the layer has those tracks.
 *
 * Every keyframe in one call must be the same kind. Mixing a number and a
 * colour on one property is not a thing either track family can represent.
 *
 * Validation completes before anything is written, and each output track is
 * one `setKeyframes` — so a colour is four sorts and four notifications, not
 * four per keyframe.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isColorBase, trackProblem } from './propValidation';

type SceneNodeView = NonNullable<ReturnType<typeof defaultSceneGraph.getNode>>;

export interface KeyframeIn {
  t: number;
  value: unknown;
  easing?: string;
}

export interface KeyframeOut {
  t: number;
  value: number;
  easing?: string;
}

/** One track and the numeric keyframes to write to it. */
export interface TrackWrite {
  path: string;
  keyframes: KeyframeOut[];
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const SUPPORTED =
  'Keyframe values must be a number, a colour ("#rrggbb", "#rrggbbaa" or { r, g, b, a }) or a point ({ x, y } or { x, y, z }).';

type Kind = 'number' | 'color' | 'point';

/** Named axis tracks for the point-shaped properties whose tracks are not `<prop>X`. */
const POINT_AXES: Readonly<Record<string, readonly [string, string, string]>> = {
  position: ['x', 'y', 'z'],
  anchor: ['anchorX', 'anchorY', 'anchorZ'],
  anchorPoint: ['anchorX', 'anchorY', 'anchorZ'],
  scale: ['scaleX', 'scaleY', 'scaleZ'],
  pointOfInterest: ['poiX', 'poiY', 'poiZ'],
  poi: ['poiX', 'poiY', 'poiZ'],
};

function kindOf(value: unknown, at: string): Kind {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`"${at}" must be a finite number.`);
    return 'number';
  }
  if (typeof value === 'string') {
    if (HEX.test(value)) return 'color';
    throw new Error(`"${at}" is the string "${value.slice(0, 40)}", which is not a hex colour. ${SUPPORTED}`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if ('r' in o || 'g' in o || 'b' in o) return 'color';
    if ('x' in o || 'y' in o) return 'point';
  }
  throw new Error(`"${at}" has an unsupported value. ${SUPPORTED}`);
}

/** RGBA in 0..1 — the scale every `_r/_g/_b/_a` track is stored in. */
function colorChannels(value: unknown, at: string): [number, number, number, number] {
  if (typeof value === 'string') {
    let h = value.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6) h += 'ff';
    const n = Number.parseInt(h, 16);
    return [((n >>> 24) & 0xff) / 255, ((n >>> 16) & 0xff) / 255, ((n >>> 8) & 0xff) / 255, (n & 0xff) / 255];
  }
  const o = value as Record<string, unknown>;
  const byte = (k: 'r' | 'g' | 'b'): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 255) {
      throw new Error(`"${at}.${k}" must be a number from 0 to 255.`);
    }
    return v / 255;
  };
  let a = 1;
  if (o.a !== undefined) {
    if (typeof o.a !== 'number' || !Number.isFinite(o.a) || o.a < 0 || o.a > 1) {
      throw new Error(`"${at}.a" must be a number from 0 to 1.`);
    }
    a = o.a;
  }
  return [byte('r'), byte('g'), byte('b'), a];
}

function pointAxes(node: SceneNodeView, prop: string, wantsZ: boolean): string[] {
  const named = POINT_AXES[prop];
  const axes = named ? [...named] : [`${prop}X`, `${prop}Y`, `${prop}Z`];
  const [ax, ay, az] = axes as [string, string, string];
  if (!named && (trackProblem(node, ax) !== null || trackProblem(node, ay) !== null)) {
    throw new Error(
      `"${prop}" has no X/Y tracks, so it cannot take point keyframes. Point keyframes work on `
      + 'position, anchor, scale, pointOfInterest, and any property with <name>X / <name>Y tracks.',
    );
  }
  if (!wantsZ) return [ax, ay];
  if (!named && trackProblem(node, az) !== null) {
    throw new Error(`"${prop}" has no Z track; send { x, y } without z.`);
  }
  return [ax, ay, az];
}

/**
 * Turn one property's keyframes into per-track numeric writes, or throw a
 * refusal naming the problem. Nothing is written here.
 */
export function planKeyframeWrites(node: SceneNodeView, prop: string, keyframes: readonly KeyframeIn[]): TrackWrite[] {
  if (keyframes.length === 0) {
    const problem = trackProblem(node, prop);
    // An empty write to a colour/point base is a no-op on no track; allow it
    // only where a number track would have been valid, as before.
    if (problem && !isColorBase(node, prop) && !POINT_AXES[prop]) throw new Error(problem);
    return problem ? [] : [{ path: prop, keyframes: [] }];
  }

  const kind = kindOf(keyframes[0]!.value, 'keyframe[0].value');
  keyframes.forEach((k, i) => {
    const kk = kindOf(k.value, `keyframe[${i}].value`);
    if (kk !== kind) {
      throw new Error(`keyframe[${i}] is a ${kk} but keyframe[0] is a ${kind}; one call animates one kind of value.`);
    }
  });

  const easing = (k: KeyframeIn): { easing?: string } => (k.easing !== undefined ? { easing: k.easing } : {});

  if (kind === 'number') {
    const problem = trackProblem(node, prop);
    if (problem) throw new Error(problem);
    return [{ path: prop, keyframes: keyframes.map((k) => ({ t: k.t, value: k.value as number, ...easing(k) })) }];
  }

  if (kind === 'color') {
    if (!isColorBase(node, prop)) {
      throw new Error(
        `"${prop}" is not a colour property of "${node.name}", so it cannot take colour keyframes. `
        + 'Colour keyframes work on fill, stroke, color, and an effect\'s colour parameter (effect.<effectId>.<param>).',
      );
    }
    const channels = keyframes.map((k, i) => colorChannels(k.value, `keyframe[${i}].value`));
    return (['_r', '_g', '_b', '_a'] as const).map((suffix, c) => ({
      path: `${prop}${suffix}`,
      keyframes: keyframes.map((k, i) => ({ t: k.t, value: channels[i]![c]!, ...easing(k) })),
    }));
  }

  // Point.
  const points = keyframes.map((k, i) => {
    const o = k.value as Record<string, unknown>;
    const n = (axis: 'x' | 'y' | 'z'): number => {
      const v = o[axis];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"keyframe[${i}].value.${axis}" must be a finite number.`);
      return v;
    };
    return { x: n('x'), y: n('y'), ...(o.z !== undefined ? { z: n('z') } : {}) };
  });
  const wantsZ = points.some((p) => 'z' in p);
  if (wantsZ && !points.every((p) => 'z' in p)) {
    throw new Error('Either every point keyframe carries z, or none does.');
  }
  const axes = pointAxes(node, prop, wantsZ);
  return axes.map((path, a) => ({
    path,
    keyframes: keyframes.map((k, i) => {
      const p = points[i]! as { x: number; y: number; z?: number };
      return { t: k.t, value: (a === 0 ? p.x : a === 1 ? p.y : p.z!), ...easing(k) };
    }),
  }));
}
