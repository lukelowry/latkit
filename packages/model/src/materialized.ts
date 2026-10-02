import type { ColumnPages } from './pages.js';
import type { Column, Index, RowAxis } from './data.js';
import type { RowsBlock, SamplesBlock } from './query.js';
import type { Schema } from './schema.js';

/** A page of actual values, never a provider handle or a deferred read. */
export interface ColumnPage {
  readonly rows: RowAxis;
  readonly column: Column;
  readonly samples?: {
    readonly firstFrame: number;
    readonly coordinates: Float64Array;
  };
}

export interface TableData {
  readonly index: Index;
  readonly rows: RowAxis;
  /** Text pages of stable row identities. */
  readonly ids: ColumnPages;
  readonly fields: Readonly<Record<string, ColumnPages>>;
}

/** Immutable, application-owned values. A new value is a new object; there is no version to track. */
export interface Data<S extends Schema = Schema> {
  readonly schema: S;
  readonly tables: Readonly<Record<string, TableData>>;
}

/** Static values for a new Data value. Each cell may be supplied only once. */
export type RowBatch = Pick<RowsBlock, 'kind' | 'index' | 'rows' | 'columns' | 'ids'>;

/** New observations. Keeping earlier observations is an application decision. */
export type SampleBatch = Pick<
  SamplesBlock,
  'kind' | 'index' | 'rows' | 'firstFrame' | 'coordinates' | 'columns'
>;

export type DataBatch = RowBatch | SampleBatch;
