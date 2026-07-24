import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('packaged Natural Earth border loader', () => {
  it('fetches both fixed assets concurrently, decodes little-endian indices, and caches success', async () => {
    const verticesGate = deferred<Response>();
    const indicesGate = deferred<Response>();
    const fetcher = vi.fn((input: URL | RequestInfo) =>
      requestUrl(input).endsWith('.vertices.bin') ? verticesGate.promise : indicesGate.promise,
    );
    vi.stubGlobal('fetch', fetcher);
    const { loadNaturalEarthBorders } = await import('../src/borders.js');

    const first = loadNaturalEarthBorders();
    const concurrent = loadNaturalEarthBorders();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      expect.stringMatching(/\/assets\/ne-50m-line-borders\.vertices\.bin$/),
      expect.stringMatching(/\/assets\/ne-50m-line-borders\.indices\.bin$/),
    ]);

    const vertices = new Uint8Array(48);
    vertices[0] = 17;
    verticesGate.resolve(ok(vertices.buffer));
    indicesGate.resolve(ok(indicesBuffer([0x01020304, 0xffffffff])));
    const [decoded, shared] = await Promise.all([first, concurrent]);

    expect(decoded).toBe(shared);
    expect(decoded.vertices).toBeInstanceOf(Uint8Array);
    expect(decoded.vertices).not.toBe(vertices);
    expect(decoded.vertices.byteLength).toBe(48);
    expect(decoded.vertices[0]).toBe(17);
    expect([...decoded.indices]).toEqual([0x01020304, 0xffffffff]);

    const cached = await loadNaturalEarthBorders();
    expect(cached).toBe(decoded);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('aborts only one participant without forwarding its signal or cancelling shared work', async () => {
    const verticesGate = deferred<Response>();
    const indicesGate = deferred<Response>();
    const fetcher = vi.fn((input: URL | RequestInfo) =>
      requestUrl(input).endsWith('.vertices.bin') ? verticesGate.promise : indicesGate.promise,
    );
    vi.stubGlobal('fetch', fetcher);
    const { loadNaturalEarthBorders } = await import('../src/borders.js');
    const controller = new AbortController();

    const cancelled = loadNaturalEarthBorders(controller.signal);
    const survivor = loadNaturalEarthBorders();
    const reason = new DOMException('superseded', 'AbortError');
    controller.abort(reason);

    await expect(cancelled).rejects.toBe(reason);
    expect(fetcher.mock.calls.every((call) => call.length === 1)).toBe(true);
    verticesGate.resolve(ok(new ArrayBuffer(24)));
    indicesGate.resolve(ok(indicesBuffer([0, 1])));
    const decoded = await survivor;
    expect(decoded.vertices).toBeInstanceOf(Uint8Array);
    expect(decoded.indices).toBeInstanceOf(Uint32Array);
  });

  it('rejects an already-aborted participant without starting a request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { loadNaturalEarthBorders } = await import('../src/borders.js');
    const controller = new AbortController();
    controller.abort();

    await expect(loadNaturalEarthBorders(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not memoize failure and retries both assets', async () => {
    let request = 0;
    const fetcher = vi.fn((input: URL | RequestInfo) => {
      const current = request++;
      if (current < 2 && requestUrl(input).endsWith('.vertices.bin')) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return Promise.resolve(
        requestUrl(input).endsWith('.vertices.bin')
          ? ok(new ArrayBuffer(24))
          : ok(indicesBuffer([0, 1])),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const { loadNaturalEarthBorders } = await import('../src/borders.js');

    await expect(loadNaturalEarthBorders()).rejects.toThrow('returned HTTP 503');
    const decoded = await loadNaturalEarthBorders();
    expect(decoded.vertices).toBeInstanceOf(Uint8Array);
    expect(decoded.indices).toBeInstanceOf(Uint32Array);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['vertex stride', new ArrayBuffer(23), indicesBuffer([0, 1]), 'multiple of 24 bytes'],
    ['index byte length', new ArrayBuffer(24), new ArrayBuffer(3), 'byte length must be divisible'],
  ] as const)('rejects invalid %s before caching', async (_name, vertices, indices, message) => {
    const fetcher = vi.fn((input: URL | RequestInfo) =>
      Promise.resolve(
        requestUrl(input).endsWith('.vertices.bin') ? ok(vertices.slice(0)) : ok(indices.slice(0)),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    const { loadNaturalEarthBorders } = await import('../src/borders.js');

    await expect(loadNaturalEarthBorders()).rejects.toThrow(message);
    await expect(loadNaturalEarthBorders()).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('observes both HTTP statuses before reading either body', async () => {
    const vertices = new Response(null, { status: 404 });
    const indices = new Response(null, { status: 500 });
    const vertexBody = vi.spyOn(vertices, 'arrayBuffer');
    const indexBody = vi.spyOn(indices, 'arrayBuffer');
    const fetcher = vi.fn((input: URL | RequestInfo) =>
      Promise.resolve(requestUrl(input).endsWith('.vertices.bin') ? vertices : indices),
    );
    vi.stubGlobal('fetch', fetcher);
    const { loadNaturalEarthBorders } = await import('../src/borders.js');

    await expect(loadNaturalEarthBorders()).rejects.toThrow('returned HTTP 404');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vertexBody).not.toHaveBeenCalled();
    expect(indexBody).not.toHaveBeenCalled();
  });
});

function ok(body: ArrayBuffer): Response {
  return new Response(body, { status: 200 });
}

function requestUrl(input: URL | RequestInfo): string {
  if (input instanceof URL) return input.href;
  return typeof input === 'string' ? input : input.url;
}

function indicesBuffer(values: readonly number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(values.length * Uint32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  values.forEach((value, index) => {
    view.setUint32(index * Uint32Array.BYTES_PER_ELEMENT, value, true);
  });
  return buffer;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
