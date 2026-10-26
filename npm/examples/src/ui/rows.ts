/** Conversions between single rows and the row sets that views select and report. */
import type { Row, Rows } from 'latkit';

/** Flattens `sets` into single rows, in order. */
export const each = (sets: readonly Rows[]): Row[] =>
  sets.flatMap(({ data, table, ids }) => ids.map((id) => ({ data, table, id })));

/** Wraps `row` in a set of one row. */
export const one = ({ data, table, id }: Row): Rows => ({ data, table, ids: [id] });
