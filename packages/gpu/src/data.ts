import {
  read as readData,
  blockBuffers,
  blockByteLength,
  validateBlock,
  validateQuery,
  validateSchema,
  type Query,
  type Data,
  type QueryBlock,
  type QueryHeader,
  type Schema,
} from '@latkit/model';
import { GpuError, interruptible } from './error.js';
import type { Entry, Memory } from './memory.js';

type Result = QueryHeader | QueryBlock;
interface Chunk {
  value: Result;
  memory: Entry;
}
interface Reader {
  next: number;
  holding: boolean;
}
interface Read {
  key: string;
  query: Query;
  meta: Entry;
  controller: AbortController;
  iterator: AsyncIterator<Result>;
  chunks: Map<number, Chunk>;
  readers: Set<Reader>;
  produced: number;
  done: boolean;
  failed: boolean;
  error?: unknown;
  header?: QueryHeader;
  pulling?: Promise<void>;
  changed: Promise<void>;
  notify(): void;
  off(): void;
}

/** Bounded memoization of local computations over immutable application data. */
export class Reads {
  private cache = new Map<string, Read>();
  private objects = new WeakMap<object, number>();
  private serial = 0;
  private schemas = new WeakMap<Schema, number>();
  private live = new Set<Read>();
  private closed = false;
  readonly maxBlockBytes: number;

  constructor(
    private readonly memory: Memory,
    maxBlockBytes: number,
    private readonly validate: boolean,
  ) {
    this.maxBlockBytes = Math.max(
      1,
      Math.floor(Math.min(maxBlockBytes, memory.budget.cpuBytes / 4, memory.budget.stagingBytes)),
    );
  }

  async *query(source: Data, query: Query, signal: AbortSignal): AsyncGenerator<Result> {
    // Optional fields commonly arrive as explicit undefined from typed renderer requests.
    if (Object.values(query).some((value) => value === undefined))
      query = Object.fromEntries(
        Object.entries(query).filter(([, value]) => value !== undefined),
      ) as unknown as Query;
    signal.throwIfAborted();
    if (this.closed) throw new GpuError('closed', 'Gpu is closed');
    const key = this.dependencyKey(source, query);
    const cache = this.cache;
    let read = cache.get(key);
    if (read?.meta.live) this.memory.queryHits++;
    else {
      read = this.open(source, query, key, cache);
      cache.set(key, read);
    }
    const reader: Reader = { next: 0, holding: false };
    read.meta.pin();
    read.readers.add(reader);
    for (const chunk of read.chunks.values()) chunk.memory.pin();
    read.notify();
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = read.chunks.get(reader.next);
        if (chunk) {
          reader.holding = true;
          try {
            yield chunk.value.version === source.version
              ? chunk.value
              : { ...chunk.value, version: source.version };
          } finally {
            reader.holding = false;
            reader.next++;
            chunk.memory.unpin();
            read.notify();
          }
          continue;
        }
        if (read.done) {
          if (read.failed) throw read.error;
          return;
        }
        if ([...read.readers].some((other) => other.holding || other.next < read.produced)) {
          await interruptible(read.changed, signal);
          continue;
        }
        read.pulling ??= this.pull(read, cache).finally(() => {
          read.pulling = undefined;
          read.notify();
        });
        await interruptible(read.pulling, signal);
      }
    } finally {
      read.readers.delete(reader);
      for (const [position, chunk] of read.chunks)
        if (position >= reader.next) chunk.memory.unpin();
      read.meta.unpin();
      if (!read.readers.size && !read.done) {
        this.stop(
          read,
          signal.aborted ? signal.reason : new DOMException('Query consumer left', 'AbortError'),
        );
        if (cache.get(read.key) === read) cache.delete(read.key);
        read.meta.close();
      }
      read.notify();
    }
  }

  private open(source: Data, query: Query, key: string, cache: Map<string, Read>): Read {
    const controller = new AbortController();
    let wake = (): void => {};
    const read = {
      key,
      query,
      controller,
      chunks: new Map<number, Chunk>(),
      readers: new Set<Reader>(),
      produced: 0,
      done: false,
      failed: false,
      changed: Promise.resolve(),
      notify: () => {},
      off: () => {},
    } as Read;
    read.notify = () => {
      wake();
      read.changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
    };
    read.notify();
    read.meta = this.memory.add([], 256 + key.length * 2, () => {
      if (cache.get(read.key) === read) cache.delete(read.key);
      this.live.delete(read);
      read.off();
      if (!read.done) this.stop(read, new GpuError('closed', 'Read cache was released'));
      for (const chunk of read.chunks.values()) chunk.memory.close();
    });
    try {
      read.iterator = readData(source, query, {
        signal: controller.signal,
        maxBlockBytes: this.maxBlockBytes,
      })[Symbol.asyncIterator]();
      this.live.add(read);
      this.memory.queries++;
      read.meta.unpin();
      return read;
    } catch (error) {
      this.memory.remove(read.meta);
      throw error;
    }
  }

  private async pull(read: Read, cache: Map<string, Read>): Promise<void> {
    try {
      const result = await interruptible(
        Promise.resolve(read.iterator.next()),
        read.controller.signal,
      );
      read.controller.signal.throwIfAborted();
      if (result.done) {
        if (!read.header)
          throw new GpuError('invalid-input', 'Query ended without its schema header');
        read.done = true;
        return;
      }
      let value = result.value;
      let metadata: number;
      let backings: readonly ArrayBufferLike[] = [];
      if (value.kind === 'schema') {
        if (read.header || read.produced)
          throw new GpuError('invalid-input', 'Query emitted more than one schema header');
        if (typeof value.version !== 'string' || !value.schema)
          throw new GpuError('invalid-input', 'Invalid query header');
        if (
          this.validate &&
          (validateSchema(value.schema).length || validateQuery(value.schema, read.query).length)
        )
          throw new GpuError('invalid-input', 'Invalid query schema or request');
        read.header = value;
        metadata =
          this.schemas.get(value.schema) ??
          new TextEncoder().encode(JSON.stringify(value.schema)).byteLength + 128;
        this.schemas.set(value.schema, metadata);
      } else {
        const header = read.header;
        if (!header || value.kind !== read.query.kind || value.version !== header.version)
          throw new GpuError('conflict', 'Query block disagrees with its authoritative header');
        const payload = blockByteLength(value);
        if (payload > Math.min(this.maxBlockBytes, header.schema.limits.maxBlockBytes))
          throw new GpuError('resource-limit', 'Query block exceeds its requested byte bound');
        if (
          this.validate &&
          validateBlock(header.schema, read.query, value, { maxBlockBytes: this.maxBlockBytes })
            .length
        )
          throw new GpuError('invalid-input', 'Invalid query block');
        backings = blockBuffers(value);
        const exposed = exposedBytes(value);
        metadata = Math.max(128, payload - exposed);
        const held = backings.reduce((total, backing) => total + backing.byteLength, 0);
        if (
          held > Math.max(payload * 4, this.memory.budget.cpuBytes / 2) ||
          held + metadata > this.memory.budget.cpuBytes
        ) {
          const bytes = viewBytes(value);
          value = this.memory.stage(bytes, () => compact(value)) as QueryBlock;
          backings = blockBuffers(value);
        }
      }
      const position = read.produced;
      const memory = this.memory.add(backings, metadata, () => {
        read.chunks.delete(position);
        if (cache.get(read.key) === read) cache.delete(read.key);
      });
      // Every current reader owns this chunk until it advances or leaves.
      for (let i = 1; i < read.readers.size; i++) memory.pin();
      read.chunks.set(position, { value, memory });
      read.produced++;
      if (!read.readers.size) memory.unpin();
    } catch (error) {
      read.error = error;
      read.failed = true;
      read.done = true;
      if (cache.get(read.key) === read) cache.delete(read.key);
      read.meta.close();
      read.controller.abort(error);
      void Promise.resolve(read.iterator.return?.()).catch(() => {});
    }
  }

  private stop(read: Read, reason: unknown): void {
    read.error = reason;
    read.failed = true;
    read.done = true;
    read.controller.abort(reason);
    void Promise.resolve(read.iterator?.return?.()).catch(() => {});
    read.notify();
  }

  private dependencyKey(data: Data, query: Query): string {
    const table = data.tables[query.from];
    const used = new Set(query.select);
    if (query.kind === 'rows') {
      for (const filter of query.where ?? []) used.add(filter.field);
      for (const order of query.orderBy ?? []) used.add(order.field);
    }
    const window = 'window' in query ? query.window : undefined;
    const dependencies: unknown[] = [
      this.identity(data.schema),
      table?.index,
      table?.rows,
      table?.ids,
    ];
    for (const name of [...used].sort()) {
      const pages = table?.fields[name] ?? [];
      if (window?.kind === 'frames') {
        dependencies.push(
          name,
          pages
            .filter(
              (page) =>
                !page.samples ||
                (page.samples.firstFrame < window.offset + window.count &&
                  page.samples.firstFrame + page.samples.coordinates.length > window.offset),
            )
            .map((page) => this.identity(page)),
        );
      } else dependencies.push(name, this.identity(pages));
      const type = data.schema.types[query.from]?.fields[name]?.type;
      if (typeof type === 'object' && type.kind === 'reference')
        dependencies.push(
          data.tables[type.to]?.index,
          this.identity(data.tables[type.to]?.ids ?? data),
        );
    }
    return this.key([dependencies, query]);
  }
  private identity(value: object): number {
    let id = this.objects.get(value);
    if (!id) {
      id = ++this.serial;
      this.objects.set(value, id);
    }
    return id;
  }
  private key(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (ArrayBuffer.isView(value) || (Array.isArray(value) && value.length > 64)) {
      let id = this.objects.get(value);
      if (!id) {
        id = ++this.serial;
        this.objects.set(value, id);
      }
      return '@' + id;
    }
    if (Array.isArray(value)) return '[' + value.map((item) => this.key(item)).join(',') + ']';
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, item]) => JSON.stringify(name) + ':' + this.key(item))
        .join(',') +
      '}'
    );
  }

  destroy(): void {
    this.closed = true;
    for (const read of [...this.live]) {
      this.stop(read, new GpuError('closed', 'Gpu is closed'));
      read.off();
      read.meta.close();
    }
    this.live.clear();
  }
}

function views(
  value: unknown,
  result: ArrayBufferView[] = [],
  seen = new Set<object>(),
): ArrayBufferView[] {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    if (ArrayBuffer.isView(value)) result.push(value);
    else for (const item of Object.values(value)) views(item, result, seen);
  }
  return result;
}
function viewBytes(value: unknown): number {
  return views(value).reduce((sum, view) => sum + view.byteLength, 0);
}
function exposedBytes(value: unknown): number {
  const byBacking = new Map<ArrayBufferLike, [number, number][]>();
  for (const view of views(value)) {
    const ranges = byBacking.get(view.buffer) ?? [];
    ranges.push([view.byteOffset, view.byteOffset + view.byteLength]);
    byBacking.set(view.buffer, ranges);
  }
  let bytes = 0;
  for (const ranges of byBacking.values()) {
    ranges.sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [start, next] of ranges) {
      bytes += Math.max(0, next - Math.max(start, end));
      end = Math.max(end, next);
    }
  }
  return bytes;
}
function compact(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (ArrayBuffer.isView(value)) {
    const constructor = value.constructor as { new (buffer: ArrayBuffer): ArrayBufferView };
    const copy = new constructor(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer,
    );
    seen.set(value, copy);
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(compact(item, seen));
    return copy;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [name, item] of Object.entries(value)) {
    const child = compact(item, seen);
    if (name === '__proto__')
      Object.defineProperty(copy, name, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else copy[name] = child;
  }
  return copy;
}
