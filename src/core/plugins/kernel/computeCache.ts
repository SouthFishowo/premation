/**
 * The compute cache a kernel precomputes into, bounded and least-recently-used.
 *
 * ── What it is for ───────────────────────────────────────────────────────────
 *
 * The work that does not depend on the pixels: the weights of a blur kernel,
 * a 3D lookup table built from a curve, a noise field. Without somewhere to put
 * it, every frame of a scrub rebuilds a table the parameters did not change —
 * which for a 32³ LUT is more time than the actual filtering.
 *
 * ── Why a BUDGET and not a count ─────────────────────────────────────────────
 *
 * The entries are not comparable. One is 64 floats, the next is a 2 MB field,
 * and a cache of "the last 8 entries" holds either half a kilobyte or sixteen
 * megabytes depending on which effect the user reached for. Bytes is the thing
 * that actually runs out, so bytes is what is counted.
 *
 * A kernel that keys its cache on something unstable — the time, say — fills
 * the budget and evicts itself every frame. That degrades to "no cache", which
 * is exactly what it should: slower, correct, and bounded. The alternative, an
 * unbounded map, is a leak that only shows up in a long session.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 *
 * One of these per effect INSTANCE per worker. Not per effect type: two copies
 * of one effect with different parameters would fight over the same keys and
 * rebuild alternately, which is slower than no cache. Not shared between
 * workers either — there is no shared memory here, and copying an entry between
 * workers would cost more than rebuilding it.
 */

import type { KernelComputeCache } from './kernelTypes';

/** The default a kernel gets when its manifest asks for nothing in particular. */
export const DEFAULT_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;

/** A ceiling on what a manifest may ask for. Workers are not free memory. */
export const MAX_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

interface Entry {
  value: unknown;
  bytes: number;
}

export class ComputeCache implements KernelComputeCache {
  /** Insertion order IS the recency order — see `get`. */
  private readonly entries = new Map<string, Entry>();
  private used = 0;

  constructor(private readonly budgetBytes: number = DEFAULT_CACHE_BUDGET_BYTES) {}

  get(key: string): unknown {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    // Re-inserted, which moves it to the end of the Map's iteration order. That
    // order is the whole LRU implementation: eviction takes the first key,
    // which is by construction the one untouched longest.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: unknown, bytes?: number): void {
    const size = bytes ?? estimateBytes(value);
    const previous = this.entries.get(key);
    if (previous) this.used -= previous.bytes;
    this.entries.delete(key);

    /*
      An entry larger than the whole budget is not stored.

      Storing it would evict everything else and then immediately be evicted
      itself by the next `set`, so the cache would hold exactly one enormous
      thing and thrash. Refusing it is the honest answer: the kernel recomputes,
      which is what it was doing before it asked.
    */
    if (size > this.budgetBytes) return;

    this.entries.set(key, { value, bytes: size });
    this.used += size;

    while (this.used > this.budgetBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.used -= evicted.bytes;
    }
  }

  /** Bytes currently held. Diagnostics and tests; nothing in the path reads it. */
  get sizeBytes(): number {
    return this.used;
  }

  get count(): number {
    return this.entries.size;
  }
}

/**
 * A size for a value the kernel did not measure.
 *
 * Deliberately crude, and only ever used as a budget input: a wrong estimate
 * makes the cache hold more or less than intended, never anything incorrect.
 * Typed arrays — which is what nearly every entry actually is — are exact.
 */
export function estimateBytes(value: unknown): number {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === 'string') return value.length * 2;
  if (Array.isArray(value)) {
    // Sampled rather than walked: a million-element array of numbers is 8 MB
    // and walking it to find that out costs more than the entry saves.
    const sample = value.length > 0 ? estimateBytes(value[0]) : 8;
    return Math.max(8, sample) * value.length;
  }
  if (value && typeof value === 'object') {
    let n = 32;
    for (const v of Object.values(value)) n += 16 + estimateBytes(v);
    return n;
  }
  return 8;
}

/** Caches held per effect instance inside ONE worker (or the main thread). */
export class ComputeCacheStore {
  private readonly byInstance = new Map<string, ComputeCache>();

  for(instanceId: string, budgetBytes?: number): ComputeCache {
    let cache = this.byInstance.get(instanceId);
    if (!cache) {
      cache = new ComputeCache(Math.min(budgetBytes ?? DEFAULT_CACHE_BUDGET_BYTES, MAX_CACHE_BUDGET_BYTES));
      this.byInstance.set(instanceId, cache);
    }
    return cache;
  }

  /** Dropped when an effect is removed or its plugin disabled. */
  forget(instanceId: string): void {
    this.byInstance.delete(instanceId);
  }

  clear(): void {
    this.byInstance.clear();
  }

  get instanceCount(): number {
    return this.byInstance.size;
  }
}
