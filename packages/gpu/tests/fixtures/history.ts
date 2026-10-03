import {
  createData,
  read,
  sliceSamples,
  type Data,
  type DataBatch,
  type Schema,
  type Query,
  type QueryOptions,
} from '@latkit/model';
export class HistorySource {
  readonly index = { source: 'history', type: 'node', version: 'i0' };
  readonly firstFrame = 2 ** 40;
  blockFrames = 2;
  reverseFrames = false;
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
  private cached?: Data;
  readonly schema: Schema = {
    axis: { name: 'coordinate' },
    types: {
      node: {
        fields: {
          value: { type: 'float64', sampled: true, nullable: true },
          weight: { type: 'float32' },
          label: { type: 'text' },
        },
      },
    },
  };
  get data(): Data {
    if (this.cached) return this.cached;
    const rows = { kind: 'range' as const, offset: 0, count: this.count };
    const batches: DataBatch[] = [
      {
        kind: 'rows',
        index: this.index,
        rows,
        ids: this.labels,
        columns: {
          label: this.labels,
          weight: {
            kind: 'numeric',
            offset: 0,
            length: this.count,
            values: Float32Array.from({ length: this.count }, (_, i) => i + 10),
          },
        },
      },
    ];
    for (let f = 0; f < this.coordinates.length; f += this.blockFrames) {
      const count = Math.min(this.blockFrames, this.coordinates.length - f);
      const column = sliceSamples(
        {
          kind: 'numeric',
          offset: 0,
          length: this.values.length,
          values: this.values,
          validity: this.validity,
          rowStride: 1,
          frameStride: this.count,
        },
        0,
        this.count,
        f,
        count,
      );
      batches.push({
        kind: 'samples',
        index: this.index,
        rows,
        firstFrame: this.firstFrame + f,
        coordinates: this.coordinates.subarray(f, f + count),
        columns: { value: column },
      });
    }
    if (this.reverseFrames) batches.reverse();
    return (this.cached = createData(this.schema, batches));
  }
  /** Rebuild the data value from the same application arrays. */
  publish(): void {
    this.cached = undefined;
  }
  query<Q extends Query>(query: Q, options?: QueryOptions) {
    return read(this.data, query, options);
  }
}
