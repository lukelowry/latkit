import type {
  Index,
  RowAxis,
  NumericColumn,
  ReferenceColumn,
  TextColumn,
  SampleColumn,
} from './data.js';
import { failure } from './error.js';

function integer(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw failure('invalid-input', `Invalid ${name}`);
  return value;
}
export function sameIndex(a: Index, b: Index): boolean {
  return a.source === b.source && a.type === b.type && a.version === b.version;
}
export function assertIndex(expected: Index, actual: Index): void {
  if (!sameIndex(expected, actual))
    throw failure('conflict', 'Physical row identities do not match');
}
export function rowCount(rows: RowAxis): number {
  if (rows.kind === 'range') {
    integer(rows.offset, 'row offset', 0, 0x100000000);
    return integer(rows.count, 'row count', 0, 0x100000000 - rows.offset);
  }
  if (!(rows.values instanceof Uint32Array))
    throw failure('invalid-input', 'Row indices must be Uint32Array');
  return rows.values.length;
}
export function rowAt(rows: RowAxis, position: number): number {
  integer(position, 'row position', 0, rowCount(rows) - 1);
  return rows.kind === 'range' ? rows.offset + position : rows.values[position];
}
/** A view into an immutable axis; sparse slices preserve their backing allocation. */
export function sliceRows(rows: RowAxis, offset: number, count: number): RowAxis {
  integer(offset, 'row slice offset', 0, rowCount(rows));
  integer(count, 'row slice count', 0, rowCount(rows) - offset);
  return rows.kind === 'range'
    ? { kind: 'range', offset: rows.offset + offset, count }
    : { kind: 'indices', values: rows.values.subarray(offset, offset + count) };
}
/** Tests an absolute bitmap address. An omitted bitmap means all present. */
export function bitAt(bitmap: Uint8Array | undefined, position: number): boolean {
  return !bitmap || (bitmap[position >>> 3] & (1 << (position & 7))) !== 0;
}
export function setBit(bitmap: Uint8Array, position: number): void {
  bitmap[position >>> 3] |= 1 << (position & 7);
}
/** Null and present nonfinite observations are distinct. A reference reads as its row. */
export function numberAt(column: NumericColumn | ReferenceColumn, position: number): number | null {
  integer(position, 'column position', 0, column.length - 1);
  const at = column.offset + position;
  return bitAt(column.validity, at) ? column.values[at] : null;
}
const decoder = new TextDecoder();
/** Decode only the requested UTF-8 cell. */
export function textAt(column: TextColumn, position: number): string | null {
  integer(position, 'column position', 0, column.length - 1);
  const at = column.offset + position;
  return bitAt(column.validity, at)
    ? decoder.decode(column.bytes.subarray(column.offsets[at], column.offsets[at + 1]))
    : null;
}
/** The observation of a row at a frame, both relative to the column; one bounds check per cell. */
export function sampleAt(column: SampleColumn, row: number, frame: number): number | null {
  const position = row * column.rowStride + frame * column.frameStride;
  if (
    !Number.isSafeInteger(row) ||
    !Number.isSafeInteger(frame) ||
    row < 0 ||
    frame < 0 ||
    position >= column.length
  )
    throw failure('invalid-input', 'Invalid sample position');
  const at = column.offset + position;
  return bitAt(column.validity, at) ? column.values[at] : null;
}
