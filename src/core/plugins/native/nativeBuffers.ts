/**
 * Who owns a pixel buffer, at each moment.
 *
 * ── The bug this exists to make impossible ───────────────────────────────────
 *
 * A frame of 4K RGBA is 33 MB. Copying it twice per effect per frame is the
 * difference between a native fast path being worth having and not, so the
 * buffers are HANDED OVER rather than copied wherever the platform allows it —
 * `postMessage` with a transfer list, between the main process and the plugin's
 * own process.
 *
 * Transfer detaches the sender's view. Reading it afterwards yields a
 * zero-length array, not an error: the picture goes black, in one effect, on
 * some frames, and nothing anywhere says why. That is the single worst failure
 * mode in this whole tier, because it looks like a rendering bug and is
 * actually a lifetime bug three layers away.
 *
 * So ownership is explicit and it is CHECKED. A buffer that has been handed
 * over is marked; reading it through this module throws a named error naming
 * the plugin and the call. The cost is a WeakSet lookup on a path that was
 * about to copy megabytes.
 *
 * ── What is and is not zero-copy, stated honestly ────────────────────────────
 *
 * Renderer → main is `ipcRenderer.invoke`, which structured-CLONES. There is no
 * transfer list on that hop and no amount of API design adds one, so the first
 * copy is real and unavoidable unless the buffer is a `SharedArrayBuffer` (see
 * below). Main → the plugin's process IS a transfer, and so is the way back.
 *
 * The result: one copy in each direction rather than three, and the ownership
 * rule holds on both hops — the renderer must not read a buffer it handed over
 * either, because the buffer it handed over is about to be replaced by the one
 * that comes back and a caller reading the stale one gets the frame before.
 *
 * `SharedArrayBuffer` would remove the remaining copy, and is deliberately not
 * used by default: it requires cross-origin isolation on the renderer, which
 * changes headers for the whole app, and it removes the detach that makes a
 * use-after-transfer detectable at all. It is available behind
 * `shareBuffer()` for a caller that has measured and wants it.
 */

/** Thrown when a buffer is read after it was handed to a plugin process. */
export class BufferHandoffError extends Error {
  constructor(what: string) {
    super(
      `${what} was read after it was handed to a plugin process. The bytes belong to the `
      + 'plugin until it answers; use the buffer that comes back.',
    );
    this.name = 'BufferHandoffError';
  }
}

/**
 * Buffers currently owned by someone else.
 *
 * Keyed on the ArrayBuffer rather than on the view, because a second view over
 * the same memory is the same bytes and reading THAT after a transfer is the
 * same bug wearing a different object.
 */
const handedOff = new WeakSet<ArrayBufferLike>();

/** Marks `view`'s memory as no longer ours, and returns it for a transfer list. */
export function handOff(view: ArrayBufferView): ArrayBufferLike {
  handedOff.add(view.buffer);
  return view.buffer;
}

/** Takes ownership back — what the answer to a call does with what it returns. */
export function reclaim(view: ArrayBufferView): void {
  handedOff.delete(view.buffer);
}

export function isHandedOff(view: ArrayBufferView): boolean {
  return handedOff.has(view.buffer);
}

/**
 * Read barrier. Call before touching a buffer that may have been handed over.
 *
 * `what` is the thing a reader of the error needs: which plugin, which call.
 * "buffer detached" would be true and useless.
 */
export function assertReadable(view: ArrayBufferView, what: string): void {
  if (handedOff.has(view.buffer)) throw new BufferHandoffError(what);
  // A real detach (a genuine transfer happened) shows up as a zero-length
  // buffer on a view that used to have one. Worth catching separately: it means
  // something transferred these bytes WITHOUT going through `handOff`, which is
  // the same bug with the bookkeeping missing.
  if (view.byteLength === 0 && view.buffer.byteLength === 0) {
    throw new BufferHandoffError(`${what} (its memory was already transferred elsewhere)`);
  }
}

/**
 * Detach a buffer for real, where the platform can.
 *
 * Turns "you must not read this" into "you cannot read this". Used on the paths
 * where the copy has already been made and the original is genuinely dead —
 * the strongest version of the rule, and the one that catches a caller who
 * never asked this module anything. Returns false where `structuredClone` with
 * a transfer list is unavailable (older runtimes, and jsdom), in which case the
 * WeakSet above is the whole enforcement.
 */
export function detachBuffer(buffer: ArrayBufferLike): boolean {
  try {
    const clone = globalThis.structuredClone;
    if (typeof clone !== 'function') return false;
    // The clone is thrown away; the transfer is the point.
    clone(buffer, { transfer: [buffer as ArrayBuffer] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect the transferables in a request, marking every one.
 *
 * One place, so a call shape that grows a buffer cannot grow one that is copied
 * by accident — and so the marking and the transfer list can never disagree,
 * which is the failure that produces a detached buffer nobody recorded.
 */
export function collectTransfers(value: unknown, into: ArrayBufferLike[] = []): ArrayBufferLike[] {
  if (!value || typeof value !== 'object') return into;
  if (ArrayBuffer.isView(value)) {
    const buffer = handOff(value);
    // Once each. A transfer list with the same buffer in it twice throws
    // `DataCloneError` at `postMessage`, which would turn two views over one
    // frame — an ordinary thing for a request to carry — into a failed call.
    if (!into.includes(buffer)) into.push(buffer);
    return into;
  }
  if (value instanceof ArrayBuffer) {
    handedOff.add(value);
    if (!into.includes(value)) into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTransfers(item, into);
    return into;
  }
  for (const item of Object.values(value)) collectTransfers(item, into);
  return into;
}

/** Take ownership back of everything in a response. The mirror of the above. */
export function reclaimAll(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (ArrayBuffer.isView(value)) { reclaim(value); return; }
  if (value instanceof ArrayBuffer) { handedOff.delete(value); return; }
  if (Array.isArray(value)) {
    for (const item of value) reclaimAll(item);
    return;
  }
  for (const item of Object.values(value)) reclaimAll(item);
}

/**
 * The shared-memory escape hatch.
 *
 * Copies `view` into a `SharedArrayBuffer` so both processes address the same
 * bytes and neither transfer nor copy happens again. Returns null when the
 * runtime has no `SharedArrayBuffer` — which is every renderer that is not
 * cross-origin isolated, so a caller must handle it.
 *
 * Deliberately NOT the default path. Shared memory has no ownership at all: the
 * plugin's process can write the buffer while the compositor reads it, and the
 * torn frame that results is not reproducible. Use it for a call whose shape
 * makes the race impossible — a one-shot analysis pass over pixels nothing else
 * is touching — and not for effect rendering.
 */
export function shareBuffer(view: Uint8ClampedArray): Uint8ClampedArray | null {
  const Shared = (globalThis as { SharedArrayBuffer?: SharedArrayBufferConstructor }).SharedArrayBuffer;
  if (typeof Shared !== 'function') return null;
  try {
    const shared = new Shared(view.byteLength);
    const out = new Uint8ClampedArray(shared as unknown as ArrayBuffer);
    out.set(view);
    return out;
  } catch {
    return null;
  }
}
