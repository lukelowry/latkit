/** Columns over arrays the page owns: a number per row, or a vector of two. */
import type { Column } from '@latkit/model';

export function numeric<T extends Column.NumericArray>(values: T): Column.Numeric & { values: T } {
  return { kind: 'numeric', offset: 0, length: values.length, values };
}
export function vector(values: Float32Array | Float64Array): Column {
  return { kind: 'vector', offset: 0, length: values.length / 2, size: 2, values: numeric(values) };
}
/** One frame of a field, a value per row. */
export function samples(values: Float32Array): Column.Sample {
  return { ...numeric(values), rowStride: 1, frameStride: values.length };
}
