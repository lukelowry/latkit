/** Columns over arrays a page owns, and the rows they fill: what every page builds its Data from. */
import type { Column, Index, Data } from '@latkit/model';

export function numeric<T extends Column.NumericArray>(values: T): Column.Numeric & { values: T } {
  return { kind: 'numeric', offset: 0, length: values.length, values };
}
/** A vector of `size` numbers per row, laid end to end. */
export function vector(values: Float32Array | Float64Array, size = 2): Column {
  return { kind: 'vector', offset: 0, length: values.length / size, size, values: numeric(values) };
}
/** Each row a row of `to`. */
export function references(to: Index, rows: Uint32Array): Column.Reference {
  return { kind: 'reference', index: to, offset: 0, length: rows.length, values: rows };
}
/** Each row a run of `values`: row i holds those from `offsets[i]` up to `offsets[i + 1]`. */
export function lists(offsets: Int32Array, values: Column): Column.List {
  return { kind: 'list', offset: 0, length: offsets.length - 1, offsets, values };
}
/** Each row a flag, packed eight to a byte. */
export function flags(values: ArrayLike<number | boolean>): Column {
  const bits = new Uint8Array(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) if (values[i]) bits[i >>> 3]! |= 1 << (i & 7);
  return { kind: 'boolean', offset: 0, length: values.length, values: bits };
}
/** UTF-8 text already laid end to end: row i spans `bytes` from `offsets[i]` to `offsets[i + 1]`. */
export function text(offsets: Int32Array, bytes: Uint8Array): Column.Text {
  return { kind: 'text', offset: 0, length: offsets.length - 1, offsets, bytes };
}
/** All `count` rows of a type, with the columns given. */
export function rows(
  index: Index,
  count: number,
  columns: Readonly<Record<string, Column>>,
  ids?: Column.Text,
): Data.RowBatch {
  return {
    kind: 'rows',
    index,
    rows: { kind: 'range', offset: 0, count },
    columns,
    ...(ids ? { ids } : {}),
  };
}
