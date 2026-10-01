import type { Index, RowAxis, NumericColumn, TextColumn, SampleColumn } from './data.js';

function integer(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Object.assign(new RangeError(`Invalid ${name}`), { code: 'invalid-input' });
  return value;
}
export function sameIndex(a: Index, b: Index): boolean {
  return a.source === b.source && a.type === b.type && a.version === b.version;
}
export function assertIndex(expected: Index, actual: Index): void {
  if (!sameIndex(expected, actual))
    throw Object.assign(new Error('Physical row identities do not match'), { code: 'conflict' });
}
export function rowCount(rows: RowAxis): number {
  if (rows.kind === 'range') {
    integer(rows.offset, 'row offset', 0, 0x100000000);
    return integer(rows.count, 'row count', 0, 0x100000000 - rows.offset);
  }
  if (!(rows.values instanceof Uint32Array))
    throw Object.assign(new TypeError('Row indices must be Uint32Array'), {
      code: 'invalid-input',
    });
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
/** Null and present nonfinite observations are distinct. */
export function numberAt(column: NumericColumn, position: number): number | null {
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
export function sampleAt(
  column: SampleColumn,
  position: { readonly row: number; readonly frame: number },
): number | null {
  integer(position.row, 'sample row');
  integer(position.frame, 'sample frame');
  return numberAt(column, position.row * column.rowStride + position.frame * column.frameStride);
}
