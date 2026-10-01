import type { RowSelection, Index, Queryable, RowAxis, SampleWindow } from '@latkit/model';

export interface FieldBinding {
  readonly source: Queryable;
  readonly from: string;
  readonly field: string;
  /** Explicit coverage for a partial overlay. Omitted means every draw row is required. */
  readonly rows?: RowSelection;
}

export type FieldInput = string | FieldBinding | FieldValues;

export interface FieldsRequest {
  readonly source: Queryable;
  readonly from: string;
  readonly rows?: RowSelection;
  readonly fields: Readonly<Record<string, FieldInput>>;
  /** Omitted reads static fields or sampled fields at the frame coordinate. */
  readonly window?: SampleWindow;
  readonly ids?: boolean;
}

/** Immutable application values, in explicitly identified physical row order. */
export interface FieldValues {
  readonly index: Index;
  readonly rows: RowAxis;
  readonly values: import('@latkit/model').Column;
}

export interface DataHit {
  readonly source: Queryable;
  readonly index: Index;
  readonly row: number;
  readonly field?: string;
  readonly frame?: number;
  readonly coordinate?: number;
}

/** Borrowed immutable data before float conversion. Presence is distinct from validity.
 * Address columns using this object's row/sample axes. */
export interface NativeFields {
  readonly index: Index;
  readonly rows: RowAxis;
  readonly rowOffset: number;
  readonly ids?: import('@latkit/model').TextColumn;
  readonly columns: Readonly<Record<string, import('@latkit/model').Column>>;
  /** Sample columns carry strides; static columns broadcast without expanding their buffers. */
  readonly samples?: { readonly firstFrame: number; readonly coordinates: Float64Array };
  readonly presence: Readonly<Record<string, Uint8Array>>;
  /** Call during preparation. Keeps backing allocations in the Gpu budget until idempotent release. */
  retain(): () => void;
}

/** Finite scalar extent over the complete selected mapping. Null means no finite values. */
export interface ExtentRequest {
  readonly source?: Queryable;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly field: FieldInput;
  readonly window?: SampleWindow;
}
