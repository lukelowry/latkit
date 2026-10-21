/** Sets of rows, as a view selects and tells them, and the rows in them. */
import type { Row, Rows } from '../latkit.js';

/** Each row of `sets`, in order. */
export const each = (sets: readonly Rows[]): Row[] =>
  sets.flatMap(({ data, table, ids }) => ids.map((id) => ({ data, table, id })));

/** `row` as a set of rows. */
export const one = ({ data, table, id }: Row): Rows => ({ data, table, ids: [id] });
