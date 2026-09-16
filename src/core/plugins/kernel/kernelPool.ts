/**
 * The kernel worker pool: the bake pool's scheduling contract, with LANES that
 * come from the plugin's declared thread safety.
 *
 * ── The scheduling contract (unchanged from `bakeWorkerPool`) ────────────────
 *
 * Within one LANE:
 *
 *   • At most ONE job runs at a time. A second submit while one is running
 *     waits rather than racing it — two kernels of the same layer finishing out
 *     of order is a stale frame on screen.
 *   • At most ONE job waits. Submitting while a job is already queued REPLACES
 *     it, and the replaced submit resolves `null` without running: a scrub or a
 *     slider drag produces far more requests than any machine can service, and
 *     only the newest is worth the work.
 *   • A running job is not cancelled — a kernel cannot be interrupted mid-loop —
 *     and resolves with `superseded: true` when a newer submit arrived while it
 *     ran. The caller decides what that means: a preview shows it if it is
 *     still newer than what is on screen, an export waits for the exact frame.
 *
 * Lanes are otherwise independent, so N lanes run on N workers at once.
 *
 * ── What is NEW here: where a lane comes from ────────────────────────────────
 *
 * The bake pool's lane is a texture key, because a bake is per layer. A plugin
 * kernel's lane is whatever its author's `threadSafety` declaration permits:
 *
 *   `unsafe`   → one lane per PLUGIN. Every effect of that plugin, on every
 *                layer, serialises. The author has told us their kernel keeps
 *                module-level state, and a worker pool running two copies of it
 *                at once would corrupt that state — invisibly, as one wrong
 *                frame in a hundred, which is unreportable.
 *   `instance` → one lane per effect INSTANCE (the default). Two layers
 *                carrying the same effect run in parallel; one layer's frames
 *                stay in order, which is what makes latest-wins meaningful.
 *   `full`     → a lane per JOB: nothing is serialised, including successive
 *                frames of one instance.
 *
 * ★ `full` deliberately does NOT get latest-wins coalescing, and that is the
 * one place this differs from the bake pool in kind rather than in naming. The
 * coalescing exists because a lane can only run one job at a time, so the
 * queued ones are stale by definition. A `full` effect has no such queue — its
 * jobs run concurrently — so dropping all but the newest would throw away work
 * that was about to be done anyway. An export, which submits one frame at a
 * time and awaits it, is unaffected either way.
 */

import type { ThreadSafety } from '../effectSchema';
import type { KernelJob, KernelRequestMessage, KernelResponseMessage } from './kernelTypes';
import { runKernelJob } from './kernelWorkerCore';

/** The part of `Worker` the pool uses — a seam for tests. */
export interface KernelWorkerLike {
  postMessage(msg: KernelRequestMessage, transfer: Transferable[]): void;
  onmessage: ((ev: { data: KernelResponseMessage }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  terminate(): void;
}

export type KernelWorkerSpawner = () => Promise<KernelWorkerLike | null>;

export interface KernelOutcome {
  pixels: Uint8ClampedArray;
  /** A newer job was submitted to this lane while this one ran. */
  superseded: boolean;
}

/**
 * The lane a job runs in, from the effect's declared thread safety.
 *
 * Exported because the scheduling rule is the interesting half of the
 * declaration and a test that cannot see it can only observe timing.
 */
export function laneFor(
  safety: ThreadSafety | undefined,
  pluginId: string,
  instanceId: string,
  jobSeq: number,
): string {
  switch (safety) {
    case 'unsafe': return `plugin:${pluginId}`;
    case 'full': return `job:${jobSeq}`;
    default: return `instance:${instanceId}`;
  }
}

interface Task {
  id: number;
  lane: string;
  job: KernelJob;
  /** `full` lanes are unique per job, so nothing can supersede them. */
  coalesce: boolean;
  resolve: (r: KernelOutcome | null) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Slot {
  worker: KernelWorkerLike;
  task: Task | null;
}

/**
 * How long a worker may sit on one job before it is presumed hung.
 *
 * A kernel cannot be interrupted from inside — JavaScript has no preemption and
 * a WASM instance has no fuel unless it opted in — so the only way to recover a
 * runaway kernel is to destroy the thread running it. That is what this does:
 * the job rejects, the worker is terminated and replaced, and the frame goes
 * out with the layer unchanged.
 */
export const KERNEL_TIMEOUT_MS = 8000;

export class KernelScheduler {
  private seq = 0;
  private readonly queue: Task[] = [];
  private readonly latest = new Map<string, number>();
  private readonly busyLanes = new Set<string>();
  private slots: Slot[] = [];
  private spawning: Promise<void> | null = null;
  /** Every spawn failed or every worker died — run jobs here from now on. */
  private dead = false;

  constructor(
    private readonly spawn: KernelWorkerSpawner,
    private readonly size: number,
  ) {}

  /** Jobs submitted and not yet resolved (queued + running). */
  pendingCount(): number {
    return this.queue.length + this.slots.filter((s) => s.task).length;
  }

  submit(lane: string, job: KernelJob, options: { coalesce?: boolean } = {}): Promise<KernelOutcome | null> {
    const id = ++this.seq;
    const coalesce = options.coalesce !== false;
    this.latest.set(lane, id);
    return new Promise<KernelOutcome | null>((resolve, reject) => {
      const task: Task = { id, lane, job, coalesce, resolve, reject, timer: null };
      const queuedAt = coalesce ? this.queue.findIndex((t) => t.lane === lane) : -1;
      if (queuedAt >= 0) {
        // Replaced in place: the lane keeps its turn, the old request never runs.
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
      if (s.task?.timer) clearTimeout(s.task.timer);
      s.task?.reject(new Error('kernel pool disposed'));
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
          let w: KernelWorkerLike | null = null;
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

  private attach(worker: KernelWorkerLike): void {
    const slot: Slot = { worker, task: null };
    worker.onmessage = (ev): void => {
      const task = slot.task;
      if (!task || ev.data.id !== task.id) return;
      if (task.timer) clearTimeout(task.timer);
      slot.task = null;
      this.busyLanes.delete(task.lane);
      const msg = ev.data;
      if (msg.ok) task.resolve({ pixels: msg.pixels, superseded: this.latest.get(task.lane) !== task.id });
      else task.reject(new Error(msg.error));
      this.pump();
    };
    worker.onerror = (): void => this.dropSlot(slot, new Error('kernel worker error'));
    this.slots.push(slot);
  }

  /** A worker died or hung. Drop it, fail its job, and keep the queue moving. */
  private dropSlot(slot: Slot, why: Error): void {
    const task = slot.task;
    if (task?.timer) clearTimeout(task.timer);
    slot.task = null;
    this.slots = this.slots.filter((s) => s !== slot);
    try { slot.worker.terminate(); } catch { /* already gone */ }
    if (task) {
      this.busyLanes.delete(task.lane);
      task.reject(why);
    }
    /*
      NOT marked dead on a hang.

      A worker terminated for running past the budget says something about the
      KERNEL, not about whether workers exist on this machine — and `dead` means
      the latter, which routes every future job onto the main thread. Doing that
      here would let one runaway effect move every other plugin's kernels onto
      the render thread, where a second runaway freezes the editor outright.
    */
    if (this.slots.length === 0 && this.spawning === null) {
      // Nothing left to post to. The next submit spawns again; `ensureWorkers`
      // only re-spawns from an empty pool, which this now is.
      this.slots = [];
    }
    this.pump();
  }

  private pump(): void {
    if (this.dead) {
      /*
        No workers at all — run what is queued here, in order.

        `runKernelJob` is the SAME function the worker calls, so the fallback
        cannot drift from the real path. It is async, unlike the bake pool's
        local path, because loading a module is: a job here still resolves in
        order because each is awaited before the next is started.
      */
      const queued = this.queue.splice(0);
      void (async (): Promise<void> => {
        for (const task of queued) {
          try {
            const pixels = await runKernelJob(task.job);
            task.resolve({ pixels, superseded: this.latest.get(task.lane) !== task.id });
          } catch (err) {
            task.reject(err);
          }
        }
      })();
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
      const job: KernelJob = own === px ? task!.job : { ...task!.job, pixels: own };
      const transfer: Transferable[] = [own.buffer as ArrayBuffer];
      for (const n of job.neighbours ?? []) {
        if (n.pixels.byteOffset === 0 && n.pixels.byteLength === n.pixels.buffer.byteLength) {
          transfer.push(n.pixels.buffer as ArrayBuffer);
        }
      }
      try {
        slot.worker.postMessage({ id: task!.id, job }, transfer);
        task!.timer = setTimeout(() => this.dropSlot(slot, new Error(
          `The kernel did not finish within ${KERNEL_TIMEOUT_MS} ms and was stopped.`,
        )), KERNEL_TIMEOUT_MS);
      } catch (err) {
        // Uncloneable params (a function smuggled into a parameter) — fail THIS job.
        slot.task = null;
        this.busyLanes.delete(task!.lane);
        task!.reject(err);
      }
    }
  }
}

// ── The app's pool ──────────────────────────────────────────────────────────

let shared: KernelScheduler | null | undefined;

/**
 * The shared pool where workers exist; null elsewhere (jsdom, a browser without
 * them), which callers read as "run the kernel on this thread".
 */
export function kernelScheduler(): KernelScheduler | null {
  if (shared !== undefined) return shared;
  if (typeof Worker === 'undefined') {
    shared = null;
    return shared;
  }
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;
  // The same sizing as the bake pool, and for the same reason: leave the main
  // thread and the compositor a core each. The two pools can be busy at once,
  // which is why neither takes more than four.
  const size = Math.max(1, Math.min(4, cores - 2));
  shared = new KernelScheduler(async () => {
    const { spawnKernelWorker } = await import('./spawnKernelWorker');
    return spawnKernelWorker() as unknown as KernelWorkerLike;
  }, size);
  return shared;
}

/** Test seam: install a scheduler (or null for "no workers"); undefined resets. */
export function setKernelSchedulerForTests(s: KernelScheduler | null | undefined): void {
  shared = s;
}
