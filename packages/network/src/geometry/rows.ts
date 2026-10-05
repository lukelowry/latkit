import { bitAt, failure } from '@latkit/model';
import type { Column, Index, RowAxis } from '@latkit/model';
export function value(column: Column | undefined, row: number, component = 0): number {
  if (!column || row < 0 || row >= column.length) return NaN;
  const at = column.offset + row;
  if (!bitAt(column.validity, at)) return NaN;
  if (column.kind === 'numeric') return column.values[at];
  if (column.kind === 'boolean') return bitAt(column.values, at) ? 1 : 0;
  if (column.kind === 'vector')
    return column.values.values[column.values.offset + at * column.size + component];
  return NaN;
}
export function indexKey(index: Index): string {
  return JSON.stringify([index.source, index.type, index.version]);
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
        if (this.sparse.has(rows.values[i]))
          throw failure('invalid-input', 'Duplicate physical row');
        this.sparse.set(rows.values[i], { value: data, offset: i });
      }
  }
  seal(): void {
    this.ranges.sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < this.ranges.length; i++)
      if (this.ranges[i].offset < this.ranges[i - 1].offset + this.ranges[i - 1].count)
        throw failure('invalid-input', 'Overlapping physical rows');
    for (const row of this.sparse.keys())
      if (this.range(row)) throw failure('invalid-input', 'Duplicate physical row');
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
