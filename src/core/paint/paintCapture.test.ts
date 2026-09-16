import {
  cloneOffsetFor,
  ctrlDragBrush,
  durationRange,
  penSample,
  smoothSamples,
  strokeOptionsFrom,
  writeOnEndKeys,
} from './paintCapture';

describe('input smoothing', () => {
  test('off is a copy; on pulls interior samples, endpoints pinned', () => {
    const zig = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }];
    expect(smoothSamples(zig, 0)).toEqual(zig);
    const s = smoothSamples(zig, 0.5);
    expect(s[0]).toEqual(zig[0]);
    expect(s[3]).toEqual(zig[3]);
    expect(s[1]!.y).toBeLessThan(10);
  });
});

describe('Duration', () => {
  test('Constant / Single Frame / Custom', () => {
    expect(durationRange('constant', 2, 30)).toEqual({ inPoint: 2 });
    expect(durationRange('writeOn', 2, 30)).toEqual({ inPoint: 2 });
    expect(durationRange('single', 2, 25)).toEqual({ inPoint: 2, outPoint: 2.04 });
    expect(durationRange('custom', 1, 10, 5)).toEqual({ inPoint: 1, outPoint: 1.5 });
  });

  test('Write On replays the drawing speed as End keys, one per frame', () => {
    // 3 equal segments; the first two drawn in 100 ms, the last in 400 ms.
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    const keys = writeOnEndKeys(pts, [0, 50, 100, 500], 1, 10); // 10 fps → 100 ms frames
    expect(keys[0]).toEqual({ t: 1, value: 0 });
    expect(keys[1]!.value).toBeCloseTo(200 / 3); // two thirds after the first frame
    expect(keys[keys.length - 1]).toEqual({ t: 1.5, value: 100 });
    expect(keys).toHaveLength(6);
    // Slower tail: later keys advance less per frame than the first.
    expect(keys[2]!.value - keys[1]!.value).toBeLessThan(keys[1]!.value);
  });

  test('an instant dab still writes on over one frame', () => {
    expect(writeOnEndKeys([{ x: 0, y: 0 }], [0], 0, 30)).toEqual([{ t: 0, value: 0 }, { t: 1 / 30, value: 100 }]);
  });
});

describe('pen input and aiming', () => {
  test('mouse and touch record no dynamics input', () => {
    expect(penSample({ pointerType: 'mouse', pressure: 0.5 })).toBeNull();
    expect(penSample({ pointerType: 'pen', pressure: 0.3, tiltX: 10, tiltY: -5 })).toEqual({ pressure: 0.3, tiltX: 10, tiltY: -5 });
  });

  test('Aligned fixes the offset at the first stroke; non-aligned re-aims every stroke', () => {
    const first = cloneOffsetFor(true, { x: 100, y: 0 }, { x: 10, y: 0 }, null);
    expect(first).toEqual({ offset: { x: 90, y: 0 }, remember: { x: 90, y: 0 } });
    expect(cloneOffsetFor(true, { x: 100, y: 0 }, { x: 50, y: 0 }, first.remember).offset).toEqual({ x: 90, y: 0 });
    expect(cloneOffsetFor(false, { x: 100, y: 0 }, { x: 50, y: 0 }, first.remember)).toEqual({ offset: { x: 50, y: 0 }, remember: null });
  });

  test('Ctrl-drag sets diameter, then hardness', () => {
    expect(ctrlDragBrush({ size: 20, hardness: 0.5 }, 30, 'size')).toEqual({ size: 50, hardness: 0.5 });
    expect(ctrlDragBrush({ size: 20, hardness: 0.5 }, 200, 'hardness')).toEqual({ size: 20, hardness: 1 });
  });
});

test('stroke options: Spacing always, other v2 options only when not default', () => {
  const base = {
    color: '#fff', size: 10, opacity: 1, flow: 1, hardness: 1, angle: 0, roundness: 1, spacing: 0.25,
    blend: 'normal' as const, channels: 'rgba' as const, dynamics: { size: 'off' as const },
  };
  expect(strokeOptionsFrom(base)).toEqual({ color: '#fff', size: 10, opacity: 1, hardness: 1, spacing: 0.25 });
  expect(strokeOptionsFrom({ ...base, flow: 0.4, roundness: 0.5, blend: 'multiply', dynamics: { size: 'pressure' } }))
    .toMatchObject({ flow: 0.4, roundness: 0.5, blend: 'multiply', dynamics: { size: 'pressure' } });
});
