import { failure } from '../error.js';
import type { Data } from '../materialized.js';
import { BLOCK_BYTES, type Query } from '../query.js';
import type { ReadResult } from '../read.js';
import type { Domain } from '../types.js';
import { Blocks } from './blocks.js';
import { Fields, type FieldScope } from './fields.js';
import { Keys } from './keys.js';
import { Memory, type Entry, type MemoryStats } from '../memory.js';
import { interruptible } from '../work.js';
import type { ExtentRequest, FieldsBlock, FieldsRequest } from './types.js';

export interface ReaderOptions {
  /**
   * The pool that holds memoized blocks, field tiles, and extents, and bounds transient copies.
   * Borrowed: destroy never destroys it. Defaults to a pool of the reader's own.
   */
  readonly memory?: Memory;
  /** Bound of one read block. Defaults to 1 MiB. */
  readonly maxBlockBytes?: number;
  /** Validate schemas, queries, and blocks at this boundary. Defaults to false. */
  readonly validate?: boolean;
}

/** Bounded, memoized local reads over immutable Data, shared by everything that reads through it. */
export interface Reader {
  /** Reads whose results stay cached and held until the scope closes. */
  open(options?: { readonly signal?: AbortSignal; readonly at?: number }): ReadScope;
  /** The stats of the reader's memory pool. */
  stats(): MemoryStats;
  /** Evict every result no one holds from the reader's memory pool. */
  trim(): void;
  destroy(): void;
}

export interface ReadScope {
  readonly signal: AbortSignal;
  /** Coordinate sampled fields read at when a request has no window. */
  readonly at?: number;
  read<Q extends Query>(data: Data, query: Q): AsyncIterable<ReadResult<Q>>;
  fields(request: FieldsRequest): AsyncIterable<FieldsBlock>;
  extent(request: ExtentRequest): Promise<Domain | null>;
  /**
   * The same scope, noting in `record` what its reads hold and whether any read sampled fields at
   * the scope's coordinate: what work derived from the reads depends on.
   */
  recording(record: ReadRecord): ReadScope;
  /** Hold results again, as reused work derived from them does; false if any was evicted. */
  hold(entries: Iterable<Entry>): boolean;
  /** Iterators not yet finished, or extents still pending. */
  readonly busy: boolean;
  /** Stop reads and release every result this scope held. Idempotent. */
  close(): void;
}
/** What reads through a recording scope held, and whether they read at its coordinate. */
export interface ReadRecord {
  readonly entries: Set<Entry>;
  sampled: boolean;
}

export function createReader(options: ReaderOptions = {}): Reader {
  return new Cache(options);
}

class Cache implements Reader {
  readonly #memory: Memory;
  /** Whether the reader made its pool, and so destroys it. */
  readonly #owned: boolean;
  readonly #keys = new Keys();
  readonly #blocks: Blocks;
  readonly #fields: Fields;
  readonly #stopped = new AbortController();

  constructor(options: ReaderOptions) {
    this.#owned = !options.memory;
    this.#memory = options.memory ?? new Memory();
    const blockBytes = options.maxBlockBytes ?? BLOCK_BYTES;
    if (!Number.isSafeInteger(blockBytes) || blockBytes < 1)
      throw failure('invalid-input', 'Block bytes must be a positive integer');
    const bound = Math.max(
      1,
      Math.floor(
        Math.min(blockBytes, this.#memory.budget.cpuBytes / 4, this.#memory.budget.stagingBytes),
      ),
    );
    this.#blocks = new Blocks(this.#memory, this.#keys, bound, options.validate ?? false);
    this.#fields = new Fields(this.#memory, this.#keys, bound);
  }

  open(options: { readonly signal?: AbortSignal; readonly at?: number } = {}): ReadScope {
    this.#stopped.signal.throwIfAborted();
    if (options.at !== undefined && !Number.isFinite(options.at))
      throw failure('invalid-input', 'Read coordinate must be finite');
    const stop = new AbortController();
    const signal = AbortSignal.any([
      this.#stopped.signal,
      stop.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const held = new Set<Entry>(),
      iterators = new Set<AsyncIterator<unknown>>();
    let pending = 0,
      closed = false;
    const use = (entry: Entry) => {
      if (closed) throw failure('closed', 'Read scope is closed');
      if (!held.has(entry)) {
        entry.pin();
        held.add(entry);
      }
    };
    const guard = <T>(items: () => AsyncIterable<T>): AsyncIterable<T> => ({
      async *[Symbol.asyncIterator]() {
        signal.throwIfAborted();
        const iterator = items()[Symbol.asyncIterator]();
        iterators.add(iterator);
        try {
          for (;;) {
            const next = await interruptible(iterator.next(), signal);
            if (next.done) return;
            yield next.value;
          }
        } finally {
          iterators.delete(iterator);
          void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
        }
      },
    });
    const fields = this.#fields;
    /** The scope, noting into each record what its reads hold and whether they read at `at`. */
    const scope = (records: readonly ReadRecord[]): ReadScope => {
      const fieldScope: FieldScope = {
        signal,
        get at() {
          for (const record of records) record.sampled = true;
          return options.at;
        },
        read: <Q extends Query>(data: Data, query: Q) =>
          this.#blocks.read(data, query, signal) as AsyncIterable<ReadResult<Q>>,
        use: (entry) => {
          use(entry);
          for (const record of records) record.entries.add(entry);
        },
      };
      return {
        signal,
        at: options.at,
        read: (data, query) => guard(() => fieldScope.read(data, query)),
        fields: (request) => guard(() => fields.read(request, fieldScope)),
        extent(request) {
          signal.throwIfAborted();
          const work = fields.extent(request, fieldScope);
          pending++;
          const settle = () => void pending--;
          void work.then(settle, settle);
          return interruptible(work, signal);
        },
        recording: (record) => scope([...records, record]),
        hold(entries) {
          for (const entry of entries) {
            if (!entry.live || entry.retire) return false;
            fieldScope.use(entry);
          }
          return true;
        },
        get busy() {
          return iterators.size > 0 || pending > 0;
        },
        close() {
          if (closed) return;
          closed = true;
          stop.abort(new DOMException('Read scope closed', 'AbortError'));
          for (const entry of held) entry.unpin();
          held.clear();
        },
      };
    };
    return scope([]);
  }

  stats(): MemoryStats {
    return this.#memory.stats();
  }
  trim(): void {
    this.#memory.trim();
  }
  destroy(): void {
    if (this.#stopped.signal.aborted) return;
    this.#stopped.abort(failure('closed', 'Reader is closed'));
    this.#blocks.destroy();
    if (this.#owned) this.#memory.destroy();
  }
}
