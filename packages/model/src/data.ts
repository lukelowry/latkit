import type { Version } from './types.js';

export type NumericType = 'float32' | 'float64' | 'int32' | 'uint32';
export type NumericArray = Float32Array | Float64Array | Int32Array | Uint32Array;

/** A deliberately small columnar vocabulary; no arbitrary object cells. */
export type DataType =
  | NumericType
  | 'text'
  | 'boolean'
  | { readonly kind: 'reference'; readonly to: string }
  | { readonly kind: 'vector'; readonly items: NumericType; readonly size: number }
  | { readonly kind: 'list'; readonly items: DataType };

/** Stable identity of a type's physical row numbering in one Model or Recording. Metadata only. */
export interface Index {
  /** Opaque identity of the Model or Recording that numbers these rows. */
  readonly source: string;
  readonly type: string;
  readonly version: Version;
}

/** Physical rows in result order. Ranges avoid allocating identity index arrays.
 * Published axes are immutable unless returned in an owned block. */
export type RowAxis =
  | { readonly kind: 'range'; readonly offset: number; readonly count: number }
  | { readonly kind: 'indices'; readonly values: Uint32Array };

/** Indices are uint32; implementations partition types exceeding that address space. */
export type RowSelection =
  | { readonly kind: 'ids'; readonly ids: readonly string[] }
  | {
      readonly kind: 'range';
      readonly offset: number;
      readonly count: number;
      readonly index?: Index;
    }
  | { readonly kind: 'indices'; readonly index: Index; readonly values: Uint32Array };

/**
 * A logical slice. Bitmaps use least-significant-bit first and the same offset as values.
 * Missing bitmap means all present. Consumers ignore payloads under zero validity bits.
 * Offsets are relative to the supplied views, not their ArrayBuffer. Views may share backing.
 */
interface Slice {
  readonly offset: number;
  readonly length: number;
  readonly validity?: Uint8Array;
}

export interface NumericColumn extends Slice {
  readonly kind: 'numeric';
  readonly values: NumericArray;
}

/** Strides address scalar positions relative to the numeric column slice. Padding is ignored.
 * length is the addressed span including padding, not the number of frame/row cells. */
export interface SampleColumn extends NumericColumn {
  readonly frameStride: number;
  readonly rowStride: number;
}

export interface BooleanColumn extends Slice {
  readonly kind: 'boolean';
  /** Bit-packed, using the same logical addressing as validity. */
  readonly values: Uint8Array;
}

export interface TextColumn extends Slice {
  readonly kind: 'text';
  readonly bytes: Uint8Array;
  /** Nonnegative monotone UTF-8 byte offsets, including a terminal offset. */
  readonly offsets: Int32Array;
}

export interface VectorColumn extends Slice {
  readonly kind: 'vector';
  readonly size: number;
  /** Child logical position is (parent.offset + row) * size + lane. Lanes are non-nullable. */
  readonly values: NumericColumn;
}

export interface ListColumn extends Slice {
  readonly kind: 'list';
  /** Offsets address logical positions in values, including its own slice offset. */
  readonly offsets: Int32Array;
  /** List items are non-nullable; the list itself may be null. */
  readonly values: Column;
}

/** Arrow-compatible primitive buffer layouts; this is not an Arrow IPC envelope. */
export type Column = NumericColumn | BooleanColumn | TextColumn | VectorColumn | ListColumn;
