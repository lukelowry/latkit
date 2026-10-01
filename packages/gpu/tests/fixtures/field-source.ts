import type {
  Column,
  Queryable,
  Query,
  QueryOptions,
  QueryHeader,
  RowsBlock,
  Schema,
  Update,
} from '@latkit/model';
import { rowAt, rowCount } from '@latkit/model';

export class FieldSource implements Queryable {
  version = 'v0';
  readonly index = { source: 'd', type: 'node', version: 'i0' };
  readonly listeners = new Set<(change: Update) => void>();
  readonly requests: Query[] = [];
  captured?: Set<number>;
  reversed = false;
  blockRows = 1024;
  readonly schema: Schema = {
    queries: ['rows'],
    limits: { maxBlockBytes: 1e6 },
    components: {
      node: {
        fields: {
          value: { type: 'float32' },
          position: { type: { kind: 'vector', items: 'float64', size: 2 } },
          color: { type: { kind: 'vector', items: 'float32', size: 4 } },
          visible: { type: 'boolean', nullable: true },
          observed: { type: 'float64', sampled: true, nullable: true },
        },
      },
    },
    connections: {},
    axis: { name: 'time' },
  };
  constructor(readonly count = 8) {}
  describe(): Promise<Schema> {
    return Promise.resolve(this.schema);
  }
  retain(): Promise<Queryable> {
    return Promise.resolve(new FieldSource(this.count));
  }
  close(): Promise<void> {
    this.publish({ kind: 'closed' });
    return Promise.resolve();
  }
  on(_event: 'change', listener: (change: Update) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(change: Update): void {
    if ('version' in change) this.version = change.version;
    for (const listener of this.listeners) listener(change);
  }
  query: Queryable['query'] = ((query: Query, options: QueryOptions = {}) =>
    this.read(query, options)) as Queryable['query'];
  private async *read(
    query: Query,
    options: QueryOptions,
  ): AsyncGenerator<QueryHeader | RowsBlock> {
    this.requests.push(query);
    if (query.kind !== 'rows') throw new Error('rows only');
    const selection = query.rows ?? { kind: 'range' as const, offset: 0, count: this.count };
    const selected =
      selection.kind === 'ids'
        ? selection.ids.map(Number)
        : Array.from({ length: rowCount(selection) }, (_, i) => rowAt(selection, i));
    if (this.reversed) selected.reverse();
    const fields = query.select as readonly string[];
    if (
      fields.includes('observed') &&
      this.captured &&
      selected.some((row) => !this.captured!.has(row))
    )
      throw Object.assign(new Error('Not captured'), { code: 'uncaptured' });
    const version = this.version;
    yield { kind: 'schema', version, schema: this.schema };
    const blockRows = Math.min(
      this.blockRows,
      Math.max(1, Math.floor((options.maxBlockBytes ?? 1e6) / 128)),
    );
    for (let offset = 0; offset < selected.length; offset += blockRows) {
      options.signal?.throwIfAborted();
      const rows = selected.slice(offset, offset + blockRows),
        columns: Record<string, Column> = {};
      for (const field of fields) {
        const base = { offset: 0, length: rows.length };
        if (field === 'position' || field === 'color') {
          const size = field === 'position' ? 2 : 4;
          const values =
            field === 'position'
              ? Float64Array.from(rows.flatMap((row) => [1e12 + row, 1e12 + row + 0.25]))
              : Float32Array.from(rows.flatMap((row) => [row / 8, 0.5, 1, 1]));
          columns[field] = {
            ...base,
            kind: 'vector',
            size,
            values: { kind: 'numeric', offset: 0, length: values.length, values },
          };
        } else if (field === 'visible') {
          const values = new Uint8Array(Math.ceil(rows.length / 8)),
            validity = new Uint8Array(values.length);
          rows.forEach((row, i) => {
            if (row % 2 === 0) values[i >>> 3] |= 1 << (i & 7);
            if (row !== 2) validity[i >>> 3] |= 1 << (i & 7);
          });
          columns[field] = { ...base, kind: 'boolean', values, validity };
        } else
          columns[field] = {
            ...base,
            kind: 'numeric',
            values:
              field === 'observed'
                ? Float64Array.from(rows, (row) => 1e12 + row + (query.at ?? 0))
                : Float32Array.from(rows),
          };
      }
      yield {
        kind: 'rows',
        version,
        index: this.index,
        rows: { kind: 'indices', values: Uint32Array.from(rows) },
        position: offset,
        columns,
      };
    }
  }
}
