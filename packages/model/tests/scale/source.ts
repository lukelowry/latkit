import { setImmediate } from 'node:timers/promises';
import type {
  Queryable,
  RetainOptions,
  Schema,
  Query,
  QueryHeader,
  QueryBlock,
  QueryOptions,
  RowsQuery,
  RowsBlock,
  SamplesQuery,
  EnvelopeQuery,
  EnvelopeBlock,
  SamplesBlock,
  EndpointsQuery,
  EndpointsBlock,
  LinksQuery,
  LinksBlock,
  AggregateQuery,
  AggregateBlock,
  RowAxis,
  Filter,
  NumericColumn,
  SampleColumn,
  Update,
  RequestOptions,
} from '../../src/index.js';
import { blockByteLength, blockBuffers, validateQuery } from '../../src/index.js';
import { text } from '../data.js';
import type { FrameRead } from '../source.js';
import { selectFrames, retainFrames } from '../source.js';
import { Store, failure, axisAt, axisLength, slice, interrupt } from './store.js';
export const schema: Schema = {
  queries: ['rows', 'aggregate'],
  limits: { maxBlockBytes: 256 * 1024 },
  components: {
    Node: {
      fields: {
        value: { type: 'float64' },
        output: { type: 'float64', sampled: true },
      },
    },
  },
  connections: {},
};
export interface Frame {
  readonly coordinate: number;
  readonly values: Float64Array;
}
export interface Read extends FrameRead<Frame> {
  readonly version: string;
  readonly schema: Schema;
  readonly frames?: readonly Frame[];
  readonly coverage?: RowAxis;
  readonly firstFrame?: number;
  readonly frameCount?: number;
  readonly firstCoordinate?: number;
}
export abstract class ScaleSource implements Queryable {
  private sourceClosed = false;
  abstract readonly version: string;
  abstract pin(): Read;
  readonly reads = new Map<AbortController, () => Promise<unknown>>();
  readonly listeners = new Set<(value: Update) => void>();
  constructor(readonly store: Store) {}
  async retain(options: RetainOptions = {}): Promise<Queryable> {
    const read = retainFrames(this.pin(), options);
    // Reserve the lazily materialized inputs. No scan or query is run.
    const backing = new Map<object, number>([[this.store, this.store.rows * 8]]);
    for (const frame of read.frames ?? []) {
      backing.set(frame, 8);
      backing.set(frame.values.buffer, frame.values.buffer.byteLength);
    }
    if (read.coverage?.kind === 'indices')
      backing.set(read.coverage.values.buffer, read.coverage.values.buffer.byteLength);
    if (read.grant?.frames) backing.set(read.grant.frames, read.grant.frames.length * 8);
    const store = this.store;
    const release = store.retention.acquire(backing, options.maxBytes);
    const releaseFrames = store.hold(read.frames ?? []);
    store.stats.acquisitions++;
    return new RetainedScaleSource(store, read, () => {
      release();
      releaseFrames();
      store.stats.acquisitions--;
    });
  }
  async close(): Promise<void> {
    if (this.sourceClosed) return;
    this.sourceClosed = true;
    await this.cancel();
    this.publish({ kind: 'closed' });
    this.listeners.clear();
  }
  async describe(options?: RequestOptions): Promise<Schema> {
    if (options?.signal?.aborted) throw failure('aborted');
    return this.pin().schema;
  }
  on(_event: 'change', listener: (value: Update) => void): () => void {
    if (this.sourceClosed) throw failure('closed');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  publish(value: Update): void {
    for (const listener of this.listeners) listener(value);
  }
  async cancel(): Promise<void> {
    const stopped = [];
    for (const [controller, stop] of this.reads) {
      controller.abort();
      stopped.push(stop());
    }
    await Promise.allSettled(stopped);
  }
  query(query: RowsQuery, options?: QueryOptions): AsyncIterable<QueryHeader | RowsBlock>;
  query(query: SamplesQuery, options?: QueryOptions): AsyncIterable<QueryHeader | SamplesBlock>;
  query(query: EnvelopeQuery, options?: QueryOptions): AsyncIterable<QueryHeader | EnvelopeBlock>;
  query(query: EndpointsQuery, options?: QueryOptions): AsyncIterable<QueryHeader | EndpointsBlock>;
  query(query: LinksQuery, options?: QueryOptions): AsyncIterable<QueryHeader | LinksBlock>;
  query(query: AggregateQuery, options?: QueryOptions): AsyncIterable<QueryHeader | AggregateBlock>;
  query(query: Query, options?: QueryOptions): AsyncIterable<QueryHeader | QueryBlock>;
  query(query: Query, options: QueryOptions = {}): AsyncIterable<QueryHeader | QueryBlock> {
    return {
      [Symbol.asyncIterator]: () => {
        const controller = new AbortController();
        const iterator = this.read(query, options, controller, () => iterator.return(undefined));
        return {
          next: () => iterator.next(),
          return: async () => {
            controller.abort();
            return iterator.return(undefined);
          },
          throw: async (error: unknown) => {
            controller.abort();
            await iterator.return(undefined);
            throw error;
          },
        };
      },
    };
  }
  private async *read(
    query: Query,
    options: QueryOptions,
    controller: AbortController,
    stop: () => Promise<unknown>,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    if (options.signal?.aborted) throw failure('aborted');
    const state = this.pin();
    const problems = validateQuery(state.schema, query);
    if (problems.length) throw Object.assign(failure('invalid-input'), { issues: problems });
    const abort = () => {
      controller.abort();
      void stop().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    this.reads.set(controller, stop);
    const stats = this.store.stats;
    stats.activeReads++;
    stats.openedReads++;
    stats.peakReads = Math.max(stats.peakReads, stats.activeReads);
    const blocks = this.blocks(query, state, options);
    try {
      yield { kind: 'schema', version: state.version, schema: state.schema };
      while (true) {
        if (controller.signal.aborted) throw failure('aborted');
        const gate = this.store.gate;
        if (gate) {
          stats.waitingReads++;
          try {
            await interrupt(gate, controller.signal);
          } finally {
            stats.waitingReads--;
          }
        }
        // Yield to the event loop, so timers and cross-thread cancellation can interrupt a scan.
        await setImmediate(undefined, { signal: controller.signal }).catch(() => {
          throw failure('aborted');
        });
        const next = blocks.next();
        if (next.done) break;
        const block = next.value;
        const bound = Math.min(options.maxBlockBytes ?? Infinity, schema.limits.maxBlockBytes);
        if (
          blockByteLength(block) > bound ||
          (options.buffers === 'owned' &&
            blockBuffers(block).reduce((n, b) => n + b.byteLength, 0) > bound)
        )
          throw failure('resource-limit');
        stats.blocks++;
        yield block;
      }
    } finally {
      blocks.return(undefined);
      options.signal?.removeEventListener('abort', abort);
      this.reads.delete(controller);
      stats.activeReads--;
      stats.releasedReads++;
    }
  }
  private rows(read: Read, selection: RowsQuery['rows'], sampled: boolean): RowAxis {
    const rows = this.store.select(selection);
    if (!sampled) return rows;
    if (!read.coverage) throw failure('invalid-input');
    if (!selection) return read.coverage;
    const covered = read.coverage.kind === 'indices' ? new Set(read.coverage.values) : undefined;
    for (let i = 0; i < axisLength(rows); i++) {
      const row = axisAt(rows, i);
      if (
        covered
          ? !covered.has(row)
          : row < (read.coverage as Extract<RowAxis, { kind: 'range' }>).offset ||
            row >=
              (read.coverage as Extract<RowAxis, { kind: 'range' }>).offset +
                axisLength(read.coverage)
      )
        throw failure('invalid-input');
    }
    return rows;
  }
  private value(read: Read, field: string, row: number, frame?: Frame): number {
    return field === 'value' ? this.store.at(row) : frame!.values[row];
  }
  private column(
    read: Read,
    field: string,
    rows: RowAxis,
    owned: boolean,
    frame?: Frame,
  ): NumericColumn {
    let values: Float64Array;
    if (rows.kind === 'range') {
      const source =
        field === 'value'
          ? this.store.page(Math.floor(rows.offset / this.store.pageRows))
          : frame!.values;
      const offset = field === 'value' ? rows.offset % this.store.pageRows : rows.offset;
      values = source.subarray(offset, offset + rows.count);
      if (owned) {
        values = values.slice();
        this.store.stats.ownedCopiedBytes += values.byteLength;
      }
    } else {
      values = Float64Array.from(rows.values, (row) => this.value(read, field, row, frame));
      this.store.stats.gatherCopiedBytes += values.byteLength;
    }
    return { kind: 'numeric', values, offset: 0, length: axisLength(rows) };
  }
  private count(rows: RowAxis, offset: number, bound: number, fields: number, ids = false): number {
    // Conservative metadata/ID allowance, verified against the actual canonical byte accounting.
    const count = Math.max(
      1,
      Math.floor(
        (bound - 768) /
          Math.max(4, fields * 8 + (rows.kind === 'indices' ? 4 : 0) + (ids ? 20 : 0)),
      ),
    );
    return Math.min(
      count,
      axisLength(rows) - offset,
      rows.kind === 'range'
        ? this.store.pageRows - ((rows.offset + offset) % this.store.pageRows)
        : Infinity,
    );
  }
  private *blocks(query: Query, read: Read, options: QueryOptions): Generator<QueryBlock> {
    const owned = options.buffers === 'owned',
      bound = Math.min(options.maxBlockBytes ?? Infinity, schema.limits.maxBlockBytes);
    if (query.kind === 'rows') {
      const sampled =
        query.select.includes('output') ||
        query.where?.some((f) => f.field === 'output') ||
        query.orderBy?.some((o) => o.field === 'output');
      const frame = sampled
        ? selectFrames(read, { kind: 'at', value: query.at! }).frames[0]
        : undefined;
      let rows = this.rows(read, query.rows, !!sampled);
      if (sampled && !frame) rows = { kind: 'range', offset: 0, count: 0 };
      if (query.where?.length || query.orderBy?.length) {
        const selected: number[] = [];
        for (let i = 0; i < axisLength(rows); i++) {
          const row = axisAt(rows, i);
          if ((query.where ?? []).every((f) => matches(this.value(read, f.field, row, frame), f)))
            selected.push(row);
        }
        if (query.orderBy?.length)
          selected.sort((a, b) => {
            for (const order of query.orderBy!) {
              const x = this.value(read, order.field, a, frame),
                y = this.value(read, order.field, b, frame);
              const c = x < y ? -1 : x > y ? 1 : 0;
              if (c) return order.direction === 'ascending' ? c : -c;
            }
            return a - b;
          });
        rows = { kind: 'indices', values: Uint32Array.from(selected) };
      }
      const total = axisLength(rows),
        offset = Math.min(total, query.offset ?? 0);
      rows = slice(rows, offset, Math.min(total - offset, query.limit ?? total));
      for (
        let position = 0;
        position < axisLength(rows) || (position === 0 && query.count && !axisLength(rows));
      ) {
        const count = this.count(rows, position, bound, query.select.length, query.ids);
        let part = slice(rows, position, count);
        if (owned && part.kind === 'indices') {
          part = { kind: 'indices', values: part.values.slice() };
          this.store.stats.ownedCopiedBytes += part.values.byteLength;
        }
        yield {
          kind: 'rows',
          version: read.version,
          index: this.store.index,
          rows: part,
          position,
          columns: Object.fromEntries(
            query.select.map((field) => [field, this.column(read, field, part, owned, frame)]),
          ),
          ...(query.count ? { total } : {}),
          ...(query.ids
            ? { ids: text(Array.from({ length: count }, (_, i) => 'n' + axisAt(part, i))) }
            : {}),
        };
        if (!count) break;
        position += count;
      }
    } else if (query.kind === 'samples') {
      const { frames, offset } = selectFrames(read, query.window),
        rows = this.rows(read, query.rows, true);
      for (let f = 0; f < frames.length; f++)
        for (let row = 0; row < axisLength(rows);) {
          const count = this.count(rows, row, bound, query.select.length);
          let part = slice(rows, row, count);
          if (owned && part.kind === 'indices') {
            part = { kind: 'indices', values: part.values.slice() };
            this.store.stats.ownedCopiedBytes += part.values.byteLength;
          }
          const columns: Record<string, SampleColumn> = {};
          for (const field of query.select)
            columns[field] = {
              ...this.column(read, field, part, owned, frames[f]),
              frameStride: count,
              rowStride: 1,
            };
          yield {
            kind: 'samples',
            version: read.version,
            index: this.store.index,
            rows: part,
            rowOffset: row,
            firstFrame: offset + f,
            coordinates: new Float64Array([frames[f].coordinate]),
            columns,
          };
          row += count;
        }
    } else if (query.kind === 'aggregate') {
      const rows = this.rows(read, query.rows, !!query.window),
        frames = query.window ? selectFrames(read, query.window).frames : [undefined];
      for (const field of query.select) {
        let count = 0,
          min = Infinity,
          max = -Infinity;
        for (const frame of frames)
          for (let i = 0; i < axisLength(rows); i++) {
            const value = this.value(read, field, axisAt(rows, i), frame);
            if (Number.isFinite(value)) {
              count++;
              min = Math.min(min, value);
              max = Math.max(max, value);
            }
          }
        yield {
          kind: 'aggregate',
          version: read.version,
          values: {
            [field]: {
              count,
              ...(query.measures.includes('min') ? { min: count ? min : null } : {}),
              ...(query.measures.includes('max') ? { max: count ? max : null } : {}),
            },
          },
        };
      }
    } else throw failure('unsupported');
  }
}
function matches(value: number, filter: Filter): boolean {
  switch (filter.operator) {
    case 'equal':
      return value === filter.value;
    case 'notEqual':
      return value !== filter.value;
    case 'lessThan':
      return value < filter.value;
    case 'lessThanOrEqual':
      return value <= filter.value;
    case 'greaterThan':
      return value > filter.value;
    case 'greaterThanOrEqual':
      return value >= filter.value;
    case 'contains':
      return false;
  }
}

class RetainedScaleSource extends ScaleSource {
  readonly version: string;
  private closing?: Promise<void>;
  constructor(
    store: Store,
    private readState: Read | undefined,
    private readonly release: () => void,
  ) {
    super(store);
    this.version = readState!.version;
  }
  pin(): Read {
    if (!this.readState) throw failure('closed');
    return this.readState;
  }
  override close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.readState = undefined;
      await super.close();
      this.release();
    })());
  }
}
