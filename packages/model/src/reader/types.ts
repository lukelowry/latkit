import type { Column, Index } from '../data/column.js';
import type { Data } from '../data/data.js';

/** A field of the request's own source and type, another source's field, or local values. */
export type FieldInput = string | FieldInput.Binding | FieldInput.Values;
export declare namespace FieldInput {
  /** A field of another source, joined to the requested rows by physical row. */
  interface Binding {
    readonly source: Data;
    readonly from: string;
    readonly field: string;
    /** Explicit coverage for a partial overlay. Omitted means every requested row is required. */
    readonly rows?: Index.Selection;
  }
  /** Immutable application values, in explicitly identified physical row order. */
  interface Values {
    readonly index: Index;
    readonly rows: Index.Rows;
    readonly values: Column;
  }
}
