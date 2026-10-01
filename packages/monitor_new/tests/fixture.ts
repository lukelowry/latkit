import {
  rowAt,
  rowCount,
  sliceRows,
  assertIndex,
  type Queryable,
  type Query,
  type QueryOptions,
  type QueryHeader,
  type QueryBlock,
  type Schema,
  type SampleWindow,
  type RowAxis,
  type Update,
  type EnvelopeBlock,
  type NumericColumn,
  type SampleColumn,
} from '@latkit/model';
/** Generated on demand: no row x history matrix or preallocated envelope cache. */
export class SignalSource implements Queryable {
  version = 'v0';
  readonly index = { document: 'monitor-fixture', type: 'signal', version: 'rows0' };
  readonly firstFrame = 2 ** 40;
  readonly requests: Query[] = [];
  reads = 0;
  observations = 0;
  blocks = 0;
  active = 0;
  peakBlockBytes = 0;
  yieldMs = 0;
  yieldCount = 0;
  readonly listeners = new Set<(event: Update) => void>();
  closed = false;
  revision = 0;
  before = 0;
  private async yield() {
    const begin = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.yieldMs += performance.now() - begin;
    this.yieldCount++;
  }
  constructor(
    readonly count = 32,
    public frames = 4096,
    readonly options: {
      native?: boolean;
      coordinateOrigin?: number;
      valueOrigin?: number;
      step?: number;
      gaps?: boolean;
      reverse?: boolean;
      blockFrames?: number;
      duplicates?: boolean;
    } = {},
  ) {}
  coordinate(frame: number) {
    return (
      (this.options.coordinateOrigin ?? 0) +
      (this.options.duplicates ? Math.floor(frame / 2) : frame) * (this.options.step ?? 0.01)
    );
  }
  value(row: number, frame: number, field = 'value') {
    return (
      (this.options.valueOrigin ?? 0) +
      Math.sin(frame * 0.013 + row * 0.071 + (field === 'other' ? 1 : 0)) *
        (0.35 + (row % 31) / 40) +
      Math.cos(frame * 0.0031 + row * 0.17) * 0.2
    );
  }
  valid(row: number, frame: number) {
    return (
      !this.options.gaps || (!(frame % 127 >= 45 && frame % 127 <= 55) && (row + frame) % 211 !== 0)
    );
  }
  get schema(): Schema {
    return {
      version: 'schema0',
      queries: [
        'rows',
        'samples',
        'aggregate',
        ...(this.options.native ? ['envelope' as const] : []),
      ],
      limits: { maxBlockBytes: 256 * 1024 },
      axis: { name: 'coordinate' },
      components: {
        signal: {
          fields: {
            value: { type: 'float64', sampled: true, nullable: true },
            other: { type: 'float64', sampled: true, nullable: true },
            weight: { type: 'float64' },
            visible: { type: 'float64', sampled: true },
          },
        },
      },
      connections: {},
    };
  }
  async describe() {
    if (this.closed) throw new Error('closed');
    return this.schema;
  }
  async retain() {
    const source = new SignalSource(this.count, this.frames, this.options);
    source.version = this.version;
    source.before = this.before;
    return source;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.listeners) fn({ kind: 'closed' });
    this.listeners.clear();
  }
  on(_event: 'change', listener: (update: Update) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  append(count: number) {
    const offset = this.firstFrame + this.frames;
    this.frames += count;
    this.version = 'v' + ++this.revision;
    for (const fn of this.listeners)
      fn({ kind: 'append', version: this.version, frames: { offset, count } });
  }
  evict(before: number) {
    this.before = before;
    this.version = 'v' + ++this.revision;
    for (const fn of this.listeners)
      fn({ kind: 'evict', version: this.version, beforeFrame: this.firstFrame + before });
  }
  query: Queryable['query'] = ((query: Query, options: QueryOptions = {}) =>
    this.read(query, options)) as Queryable['query'];
  private range(window: SampleWindow, frames: number, before: number): [number, number] {
    if (window.kind === 'frames') {
      const first = window.offset - this.firstFrame;
      if (first < before) throw new Error('expired');
      if (first + window.count > frames) throw new Error('future frames');
      return [first, first + window.count];
    }
    const lower = (value: number, inclusive: boolean) => {
      let lo = before,
        hi = frames;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2),
          at = this.coordinate(mid);
        if (at < value || (inclusive && at === value)) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    if (window.kind === 'at') {
      const end = lower(window.value, true);
      return [Math.max(before, end - 1), end];
    }
    if (before && window.between[0] < this.coordinate(before)) throw new Error('expired');
    return [
      Math.max(before, lower(window.between[0], false) - (window.context?.before ?? 0)),
      Math.min(frames, lower(window.between[1], true) + (window.context?.after ?? 0)),
    ];
  }
  private async *read(
    query: Query,
    options: QueryOptions,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    options.signal?.throwIfAborted();
    if (this.closed) throw new Error('closed');
    const version = this.version,
      frames = this.frames,
      before = this.before;
    this.reads++;
    this.active++;
    if (this.requests.length < 10000) this.requests.push(query);
    try {
      yield { kind: 'schema', version, schema: this.schema };
      if (!['samples', 'rows', 'aggregate', 'envelope'].includes(query.kind))
        throw new Error('unsupported');
      if (query.kind === 'endpoints' || query.kind === 'links') throw new Error('unsupported');
      if (query.rows && query.rows.kind !== 'ids' && query.rows.index)
        assertIndex(query.rows.index, this.index);
      const rows: RowAxis =
        query.rows?.kind === 'ids'
          ? { kind: 'indices', values: Uint32Array.from(query.rows.ids, Number) }
          : (query.rows ?? { kind: 'range', offset: 0, count: this.count });
      const total = rowCount(rows);
      for (let i = 0; i < total; i++)
        if (rowAt(rows, i) >= this.count) throw new Error('Unknown row');
      const window = 'window' in query ? query.window : undefined,
        [start, end] = window ? this.range(window, frames, before) : [0, 1];
      const limit = Math.min(options.maxBlockBytes ?? Infinity, this.schema.limits.maxBlockBytes);
      const emit = (block: QueryBlock, bytes: number) => {
        if (bytes > limit) throw new Error('Fixture block too large');
        this.blocks++;
        this.peakBlockBytes = Math.max(this.peakBlockBytes, bytes);
        return options.buffers === 'owned' ? structuredClone(block) : block;
      };
      if (query.kind === 'aggregate') {
        const values: Record<string, { count: number; min: number | null; max: number | null }> =
          {};
        let work = performance.now();
        for (const name of query.select) {
          let min = Infinity,
            max = -Infinity;
          for (let f = start; f < end; f++) {
            for (let r = 0; r < total; r++) {
              const row = rowAt(rows, r);
              if (name === 'weight' || this.valid(row, f)) {
                const value = name === 'weight' ? row : this.value(row, f, name);
                min = Math.min(min, value);
                max = Math.max(max, value);
              }
            }
            if (performance.now() - work > 3) {
              await this.yield();
              options.signal?.throwIfAborted();
              work = performance.now();
            }
          }
          values[name] = {
            count: total * (end - start),
            min: min === Infinity ? null : min,
            max: max === -Infinity ? null : max,
          };
        }
        yield { kind: 'aggregate', version, schemaVersion: 'schema0', values };
        return;
      }
      if (query.kind === 'envelope') {
        const buckets = query.buckets,
          span = query.window.between[1] - query.window.between[0],
          rowsPer = Math.max(
            1,
            Math.min(
              32,
              Math.floor((limit - 1024) / (Math.min(buckets, 256) * 100 * query.select.length)),
            ),
          ),
          bucketStep = Math.max(
            1,
            Math.min(buckets, Math.floor((limit - 1024) / (rowsPer * 100 * query.select.length))),
          );
        for (let r0 = 0; r0 < total; r0 += rowsPer)
          for (let b0 = 0; b0 < buckets; b0 += bucketStep) {
            const nr = Math.min(rowsPer, total - r0),
              nb = Math.min(bucketStep, buckets - b0),
              selected = sliceRows(rows, r0, nr),
              columns: EnvelopeBlock['columns'] = {};
            let work = performance.now();
            for (const name of query.select) {
              const values = new Float64Array(nr * nb * 4),
                coordinates = new Float64Array(values.length),
                ids = new Float64Array(values.length),
                validity = new Uint8Array(Math.ceil(values.length / 8)),
                continuous = new Uint8Array(Math.ceil((nr * nb) / 8));
              for (let r = 0; r < nr; r++)
                for (let b = 0; b < nb; b++) {
                  const bucket = b0 + b,
                    lo = query.window.between[0] + (span * bucket) / buckets,
                    hi = query.window.between[0] + (span * (bucket + 1)) / buckets;
                  let [first, last] = this.range(
                    { kind: 'range', between: [lo, hi] },
                    frames,
                    before,
                  );
                  if (bucket === 0) first = start;
                  if (bucket === buckets - 1) last = end;
                  else while (last > first && this.coordinate(last - 1) >= hi) last--;
                  let a = -1,
                    z = -1,
                    min = -1,
                    max = -1,
                    minimum = Infinity,
                    maximum = -Infinity,
                    gap = false;
                  for (let f = first; f < last; f++) {
                    this.observations++;
                    if (!this.valid(rowAt(selected, r), f)) {
                      gap = true;
                      continue;
                    }
                    const value = this.value(rowAt(selected, r), f, name);
                    if (a < 0) a = f;
                    z = f;
                    if (value < minimum) {
                      minimum = value;
                      min = f;
                    }
                    if (value > maximum) {
                      maximum = value;
                      max = f;
                    }
                  }
                  if (a >= 0) {
                    const cell = r * nb + b,
                      at = cell * 4;
                    for (const [slot, f] of [a, min, max, z].entries()) {
                      values[at + slot] = this.value(rowAt(selected, r), f, name);
                      coordinates[at + slot] = this.coordinate(f);
                      ids[at + slot] = this.firstFrame + f;
                      validity[(at + slot) >>> 3] |= 1 << ((at + slot) & 7);
                    }
                    if (!gap) continuous[cell >>> 3] |= 1 << (cell & 7);
                  }
                  if (performance.now() - work > 3) {
                    await this.yield();
                    options.signal?.throwIfAborted();
                    work = performance.now();
                  }
                }
              (columns as Record<string, unknown>)[name] = {
                values: { kind: 'numeric', values, validity, offset: 0, length: values.length },
                coordinates,
                frames: ids,
                continuous,
              };
            }
            options.signal?.throwIfAborted();
            yield emit(
              {
                kind: 'envelope',
                version,
                schemaVersion: 'schema0',
                index: this.index,
                rows: selected,
                rowOffset: r0,
                firstBucket: b0,
                bucketCount: nb,
                columns,
              },
              nr * nb * 100 * query.select.length + 1024,
            );
          }
        return;
      }
      const rowsPer = Math.max(
          1,
          Math.min(total, 1024, Math.floor((limit - 1024) / 32 / query.select.length)),
        ),
        frameStep = Math.max(
          1,
          Math.min(
            this.options.blockFrames ?? 1024,
            Math.floor((limit - 1024) / (rowsPer * 9 * query.select.length + 8)),
          ),
        );
      const offsets: number[] = [];
      for (let f = start; f < end; f += frameStep) offsets.push(f);
      if (this.options.reverse) offsets.reverse();
      for (let r0 = 0; r0 < total; r0 += rowsPer)
        for (const f0 of offsets) {
          const nr = Math.min(rowsPer, total - r0),
            nf = Math.min(frameStep, end - f0),
            selected = sliceRows(rows, r0, nr),
            columns: Record<string, SampleColumn | NumericColumn> = {};
          for (const name of query.select) {
            const n = query.kind === 'rows' ? nr : nr * nf,
              values = new Float64Array(n),
              validity = new Uint8Array(Math.ceil(n / 8));
            for (let i = 0; i < n; i++) {
              const row = rowAt(selected, i % nr),
                f = f0 + Math.floor(i / nr);
              values[i] =
                name === 'weight'
                  ? row
                  : name === 'visible'
                    ? f % 23 < 18
                      ? 1
                      : 0
                    : this.value(row, f, name);
              if (name === 'weight' || name === 'visible' || this.valid(row, f))
                validity[i >>> 3] |= 1 << (i & 7);
            }
            columns[name] = {
              kind: 'numeric',
              values,
              validity,
              offset: 0,
              length: n,
              ...(query.kind === 'samples' ? { rowStride: 1, frameStride: nr } : {}),
            };
            this.observations += n;
          }
          options.signal?.throwIfAborted();
          yield emit(
            query.kind === 'samples'
              ? {
                  kind: 'samples',
                  version,
                  schemaVersion: 'schema0',
                  index: this.index,
                  rows: selected,
                  rowOffset: r0,
                  firstFrame: this.firstFrame + f0,
                  coordinates: Float64Array.from({ length: nf }, (_, i) => this.coordinate(f0 + i)),
                  columns: columns as Record<string, SampleColumn>,
                }
              : {
                  kind: 'rows',
                  version,
                  schemaVersion: 'schema0',
                  index: this.index,
                  rows: selected,
                  position: r0,
                  columns,
                },
            nr * nf * 9 * query.select.length + nf * 8 + 1024,
          );
        }
    } finally {
      this.active--;
    }
  }
}
