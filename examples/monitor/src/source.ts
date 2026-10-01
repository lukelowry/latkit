import {
  blockByteLength,
  assertIndex,
  rowAt,
  rowCount,
  sliceRows,
  validateQuery,
  type Queryable,
  type Query,
  type QueryOptions,
  type QueryHeader,
  type QueryBlock,
  type RequestOptions,
  type RetainOptions,
  type RowAxis,
  type SampleWindow,
  type SampleColumn,
  type Schema,
  type Update,
  type Failure,
} from '@latkit/model';

function fail(code: Failure['code'], message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Example-owned acquisition. Published frames are immutable; retained reads share their backing. */
export class Telemetry implements Queryable {
  version = '0';
  readonly index;
  readonly schema: Schema;
  private frames: Float64Array[] = [];
  private first = 0;
  private fixed = false;
  private closed = false;
  private listeners = new Set<(update: Update) => void>();
  constructor(
    readonly fields: readonly string[],
    readonly count: number,
    readonly step: number,
    source = crypto.randomUUID(),
  ) {
    this.index = { source, type: 'sensor', version: '0' };
    this.schema = {
      queries: ['samples'],
      limits: { maxBlockBytes: 256 * 1024 },
      axis: { name: 'Time', unit: 's' },
      types: {
        sensor: {
          fields: Object.fromEntries(
            fields.map((name) => [name, { type: 'float64', sampled: true }]),
          ),
        },
      },
    };
  }
  private check(options?: RequestOptions): void {
    options?.signal?.throwIfAborted();
    if (this.closed) fail('closed', 'Telemetry acquisition is closed');
  }
  // Promise rejection is part of the Queryable contract.
  // eslint-disable-next-line @typescript-eslint/require-await
  async describe(options?: RequestOptions): Promise<Schema> {
    this.check(options);
    return this.schema;
  }
  /** Ownership of values passes to this source. The producer never mutates a published frame. */
  append(values: Float64Array): void {
    this.check();
    if (this.fixed) fail('invalid-input', 'Retained telemetry is immutable');
    if (values.length !== this.fields.length * this.count)
      fail('invalid-input', 'Wrong frame size');
    const offset = this.frames.length;
    this.frames.push(values);
    this.version = String(offset + 1);
    for (const listener of this.listeners)
      listener({ kind: 'append', version: this.version, frames: { offset, count: 1 } });
  }
  on(_event: 'change', listener: (update: Update) => void): () => void {
    this.check();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  // Promise rejection is part of the Queryable contract.
  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.frames = [];
    for (const listener of this.listeners) listener({ kind: 'closed' });
    this.listeners.clear();
  }
  private range(window: SampleWindow, end: number): [number, number] {
    if (window.kind === 'frames') {
      if (window.offset < this.first || window.offset + window.count > end)
        fail('invalid-input', 'Frames are outside this acquisition');
      return [window.offset, window.offset + window.count];
    }
    const lower = (value: number, inclusive: boolean) => {
      let lo = this.first,
        hi = end;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2),
          at = mid * this.step;
        if (at < value || (inclusive && at === value)) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    if (window.kind === 'at') {
      const hi = lower(window.value, true);
      return [Math.max(this.first, hi - 1), hi];
    }
    return [
      Math.max(this.first, lower(window.between[0], false) - (window.context?.before ?? 0)),
      Math.min(end, lower(window.between[1], true) + (window.context?.after ?? 0)),
    ];
  }
  // Promise rejection is part of the Queryable contract.
  // eslint-disable-next-line @typescript-eslint/require-await
  async retain(options: RetainOptions = {}): Promise<Queryable> {
    this.check(options);
    const end = this.first + this.frames.length;
    const [lo, hi] = options.window ? this.range(options.window, end) : [this.first, end];
    const bytes = (hi - lo) * this.fields.length * this.count * 8;
    const limit = options.maxBytes ?? 64 * 1024 ** 2;
    if (!Number.isSafeInteger(limit) || limit < 0) fail('invalid-input', 'Invalid retain budget');
    if (bytes > limit) fail('resource-limit', 'Telemetry retain budget exceeded');
    const retained = new Telemetry(this.fields, this.count, this.step, this.index.source);
    retained.frames = this.frames.slice(lo - this.first, hi - this.first);
    retained.first = lo;
    retained.version = this.version;
    retained.fixed = true;
    return retained;
  }
  query: Queryable['query'] = ((query: Query, options: QueryOptions = {}) =>
    this.read(query, options)) as Queryable['query'];
  private async *read(
    query: Query,
    options: QueryOptions,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    this.check(options);
    const issues = validateQuery(this.schema, query);
    if (issues.length) fail('invalid-input', issues[0]!.message);
    if (query.kind !== 'samples') fail('unsupported', 'Telemetry exposes sampled observations');
    const version = this.version,
      frames = this.frames,
      end = this.first + frames.length;
    const [lo, hi] = this.range(query.window, end);
    let rows: RowAxis;
    if (query.rows?.kind === 'ids') {
      rows = {
        kind: 'indices',
        values: Uint32Array.from(query.rows.ids, (id) => {
          const row = Number(id);
          if (!Number.isInteger(row) || row < 0 || row >= this.count || String(row) !== id)
            fail('invalid-input', 'Unknown sensor ID');
          return row;
        }),
      };
    } else {
      if (query.rows?.index) assertIndex(query.rows.index, this.index);
      rows = query.rows ?? { kind: 'range', offset: 0, count: this.count };
    }
    const count = rowCount(rows);
    for (let i = 0; i < count; i++)
      if (rowAt(rows, i) >= this.count) fail('invalid-input', 'Unknown sensor row');
    const bound = Math.min(options.maxBlockBytes ?? Infinity, this.schema.limits.maxBlockBytes);
    if (!Number.isSafeInteger(bound) || bound < 1) fail('invalid-input', 'Invalid block budget');
    const emptyColumns = Object.fromEntries(
      query.select.map((field) => [
        field,
        {
          kind: 'numeric' as const,
          offset: 0,
          length: 0,
          values: new Float64Array(0),
          frameStride: 0,
          rowStride: 1,
        },
      ]),
    );
    const overhead = blockByteLength({
      kind: 'samples',
      version,
      index: this.index,
      rows: sliceRows(rows, 0, 0),
      rowOffset: 0,
      firstFrame: lo,
      coordinates: new Float64Array(0),
      columns: emptyColumns,
    });
    const perRow = query.select.length * 8 + (rows.kind === 'indices' ? 4 : 0);
    const tileRows = Math.min(count, Math.floor((bound - overhead - 8) / Math.max(1, perRow)));
    if (tileRows < 1 && count && hi > lo)
      fail('resource-limit', 'A sample exceeds the block budget');
    yield { kind: 'schema', version, schema: this.schema };
    if (!count || hi === lo) return;
    let work = performance.now();
    for (let offset = 0; offset < count; offset += tileRows) {
      const n = Math.min(tileRows, count - offset),
        selected = sliceRows(rows, offset, n);
      const tileFrames = Math.min(
        64,
        Math.floor(
          (bound - overhead - (selected.kind === 'indices' ? n * 4 : 0)) /
            (n * query.select.length * 8 + 8),
        ),
      );
      for (let frame = lo; frame < hi; frame += tileFrames) {
        this.check(options);
        if (performance.now() - work > 3) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          this.check(options);
          work = performance.now();
        }
        const length = Math.min(tileFrames, hi - frame);
        const columns: Record<string, SampleColumn> = {};
        for (const field of query.select) {
          const base = this.fields.indexOf(field) * this.count;
          // Appends and exact readings borrow one frame. History packs bounded rectangles,
          // reducing hundreds of per-frame query/upload/draw operations to a handful of tiles.
          let values: Float64Array;
          if (length === 1 && selected.kind === 'range' && options.buffers !== 'owned') {
            values = frames[frame - this.first]!.subarray(
              base + selected.offset,
              base + selected.offset + n,
            );
          } else {
            values = new Float64Array(n * length);
            for (let f = 0; f < length; f++) {
              const input = frames[frame + f - this.first]!;
              if (selected.kind === 'range')
                values.set(
                  input.subarray(base + selected.offset, base + selected.offset + n),
                  f * n,
                );
              else
                for (let r = 0; r < n; r++) values[f * n + r] = input[base + selected.values[r]!]!;
            }
          }
          columns[field] = {
            kind: 'numeric',
            offset: 0,
            length: values.length,
            values,
            frameStride: n,
            rowStride: 1,
          };
        }
        const block: QueryBlock = {
          kind: 'samples',
          version,
          index: this.index,
          rows:
            selected.kind === 'indices' && options.buffers === 'owned'
              ? { kind: 'indices', values: selected.values.slice() }
              : selected,
          rowOffset: offset,
          firstFrame: frame,
          coordinates: Float64Array.from({ length }, (_, i) => (frame + i) * this.step),
          columns,
        };
        yield block;
      }
    }
  }
}
