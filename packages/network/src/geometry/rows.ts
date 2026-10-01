import { rowCount, rowAt } from '@latkit/model';
import { type NativeFields } from '@latkit/gpu';
import type { Column, Index, RowAxis } from '@latkit/model';
export function bit(bytes: Uint8Array | undefined, index: number): boolean {
  return !bytes || !!(bytes[index >>> 3] & (1 << (index & 7)));
}
export function value(column: Column | undefined, row: number, component = 0): number {
  if (!column || row < 0 || row >= column.length) return NaN;
  const at = column.offset + row;
  if (!bit(column.validity, at)) return NaN;
  if (column.kind === 'numeric') return column.values[at];
  if (column.kind === 'boolean') return bit(column.values, at) ? 1 : 0;
  if (column.kind === 'vector')
    return column.values.values[column.values.offset + at * column.size + component];
  return NaN;
}
export function nativeValue(
  native: NativeFields,
  name: string,
  row: number,
  component = 0,
): number {
  return bit(native.presence[name], row) ? value(native.columns[name], row, component) : NaN;
}
export function indexKey(index: Index): string {
  return JSON.stringify([index.document, index.type, index.version]);
}
/** Range lookup is logarithmic and allocation-free per physical row. Sparse rows allocate only their explicit entries. */
export class RowLookup<T> {
  private ranges: { offset: number; count: number; value: T }[] = [];
  private sparse = new Map<number, { value: T; offset: number }>();
  add(rows: RowAxis, data: T): void {
    if (rows.kind === 'range')
      this.ranges.push({ offset: rows.offset, count: rows.count, value: data });
    else
      for (let i = 0; i < rows.values.length; i++) {
        if (this.sparse.has(rows.values[i])) throw new Error('Duplicate physical row');
        this.sparse.set(rows.values[i], { value: data, offset: i });
      }
  }
  seal(): void {
    this.ranges.sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < this.ranges.length; i++)
      if (this.ranges[i].offset < this.ranges[i - 1].offset + this.ranges[i - 1].count)
        throw new Error('Overlapping physical rows');
    for (const row of this.sparse.keys())
      if (this.range(row)) throw new Error('Duplicate physical row');
  }
  private range(row: number): { value: T; offset: number } | undefined {
    let lo = 0,
      hi = this.ranges.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.ranges[m].offset <= row) lo = m + 1;
      else hi = m;
    }
    const found = this.ranges[lo - 1];
    return found && row < found.offset + found.count
      ? { value: found.value, offset: row - found.offset }
      : undefined;
  }
  get(row: number): { value: T; offset: number } | undefined {
    return this.sparse.get(row) ?? this.range(row);
  }
}
export function rowsEqual(a: RowAxis, b: RowAxis): boolean {
  if (a === b) return true;
  if (a.kind === 'range' && b.kind === 'range') return a.offset === b.offset && a.count === b.count;
  if (rowCount(a) !== rowCount(b)) return false;
  for (let i = 0; i < rowCount(a); i++) if (rowAt(a, i) !== rowAt(b, i)) return false;
  return true;
}
