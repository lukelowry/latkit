import type { Index } from './data/column.js';
import type { Data } from './data/data.js';

/**
 * A row of a table: what views select, hover, and pick, and what their proposals name. The index
 * names the row space, so an item outlives appends that replace the Data value it came from.
 */
export interface Item {
  readonly source: Data;
  readonly index: Index;
  readonly row: number;
}

/**
 * An item's identity as a string: its row space and row, then what a view adds, such as a kind.
 * Items naming the same row of the same row space, with the same qualifiers, share it.
 */
export function itemKey(item: Item, ...qualifiers: readonly (string | number)[]): string {
  const { source, type, version } = item.index;
  return JSON.stringify([source, type, version, item.row, ...qualifiers]);
}
