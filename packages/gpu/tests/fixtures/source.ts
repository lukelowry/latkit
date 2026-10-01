import type {
  Queryable,
  Query,
  QueryOptions,
  QueryBlock,
  QueryHeader,
  Schema,
  Update,
  RowsBlock,
  SamplesBlock,
} from '@latkit/model';
import { interruptible } from '../../src/error.js';

export class Source implements Queryable {
  version = 'v0';
  reads = 0;
  pulls = 0;
  ended = 0;
  closes = 0;
  gate?: Promise<void>;
  listeners = new Set<(change: Update) => void>();
  values: Float32Array | Float64Array;
  readonly schema: Schema;
  readonly index = { source: 'document', type: 'node', version: 'rows0' };
  constructor(
    readonly count = 16,
    readonly options: {
      blockRows?: number;
      sampled?: boolean;
      frames?: number;
      float64?: boolean;
    } = {},
  ) {
    const length = count * (options.sampled ? (options.frames ?? 4) : 1);
    this.values = options.float64
      ? Float64Array.from({ length }, (_, i) => 1e12 + i / 4)
      : Float32Array.from({ length }, (_, i) => i);
    this.schema = {
      queries: options.sampled ? ['rows', 'samples'] : ['rows'],
      limits: { maxBlockBytes: 8 * 1024 ** 2 },
      components: {
        node: {
          fields: {
            value: {
              type: options.float64 ? 'float64' : 'float32',
              ...(options.sampled ? { sampled: true as const } : {}),
            },
          },
        },
      },
      connections: {},
      ...(options.sampled ? { axis: { name: 'coordinate', unit: 'step' } } : {}),
    };
  }
  describe(): Promise<Schema> {
    return Promise.resolve(this.schema);
  }
  retain(): Promise<Queryable> {
    const next = new Source(this.count, this.options);
    next.values = this.values;
    next.version = this.version;
    return Promise.resolve(next);
  }
  close(): Promise<void> {
    this.closes++;
    this.publish({ kind: 'closed' });
    return Promise.resolve();
  }
  on(_event: 'change', listener: (change: Update) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(change?: Update): void {
    if (!change) {
      this.version += '+';
      change = { kind: 'replace', version: this.version };
    }
    for (const listener of this.listeners) listener(change);
  }
  query: Queryable['query'] = ((query: Query, options: QueryOptions = {}) =>
    this.read(query, options)) as Queryable['query'];
  private async *read(
    query: Query,
    options: QueryOptions,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    this.reads++;
    const version = this.version,
      values = this.values;
    try {
      options.signal?.throwIfAborted();
      if (this.gate) await (options.signal ? interruptible(this.gate, options.signal) : this.gate);
      yield { kind: 'schema', version, schema: this.schema };
      if (query.kind !== 'rows' && query.kind !== 'samples')
        throw new Error('Fixture supports rows and samples');
      const selected = query.rows;
      if (selected && selected.kind !== 'range') throw new Error('Fixture selects ranges');
      const start = selected?.offset ?? 0,
        total = selected?.count ?? this.count;
      const blockRows = Math.max(
        1,
        Math.min(
          this.options.blockRows ?? 4096,
          Math.floor(((options.maxBlockBytes ?? 1e6) - 512) / values.BYTES_PER_ELEMENT),
        ),
      );
      const firstFrame =
        query.kind === 'samples' && query.window.kind === 'frames'
          ? query.window.offset
          : query.kind === 'samples' && query.window.kind === 'at'
            ? Math.floor(query.window.value)
            : query.kind === 'rows' && query.at !== undefined
              ? Math.floor(query.at)
              : 0;
      const frameCount =
        query.kind === 'samples' && query.window.kind === 'frames' ? query.window.count : 1;
      if (firstFrame < 0) return;
      for (let frame = firstFrame; frame < firstFrame + frameCount; frame++)
        for (let offset = 0; offset < total; offset += blockRows) {
          options.signal?.throwIfAborted();
          this.pulls++;
          const count = Math.min(blockRows, total - offset),
            physical = start + offset;
          const view = values.subarray(
            frame * this.count + physical,
            frame * this.count + physical + count,
          );
          const column = {
            kind: 'numeric' as const,
            values: options.buffers === 'owned' ? view.slice() : view,
            offset: 0,
            length: count,
          };
          const base = {
            version,
            index: this.index,
            rows: { kind: 'range' as const, offset: physical, count },
          };
          if (query.kind === 'rows')
            yield {
              ...base,
              kind: 'rows',
              position: offset,
              columns: { value: column },
            } satisfies RowsBlock;
          else
            yield {
              ...base,
              kind: 'samples',
              rowOffset: offset,
              firstFrame: frame,
              coordinates: Float64Array.of(frame),
              columns: { value: { ...column, rowStride: 1, frameStride: count } },
            } satisfies SamplesBlock;
        }
    } finally {
      this.ended++;
    }
  }
}
