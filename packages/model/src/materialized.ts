import type { Column, Index, RowAxis, SampleColumn, TextColumn } from './data.js';
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

/** Replace a type's rows and fields, or update the specified rows in its existing row space. */
export interface RowsPatch {
  readonly kind: 'rows';
  readonly index: Index;
  readonly rows: RowAxis;
  readonly columns: Readonly<Record<string, Column>>;
  readonly ids?: TextColumn;
  readonly replace?: boolean;
}

/** A publication of observations. Keeping earlier observations is a consumer decision. */
export interface SamplesPatch {
  readonly kind: 'samples';
  readonly index: Index;
  readonly rows: RowAxis;
  readonly firstFrame: number;
  readonly coordinates: Float64Array;
  readonly columns: Readonly<Record<string, SampleColumn>>;
}

export type DataPatch = RowsPatch | SamplesPatch;

/** Data revisions describe publications, never replay capabilities. */
export type DataEvent =
  | { readonly kind: 'begin'; readonly version: Version; readonly initial: boolean }
  | { readonly kind: 'data'; readonly version: Version; readonly patch: DataPatch }
  | { readonly kind: 'end'; readonly version: Version };
