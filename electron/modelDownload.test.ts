/**
 * The Object Matte model download proxy.
 *
 * Two behaviours carry the channel's whole safety story, and both are pinned
 * here: which URLs it will touch at all (`checkModelUrl` is a closed predicate,
 * not a formality), and the refusal to buffer more than the cap however the
 * server describes itself — a header is a claim, the stream is the truth.
 */

/*
  `electron` is mocked because IMPORTING it is what breaks, not calling it —
  see ipcRegistration.test.ts for the full story. This suite only exercises
  the pure pieces; the IPC wiring goes through ipcGuard like every other
  channel and is covered by that suite's source sweep.
*/
jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

import { checkModelUrl, downloadModelBytes } from './modelDownload';

/** A Response-shaped stub whose body streams `chunks`. */
function stubResponse(
  chunks: Uint8Array[],
  opts: { ok?: boolean; status?: number; contentLength?: number | null } = {},
): unknown {
  const { ok = true, status = 200, contentLength = null } = opts;
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Teapot',
    headers: { get: (name: string) => (name === 'content-length' && contentLength !== null ? String(contentLength) : null) },
    body: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('checkModelUrl', () => {
  it.each([
    [undefined, /required/i],
    ['', /required/i],
    ['not a url', /not a valid URL/i],
    ['http://example.test/model.onnx', /https/],
    ['https://localhost/model.onnx', /public host/i],
    ['https://models.localhost/model.onnx', /public host/i],
    ['https://nas.local/model.onnx', /public host/i],
    ['https://192.168.1.5/model.onnx', /IP address/i],
    ['https://[::1]/model.onnx', /IP address/i],
  ])('refuses %p', (url, message) => {
    expect(checkModelUrl(url)).toMatch(message as RegExp);
  });

  it('accepts a plain https host', () => {
    expect(checkModelUrl('https://huggingface.co/x/resolve/main/model.onnx')).toBeNull();
  });
});

describe('downloadModelBytes', () => {
  const signal = new AbortController().signal;

  it('streams the body into one buffer and reports progress', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    global.fetch = jest.fn(async () => stubResponse(chunks, { contentLength: 5 })) as unknown as typeof fetch;

    const seen: Array<[number, number | null]> = [];
    const result = await downloadModelBytes('https://example.test/m.onnx', signal, (r, t) => seen.push([r, t]));

    expect(result.ok).toBe(true);
    expect(result.ok && Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5]);
    // At least the first chunk and the completion are reported, with the total.
    expect(seen[0]).toEqual([3, 5]);
    expect(seen[seen.length - 1]).toEqual([5, 5]);
  });

  it('refuses a declared size over the cap before reading any body', async () => {
    global.fetch = jest.fn(async () =>
      stubResponse([new Uint8Array(8)], { contentLength: 600 * 1024 * 1024 }),
    ) as unknown as typeof fetch;

    const result = await downloadModelBytes('https://example.test/huge.onnx', signal, () => undefined);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/larger than/);
  });

  it('stops a stream that exceeds the cap without ever declaring a length', async () => {
    // A server that reports no length can still send gigabytes; the header
    // check alone would wave this through.
    const big = new Uint8Array(64 * 1024 * 1024);
    global.fetch = jest.fn(async () =>
      stubResponse(Array.from({ length: 9 }, () => big)),
    ) as unknown as typeof fetch;

    const result = await downloadModelBytes('https://example.test/endless.onnx', signal, () => undefined);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/exceeded/);
  });

  it('reports a refusing host by its status', async () => {
    global.fetch = jest.fn(async () => stubResponse([], { ok: false, status: 404 })) as unknown as typeof fetch;

    const result = await downloadModelBytes('https://example.test/gone.onnx', signal, () => undefined);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/404/);
  });

  it('answers an abort as a cancellation, not an error', async () => {
    global.fetch = jest.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    const result = await downloadModelBytes('https://example.test/m.onnx', signal, () => undefined);
    expect(result).toEqual({ ok: false, message: 'Cancelled.' });
  });
});
