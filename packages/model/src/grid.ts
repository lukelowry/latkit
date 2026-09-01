/**
 * A queryable table over a class's columns: free-text search over labels and formatted cells,
 * numeric-aware stable sort, and windows that format only the rows they return.
 *
 * @remarks
 * A grid is immutable over its inputs; full passes run cooperatively in chunks so a large class
 * never blocks the event loop. A host whose values move (a monitor table at a playhead) builds a
 * new grid from freshly sampled columns.
 */

import type { Column } from './model.js';

/** Which column orders the rows, or `null` for the element label, and in which direction. */
export interface GridSort {
  readonly column: string | null;
  readonly dir: 'asc' | 'desc';
}

/** A filtered, sorted slice of rows plus the filtered total, for a scroll spacer. */
export interface GridWindow {
  readonly rows: readonly {
    readonly index: number;
    readonly label: string;
    readonly cells: readonly string[];
  }[];
  readonly total: number;
}

/** A query engine over one class. */
export interface Grid {
  /** Rows `offset` through `offset + limit` under `query` and `sort`. */
  window(
    query: string,
    sort: GridSort | null,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<GridWindow>;
  /** The display position of element `index` under `query` and `sort`, or null when filtered out. */
  locate(
    index: number,
    query: string,
    sort: GridSort | null,
    signal?: AbortSignal,
  ): Promise<number | null>;
  /** Drop every cache; pending and later queries reject with `AbortError`. */
  dispose(): void;
}

const CHUNK = 4096;

/**
 * The one number-to-text rule every view shares.
 *
 * @remarks
 * Six significant figures, so f32 samples never show precision artifacts; exponential outside
 * `[1e-3, 1e5)` so a column of susceptances or megawatts stays aligned; blank for `NaN`.
 */
export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return '';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e5 || magnitude < 1e-3)) return value.toExponential(3);
  return String(Number(value.toPrecision(6)));
}

function cellOf(column: Column, index: number): string {
  switch (column.kind) {
    case 'number':
      return formatNumber(column.values[index]!);
    case 'text':
      return column.values[index] ?? '';
    case 'flag':
      return column.values[index] ? 'true' : 'false';
  }
}

function abortError(): DOMException {
  return new DOMException('The grid query was cancelled.', 'AbortError');
}

/** Yield to the event loop, not just the microtask queue, so input and rendering stay responsive. */
function breathe(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function merge(
  from: Uint32Array,
  into: Uint32Array,
  start: number,
  middle: number,
  end: number,
  compare: (a: number, b: number) => number,
): void {
  let left = start;
  let right = middle;
  for (let out = start; out < end; out++) {
    into[out] =
      right >= end || (left < middle && compare(from[left]!, from[right]!) <= 0)
        ? from[left++]!
        : from[right++]!;
  }
}

/** Sort indices cooperatively: native runs of `CHUNK`, then pairwise merges, yielding between. */
async function sortIndices(
  count: number,
  compare: (a: number, b: number) => number,
  pause: () => Promise<void>,
): Promise<Uint32Array> {
  const stable = (a: number, b: number): number => compare(a, b) || a - b;
  let order = new Uint32Array(count);
  for (let index = 0; index < count; index++) order[index] = index;
  for (let start = 0; start < count; start += CHUNK) {
    order.subarray(start, Math.min(count, start + CHUNK)).sort(stable);
    await pause();
  }
  let buffer = new Uint32Array(count);
  for (let width = CHUNK; width < count; width *= 2) {
    for (let start = 0; start < count; start += 2 * width) {
      const middle = Math.min(count, start + width);
      merge(order, buffer, start, middle, Math.min(count, start + 2 * width), stable);
    }
    [order, buffer] = [buffer, order];
    await pause();
  }
  return order;
}

/**
 * Build a grid over one class's labels and columns.
 *
 * @throws Error when a column's length differs from the label count or a column id repeats.
 */
export function createGrid(labels: readonly string[], columns: readonly Column[]): Grid {
  const count = labels.length;
  const ids = new Set<string>();
  for (const column of columns) {
    if (ids.has(column.id)) throw new Error(`column '${column.id}' repeats`);
    ids.add(column.id);
    if (column.values.length !== count) {
      throw new Error(`column '${column.id}' has ${column.values.length} values for ${count} rows`);
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  let disposed = false;
  let blobs: readonly string[] | null = null;
  let filter: { readonly query: string; readonly hits: Uint32Array } | null = null;
  const orders = new Map<string, Uint32Array>();
  const inflight = new Map<string, Promise<unknown>>();

  const pause = async (): Promise<void> => {
    await breathe();
    if (disposed) throw abortError();
  };

  /** Coalesce concurrent builds of the same index. */
  function once<T>(key: string, build: () => Promise<T>): Promise<T> {
    let pending = inflight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = build().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

  async function searchBlobs(): Promise<readonly string[]> {
    if (blobs) return blobs;
    return once('blobs', async () => {
      const out = new Array<string>(count);
      for (let index = 0; index < count; index++) {
        const cells = columns.map((column) => cellOf(column, index));
        out[index] = `${labels[index]!} ${cells.join(' ')}`.toLowerCase();
        if (index % CHUNK === CHUNK - 1) await pause();
      }
      blobs = out;
      return out;
    });
  }

  async function hitsFor(query: string): Promise<Uint32Array> {
    if (filter?.query === query) return filter.hits;
    return once(`filter:${query}`, async () => {
      const all = await searchBlobs();
      const hits: number[] = [];
      for (let index = 0; index < all.length; index++)
        if (all[index]!.includes(query)) hits.push(index);
      const result = Uint32Array.from(hits);
      filter = { query, hits: result };
      return result;
    });
  }

  /** Display order under one sort, or null for an unknown column. */
  async function orderFor(sort: GridSort): Promise<Uint32Array | null> {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = `${sort.column === null ? 'label' : `column:${sort.column}`}\0${sort.dir}`;
    const cached = orders.get(key);
    if (cached) return cached;
    const column = sort.column === null ? null : columns.find((c) => c.id === sort.column);
    if (column === undefined) return null;
    return once(`order:${key}`, async () => {
      let compare: (a: number, b: number) => number;
      if (column === null) {
        compare = (a, b) => dir * collator.compare(labels[a]!, labels[b]!);
      } else if (column.kind === 'text') {
        const values = column.values;
        compare = (a, b) => {
          const ta = values[a];
          const tb = values[b];
          if (ta === null && tb === null) return 0;
          if (ta === null) return 1;
          if (tb === null) return -1;
          return dir * collator.compare(ta, tb);
        };
      } else if (column.kind === 'flag') {
        const values = column.values;
        compare = (a, b) => dir * (values[a]! - values[b]!);
      } else {
        const values = column.values;
        compare = (a, b) => {
          const va = values[a]!;
          const vb = values[b]!;
          const ma = Number.isNaN(va);
          const mb = Number.isNaN(vb);
          if (ma && mb) return 0;
          if (ma) return 1;
          if (mb) return -1;
          return dir * (va - vb);
        };
      }
      const order = await sortIndices(count, compare, pause);
      orders.set(key, order);
      return order;
    });
  }

  /** Source indices in display order, or null for natural order. */
  async function displayOrder(
    query: string,
    sort: GridSort | null,
    signal?: AbortSignal,
  ): Promise<Uint32Array | null> {
    if (disposed) throw abortError();
    signal?.throwIfAborted();
    const needle = query.trim().toLowerCase();
    const [hits, order] = await Promise.all([
      needle ? hitsFor(needle) : null,
      sort ? orderFor(sort) : null,
    ]);
    if (disposed) throw abortError();
    signal?.throwIfAborted();
    if (order && hits) {
      const mask = new Uint8Array(count);
      for (const index of hits) mask[index] = 1;
      return order.filter((index) => mask[index] === 1);
    }
    return order ?? hits;
  }

  return {
    async window(query, sort, offset, limit, signal) {
      const indices = await displayOrder(query, sort, signal);
      const total = indices ? indices.length : count;
      const start = Math.min(Math.max(0, Math.trunc(offset)), total);
      const end = Math.min(total, start + Math.max(0, Math.trunc(limit)));
      const rows: GridWindow['rows'][number][] = [];
      for (let at = start; at < end; at++) {
        const index = indices ? indices[at]! : at;
        rows.push({
          index,
          label: labels[index]!,
          cells: columns.map((column) => cellOf(column, index)),
        });
      }
      return { rows, total };
    },
    async locate(index, query, sort, signal) {
      if (!Number.isInteger(index) || index < 0 || index >= count) return null;
      const indices = await displayOrder(query, sort, signal);
      if (!indices) return index;
      const at = indices.indexOf(index);
      return at >= 0 ? at : null;
    },
    dispose() {
      disposed = true;
      blobs = null;
      filter = null;
      orders.clear();
    },
  };
}
