import {
  createData,
  read,
  type Data,
  type DataBatch,
  type Schema,
  type Query,
  type QueryOptions,
} from '@latkit/model';
/** Application-owned fixture; data values are independent of the mutable test harness. */
export class Source {
  values: Float32Array | Float64Array;
  readonly schema: Schema;
  readonly index = { source: 'document', type: 'node', version: 'rows0' };
  private cached?: Data;
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
      types: {
        node: {
          fields: {
            value: {
              type: options.float64 ? 'float64' : 'float32',
              ...(options.sampled ? { sampled: true as const } : {}),
            },
          },
        },
      },
      ...(options.sampled ? { axis: { name: 'coordinate', unit: 'step' } } : {}),
    };
  }
  get data(): Data {
    if (this.cached) return this.cached;
    const batches: DataBatch[] = [];
    for (let f = 0; f < (this.options.sampled ? (this.options.frames ?? 4) : 1); f++)
      for (let offset = 0; offset < this.count; offset += this.options.blockRows ?? 4096) {
        const count = Math.min(this.options.blockRows ?? 4096, this.count - offset);
        const column = {
          kind: 'numeric' as const,
          offset: 0,
          length: count,
          values: this.values.subarray(f * this.count + offset, f * this.count + offset + count),
        };
        const base = { index: this.index, rows: { kind: 'range' as const, offset, count } };
        batches.push(
          this.options.sampled
            ? {
                ...base,
                kind: 'samples',
                firstFrame: f,
                coordinates: Float64Array.of(f),
                columns: { value: { ...column, rowStride: 1, frameStride: count } },
              }
            : { ...base, kind: 'rows', columns: { value: column } },
        );
      }
    return (this.cached = createData(this.schema, batches));
  }
  /** Rebuild the data value from the current application arrays. */
  publish(): void {
    this.cached = undefined;
  }
  query<Q extends Query>(query: Q, options?: QueryOptions) {
    return read(this.data, query, options);
  }
}
