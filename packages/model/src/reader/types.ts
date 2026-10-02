import type { Column, Index, RowAxis, RowSelection, TextColumn } from '../data.js';
import type { Data } from '../materialized.js';
import type { SampleWindow } from '../query.js';

/** A field of another source, joined to the requested rows by physical row. */
export interface FieldBinding {
  readonly source: Data;
  readonly from: string;
  readonly field: string;
  /** Explicit coverage for a partial overlay. Omitted means every requested row is required. */
  readonly rows?: RowSelection;
}

/** Immutable application values, in explicitly identified physical row order. */
export interface FieldValues {
  readonly index: Index;
  readonly rows: RowAxis;
  readonly values: Column;
}

/** A field of the request's own source and type, another source's field, or local values. */
export type FieldInput = string | FieldBinding | FieldValues;

export interface FieldsRequest {
  readonly source: Data;
  readonly from: string;
  readonly rows?: RowSelection;
  /** Output names to inputs. */
  readonly fields: Readonly<Record<string, FieldInput>>;
  /** Omitted reads static fields, and sampled fields at the scope's coordinate. */
  readonly window?: SampleWindow;
  /** Coordinate for sampled point reads; defaults to the scope's. */
  readonly at?: number;
  readonly ids?: boolean;
}

/**
 * Fields joined to one physical row order. Presence marks the rows a binding covers and is
 * distinct from validity. Address columns using this block's row and sample axes.
 */
export interface FieldsBlock {
  readonly kind: 'fields';
  readonly index: Index;
  readonly rows: RowAxis;
  /** Position of the first row among the request's rows. */
  readonly rowOffset: number;
  readonly ids?: TextColumn;
  readonly columns: Readonly<Record<string, Column>>;
  readonly presence: Readonly<Record<string, Uint8Array>>;
  /** Sample columns carry strides; static columns broadcast without expanding their buffers. */
  readonly samples?: { readonly firstFrame: number; readonly coordinates: Float64Array };
}

/** The finite extent of one scalar numeric field over the requested rows. */
export interface ExtentRequest {
  readonly source: Data;
  readonly from: string;
  readonly rows?: RowSelection;
  readonly field: FieldInput;
  /** Omitted reads static fields, and sampled fields at the scope's coordinate. */
  readonly window?: SampleWindow;
}
