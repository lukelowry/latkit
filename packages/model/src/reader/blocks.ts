import { blockBuffers, blockByteLength, exposedBytes } from '../buffers.js';
import { copyBuffers } from '../columns.js';
import { failure } from '../error.js';
import type { Data } from '../materialized.js';
import type { Query, QueryBlock } from '../query.js';
import { read as readData } from '../read.js';
import type { Schema } from '../schema.js';
import { validateBlock } from '../validation/block.js';
import { validateQuery } from '../validation/query.js';
import { validateSchema } from '../validation/schema.js';
import type { Keys } from './keys.js';
import type { Entry, Memory } from '../memory.js';
import { interruptible } from '../work.js';

interface Chunk {
  value: QueryBlock;
  memory: Entry;
}
interface Reader {
  next: number;
  holding: boolean;
}
interface Read {
  key: string;
  schema: Schema;
  query: Query;
  meta: Entry;
  controller: AbortController;
  iterator: AsyncIterator<QueryBlock>;
  chunks: Map<number, Chunk>;
  readers: Set<Reader>;
  produced: number;
  done: boolean;
  failed: boolean;
  error?: unknown;
  pulling?: Promise<void>;
  changed: Promise<void>;
  notify(): void;
}

/** Bounded memoization of local reads over immutable application data, shared by every reader. */
export class Blocks {
  private cache = new Map<string, Read>();
  private live = new Set<Read>();
  private valid = new WeakSet<Schema>();
  private closed = false;

  constructor(
    private readonly memory: Memory,
    private readonly keys: Keys,
    readonly maxBlockBytes: number,
    private readonly validate: boolean,
  ) {}

  async *read(source: Data, query: Query, signal: AbortSignal): AsyncGenerator<QueryBlock> {
    // Optional fields commonly arrive as explicit undefined from typed requests.
    if (Object.values(query).some((value) => value === undefined))
      query = Object.fromEntries(
        Object.entries(query).filter(([, value]) => value !== undefined),
      ) as unknown as Query;
    signal.throwIfAborted();
    if (this.closed) throw failure('closed', 'Reader is closed');
    const key = this.keys.query(source, query);
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
            yield chunk.value;
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
    if (this.validate) {
      if (!this.valid.has(source.schema)) {
        if (validateSchema(source.schema).length)
          throw failure('invalid-input', 'Invalid source schema');
        this.valid.add(source.schema);
      }
      if (validateQuery(source.schema, query).length)
        throw failure('invalid-input', 'Invalid query');
    }
    const controller = new AbortController();
    let wake = (): void => {};
    const read = {
      key,
      schema: source.schema,
      query,
      controller,
      chunks: new Map<number, Chunk>(),
      readers: new Set<Reader>(),
      produced: 0,
      done: false,
      failed: false,
      changed: Promise.resolve(),
      notify: () => {},
    } as unknown as Read;
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
      if (!read.done) this.stop(read, failure('closed', 'Read cache was released'));
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
        read.done = true;
        return;
      }
      let value = result.value;
      if (value.kind !== read.query.kind)
        throw failure('conflict', 'Query block disagrees with its request');
      const payload = blockByteLength(value);
      if (payload > this.maxBlockBytes)
        throw failure('resource-limit', 'Query block exceeds its requested byte bound');
      if (
        this.validate &&
        validateBlock(read.schema, read.query, value, { maxBlockBytes: this.maxBlockBytes }).length
      )
        throw failure('invalid-input', 'Invalid query block');
      let backings = blockBuffers(value);
      const metadata = Math.max(128, payload - exposedBytes(value));
      const held = backings.reduce((total, backing) => total + backing.byteLength, 0);
      if (
        held > Math.max(payload * 4, this.memory.budget.cpuBytes / 2) ||
        held + metadata > this.memory.budget.cpuBytes
      ) {
        // Borrowed views can pin far larger allocations; keep only the exposed bytes.
        value = this.memory.stage(payload, () => copyBuffers(value));
        backings = blockBuffers(value);
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

  destroy(): void {
    this.closed = true;
    for (const read of [...this.live]) {
      this.stop(read, failure('closed', 'Reader is closed'));
      read.meta.close();
    }
    this.live.clear();
  }
}
