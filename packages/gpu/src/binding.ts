import type {
  BooleanColumn,
  FieldSelection,
  Index,
  NumericColumn,
  Queryable,
  RowAxis,
  VectorColumn,
} from '@latkit/model';
import { GpuError, integer } from './error.js';

export interface FieldBinding extends FieldSelection {
  readonly source: Queryable;
}

/** Immutable application values, in explicitly identified physical row order. */
export interface FieldValues {
  readonly index: Index;
  readonly rows: RowAxis;
  readonly values: NumericColumn | VectorColumn | BooleanColumn;
}

export interface DataHit {
  readonly source: Queryable;
  readonly index: Index;
  readonly row: number;
  readonly field?: string;
  readonly frame?: number;
  readonly coordinate?: number;
}

export function sameIndex(a: Index, b: Index): boolean {
  return a.document === b.document && a.type === b.type && a.version === b.version;
}

export function assertIndex(expected: Index, actual: Index): void {
  if (!sameIndex(expected, actual))
    throw new GpuError('conflict', 'Physical row identities do not match');
}

export function rowCount(rows: RowAxis): number {
  if (rows.kind === 'range') {
    integer(rows.offset, 'row offset', 0, 0x100000000);
    return integer(rows.count, 'row count', 0, 0x100000000 - rows.offset);
  }
  if (!(rows.values instanceof Uint32Array))
    throw new GpuError('invalid-input', 'Row indices must be Uint32Array');
  return rows.values.length;
}

export function rowAt(rows: RowAxis, position: number): number {
  integer(position, 'row position', 0, rowCount(rows) - 1);
  return rows.kind === 'range' ? rows.offset + position : rows.values[position];
}

export function sliceRows(rows: RowAxis, offset: number, count: number): RowAxis {
  integer(offset, 'row slice offset', 0, rowCount(rows));
  integer(count, 'row slice count', 0, rowCount(rows) - offset);
  return rows.kind === 'range'
    ? { kind: 'range', offset: rows.offset + offset, count }
    : { kind: 'indices', values: rows.values.subarray(offset, offset + count) };
}
