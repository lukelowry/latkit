import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTiles, tileId, tileOf, writeArchive } from '../src/sources/archive.js';
import type { TileSource } from '../src/sources/archive.js';

afterEach(() => vi.unstubAllGlobals());

interface Tile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly bytes: Uint8Array;
}

const BOUNDS = [-10, -20, 30, 40] as const;
const WORLD = [-180, -85.0511287798, 180, 85.0511287798];
const encoder = new TextEncoder();

/** A deterministic stream of numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Tiles at zooms 0 to 3 holding their own coordinates, with holes and one repeated content. */
function sampleTiles(): Tile[] {
  const tiles: Tile[] = [];
  for (let z = 0; z <= 3; z++)
    for (let x = 0; x < 2 ** z; x++)
      for (let y = 0; y < 2 ** z; y++) {
        if ((x + y) % 5 === 4) continue;
        const repeated = z === 3 && x < 2;
        tiles.push({ z, x, y, bytes: new Uint8Array(repeated ? [9, 9, 9] : [z, x, y, x * 7 + y]) });
      }
  return tiles;
}

/** 20000 distinct tiles at zoom 8, in shuffled order: enough to need leaf directories. */
function manyTiles(): Tile[] {
  const tiles: Tile[] = [];
  for (let i = 0; i < 20000; i++) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, i, true);
    tiles.push({ z: 8, x: i % 256, y: Math.floor(i / 256), bytes });
  }
  const next = random(7);
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

/** 40 tiles of 1000 bytes each, so most tile data lies past the first read. */
function wideTiles(): Tile[] {
  return Array.from({ length: 40 }, (_, i) => ({
    z: 3,
    x: i % 8,
    y: Math.floor(i / 8),
    bytes: new Uint8Array(1000).fill(i + 1),
  }));
}

function inIdOrder(tiles: readonly Tile[]): Tile[] {
  return tiles
    .map((tile) => ({ tile, id: tileId(tile.z, tile.x, tile.y) }))
    .sort((a, b) => a.id - b.id)
    .map(({ tile }) => tile);
}

function archiveOf(tiles: readonly Tile[], kind: TileSource['kind'] = 'vector'): Uint8Array {
  const zooms = tiles.map((tile) => tile.z);
  return writeArchive(tiles, {
    kind,
    minZoom: Math.min(...zooms),
    maxZoom: Math.max(...zooms),
    bounds: BOUNDS,
    metadata: { name: 'sample', attribution: '© Sample' },
  });
}

function u64(archive: Uint8Array, at: number): number {
  return Number(new DataView(archive.buffer, archive.byteOffset).getBigUint64(at, true));
}

function section(archive: Uint8Array, at: number): Uint8Array {
  return archive.subarray(u64(archive, at), u64(archive, at) + u64(archive, at + 8));
}

async function expectTiles(source: TileSource, tiles: readonly Tile[]): Promise<void> {
  const read = await Promise.all(tiles.map((tile) => source.tile(tile.z, tile.x, tile.y)));
  read.forEach((bytes, i) => expect(bytes).toEqual(tiles[i].bytes));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Request {
  readonly url: string;
  readonly range: string | null;
}

interface File {
  readonly body?: Uint8Array | string;
  readonly type?: string;
  readonly status?: number;
}

function bytesOf(body: Uint8Array | string): Uint8Array<ArrayBuffer> {
  return typeof body === 'string' ? encoder.encode(body) : body.slice();
}

/** A response to one request for a file, honoring Range unless told to ignore it. */
function respond(file: File | undefined, range: string | null, ignoreRange = false): Response {
  if (!file) return new Response('missing', { status: 404 });
  if (file.status)
    return new Response(file.status === 204 ? null : 'error', { status: file.status });
  const body = bytesOf(file.body ?? '');
  const headers = { 'content-type': file.type ?? 'application/octet-stream' };
  const match = range && !ignoreRange ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
  if (!match) return new Response(body, { status: 200, headers });
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), body.length - 1);
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}

/** Stub fetch to serve files from memory; the returned list records every request. */
function serve(files: Readonly<Record<string, File>>, ignoreRange = false): Request[] {
  const requests: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get('range');
      requests.push({ url, range });
      return respond(files[url], range, ignoreRange);
    }),
  );
  return requests;
}

function goOffline(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.reject(new TypeError('offline'))),
  );
}

/** Stub Cache Storage, matching keys without fragments as browsers do. */
function stubCaches(): {
  readonly kept: Map<string, Promise<ArrayBuffer>>;
  readonly names: string[];
} {
  const kept = new Map<string, Promise<ArrayBuffer>>();
  const names: string[] = [];
  const keyOf = (request: string | URL): string => String(request).split('#')[0];
  const cache = {
    match: async (request: string | URL) => {
      const body = kept.get(keyOf(request));
      return body ? new Response(await body) : undefined;
    },
    put: async (request: string | URL, response: Response) => {
      if (response.status !== 200) throw new TypeError('Cache Storage refuses partial responses');
      kept.set(keyOf(request), response.arrayBuffer());
    },
  };
  vi.stubGlobal('caches', {
    open: async (name: string) => {
      names.push(name);
      return cache;
    },
  });
  return { kept, names };
}

describe('tile ids', () => {
  it('numbers tiles along the Hilbert curve, zoom by zoom', () => {
    expect(tileId(0, 0, 0)).toBe(0);
    expect(tileId(1, 0, 0)).toBe(1);
    expect(tileId(1, 0, 1)).toBe(2);
    expect(tileId(1, 1, 1)).toBe(3);
    expect(tileId(1, 1, 0)).toBe(4);
    expect(tileId(2, 0, 0)).toBe(5);
    expect(tileId(12, 3423, 1763)).toBe(19078479);
    expect(tileOf(19078479)).toEqual([12, 3423, 1763]);
    expect(tileOf(4)).toEqual([1, 1, 0]);
  });

  it('round-trips ids at zooms 12, 20, and 26', () => {
    const next = random(3);
    for (const z of [12, 20]) {
      const seen = new Set<number>();
      for (let i = 0; i < 500; i++) {
        const x = Math.floor(next() * 2 ** z);
        const y = Math.floor(next() * 2 ** z);
        const id = tileId(z, x, y);
        expect(tileOf(id)).toEqual([z, x, y]);
        seen.add(id);
      }
      expect(seen.size).toBeGreaterThan(490);
    }
    const last = 2 ** 26 - 1;
    for (const [x, y] of [
      [0, 0],
      [last, 0],
      [0, last],
      [last, last],
      [12345678, 54321],
    ])
      expect(tileOf(tileId(26, x, y))).toEqual([26, x, y]);
    expect(tileId(26, 2 ** 25, 0)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('rejects tiles outside their zoom', () => {
    expect(() => tileId(27, 0, 0)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }) as Error,
    );
    expect(() => tileId(2, 4, 0)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }) as Error,
    );
    expect(() => tileId(1.5, 0, 0)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }) as Error,
    );
    expect(() => tileOf(-1)).toThrow(expect.objectContaining({ code: 'invalid-input' }) as Error);
  });
});

describe('archives', () => {
  it('round-trips through bytes, an ArrayBuffer, and a Blob', async () => {
    const tiles = sampleTiles();
    const archive = archiveOf(tiles);
    const sources = [
      await openTiles(archive),
      await openTiles(archive.slice().buffer),
      await openTiles(new Blob([archive as Uint8Array<ArrayBuffer>])),
    ];
    for (const source of sources) {
      expect(source).toMatchObject({
        kind: 'vector',
        minZoom: 0,
        maxZoom: 3,
        attribution: '© Sample',
        metadata: { name: 'sample', attribution: '© Sample' },
      });
      source.bounds.forEach((value, i) => expect(value).toBeCloseTo(BOUNDS[i], 6));
      await expectTiles(source, tiles);
      expect(await source.tile(2, 3, 1)).toBeNull();
      expect(await source.tile(5, 0, 0)).toBeNull();
    }
  });

  it('stores identical contents once and merges runs of them', async () => {
    const same = new Uint8Array([1, 2, 3]);
    const run = Array.from({ length: 64 }, (_, i) => ({ z: 3, x: i % 8, y: i >> 3, bytes: same }));
    const archive = archiveOf(run);
    expect([u64(archive, 72), u64(archive, 80), u64(archive, 88)]).toEqual([64, 1, 1]);
    expect(u64(archive, 64)).toBe(3);
    await expectTiles(await openTiles(archive), run);

    const apart = [
      { z: 1, x: 0, y: 0, bytes: new Uint8Array([5]) },
      { z: 1, x: 0, y: 1, bytes: new Uint8Array([6]) },
      { z: 1, x: 1, y: 1, bytes: new Uint8Array([5]) },
    ];
    const split = archiveOf(apart);
    expect([u64(split, 72), u64(split, 80), u64(split, 88)]).toEqual([3, 3, 2]);
    await expectTiles(await openTiles(split), apart);
  });

  it('writes the header the spec lays out', () => {
    const archive = writeArchive(sampleTiles(), {
      kind: 'vector',
      minZoom: 0,
      maxZoom: 3,
      bounds: BOUNDS,
    });
    const view = new DataView(archive.buffer);
    expect(new TextDecoder().decode(archive.subarray(0, 7))).toBe('PMTiles');
    expect([archive[7], archive[96], archive[97], archive[98], archive[99]]).toEqual([
      3, 1, 1, 1, 1,
    ]);
    expect([view.getInt32(102, true), view.getInt32(114, true)]).toEqual([-10e7, 40e7]);
    expect([archive[118], view.getInt32(119, true), view.getInt32(123, true)]).toEqual([
      0, 10e7, 10e7,
    ]);
    expect(u64(archive, 8)).toBe(127);
    expect(new TextDecoder().decode(section(archive, 24))).toBe('{}');
  });

  it('writes packs as tile type 0, marked in metadata', async () => {
    const tiles = sampleTiles();
    const archive = writeArchive(tiles, {
      kind: 'pack',
      minZoom: 0,
      maxZoom: 3,
      bounds: BOUNDS,
      center: [1, 2, 3],
      metadata: { fields: ['load'] },
    });
    expect(archive[99]).toBe(0);
    expect(archive[118]).toBe(3);
    const source = await openTiles(archive);
    expect(source).toMatchObject({
      kind: 'pack',
      metadata: { fields: ['load'], latkit: 'pack' },
    });
    await expectTiles(source, tiles);
  });

  it('splits large directories into leaves', async () => {
    const tiles = manyTiles();
    const archive = archiveOf(tiles);
    expect(u64(archive, 48)).toBeGreaterThan(0);
    expect(127 + u64(archive, 16)).toBeLessThanOrEqual(16384);
    expect(u64(archive, 80)).toBe(20000);
    const source = await openTiles(archive);
    await expectTiles(source, tiles);
    expect(await source.tile(8, 255, 255)).toBeNull();
    await expectTiles(
      await openTiles(new Blob([archive as Uint8Array<ArrayBuffer>])),
      tiles.slice(0, 500),
    );
  });

  it('reads gzip directories and tiles back decompressed', async () => {
    const tiles = sampleTiles();
    const zipped = await Promise.all(
      tiles.map(async (tile) => ({ ...tile, bytes: await gzip(tile.bytes) })),
    );
    const plain = archiveOf(zipped);
    const [root, metadata] = await Promise.all([gzip(section(plain, 8)), gzip(section(plain, 24))]);
    const data = section(plain, 56);
    const leaves = 127 + root.length + metadata.length;
    const archive = new Uint8Array(leaves + data.length);
    archive.set(plain.subarray(0, 127));
    archive.set(root, 127);
    archive.set(metadata, 127 + root.length);
    archive.set(data, leaves);
    const view = new DataView(archive.buffer);
    const offsets = [
      127,
      root.length,
      127 + root.length,
      metadata.length,
      leaves,
      0,
      leaves,
      data.length,
    ];
    offsets.forEach((value, i) => view.setBigUint64(8 + 8 * i, BigInt(value), true));
    view.setUint8(97, 2);
    view.setUint8(98, 2);
    const source = await openTiles(archive);
    expect(source.metadata).toMatchObject({ name: 'sample' });
    await expectTiles(source, tiles);
  });

  it('lets options override the zooms and attribution an archive declares', async () => {
    const tiles = sampleTiles();
    const source = await openTiles(archiveOf(tiles), {
      minZoom: 1,
      maxZoom: 2,
      attribution: 'Mine',
    });
    expect(source).toMatchObject({ kind: 'vector', minZoom: 1, maxZoom: 2, attribution: 'Mine' });
    await expectTiles(source, tiles);
  });

  it('refuses tiles of images, and type 0 that is not a pack', async () => {
    const archive = writeArchive(sampleTiles(), {
      kind: 'pack',
      minZoom: 0,
      maxZoom: 3,
      bounds: BOUNDS,
    });
    archive.set(
      encoder.encode('{"other":1}'.padEnd(section(archive, 24).length)),
      u64(archive, 24),
    );
    await expect(openTiles(archive)).rejects.toMatchObject({ code: 'unsupported' });
    for (const type of [2, 3, 4, 5]) {
      const images = archiveOf(sampleTiles());
      images[99] = type;
      await expect(openTiles(images)).rejects.toMatchObject({ code: 'unsupported' });
    }
  });

  it('reports archives it cannot read', async () => {
    const archive = archiveOf(sampleTiles());
    const patched = (at: number, value: number): Uint8Array => {
      const copy = archive.slice();
      copy[at] = value;
      return copy;
    };
    await expect(openTiles(encoder.encode('not an archive'))).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(openTiles(patched(0, 0))).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(openTiles(patched(7, 2))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(openTiles(patched(97, 3))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(openTiles(patched(98, 4))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(openTiles(archive.subarray(0, 100))).rejects.toMatchObject({ code: 'protocol' });
    const corrupt = archive.slice();
    corrupt.fill(0xff, 127, 140);
    await expect(openTiles(corrupt)).rejects.toMatchObject({ code: 'protocol' });

    const many = archiveOf(manyTiles());
    const [tile] = manyTiles();
    for (const cut of [many.subarray(0, 30000), new Blob([many.slice(0, 30000)])]) {
      const source = await openTiles(cut);
      await expect(source.tile(tile.z, tile.x, tile.y)).rejects.toMatchObject({ code: 'protocol' });
    }
    const aborted = AbortSignal.abort();
    await expect(openTiles(archive, { signal: aborted })).rejects.toMatchObject({
      code: 'aborted',
    });
    const source = await openTiles(archive);
    await expect(source.tile(0, 0, 0, aborted)).rejects.toMatchObject({ code: 'aborted' });
    await expect(source.tile(1, 2, 0)).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('refuses to write archives that would be wrong', () => {
    const header = { kind: 'vector', minZoom: 0, maxZoom: 2, bounds: BOUNDS } as const;
    const bytes = new Uint8Array([1]);
    const twice = [
      { z: 1, x: 0, y: 0, bytes },
      { z: 1, x: 0, y: 0, bytes },
    ];
    const invalid = expect.objectContaining({ code: 'invalid-input' }) as Error;
    expect(() => writeArchive(twice, header)).toThrow(invalid);
    expect(() => writeArchive([{ z: 3, x: 0, y: 0, bytes }], header)).toThrow(invalid);
    expect(() => writeArchive([{ z: 1, x: 2, y: 0, bytes }], header)).toThrow(invalid);
    expect(() => writeArchive([], { ...header, kind: 'images' as 'vector' })).toThrow(invalid);
    expect(() => writeArchive([], { ...header, minZoom: 3 })).toThrow(invalid);
    expect(() => writeArchive([], { ...header, bounds: [0, 0, NaN, 0] })).toThrow(invalid);
  });

  it('writes and reads an empty archive', async () => {
    const source = await openTiles(
      writeArchive([], { kind: 'vector', minZoom: 0, maxZoom: 0, bounds: BOUNDS }),
    );
    expect(source).toMatchObject({ kind: 'vector' });
    expect(await source.tile(0, 0, 0)).toBeNull();
  });
});

describe('archives by URL', () => {
  const url = 'https://tiles.test/many.pmtiles';
  const tiles = manyTiles();
  const archive = archiveOf(tiles);
  const [first, second] = inIdOrder(tiles);

  it('reads the header and root in one request, then ranges, caching leaves', async () => {
    const requests = serve({ [url]: { body: archive } });
    const source = await openTiles(url);
    expect(requests).toEqual([{ url, range: 'bytes=0-16383' }]);
    expect(source.metadata).toMatchObject({ name: 'sample' });
    expect(await source.tile(first.z, first.x, first.y)).toEqual(first.bytes);
    const afterFirst = requests.length;
    expect(afterFirst).toBeGreaterThanOrEqual(2);
    expect(await source.tile(second.z, second.x, second.y)).toEqual(second.bytes);
    expect(requests.length).toBe(afterFirst + 1);
    expect(requests.every((request) => request.range !== null)).toBe(true);
    await expectTiles(source, tiles.slice(0, 200));
  });

  it('shares concurrent reads of one range', async () => {
    const requests = serve({ [url]: { body: archive } });
    const source = await openTiles(new URL(url));
    const read = await Promise.all([1, 2, 3].map(() => source.tile(first.z, first.x, first.y)));
    read.forEach((bytes) => expect(bytes).toEqual(first.bytes));
    const ranges = requests.map((request) => request.range);
    expect(new Set(ranges).size).toBe(ranges.length);
    expect(requests.length).toBeLessThanOrEqual(3);
  });

  it('keeps the whole body when a server ignores Range', async () => {
    const requests = serve({ [url]: { body: archive } }, true);
    const source = await openTiles(url);
    await expectTiles(source, tiles.slice(0, 300));
    expect(requests.length).toBe(1);
  });

  it('aborts a shared read only once every reader has', async () => {
    const wide = wideTiles();
    const body = archiveOf(wide);
    const gates: { readonly signal: AbortSignal; readonly release: () => void }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string, init: RequestInit) => {
        const range = new Headers(init.headers).get('range');
        if (range === 'bytes=0-16383') return Promise.resolve(respond({ body }, range));
        const signal = init.signal!;
        return new Promise<Response>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          gates.push({ signal, release: () => resolve(respond({ body }, range)) });
        });
      }),
    );
    const source = await openTiles(url);
    const [before, last] = inIdOrder(wide).slice(-2);
    const a = new AbortController();
    const b = new AbortController();
    const one = source.tile(last.z, last.x, last.y, a.signal);
    const two = source.tile(last.z, last.x, last.y, b.signal);
    await vi.waitFor(() => expect(gates.length).toBe(1));
    a.abort();
    await expect(one).rejects.toMatchObject({ code: 'aborted' });
    expect(gates[0].signal.aborted).toBe(false);
    gates[0].release();
    expect(await two).toEqual(last.bytes);

    const c = new AbortController();
    const d = new AbortController();
    const three = source.tile(before.z, before.x, before.y, c.signal);
    const four = source.tile(before.z, before.x, before.y, d.signal);
    await vi.waitFor(() => expect(gates.length).toBe(2));
    c.abort();
    d.abort();
    await expect(three).rejects.toMatchObject({ code: 'aborted' });
    await expect(four).rejects.toMatchObject({ code: 'aborted' });
    expect(gates[1].signal.aborted).toBe(true);

    const five = source.tile(before.z, before.x, before.y);
    await vi.waitFor(() => expect(gates.length).toBe(3));
    gates[2].release();
    expect(await five).toEqual(before.bytes);
  });

  it('reports servers that fail', async () => {
    serve({ [url]: { status: 500 } });
    await expect(openTiles(url)).rejects.toMatchObject({ code: 'io' });
    serve({});
    await expect(openTiles(url)).rejects.toMatchObject({ code: 'io' });
    serve({ [url]: { body: '<html>not tiles</html>', type: 'text/html' } });
    await expect(openTiles(url)).rejects.toMatchObject({ code: 'invalid-input' });
    goOffline();
    await expect(openTiles(url)).rejects.toMatchObject({ code: 'io' });

    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init: RequestInit) => {
        const range = new Headers(init.headers).get('range');
        return ++calls === 1
          ? respond({ body: archive }, range)
          : new Response('down', { status: 503 });
      }),
    );
    const source = await openTiles(url);
    await expect(source.tile(first.z, first.x, first.y)).rejects.toMatchObject({ code: 'io' });
  });

  it('keeps ranges in Cache Storage and reads them offline', async () => {
    const { kept, names } = stubCaches();
    serve({ [url]: { body: archive } });
    const sample = tiles.slice(0, 50);
    await expectTiles(await openTiles(url, { persist: true }), sample);
    expect(names[0]).toBe('latkit-geography');
    expect(kept.has(`${url}?bytes=0-16383`)).toBe(true);
    goOffline();
    const offline = await openTiles(url, { persist: true });
    await expectTiles(offline, sample);
    const unread = tiles.find((tile) => !sample.includes(tile))!;
    await expect(offline.tile(unread.z, unread.x, unread.y)).rejects.toMatchObject({ code: 'io' });
  });

  it('keeps a whole body sent for a range, and reads it offline', async () => {
    const { kept } = stubCaches();
    serve({ [url]: { body: archive } }, true);
    await openTiles(url, { persist: true });
    expect(kept.size).toBe(1);
    goOffline();
    await expectTiles(await openTiles(url, { persist: true }), tiles.slice(0, 100));
  });

  it('keeps nothing without persist, or without Cache Storage', async () => {
    const { kept } = stubCaches();
    serve({ [url]: { body: archive } });
    await expectTiles(await openTiles(url), tiles.slice(0, 5));
    expect(kept.size).toBe(0);
    vi.stubGlobal('caches', undefined);
    await expectTiles(await openTiles(url, { persist: true }), tiles.slice(0, 5));
  });
});

describe('templates', () => {
  it('fetches vector tiles from a template', async () => {
    const mvt = new Uint8Array([0x1a, 0x02, 0x08, 0x01]);
    const requests = serve({
      'https://t.test/1/0/1.pbf?key=k': { body: mvt },
      'https://t.test/1/1/1.pbf?key=k': { status: 204 },
      'https://t.test/1/1/0.pbf?key=k': { status: 500 },
    });
    const source = await openTiles('https://t.test/{z}/{x}/{y}.pbf?key=k');
    expect(source).toMatchObject({ kind: 'vector', minZoom: 0, maxZoom: 14, bounds: WORLD });
    expect(source.metadata).toEqual({});
    expect(await source.tile(1, 0, 1)).toEqual(mvt);
    expect(await source.tile(1, 0, 0)).toBeNull();
    expect(await source.tile(1, 1, 1)).toBeNull();
    await expect(source.tile(1, 1, 0)).rejects.toMatchObject({ code: 'io' });
    expect(requests.every((request) => request.range === null)).toBe(true);
    const fetched = requests.length;
    expect(await source.tile(20, 0, 0)).toBeNull();
    expect(requests.length).toBe(fetched);
  });

  it('reads vector tiles, gzipped or not, from a URL template', async () => {
    const mvt = encoder.encode('vector tile');
    serve({
      'https://t.test/v/2/1/1.pbf': { body: await gzip(mvt) },
      'https://t.test/v/2/1/2.pbf': { body: mvt },
    });
    const source = await openTiles(new URL('https://t.test/v/{z}/{x}/{y}.pbf'), {
      attribution: '© T',
    });
    expect(source).toMatchObject({ kind: 'vector', maxZoom: 14, attribution: '© T' });
    expect(await source.tile(2, 1, 1)).toEqual(mvt);
    expect(await source.tile(2, 1, 2)).toEqual(mvt);
  });

  it('reads a template without an extension as vector tiles, and refuses images', async () => {
    const source = await openTiles('https://t.test/{z}/{x}/{y}', { maxZoom: 10 });
    expect(source).toMatchObject({ kind: 'vector', maxZoom: 10 });
    for (const extension of ['png', 'jpg', 'webp', 'avif'])
      await expect(openTiles(`https://t.test/{z}/{x}/{y}.${extension}`)).rejects.toMatchObject({
        code: 'unsupported',
      });
  });

  it('shares concurrent requests and keeps tiles offline by their URL', async () => {
    const { kept } = stubCaches();
    const mvt = new Uint8Array([1, 2, 3, 4]);
    const requests = serve({ 'https://t.test/3/2/1.pbf': { body: mvt } });
    const source = await openTiles('https://t.test/{z}/{x}/{y}.pbf', { persist: true });
    const read = await Promise.all([source.tile(3, 2, 1), source.tile(3, 2, 1)]);
    read.forEach((bytes) => expect(bytes).toEqual(mvt));
    expect(requests.length).toBe(1);
    expect(kept.has('https://t.test/3/2/1.pbf')).toBe(true);
    goOffline();
    const offline = await openTiles('https://t.test/{z}/{x}/{y}.pbf', { persist: true });
    expect(await offline.tile(3, 2, 1)).toEqual(mvt);
  });
});

describe('TileJSON', () => {
  const url = 'https://t.test/maps/tiles.json';

  it('reads TileJSON and fetches its tiles', async () => {
    const json = {
      tilejson: '3.0.0',
      tiles: ['v/{z}/{x}/{y}.pbf'],
      minzoom: 2,
      maxzoom: 12,
      bounds: [-100, 30, -90, 40],
      attribution: '© OpenMap',
      vector_layers: [{ id: 'roads' }],
    };
    const mvt = encoder.encode('roads');
    const requests = serve({
      [url]: { body: JSON.stringify(json), type: 'application/json' },
      'https://t.test/maps/v/3/1/2.pbf': { body: mvt },
    });
    const source = await openTiles(url);
    expect(source).toMatchObject({
      kind: 'vector',
      minZoom: 2,
      maxZoom: 12,
      bounds: [-100, 30, -90, 40],
      attribution: '© OpenMap',
      metadata: json,
    });
    expect(await source.tile(3, 1, 2)).toEqual(mvt);
    expect(requests.map((request) => request.url)).toEqual([
      url,
      'https://t.test/maps/v/3/1/2.pbf',
    ]);
  });

  it('refuses TileJSON of images, by its tiles or its format', async () => {
    serve({ [url]: { body: JSON.stringify({ tiles: ['https://img.test/{z}/{x}/{y}.jpg'] }) } });
    await expect(openTiles(url)).rejects.toMatchObject({ code: 'unsupported' });
    serve({
      [url]: { body: JSON.stringify({ tiles: ['https://img.test/{z}/{x}/{y}'], format: 'png' }) },
    });
    await expect(openTiles(url)).rejects.toMatchObject({ code: 'unsupported' });
    serve({
      [url]: {
        body: ` ${JSON.stringify({ tiles: ['https://v.test/{z}/{x}/{y}'], vector_layers: [] })}`,
      },
    });
    expect(await openTiles(url)).toMatchObject({ kind: 'vector', maxZoom: 14 });
  });

  it('fetches the whole TileJSON when the first range holds only part', async () => {
    const json = { tiles: ['https://t.test/{z}/{x}/{y}.pbf'], description: 'x'.repeat(20000) };
    const requests = serve({ [url]: { body: JSON.stringify(json), type: 'application/json' } });
    const source = await openTiles(url);
    expect(source.metadata).toEqual(json);
    expect(requests.map((request) => request.range)).toEqual(['bytes=0-16383', null]);
  });

  it('flips rows for TMS', async () => {
    const json = { tiles: ['https://t.test/{z}/{x}/{y}.pbf'], scheme: 'tms' };
    const mvt = new Uint8Array([7]);
    serve({ [url]: { body: JSON.stringify(json) }, 'https://t.test/2/1/3.pbf': { body: mvt } });
    expect(await (await openTiles(url)).tile(2, 1, 0)).toEqual(mvt);
  });

  it('refuses TileJSON that names no tiles', async () => {
    serve({ [url]: { body: '{"tiles": []}' } });
    await expect(openTiles(url)).rejects.toMatchObject({ code: 'invalid-input' });
    serve({ [url]: { body: '{"tiles": ' } });
    await expect(openTiles(url)).rejects.toMatchObject({ code: 'invalid-input' });
  });
});
