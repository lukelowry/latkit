import type {
  BooleanColumn,
  ListColumn,
  RowSelection,
  Index,
  NumericColumn,
  Queryable,
  RowAxis,
  VectorColumn,
  SampleWindow,
} from '@latkit/model';
import { GpuError, integer } from './error.js';

export interface FieldBinding {
  readonly source: Queryable;
  readonly from: string;
  readonly field: string;
  /** Explicit coverage for a partial overlay. Omitted means every draw row is required. */
  readonly rows?: RowSelection;
}

/** Native numeric columns accepted by the shared field pipeline. List items are non-nullable. */
export type FieldColumn =
  | NumericColumn
  | VectorColumn
  | BooleanColumn
  | (ListColumn & { readonly values: NumericColumn | VectorColumn });

export type FieldInput = string | FieldBinding | FieldValues;

export interface FieldsRequest {
  /** Default acquisition for string fields. Omit when every input is explicit. */
  readonly source?: Queryable;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly fields: Readonly<Record<string, FieldInput>>;
  readonly float64: 'relative' | 'float32';
  /** Native fields also needed by CPU geometry or interaction. Shares the upload's resolved columns. */
  readonly read?: readonly string[];
  /** Aliases to upload; defaults to all fields. Native-only control fields need no duplicate GPU allocation. */
  readonly upload?: readonly string[];
}

/** Immutable application values, in explicitly identified physical row order. */
export interface FieldValues {
  readonly index: Index;
  readonly rows: RowAxis;
  readonly values: FieldColumn;
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

/** Borrowed immutable data before float conversion. Presence is distinct from validity.
 * A GPU page may reference a larger native tile; address columns using this object's rows. */
export interface NativeFields {
  readonly index: Index;
  readonly rows: RowAxis;
  readonly columns: Readonly<Record<string, FieldColumn>>;
  readonly presence: Readonly<Record<string, Uint8Array>>;
  /** Call during preparation. Keeps backing allocations in the Gpu budget until idempotent release. */
  retain(): () => void;
}

/** Finite scalar extent over the complete selected mapping. Null means no finite values. */
export interface ExtentRequest {
  readonly source?: Queryable;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly field: FieldInput;
  readonly window?: SampleWindow;
}
