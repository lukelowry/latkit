import {
  rowAt,
  rowCount,
  sliceRows,
  type Queryable,
  type Schema,
  type Query,
  type QueryOptions,
  type QueryHeader,
  type QueryBlock,
  type Column,
  type RowAxis,
  type Update,
  type EnvelopeBlock,
} from '@latkit/model';
export class HistorySource implements Queryable {
  version = 'v0';
  readonly index = { source: 'history', type: 'node', version: 'i0' };
  readonly firstFrame = 2 ** 40;
  readonly listeners = new Set<(change: Update) => void>();
  requests: Query[] = [];
  blockFrames = 2;
  reverseFrames = false;
  native?: EnvelopeBlock;
  readonly values: Float64Array;
  readonly validity: Uint8Array;
  readonly labels = {
    kind: 'text' as const,
    offset: 1,
    length: 2,
    bytes: new TextEncoder().encode('!\u03b1beta'),
    offsets: Int32Array.of(0, 1, 3, 7),
  };
  constructor(
    readonly coordinates = Float64Array.of(0, 1, 1, 2, 3, 4, 6),
    readonly count = 2,
  ) {
    this.values = Float64Array.from({ length: coordinates.length * count }, (_, i) =>
      count === 2 && coordinates.length === 7
        ? [
            [9, 2, 10, NaN, 1, 8, 4],
            [3, 5, 8, 2, 2, 9, 0],
          ][i % count][Math.floor(i / count)]
        : Math.sin(i),
    );
    this.validity = new Uint8Array(Math.ceil(this.values.length / 8)).fill(255);
    if (count === 2 && coordinates.length === 7) this.validity[0] &= ~(1 << 3);
  }
  get schema(): Schema {
    return {
      queries: this.native ? ['rows', 'samples', 'envelope'] : ['rows', 'samples'],
      limits: { maxBlockBytes: 1e6 },
      axis: { name: 'coordinate' },
      components: {
        node: {
          fields: {
            value: { type: 'float64', sampled: true, nullable: true },
            weight: { type: 'float32' },
            label: { type: 'text' },
          },
        },
      },
      connections: {},
    };
  }
  describe(): Promise<Schema> {
    return Promise.resolve(this.schema);
  }
  retain(): Promise<Queryable> {
    return Promise.resolve(this);
  }
  close(): Promise<void> {
    for (const listener of this.listeners) listener({ kind: 'closed' });
    return Promise.resolve();
  }
  on(_event: 'change', listener: (change: Update) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  query: Queryable['query'] = ((query: Query, options: QueryOptions = {}) =>
    this.read(query, options)) as Queryable['query'];
  private async *read(
    query: Query,
    options: QueryOptions,
  ): AsyncGenerator<QueryHeader | QueryBlock> {
    this.requests.push(query);
    options.signal?.throwIfAborted();
    yield { kind: 'schema', version: this.version, schema: this.schema };
    if (query.kind === 'envelope') {
      if (!this.native) throw new Error('unsupported');
      yield options.buffers === 'owned' ? structuredClone(this.native) : this.native;
      return;
    }
    if (query.kind !== 'rows' && query.kind !== 'samples') throw new Error('unsupported');
    const selected = query.rows;
    const rows: RowAxis =
      selected?.kind === 'ids'
        ? { kind: 'indices', values: Uint32Array.from(selected.ids, Number) }
        : (selected ?? { kind: 'range', offset: 0, count: this.count });
    const nr = rowCount(rows);
    if (query.kind === 'rows') {
      const columns: Record<string, Column> = {};
      for (const name of query.select) {
        if (name === 'label') columns[name] = this.labels;
        else
          columns[name] = {
            kind: 'numeric',
            offset: 0,
            length: nr,
            values: Float32Array.from({ length: nr }, (_, i) => rowAt(rows, i) + 10),
          };
      }
      const labels = query.ids ? { ...this.labels, length: nr } : undefined;
      yield {
        kind: 'rows',
        version: this.version,
        index: this.index,
        rows,
        position: 0,
        columns,
        ...(labels ? { ids: labels } : {}),
      };
      return;
    }
    const window = query.window;
    let first = 0,
      end = this.coordinates.length;
    if (window.kind === 'frames') {
      first = window.offset - this.firstFrame;
      end = first + window.count;
    } else if (window.kind === 'at') {
      while (first < end && this.coordinates[first] <= window.value) first++;
      end = first;
      first = Math.max(0, end - 1);
    } else {
      while (first < end && this.coordinates[first] < window.between[0]) first++;
      let last = first;
      while (last < end && this.coordinates[last] <= window.between[1]) last++;
      first = Math.max(0, first - (window.context?.before ?? 0));
      end = Math.min(end, last + (window.context?.after ?? 0));
    }
    const tiles: number[] = [];
    for (let frame = first; frame < end; frame += this.blockFrames) tiles.push(frame);
    if (this.reverseFrames) tiles.reverse();
    for (const frame of tiles) {
      options.signal?.throwIfAborted();
      const nf = Math.min(this.blockFrames, end - frame),
        columns: Record<string, import('@latkit/model').SampleColumn> = {};
      for (const name of query.select) {
        if (name !== 'value') throw new Error('Only value is sampled');
        if (rows.kind === 'range') {
          const at = frame * this.count + rows.offset,
            span = (nf - 1) * this.count + nr,
            start = Math.floor(at / 8) * 8;
          // Values and validity share absolute offsets, including deliberately unaddressed cells.
          columns[name] = {
            kind: 'numeric',
            values: this.values.subarray(start, at + span),
            validity: this.validity.subarray(start / 8, Math.ceil((at + span) / 8)),
            offset: at - start,
            length: span,
            rowStride: 1,
            frameStride: this.count,
          };
        } else {
          const values = new Float64Array(nf * nr),
            validity = new Uint8Array(Math.ceil(values.length / 8));
          for (let f = 0; f < nf; f++)
            for (let r = 0; r < nr; r++) {
              const at = (frame + f) * this.count + rowAt(rows, r),
                to = f * nr + r;
              values[to] = this.values[at];
              if (this.validity[at >>> 3] & (1 << (at & 7))) validity[to >>> 3] |= 1 << (to & 7);
            }
          columns[name] = {
            kind: 'numeric',
            values,
            validity,
            offset: 0,
            length: values.length,
            rowStride: 1,
            frameStride: nr,
          };
        }
      }
      yield {
        kind: 'samples',
        version: this.version,
        index: this.index,
        rows: sliceRows(rows, 0, nr),
        rowOffset: 0,
        firstFrame: this.firstFrame + frame,
        coordinates: this.coordinates.subarray(frame, frame + nf),
        columns,
      };
    }
  }
}
