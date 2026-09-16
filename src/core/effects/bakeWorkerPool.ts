/**
 * A small pool of bake workers with LATEST-WINS coalescing per lane.
 *
 * ── The scheduling contract ────────────────────────────────────────────────
 *
 * A LANE is one texture key (`asset:<layerId>`). Within a lane:
 *
 *   • At most ONE job runs at a time. A second submit while one is running
 *     waits in the queue rather than racing it — two bakes of the same layer
 *     finishing out of order is the stale-frame bug this pool must not create.
 *   • At most ONE job waits. Submitting while a job is already queued REPLACES
 *     it, and the replaced submit resolves `null` without ever running: a
 *     scrub or a slider drag produces far more requests than any machine can
 *     bake, and only the newest is worth the work.
 *   • A job that was already RUNNING is not cancelled — a kernel cannot be
 *     interrupted mid-loop — and resolves with `superseded: true` when a newer
 *     submit arrived meanwhile. Callers decide what that means: an image entry
 *     discards it (a newer entry is already baking), a playing video SHOWS it
 *     when it is still newer than the frame on screen, because under sustained
 *     playback slower than the bake every job is superseded by the time it
 *     lands, and dropping them all would freeze the picture.
 *
 * Lanes are otherwise independent, so N layers bake on N workers at once.
 *
 * ── Failure ────────────────────────────────────────────────────────────────
 *
 * Input buffers are TRANSFERRED to the worker, so a job cannot be re-run
 * locally once posted. A job that fails rejects, and the caller takes its own
 * main-thread path from the source it still holds. A worker that fails to load
 * or crashes is dropped; with none left the pool runs queued jobs through
 * `runLocal` so nothing already submitted is lost.
 */

import type { BakeJobInput, BakeRequestMessage, BakeResponseMessage } from './bakeWorkerCore';
import { runBakeJob } from './bakeWorkerCore';

/** The part of `Worker` the pool uses — a seam for tests. */
export interface BakeWorkerLike {
  postMessage(msg: BakeRequestMessage, transfer: Transferable[]): void;
  onmessage: ((ev: { data: BakeResponseMessage }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  terminate(): void;
}

export type BakeWorkerSpawner = () => Promise<BakeWorkerLike | null>;

/** A landed bake. `superseded`: a newer job was submitted to this lane while it ran. */
export interface BakeOutcome {
  pixels: Uint8ClampedArray;
  superseded: boolean;
}

interface Task {
  id: number;
  lane: string;
  job: BakeJobInput;
  resolve: (r: BakeOutcome | null) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: BakeWorkerLike;
  task: Task | null;
}

export class BakeScheduler {
  private seq = 0;
  private readonly queue: Task[] = [];
  private readonly latest = new Map<string, number>();
  private readonly busyLanes = new Set<string>();
  private slots: Slot[] = [];
  private spawning: Promise<void> | null = null;
  /** Every spawn failed or every worker died — run jobs locally from here on. */
  private dead = false;

  constructor(
    private readonly spawn: BakeWorkerSpawner,
    private readonly size: number,
    private readonly runLocal: (job: BakeJobInput) => Uint8ClampedArray,
  ) {}

  /** Jobs submitted and not yet resolved (queued + running). */
  pendingCount(): number {
    return this.queue.length + this.slots.filter((s) => s.task).length;
  }

  submit(lane: string, job: BakeJobInput): Promise<BakeOutcome | null> {
    const id = ++this.seq;
    this.latest.set(lane, id);
    return new Promise<BakeOutcome | null>((resolve, reject) => {
      const queuedAt = this.queue.findIndex((t) => t.lane === lane);
      const task: Task = { id, lane, job, resolve, reject };
      if (queuedAt >= 0) {
        // Replace in place: the lane keeps its turn, the old request never runs.
        this.queue[queuedAt]!.resolve(null);
        this.queue[queuedAt] = task;
      } else {
        this.queue.push(task);
      }
      void this.ensureWorkers().then(() => this.pump());
    });
  }

  dispose(): void {
    for (const s of this.slots) {
      try { s.worker.terminate(); } catch { /* already gone */ }
      s.task?.reject(new Error('bake pool disposed'));
    }
    this.slots = [];
    for (const t of this.queue.splice(0)) t.resolve(null);
    this.busyLanes.clear();
  }

  private ensureWorkers(): Promise<void> {
    if (this.dead || this.slots.length > 0) return Promise.resolve();
    if (!this.spawning) {
      this.spawning = (async (): Promise<void> => {
        for (let i = 0; i < this.size; i++) {
          let w: BakeWorkerLike | null = null;
          try { w = await this.spawn(); } catch { w = null; }
          if (!w) break;
          this.attach(w);
        }
        if (this.slots.length === 0) this.dead = true;
        this.spawning = null;
      })();
    }
    return this.spawning;
  }

  private attach(worker: BakeWorkerLike): void {
    const slot: Slot = { worker, task: null };
    worker.onmessage = (ev): void => {
      const task = slot.task;
      if (!task || ev.data.id !== task.id) return;
      slot.task = null;
      this.busyLanes.delete(task.lane);
      const msg = ev.data;
      if (msg.ok) task.resolve({ pixels: msg.pixels, superseded: this.latest.get(task.lane) !== task.id });
      else task.reject(new Error(msg.error));
      this.pump();
    };
    worker.onerror = (): void => {
      // A load or runtime failure: this worker is gone. Its in-flight job's
      // input was transferred away, so it can only fail; queued work moves on.
      const task = slot.task;
      slot.task = null;
      this.slots = this.slots.filter((s) => s !== slot);
      try { worker.terminate(); } catch { /* already gone */ }
      if (task) {
        this.busyLanes.delete(task.lane);
        task.reject(new Error('bake worker error'));
      }
      if (this.slots.length === 0) this.dead = true;
      this.pump();
    };
    this.slots.push(slot);
  }

  private pump(): void {
    if (this.dead) {
      // Nothing left to post to: run what is queued here, in order.
      for (const task of this.queue.splice(0)) {
        try {
          task.resolve({ pixels: this.runLocal(task.job), superseded: this.latest.get(task.lane) !== task.id });
        } catch (err) {
          task.reject(err);
        }
      }
      return;
    }
    for (const slot of this.slots) {
      if (slot.task) continue;
      const at = this.queue.findIndex((t) => !this.busyLanes.has(t.lane));
      if (at < 0) return;
      const [task] = this.queue.splice(at, 1);
      slot.task = task!;
      this.busyLanes.add(task!.lane);
      const px = task!.job.pixels;
      // Transfer only a buffer the view owns outright; a view into a larger
      // buffer would detach bytes that are not the job's.
      const own = px.byteOffset === 0 && px.byteLength === px.buffer.byteLength
        ? px
        : new Uint8ClampedArray(px);
      const job: BakeJobInput = own === px ? task!.job : { ...task!.job, pixels: own };
      try {
        slot.worker.postMessage({ id: task!.id, job }, [own.buffer as ArrayBuffer]);
      } catch (err) {
        // Uncloneable params (a function smuggled into an effect) — fail THIS job.
        slot.task = null;
        this.busyLanes.delete(task!.lane);
        task!.reject(err);
      }
    }
  }
}

// ── The app's pool ──────────────────────────────────────────────────────────

let shared: BakeScheduler | null | undefined;

/**
 * Where workers exist — Chromium/Electron — the shared pool; null elsewhere
 * (jsdom, a browser without OffscreenCanvas), which callers read as "bake on
 * the main thread as before".
 */
export function bakeScheduler(): BakeScheduler | null {
  if (shared !== undefined) return shared;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    shared = null;
    return shared;
  }
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  // Leave the main thread and the compositor a core each; four is enough to
  // bake every visible styled layer of a typical comp in parallel.
  const size = Math.max(1, Math.min(4, cores - 2));
  shared = new BakeScheduler(
    async () => {
      const { spawnBakeWorker } = await import('./spawnBakeWorker');
      return spawnBakeWorker() as unknown as BakeWorkerLike;
    },
    size,
    (job) => {
      // Reached only when every worker failed to load: the same job function,
      // on this thread.
      return runBakeJob(job, (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      });
    },
  );
  return shared;
}

/** Test seam: install a scheduler (or null for "no workers"); undefined resets. */
export function setBakeSchedulerForTests(s: BakeScheduler | null | undefined): void {
  shared = s;
}
