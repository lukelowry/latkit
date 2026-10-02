import {
  appendData,
  createData,
  read,
  type Data,
  type RowBatch,
  type SampleBatch,
  type Schema,
  type Query,
  type QueryOptions,
} from '@latkit/model';
/** Values belong to this test application's store, with small independent backing allocations. */
export class SignalSource {
  readonly index = { source: 'monitor-fixture', type: 'signal', version: 'rows0' };
  readonly firstFrame = 2 ** 40;
  before = 0;
  private cached?: Data;
  private storedThrough = 0;
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
  readonly schema: Schema = {
    axis: { name: 'coordinate' },
    types: {
      signal: {
        fields: {
          value: { type: 'float64', sampled: true, nullable: true },
          other: { type: 'float64', sampled: true, nullable: true },
          weight: { type: 'float64' },
          visible: { type: 'float64', sampled: true },
        },
      },
    },
  };
  get data(): Data {
    if (this.cached && this.storedThrough === this.frames) return this.cached;
    const rows = { kind: 'range' as const, offset: 0, count: this.count },
      batches: SampleBatch[] = [];
    const staticBatches: RowBatch[] = [];
    if (!this.cached)
      staticBatches.push({
        kind: 'rows',
        index: this.index,
        rows,
        columns: {
          weight: {
            kind: 'numeric',
            offset: 0,
            length: this.count,
            values: Float64Array.from({ length: this.count }, (_, i) => i),
          },
        },
      });
    for (let f = this.storedThrough; f < this.frames; f += this.options.blockFrames ?? 64) {
      const nf = Math.min(this.options.blockFrames ?? 64, this.frames - f);
      const coordinates = Float64Array.from({ length: nf }, (_, i) => this.coordinate(f + i));
      for (let r = 0; r < this.count; r += 16) {
        const nr = Math.min(16, this.count - r);
        const columns: import('@latkit/model').SampleBatch['columns'] = Object.fromEntries(
          ['value', 'other', 'visible'].map((name) => {
            const values = new Float64Array(nr * nf),
              validity = new Uint8Array(Math.ceil(values.length / 8));
            for (let j = 0; j < nf; j++)
              for (let i = 0; i < nr; i++) {
                const at = j * nr + i;
                values[at] =
                  name === 'visible' ? ((f + j) % 23 < 18 ? 1 : 0) : this.value(r + i, f + j, name);
                if (name === 'visible' || this.valid(r + i, f + j))
                  validity[at >>> 3] |= 1 << (at & 7);
              }
            return [
              name,
              {
                kind: 'numeric',
                offset: 0,
                length: values.length,
                values,
                validity,
                rowStride: 1,
                frameStride: nr,
              },
            ];
          }),
        );
        batches.push({
          kind: 'samples',
          index: this.index,
          rows: { kind: 'range', offset: r, count: nr },
          firstFrame: this.firstFrame + f,
          coordinates,
          columns,
        });
      }
    }
    this.storedThrough = this.frames;
    this.cached = this.cached
      ? appendData(this.cached, batches)
      : createData(this.schema, [...staticBatches, ...batches]);
    return this.cached;
  }
  append(count: number): void {
    this.frames += count;
  }
  query<Q extends Query>(query: Q, options?: QueryOptions) {
    return read(this.data, query, options);
  }
}
