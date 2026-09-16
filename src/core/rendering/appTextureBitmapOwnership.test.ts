/**
 * AppTextureProvider closes the ImageBitmaps it stops referencing — and never
 * one that is still a texture source or a re-bake source.
 *
 * An ImageBitmap's pixels are off-heap; dropping the reference does not free
 * them in any useful time frame. The provider used to close a bitmap only when
 * an image fell out of the parked LRU, so a superseded decode, a file swap on a
 * layer, a re-bake, an offline replacement and the decoded `unbaked` source of
 * a baked image all stranded their pixels.
 *
 * The other half is the risk: an entry that replaces another INHERITS its
 * bitmap (to keep the old picture on screen while the new decode runs) and, for
 * the same file, its `unbaked` source. Closing either early would blank a layer
 * or break the next re-bake — so those cases are pinned as NOT closed.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider, type ImageLoader } from './AppTextureProvider';

type FakeBitmap = ImageBitmap & { tag: string; close: jest.Mock };

const bitmap = (tag: string): FakeBitmap =>
  ({ width: 64, height: 64, tag, close: jest.fn() }) as unknown as FakeBitmap;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function setup(loader: ImageLoader): AppTextureProvider {
  const resources = new ResourceManager(new NullBackend());
  resources.beginFrame(1);
  return new AppTextureProvider(resources, { loader });
}

describe('AppTextureProvider bitmap ownership', () => {
  it('closes a decode that was superseded before it landed, not the one that won', async () => {
    const da = deferred<ImageBitmap>();
    const db = deferred<ImageBitmap>();
    const provider = setup((src) => (src === 'blob:a' ? da.promise : db.promise));
    provider.setImage('asset:x', 'blob:a');
    provider.setImage('asset:x', 'blob:b');
    const a = bitmap('a');
    const b = bitmap('b');
    da.resolve(a);
    db.resolve(b);
    await flush();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
    expect(provider.get('asset:x')!.ready).toBe(true);
  });

  it('a file swap closes the old picture once the new one is uploaded — never the new one', async () => {
    const a = bitmap('a');
    const b = bitmap('b');
    const provider = setup(async (src) => (src === 'blob:a' ? a : b));
    provider.setImage('asset:x', 'blob:a');
    await flush();
    provider.setImage('asset:x', 'blob:b');
    // Still on screen while the new decode runs.
    expect(a.close).not.toHaveBeenCalled();
    await flush();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
  });

  it('a bake change on the same file keeps the decoded source (it is what re-bakes read)', async () => {
    const a = bitmap('a');
    const loader = jest.fn(async () => a);
    const provider = setup(loader);
    provider.setImage('asset:x', 'blob:a');
    await flush();
    provider.setImage('asset:x', 'blob:a', undefined, undefined, { effects: [], width: 64, height: 64 });
    await flush();
    expect(loader).toHaveBeenCalledTimes(1); // reused, not re-decoded
    expect(a.close).not.toHaveBeenCalled();
  });

  it('an offline replacement closes the picture it inherited', async () => {
    const a = bitmap('a');
    const provider = setup(async (src) => {
      if (src === 'blob:broken') throw new Error('404');
      return a;
    });
    provider.setImage('asset:x', 'blob:a');
    await flush();
    provider.setImage('asset:x', 'blob:broken');
    await flush();
    expect(provider.get('asset:x')!.ready).toBe(true); // colour bars
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  it('dispose closes every decoded bitmap exactly once', async () => {
    const a = bitmap('a');
    const b = bitmap('b');
    const provider = setup(async (src) => (src === 'blob:a' ? a : b));
    provider.setImage('asset:x', 'blob:a');
    provider.setImage('asset:y', 'blob:b');
    await flush();
    provider.dispose();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it('a healthy re-render of the same image closes nothing', async () => {
    const a = bitmap('a');
    const provider = setup(async () => a);
    for (let i = 0; i < 5; i++) {
      provider.setImage('asset:x', 'blob:a');
      await flush();
    }
    expect(a.close).not.toHaveBeenCalled();
  });
});
