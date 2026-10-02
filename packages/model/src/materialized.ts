import type { Column, Index, RowAxis, TextColumn } from './data.js';
import type { RowsBlock, SamplesBlock } from './query.js';
import type { Schema } from './schema.js';
import type { Version } from './types.js';

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
  readonly ids: readonly { readonly rows: RowAxis; readonly column: TextColumn }[];
  readonly fields: Readonly<Record<string, readonly ColumnPage[]>>;
}

/** Immutable, application-owned values. There are no I/O or lifetime methods. */
export interface Data<S extends Schema = Schema> {
  readonly schema: S;
  readonly version: Version;
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

/** Data revisions describe publications, never replay capabilities. */
export type DataEvent =
  | { readonly kind: 'begin'; readonly version: Version; readonly initial: boolean }
  | { readonly kind: 'data'; readonly version: Version; readonly block: DataBatch }
  | { readonly kind: 'end'; readonly version: Version };
