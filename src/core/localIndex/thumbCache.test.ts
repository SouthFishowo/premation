/**
 * Start-screen thumbnail URLs: memoized, bounded, and revoked on eviction.
 *
 * The memo used to be an unbounded Map of object URLs that were never revoked,
 * and a re-captured project gets a new content hash — so every capture of every
 * project pinned another decoded PNG for the rest of the session.
 */

import { thumbUrl, releaseThumbUrls } from './thumbCache';

let minted = 0;
const created: string[] = [];
const revoked: string[] = [];
const read = jest.fn(async (_hash: string) => new Uint8Array([137, 80, 78, 71]));

beforeEach(() => {
  releaseThumbUrls();
  minted = 0;
  created.length = 0;
  revoked.length = 0;
  read.mockClear();
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
    const url = `blob:thumb-${minted++}`;
    created.push(url);
    return url;
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => { revoked.push(u); };
  (window as unknown as { motionEditor?: unknown }).motionEditor = { thumbs: { read, write: jest.fn() } };
});

afterAll(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('thumbUrl', () => {
  it('mints one URL per hash, even for concurrent requests', async () => {
    const [a, b] = await Promise.all([thumbUrl('h1'), thumbUrl('h1')]);
    expect(a).toBe(b);
    expect(await thumbUrl('h1')).toBe(a);
    expect(created).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('evicts the least-recently used hash past the cap and revokes its URL', async () => {
    const first = await thumbUrl('h0');
    for (let i = 1; i < 256; i++) await thumbUrl(`h${i}`);
    expect(revoked).toEqual([]);
    // Touch h0 so h1 is now the oldest.
    await thumbUrl('h0');
    await thumbUrl('h256');
    expect(revoked).toEqual(['blob:thumb-1']);
    expect(await thumbUrl('h0')).toBe(first);
    // An evicted hash is read again on demand.
    const again = await thumbUrl('h1');
    expect(again).not.toBe('blob:thumb-1');
  });

  it('releaseThumbUrls revokes everything it holds', async () => {
    await thumbUrl('a');
    await thumbUrl('b');
    releaseThumbUrls();
    expect(revoked.sort()).toEqual(['blob:thumb-0', 'blob:thumb-1']);
  });
});
