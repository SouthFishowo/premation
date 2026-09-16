/**
 * Ownership of a pixel buffer, at each moment.
 *
 * The bug being made impossible: a transferred `ArrayBuffer` is DETACHED, and
 * reading a view over it yields a zero-length array rather than an error. The
 * picture goes black, in one effect, on some frames, and nothing anywhere says
 * why — a lifetime bug that presents as a rendering bug three layers away.
 *
 * So the rule is checked rather than documented, and it is checked on the
 * BUFFER rather than on the view: a second view over the same memory is the
 * same bytes, and reading it after a transfer is the same bug wearing a
 * different object.
 */

import {
  BufferHandoffError,
  assertReadable,
  collectTransfers,
  handOff,
  isHandedOff,
  reclaim,
  reclaimAll,
  shareBuffer,
} from './nativeBuffers';

describe('handing a buffer over', () => {
  it('marks it, and reading it afterwards throws by name', () => {
    const pixels = new Uint8ClampedArray(16);
    handOff(pixels);
    expect(isHandedOff(pixels)).toBe(true);
    expect(() => assertReadable(pixels, 'acme.fx input')).toThrow(BufferHandoffError);
    expect(() => assertReadable(pixels, 'acme.fx input')).toThrow(/acme\.fx input/);
  });

  it('catches a SECOND view over the same memory', () => {
    const buffer = new ArrayBuffer(16);
    const a = new Uint8ClampedArray(buffer);
    const b = new Float32Array(buffer);
    handOff(a);
    expect(() => assertReadable(b, 'the other view')).toThrow(BufferHandoffError);
  });

  it('is readable again once the answer comes back', () => {
    const pixels = new Uint8ClampedArray(16);
    handOff(pixels);
    reclaim(pixels);
    expect(() => assertReadable(pixels, 'x')).not.toThrow();
  });

  it('says so when something transferred the memory WITHOUT telling this module', () => {
    // A real detach shows up as a zero-length buffer on a view that had one.
    // Worth its own message: it means the bookkeeping was bypassed, which is
    // the same bug with nothing recording it.
    const detached = new Uint8ClampedArray(0);
    expect(() => assertReadable(detached, 'acme.fx output')).toThrow(/transferred elsewhere/);
  });
});

describe('collecting what a request hands over', () => {
  it('finds buffers nested anywhere in the request', () => {
    const pixels = new Uint8ClampedArray(8);
    const neighbour = new Uint8ClampedArray(8);
    const list = collectTransfers({
      call: 'effect',
      pixels,
      params: { amount: 3 },
      neighbours: [{ offset: -1, pixels: neighbour }],
    });
    expect(list).toHaveLength(2);
    // Marked as well as listed — the two must never be able to disagree, which
    // is the whole reason this is one function and not two.
    expect(isHandedOff(pixels)).toBe(true);
    expect(isHandedOff(neighbour)).toBe(true);
  });

  it('lists a shared buffer once', () => {
    const shared = new ArrayBuffer(8);
    const a = new Uint8ClampedArray(shared);
    const list = collectTransfers({ a, b: new Float32Array(shared) });
    expect(list).toEqual([shared]);
  });

  it('takes ownership back of everything in a response', () => {
    const out = { call: 'effect', pixels: new Uint8ClampedArray(8) };
    collectTransfers(out);
    reclaimAll(out);
    expect(isHandedOff(out.pixels)).toBe(false);
  });

  it('walks a plain value without finding anything to hand over', () => {
    expect(collectTransfers({ method: 'open', payload: 'file.mov' })).toEqual([]);
    expect(collectTransfers(null)).toEqual([]);
  });
});

describe('the shared-memory escape hatch', () => {
  it('copies into shared memory where the runtime has it, and answers null where it does not', () => {
    const source = new Uint8ClampedArray([1, 2, 3, 4]);
    const shared = shareBuffer(source);
    if (shared === null) {
      // No SharedArrayBuffer without cross-origin isolation. A caller has to
      // handle that, which is why this returns null instead of throwing.
      expect(typeof (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer).not.toBe('function');
      return;
    }
    expect([...shared]).toEqual([1, 2, 3, 4]);
    expect(shared.buffer).not.toBe(source.buffer);
  });
});
