import {
  appendedPages,
  rowAt,
  rowCount,
  sampleAt,
  type ColumnPage,
  type ColumnPages,
  type Domain,
  type RowSelection,
  type SampleColumn,
} from '@latkit/model';
import type { Binding } from './bindings.js';

export function mergeDomain(a: Domain | null, b: Domain | null): Domain | null {
  return !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}
/** The value pages a trace draws. */
export function tracePages(trace: Binding): ColumnPages | undefined {
  return trace.source.tables[trace.trace.from]?.fields[trace.field];
}
/** The rows of a trace, as a cache key and a membership test. */
interface Selection {
  readonly key: string;
  has(row: number): boolean;
}
function selection(rows: RowSelection | undefined): Selection {
  if (rows?.kind === 'range')
    return {
      key: 'range:' + rows.offset + ':' + rows.count,
      has: (row) => row >= rows.offset && row < rows.offset + rows.count,
    };
  if (rows?.kind === 'indices') {
    const set = new Set(rows.values);
    return { key: 'indices:' + [...rows.values].join(','), has: (row) => set.has(row) };
  }
  return { key: '', has: () => true };
}

/** Whole-page extents never change, so each is measured once per row selection. */
const measured = new WeakMap<ColumnPage, Map<string, Domain | null>>();
/** The extent of a page's selected rows over the frames inside `window`. */
function extent(page: ColumnPage, rows: Selection, window: Domain): Domain | null {
  const coordinates = page.samples!.coordinates;
  let first = 0,
    end = coordinates.length;
  while (first < end && coordinates[first] < window[0]) first++;
  while (end > first && coordinates[end - 1] > window[1]) end--;
  if (first === end) return null;
  const whole = first === 0 && end === coordinates.length;
  let cache = measured.get(page);
  if (whole && cache?.has(rows.key)) return cache.get(rows.key)!;
  const column = page.column as SampleColumn;
  let lo = Infinity,
    hi = -Infinity;
  for (let r = 0; r < rowCount(page.rows); r++) {
    if (!rows.has(rowAt(page.rows, r))) continue;
    for (let f = first; f < end; f++) {
      const value = sampleAt(column, r, f);
      if (value !== null && Number.isFinite(value)) {
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
  }
  const result: Domain | null = lo <= hi ? [lo, hi] : null;
  if (whole) {
    if (!cache) measured.set(page, (cache = new Map<string, Domain | null>()));
    cache.set(rows.key, result);
  }
  return result;
}

/** The traces' value extent over a window: measured once, then folding in each appended page. */
export class Fit {
  #window?: Domain;
  #extent: Domain | null = null;
  readonly #folded = new Map<Binding['trace'], { pages: ColumnPages; rows: Selection }>();
  values(traces: readonly Binding[], window: Domain): Domain | null {
    if (!this.#window || this.#window[0] !== window[0] || this.#window[1] !== window[1]) {
      this.#window = window;
      this.#extent = null;
      this.#folded.clear();
    }
    for (const trace of traces) {
      const pages = tracePages(trace),
        folded = this.#folded.get(trace.trace);
      if (!pages || pages === folded?.pages) continue;
      const added = folded && appendedPages(folded.pages, pages);
      if (folded && !added) {
        // Not an append: measure the window again.
        this.#window = undefined;
        return this.values(traces, window);
      }
      const rows = folded?.rows ?? selection(trace.rows);
      for (const page of added ?? pages)
        this.#extent = mergeDomain(this.#extent, extent(page, rows, window));
      this.#folded.set(trace.trace, { pages, rows });
    }
    return this.#extent;
  }
}
