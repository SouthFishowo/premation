/**
 * When a native call runs, and what happens to the ones behind it.
 *
 * Three rules, and they pull against each other on purpose:
 *
 *   • A PREVIEW drops what the playhead has already moved past. A scrub submits
 *     a call per pointer move and a queue that runs all of them finishes
 *     minutes after the user stopped.
 *   • An EXPORT drops nothing. Every frame is the one that matters, and a
 *     coalesced call there is a frame written with the previous frame's pixels.
 *   • CONCURRENCY comes from the plugin's own `threadSafety`, through the very
 *     same `laneFor` the CPU kernel pool uses — not a second copy of the rule.
 *
 * And the budget, which is what "no native call on the render loop's critical
 * path" actually means: a plugin that overruns is skipped in preview until it
 * comes back under, so the playhead keeps moving and the effect falls back to
 * its JavaScript path.
 */

import {
  NATIVE_BUDGET_COOLDOWN_MS,
  NATIVE_PREVIEW_BUDGET_MS,
  NativeScheduler,
  type NativeJob,
} from './nativeScheduler';
import type { NativeCallOutcome } from './nativeAbi';

function job(overrides: Partial<NativeJob> = {}): NativeJob {
  return {
    pluginId: 'studio.acme.fx',
    instanceId: 'i1',
    request: { call: 'invoke', method: 'x', payload: null },
    ...overrides,
  };
}

/** A dispatch whose calls are settled by hand, so ordering is observable. */
function controllable() {
  const inFlight: Array<{ job: NativeJob; settle: (o: NativeCallOutcome) => void }> = [];
  const dispatch = (j: NativeJob): Promise<NativeCallOutcome> =>
    new Promise<NativeCallOutcome>((resolve) => { inFlight.push({ job: j, settle: resolve }); });
  const ok = (index = 0): void => {
    const entry = inFlight.splice(index, 1)[0]!;
    entry.settle({ ok: true, result: { call: 'invoke', result: null }, elapsedMs: 1 });
  };
  return { dispatch, inFlight, ok };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

describe('latest-wins, during a preview', () => {
  it('drops a queued call when a newer one arrives for the same lane', async () => {
    const c = controllable();
    const s = new NativeScheduler(c.dispatch);

    const first = s.submit(job({ request: { call: 'invoke', method: 'a', payload: null } }));
    await flush();
    // One is running; the next two queue behind it in the same instance lane.
    const stale = s.submit(job({ request: { call: 'invoke', method: 'b', payload: null } }));
    const newest = s.submit(job({ request: { call: 'invoke', method: 'c', payload: null } }));

    // The stale one never runs, and says so rather than hanging.
    await expect(stale).resolves.toBeNull();

    c.ok();
    await flush();
    expect(c.inFlight).toHaveLength(1);
    expect((c.inFlight[0]!.job.request as { method: string }).method).toBe('c');
    c.ok();
    await expect(newest).resolves.toMatchObject({ ok: true });
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('does not coalesce across instances — two layers are two lanes', async () => {
    const c = controllable();
    const s = new NativeScheduler(c.dispatch);
    void s.submit(job({ instanceId: 'a' }));
    void s.submit(job({ instanceId: 'b' }));
    await flush();
    expect(c.inFlight).toHaveLength(2);
  });
});

describe('lanes come from threadSafety', () => {
  it('serialises everything for an `unsafe` plugin, whatever the instance', async () => {
    const c = controllable();
    const s = new NativeScheduler(c.dispatch);
    void s.submit(job({ instanceId: 'a', threadSafety: 'unsafe' }));
    void s.submit(job({ instanceId: 'b', threadSafety: 'unsafe' }));
    await flush();
    expect(c.inFlight).toHaveLength(1);
  });

  it('runs a `full` plugin concurrently, and coalesces nothing', async () => {
    const c = controllable();
    const s = new NativeScheduler(c.dispatch);
    const a = s.submit(job({ instanceId: 'a', threadSafety: 'full' }));
    const b = s.submit(job({ instanceId: 'a', threadSafety: 'full' }));
    await flush();
    // Two calls in flight on ONE instance: a `full` lane is unique per job, so
    // there is nothing to supersede and nothing about to be wasted.
    expect(c.inFlight).toHaveLength(2);
    c.ok(); c.ok();
    await expect(a).resolves.toMatchObject({ ok: true });
    await expect(b).resolves.toMatchObject({ ok: true });
  });

  it('holds the overall concurrency ceiling', async () => {
    const c = controllable();
    const s = new NativeScheduler(c.dispatch, 2);
    for (let i = 0; i < 5; i += 1) void s.submit(job({ instanceId: `i${i}`, threadSafety: 'full' }));
    await flush();
    expect(c.inFlight).toHaveLength(2);
  });
});

describe('export mode', () => {
  it('stops dropping anything', async () => {
    const c = controllable();
    const s = new NativeScheduler(c.dispatch);
    s.setExactMode(true);

    void s.submit(job());
    await flush();
    const second = s.submit(job());
    const third = s.submit(job());

    c.ok();
    await flush();
    c.ok();
    await flush();
    c.ok();
    // Every frame is the one that matters, so nothing resolved null.
    await expect(second).resolves.toMatchObject({ ok: true });
    await expect(third).resolves.toMatchObject({ ok: true });
  });

  it('settles when the queue drains, and names what did not land in time', async () => {
    jest.useFakeTimers();
    try {
      const c = controllable();
      const s = new NativeScheduler(c.dispatch);
      s.setExactMode(true);
      void s.submit(job({ instanceId: 'slow-layer' }));
      await flush();

      const settling = s.settle(500);
      jest.advanceTimersByTime(501);
      // The same shape `settleGenerators` returns, so the export loop can turn
      // both into layer diagnostics without knowing which tier was slow.
      await expect(settling).resolves.toEqual(['slow-layer']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('settles immediately when there is nothing outstanding', async () => {
    const s = new NativeScheduler(controllable().dispatch);
    await expect(s.settle(10)).resolves.toEqual([]);
  });
});

describe('the budget', () => {
  it('benches a plugin that overran, and skips it rather than waiting', async () => {
    let clock = 0;
    const dispatch = (): Promise<NativeCallOutcome> => {
      clock += NATIVE_PREVIEW_BUDGET_MS + 10;
      return Promise.resolve({ ok: true, result: { call: 'invoke', result: null }, elapsedMs: 0 });
    };
    const s = new NativeScheduler(dispatch, 4, () => clock);

    await s.submit(job());
    expect(s.benched('studio.acme.fx')).toBe(true);
    // Skipped, not queued: the playhead keeps moving and the effect falls back.
    await expect(s.submit(job())).resolves.toBeNull();

    clock += NATIVE_BUDGET_COOLDOWN_MS + 1;
    expect(s.benched('studio.acme.fx')).toBe(false);
  });

  it('never benches anyone during an export', async () => {
    let clock = 0;
    const dispatch = (): Promise<NativeCallOutcome> => {
      clock += 5000;
      return Promise.resolve({ ok: true, result: { call: 'invoke', result: null }, elapsedMs: 0 });
    };
    const s = new NativeScheduler(dispatch, 4, () => clock);
    s.setExactMode(true);
    await s.submit(job());
    // A plugin too slow for a preview is not too slow for a file — and an
    // export that silently used the fallback would produce a different picture
    // from the one the user approved in the viewport.
    expect(s.benched('studio.acme.fx')).toBe(false);
    await expect(s.submit(job())).resolves.toMatchObject({ ok: true });
  });

  it('un-benches everyone when an export starts', async () => {
    let clock = 0;
    const s = new NativeScheduler(
      () => { clock += 1000; return Promise.resolve({ ok: true, result: { call: 'invoke', result: null }, elapsedMs: 0 }); },
      4,
      () => clock,
    );
    await s.submit(job());
    expect(s.benched('studio.acme.fx')).toBe(true);
    s.setExactMode(true);
    expect(s.benched('studio.acme.fx')).toBe(false);
  });
});

describe('failures', () => {
  it('collects them for the export gate, and drains the list when taken', async () => {
    const s = new NativeScheduler(() =>
      Promise.resolve({ ok: false, code: 'crashed', error: 'the process stopped' }));
    await s.submit(job({ instanceId: 'layer-3' }));
    expect(s.takeErrors()).toEqual([
      { pluginId: 'studio.acme.fx', instanceId: 'layer-3', message: 'the process stopped' },
    ]);
    // Drained: a list that is not would answer "did anything fail while I built
    // THIS frame" wrongly for every frame after the first.
    expect(s.takeErrors()).toEqual([]);
  });

  it('turns a dispatch that threw into an outcome, not a rejection', async () => {
    const s = new NativeScheduler(() => { throw new Error('the bridge is gone'); });
    await expect(s.submit(job())).resolves.toMatchObject({ ok: false, code: 'failed' });
  });

  it('drops a plugin\'s queued work when it is unloaded', async () => {
    const c = controllable();
    const s = new NativeScheduler(c.dispatch);
    void s.submit(job());
    await flush();
    const queued = s.submit(job());
    s.forget('studio.acme.fx');
    await expect(queued).resolves.toBeNull();
  });
});
