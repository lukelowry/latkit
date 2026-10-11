import { failure } from '@latkit/model';

/** How many bytes an archive's first read asks for: its header and, usually, its root directory. */
export const HEAD_BYTES = 16384;
const CACHE_NAME = 'latkit-geography';
const EMPTY = new Uint8Array(0);
const ignore = (): void => {};

/** An archive's bytes by offset: in memory, in a Blob, or behind a URL. */
export interface ByteRanges {
  /** The first bytes, read on opening; every byte when the archive is held whole. */
  readonly head: Uint8Array;
  /** `length` bytes from `offset`, past the head. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** A response's bytes, status, and content type; `kept` when read from Cache Storage. */
export interface Fetched {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly status: number;
  readonly type: string;
  readonly kept: boolean;
}

/** The failure an aborted read throws. */
export function abortedBy(signal: AbortSignal): Error {
  return failure('aborted', 'Tiles were not read: the request was aborted', {
    cause: signal.reason,
  });
}

/** The failure a read past the end throws. */
export function truncated(): Error {
  return failure('protocol', 'The archive ends before the bytes its directory names');
}

/** A promise that rejects as soon as `signal` aborts, calling `onAbort` first. */
export function raced<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(abortedBy(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort?.();
      reject(abortedBy(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error as Error);
      },
    );
  });
}

interface Pending<T> {
  readonly promise: Promise<T>;
  readonly controller: AbortController;
  waiters: number;
}

/** Concurrent requests for one key share one fetch, which aborts only once every caller has. */
export class SharedRequests<T> {
  private readonly pending = new Map<string, Pending<T>>();

  request(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortedBy(signal));
    const pending = this.pending.get(key) ?? this.begin(key, start);
    pending.waiters++;
    return raced(pending.promise, signal, () => this.leave(key, pending));
  }

  private begin(key: string, start: (signal: AbortSignal) => Promise<T>): Pending<T> {
    const controller = new AbortController();
    const pending: Pending<T> = { promise: start(controller.signal), controller, waiters: 0 };
    this.pending.set(key, pending);
    const settle = (): void => this.forget(key, pending);
    pending.promise.then(settle, settle);
    return pending;
  }

  private leave(key: string, pending: Pending<T>): void {
    if (--pending.waiters > 0) return;
    this.forget(key, pending);
    pending.controller.abort();
  }

  private forget(key: string, pending: Pending<T>): void {
    if (this.pending.get(key) === pending) this.pending.delete(key);
  }
}

/** The Cache Storage this source keeps bytes in, or null when it keeps none. */
export function openCache(persist: boolean): Promise<Cache | null> {
  if (!persist || typeof globalThis.caches === 'undefined') return Promise.resolve(null);
  try {
    return globalThis.caches.open(CACHE_NAME).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/** The Cache Storage key of a URL's byte range: a query, since Cache Storage ignores fragments. */
function rangeKey(url: string, start: number, end: number): string {
  const base = url.split('#', 1)[0];
  return `${base}${base.includes('?') ? '&' : '?'}bytes=${start}-${end}`;
}

/** A URL's bytes: from Cache Storage under `key` when kept there, else fetched and kept when 200 or 206. */
export async function fetchKept(
  url: string,
  key: string,
  range: string | null,
  cache: Cache | null,
  signal?: AbortSignal,
): Promise<Fetched> {
  const kept = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (kept)
    return { bytes: await bodyOf(kept, url, signal), status: 200, type: typeOf(kept), kept: true };
  const response = await send(url, range, signal);
  if (response.status !== 200 && response.status !== 206) {
    response.body?.cancel().catch(ignore);
    return { bytes: EMPTY, status: response.status, type: '', kept: false };
  }
  const bytes = await bodyOf(response, url, signal);
  const type = typeOf(response);
  if (cache)
    cache.put(key, new Response(bytes, { headers: { 'content-type': type } })).catch(ignore);
  return { bytes, status: response.status, type, kept: false };
}

function typeOf(response: Response): string {
  return response.headers.get('content-type') ?? '';
}

async function send(url: string, range: string | null, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { headers: range ? { Range: range } : undefined, signal });
  } catch (error) {
    throw unread(url, error, signal);
  }
}

async function bodyOf(
  response: Response,
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw unread(url, error, signal);
  }
}

function unread(url: string, error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return abortedBy(signal);
  return failure('io', `Tiles could not be read from ${url}`, { cause: error });
}

/** Bytes held in memory, read without copying. */
export function memoryRanges(bytes: Uint8Array): ByteRanges {
  return { head: bytes, read: () => Promise.reject(truncated()) };
}

/** A Blob's bytes, read by slices. */
export async function blobRanges(blob: Blob, signal?: AbortSignal): Promise<ByteRanges> {
  const head = await sliceOf(blob, 0, HEAD_BYTES, signal);
  return {
    head,
    read: async (offset, length, signal) =>
      exact(await sliceOf(blob, offset, offset + length, signal), length),
  };
}

async function sliceOf(
  blob: Blob,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return new Uint8Array(await raced(blob.slice(start, end).arrayBuffer(), signal));
}

function exact(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length !== length) throw truncated();
  return bytes;
}

interface Range {
  readonly bytes: Uint8Array;
  readonly type: string;
  /** Whether the server sent every byte, ignoring the range. */
  readonly whole: boolean;
}

/** A URL's bytes by HTTP range requests; every byte, once a server ignores a range. */
export class UrlRanges implements ByteRanges {
  head: Uint8Array = EMPTY;
  /** The first response's content type. */
  type = '';
  readonly url: string;
  readonly cache: Promise<Cache | null>;
  private whole = false;
  private readonly requests = new SharedRequests<Range>();

  constructor(url: string, persist: boolean) {
    this.url = url;
    this.cache = openCache(persist);
  }

  /** Read the first bytes. */
  async open(signal?: AbortSignal): Promise<this> {
    const first = await this.range(0, HEAD_BYTES, signal);
    this.head = first.bytes;
    this.type = first.type;
    this.whole = first.whole || first.bytes.length < HEAD_BYTES;
    return this;
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.whole) throw truncated();
    const range = await this.range(offset, length, signal);
    if (!range.whole) return exact(range.bytes, length);
    this.head = range.bytes;
    this.whole = true;
    return exact(range.bytes.subarray(offset, offset + length), length);
  }

  /** Every byte: the head when it holds them, else the whole URL fetched. */
  async body(signal?: AbortSignal): Promise<Uint8Array> {
    if (this.whole) return this.head;
    const fetched = await fetchKept(this.url, this.url, null, await this.cache, signal);
    if (fetched.status !== 200)
      throw failure('io', `Tiles could not be read from ${this.url} (${fetched.status})`);
    return fetched.bytes;
  }

  private range(offset: number, length: number, signal?: AbortSignal): Promise<Range> {
    const end = offset + length - 1;
    return this.requests.request(
      `${offset}-${end}`,
      async (shared) => {
        const key = rangeKey(this.url, offset, end);
        const fetched = await fetchKept(
          this.url,
          key,
          `bytes=${offset}-${end}`,
          await this.cache,
          shared,
        );
        if (fetched.status !== 200 && fetched.status !== 206)
          throw failure('io', `Tiles could not be read from ${this.url} (${fetched.status})`);
        const whole = fetched.kept ? fetched.bytes.length > length : fetched.status === 200;
        return { bytes: fetched.bytes, type: fetched.type, whole };
      },
      signal,
    );
  }
}
