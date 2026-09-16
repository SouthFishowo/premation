/**
 * useLivePlayhead — follow the playhead every frame WITHOUT re-rendering.
 *
 * The `KeyframeLane` pattern, packaged: `apply(time)` runs on every clock tick
 * of the active tab (through `subscribeTime`) and once after every render of
 * the host (a layout effect, so it lands before paint). Whatever `apply` writes
 * — a transform, a width, a text node — is therefore always the live value,
 * even when the host just re-rendered with an older, throttled one.
 *
 * `apply` is held in a ref: pass a fresh closure each render, it never
 * re-subscribes.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { getTime, subscribeTime } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';

export function useLivePlayhead(apply: (time: number) => void, enabled = true): void {
  const activeTab = useProjectStore((s) => s.activeTabId);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  // After EVERY render: a host re-render may have written a stale value.
  useLayoutEffect(() => {
    if (enabled) applyRef.current(getTime(activeTab));
  });

  useEffect(() => {
    if (!enabled || !activeTab) return undefined;
    return subscribeTime(activeTab, (t) => applyRef.current(t));
  }, [enabled, activeTab]);
}
