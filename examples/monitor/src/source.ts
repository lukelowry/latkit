import { appendData, createData, type Data, type SampleBatch, type Schema } from '@latkit/model';

/** Application storage. Keeping history is an explicit choice made by this example. */
export class Telemetry {
  readonly index;
  readonly schema: Schema;
  private frame = 0;
  data: Data;
  constructor(
    readonly fields: readonly string[],
    readonly count: number,
    readonly step: number,
    source = crypto.randomUUID(),
  ) {
    this.index = { source, type: 'sensor', version: '0' };
    this.schema = {
      axis: { name: 'Time', unit: 's' },
      types: {
        sensor: {
          fields: Object.fromEntries(
            fields.map((name) => [name, { type: 'float64', sampled: true }]),
          ),
        },
      },
    };
    this.data = createData(this.schema, '0', []);
  }
  /** Ownership of values passes to the application store. Never mutate published buffers. */
  append(values: Float64Array): void {
    if (values.length !== this.fields.length * this.count) throw new RangeError('Wrong frame size');
    const frame = this.frame++;
    const batch: SampleBatch = {
      kind: 'samples',
      index: this.index,
      rows: { kind: 'range', offset: 0, count: this.count },
      firstFrame: frame,
      coordinates: Float64Array.of(frame * this.step),
      columns: Object.fromEntries(
        this.fields.map((name, i) => [
          name,
          {
            kind: 'numeric',
            offset: 0,
            length: this.count,
            values: values.subarray(i * this.count, (i + 1) * this.count),
            rowStride: 1,
            frameStride: this.count,
          },
        ]),
      ),
    };
    this.data = appendData(this.data, String(frame + 1), [batch]);
  }
}
