/**
 * The retime core: the Speed % integral and the chain time it hands every
 * consumer. Asserted against a brute-force numerical integration of what the
 * engine actually samples, not against hand-derived numbers — the endpoints of
 * a wrong integral are often still right.
 */

import { AnimationEngine } from '@motion/animation';
import {
  SPEED_PROP,
  pickRetimeBar,
  readRetimeMode,
  retimeClipOf,
  retimedChainTime,
  speedAdvance,
} from './retime';

const N = 'n';

/** ∫ speed over [a, b] by 20k-step midpoint rule on the engine's own curve. */
function bruteAdvance(anim: AnimationEngine, a: number, b: number): number {
  const steps = 20000;
  const h = (b - a) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) sum += (anim.sample(N, SPEED_PROP, a + (i + 0.5) * h) ?? 100) / 100;
  return sum * h;
}

describe('readRetimeMode', () => {
  it('reads the mode off the tracks', () => {
    const anim = new AnimationEngine();
    expect(readRetimeMode(anim, N)).toBe('normal');
    anim.setKeyframe(N, 'timeRemap', 0, 0);
    expect(readRetimeMode(anim, N)).toBe('frames');
    anim.setKeyframe(N, SPEED_PROP, 0, 50);
    expect(readRetimeMode(anim, N)).toBe('speed');
  });
});

describe('speedAdvance', () => {
  it('is exact for linear ramps', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe(N, SPEED_PROP, 1, 100, 'linear');
    anim.setKeyframe(N, SPEED_PROP, 2, 25, 'linear');
    // (1 + 0.25) / 2 over one second.
    expect(speedAdvance(anim, N, 1, 2)).toBeCloseTo(0.625, 9);
    expect(speedAdvance(anim, N, 1.2, 1.7)).toBeCloseTo(bruteAdvance(anim, 1.2, 1.7), 6);
  });

  it('holds speed flat before the first key and after the last', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe(N, SPEED_PROP, 1, 200, 'linear');
    anim.setKeyframe(N, SPEED_PROP, 2, 50, 'linear');
    expect(speedAdvance(anim, N, 0, 1)).toBeCloseTo(2, 9);
    expect(speedAdvance(anim, N, 2, 4)).toBeCloseTo(1, 9);
  });

  it('jumps at a hold key instead of ramping', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe(N, SPEED_PROP, 0, 400, 'step');
    anim.setKeyframe(N, SPEED_PROP, 1, 100, 'step');
    expect(speedAdvance(anim, N, 0, 1)).toBeCloseTo(4, 9);
    expect(speedAdvance(anim, N, 0, 2)).toBeCloseTo(5, 9);
  });

  it('integrates eased segments to well under a frame', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe(N, SPEED_PROP, 0, 100, 'easeInOut');
    anim.setKeyframe(N, SPEED_PROP, 1.5, 20, 'easeInOut');
    anim.setKeyframe(N, SPEED_PROP, 3, 300, 'linear');
    for (const [a, b] of [[0, 3], [0.3, 1.1], [1.4, 2.9]] as const) {
      expect(Math.abs(speedAdvance(anim, N, a, b) - bruteAdvance(anim, a, b))).toBeLessThan(1 / 240);
    }
  });

  it('plays backwards through a negative speed', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe(N, SPEED_PROP, 0, -100, 'step');
    expect(speedAdvance(anim, N, 0, 2)).toBeCloseTo(-2, 9);
  });

  it('recomputes when the curve changes', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe(N, SPEED_PROP, 0, 50, 'linear');
    expect(speedAdvance(anim, N, 0, 1)).toBeCloseTo(0.5, 9);
    anim.setKeyframe(N, SPEED_PROP, 0, 300, 'linear');
    expect(speedAdvance(anim, N, 0, 1)).toBeCloseTo(3, 9);
  });
});

describe('retimedChainTime', () => {
  it('keeps the in-point frame and integrates from there', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe(N, SPEED_PROP, 0, 50, 'step');
    // Bar at comp 2s showing source 5s (sourceIn 150 at 30fps).
    const clip = retimeClipOf({ start: 60, end: 400, clip: { sourceIn: 150 } }, 30)!;
    // The clip map adds offsetSec back, so source = chain + offset.
    const sourceAt = (t: number): number => retimedChainTime(anim, N, t, clip)! + clip.offsetSec;
    expect(sourceAt(2)).toBeCloseTo(5, 9);
    expect(sourceAt(4)).toBeCloseTo(6, 9);
  });

  it('samples the remap track in Frame Number mode', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe(N, 'timeRemap', 0, 3, 'linear');
    anim.setKeyframe(N, 'timeRemap', 2, 5, 'linear');
    expect(retimedChainTime(anim, N, 1, null)).toBeCloseTo(4, 9);
  });

  it('is undefined for a layer that is not retimed', () => {
    expect(retimedChainTime(new AnimationEngine(), N, 1, null)).toBeUndefined();
  });
});

describe('pickRetimeBar', () => {
  const bars = [
    { start: 0, end: 30, clip: { sourceIn: 0 } },
    { start: 60, end: 90, clip: { sourceIn: 100 } },
  ];
  it('prefers the live bar, else the nearest', () => {
    expect(pickRetimeBar(bars, 65)).toBe(bars[1]);
    expect(pickRetimeBar(bars, 35)).toBe(bars[0]);
    expect(pickRetimeBar(bars, 55)).toBe(bars[1]);
    expect(pickRetimeBar([], 5)).toBeNull();
  });
});
