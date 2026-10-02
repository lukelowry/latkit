import type { ColumnPages } from './pages.js';
import type { ColumnPage } from './materialized.js';
import type { TextColumn } from './data.js';
import { bitAt, rowCount } from './access.js';

const encoder = new TextEncoder();

/** Each ID's row, keyed by the UTF-8 bytes already in the ID pages: no string per row. As with a
 *  map, a later page wins a repeated ID, and null IDs are absent. */
export class IdIndex {
  private readonly pages: readonly ColumnPage[];
  /** Each page's first entry; the last is the entry count. */
  private readonly starts: Uint32Array;
  private readonly rows: Uint32Array;
  /** Entry + 1 per slot, 0 when empty; a power of two, at most half full. */
  private readonly slots: Uint32Array;

  constructor(pages: ColumnPages) {
    this.pages = Array.from(pages);
    this.starts = new Uint32Array(this.pages.length + 1);
    this.pages.forEach((page, p) => (this.starts[p + 1] = this.starts[p] + rowCount(page.rows)));
    const count = this.starts[this.pages.length];
    let size = 16;
    while (size < 2 * count) size *= 2;
    this.slots = new Uint32Array(size);
    this.rows = new Uint32Array(count);
    this.pages.forEach((page, p) => {
      const column = page.column as TextColumn,
        axis = page.rows;
      for (let i = 0, n = this.starts[p + 1] - this.starts[p]; i < n; i++) {
        const entry = this.starts[p] + i,
          at = column.offset + i;
        this.rows[entry] = axis.kind === 'range' ? axis.offset + i : axis.values[i];
        if (bitAt(column.validity, at))
          this.slots[this.probe(column.bytes, column.offsets[at], column.offsets[at + 1])] =
            entry + 1;
      }
    });
  }

  /** The row holding `id`, if any. */
  row(id: string): number | undefined {
    const key = encoder.encode(id);
    const entry = this.slots[this.probe(key, 0, key.length)];
    return entry ? this.rows[entry - 1] : undefined;
  }

  /** The slot holding these bytes, or the empty slot where they belong. */
  private probe(bytes: Uint8Array, start: number, end: number): number {
    const mask = this.slots.length - 1;
    let slot = hash(bytes, start, end) & mask;
    while (this.slots[slot] && !this.equals(this.slots[slot] - 1, bytes, start, end))
      slot = (slot + 1) & mask;
    return slot;
  }

  private equals(entry: number, bytes: Uint8Array, start: number, end: number): boolean {
    let low = 0,
      high = this.pages.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (this.starts[middle] <= entry) low = middle;
      else high = middle - 1;
    }
    const column = this.pages[low].column as TextColumn,
      at = column.offset + entry - this.starts[low],
      from = column.offsets[at];
    if (column.offsets[at + 1] - from !== end - start) return false;
    for (let i = 0; i < end - start; i++)
      if (column.bytes[from + i] !== bytes[start + i]) return false;
    return true;
  }
}

function hash(bytes: Uint8Array, start: number, end: number): number {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}
