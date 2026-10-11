import type { Column, Index } from './column.js';
import type { Block } from '../query/query.js';
import type { Schema } from '../schema/schema.js';

/** Immutable, application-owned values. A new value is a new object; there is no version to track. */
export interface Data<S extends Schema = Schema> {
  readonly schema: S;
  readonly tables: Readonly<Record<string, Data.Table>>;
}
export declare namespace Data {
  /** A type's rows: their index, their stable ids, and each field's pages. */
  interface Table {
    readonly index: Index;
    readonly rows: Index.Rows;
    /** Text pages of stable row identities. */
    readonly ids: Pages;
    readonly fields: Readonly<Record<string, Pages>>;
  }
  /** A page of actual values, never a provider handle or a deferred read. */
  interface Page {
    readonly rows: Index.Rows;
    readonly column: Column;
    readonly samples?: {
      readonly firstFrame: number;
      readonly coordinates: Float64Array;
    };
  }
  /**
   * Immutable pages in publication order, which createData and appendData make. Iteration and
   * at() expose existing pages without copying their payloads.
   */
  interface Pages extends Iterable<Page> {
    readonly kind: 'column-pages';
    readonly length: number;
    at(index: number): Page | undefined;
  }
  /** Static values for a new Data value. Each cell may be supplied only once. */
  type RowBatch = Pick<Block.Rows, 'kind' | 'index' | 'rows' | 'columns' | 'ids'>;
  /** New observations. Keeping earlier observations is an application decision. */
  type SampleBatch = Pick<
    Block.Samples,
    'kind' | 'index' | 'rows' | 'firstFrame' | 'coordinates' | 'columns'
  >;
  type Batch = RowBatch | SampleBatch;
  /** Where an observation lies: its frame and coordinate, and the pages that hold it. */
  interface Location {
    readonly frame: number;
    readonly coordinate: number;
    /** Frame offset into each page's sample coordinates and column strides. */
    readonly offset: number;
    readonly pages: readonly Page[];
  }
}
