import {
  createData,
  read,
  textColumn,
  type Data,
  type DataPatch,
  type Schema,
  type Query,
  type QueryOptions,
  type Column,
} from '@latkit/model';
export class FieldSource {
  version = 'v0';
  readonly index = { source: 'd', type: 'node', version: 'i0' };
  captured?: Set<number>;
  reversed = false;
  blockRows = 1024;
  private cached?: Data;
  readonly schema: Schema = {
    limits: { maxBlockBytes: 1e6 },
    axis: { name: 'time' },
    types: {
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
  };
  constructor(readonly count = 8) {}
  get data(): Data {
    if (this.cached?.version === this.version) return this.cached;
    const patches: DataPatch[] = [];
    for (let offset = 0; offset < this.count; offset += this.blockRows) {
      const count = Math.min(this.blockRows, this.count - offset),
        rows = Array.from({ length: count }, (_, i) => offset + i);
      if (this.reversed) rows.reverse();
      const columns: Record<string, Column> = {};
      const numeric = (values: Float32Array | Float64Array) => ({
        kind: 'numeric' as const,
        offset: 0,
        length: values.length,
        values,
      });
      columns.value = numeric(Float32Array.from(rows));
      columns.position = {
        kind: 'vector',
        offset: 0,
        length: count,
        size: 2,
        values: numeric(Float64Array.from(rows.flatMap((r) => [1e12 + r, 1e12 + r + 0.25]))),
      };
      columns.color = {
        kind: 'vector',
        offset: 0,
        length: count,
        size: 4,
        values: numeric(Float32Array.from(rows.flatMap((r) => [r / 8, 0.5, 1, 1]))),
      };
      const values = new Uint8Array(Math.ceil(count / 8)),
        validity = new Uint8Array(values.length);
      rows.forEach((r, i) => {
        if (r % 2 === 0) values[i >>> 3] |= 1 << (i & 7);
        if (r !== 2) validity[i >>> 3] |= 1 << (i & 7);
      });
      columns.visible = { kind: 'boolean', offset: 0, length: count, values, validity };
      patches.push({
        kind: 'rows',
        index: this.index,
        rows: { kind: 'indices', values: Uint32Array.from(rows) },
        columns,
        ids: textColumn(rows.map(String)),
      });
      const selected = this.captured ? rows.filter((r) => this.captured!.has(r)) : rows;
      for (let f = 0; f < 8; f++)
        patches.push({
          kind: 'samples',
          index: this.index,
          rows: { kind: 'indices', values: Uint32Array.from(selected) },
          firstFrame: f,
          coordinates: Float64Array.of(f),
          columns: {
            observed: {
              ...numeric(Float64Array.from(selected, (r) => 1e12 + r + f)),
              rowStride: 1,
              frameStride: Math.max(1, selected.length),
            },
          },
        });
    }
    return (this.cached = createData(this.schema, this.version, patches));
  }
  publish(change: { version?: string } = {}): void {
    this.version = change.version ?? this.version + '+';
    if (this.cached) this.cached = { ...this.cached, version: this.version };
  }
  query<Q extends Query>(query: Q, options?: QueryOptions) {
    return read(this.data, query, options);
  }
}
