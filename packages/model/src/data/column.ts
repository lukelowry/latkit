/** Opaque source-scoped token; compare only for equality. Never reused within its source. */
export type Version = string;
/** Finite, ordered inclusive coordinates. */
export type Domain = readonly [minimum: number, maximum: number];
export type Scalar = number | string | boolean | null;
/** Domain values, including vectors and lists. Numbers must be finite. Null denotes absence. */
export type Value = Scalar | readonly Value[];

/** Stable identity of a type's physical row numbering in one application row space. Metadata only. */
export interface Index {
  /** Opaque identity of the application row space that numbers these rows. */
  readonly source: string;
  readonly type: string;
  readonly version: Version;
}
export declare namespace Index {
  /**
   * Physical rows in result order. Ranges avoid allocating identity index arrays. Published rows
   * are immutable unless returned in an owned block.
   */
  type Rows =
    | { readonly kind: 'range'; readonly offset: number; readonly count: number }
    | { readonly kind: 'indices'; readonly values: Uint32Array };
  /** The rows a read selects: by id, or by range or indices of an index; indices are uint32. */
  type Selection =
    | { readonly kind: 'ids'; readonly ids: readonly string[] }
    | {
        readonly kind: 'range';
        readonly offset: number;
        readonly count: number;
        readonly index?: Index;
      }
    | { readonly kind: 'indices'; readonly index: Index; readonly values: Uint32Array };
}

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

/** Arrow-compatible primitive buffer layouts; this is not an Arrow IPC envelope. */
export type Column =
  Column.Numeric | Column.Boolean | Column.Text | Column.Vector | Column.List | Column.Reference;
export declare namespace Column {
  type NumericArray = Float32Array | Float64Array | Int32Array | Uint32Array;
  interface Numeric extends Slice {
    readonly kind: 'numeric';
    readonly values: NumericArray;
  }
  /**
   * Strides address scalar positions relative to the numeric column slice. Padding is ignored.
   * length is the addressed span including padding, not the number of frame/row cells.
   */
  interface Sample extends Numeric {
    readonly frameStride: number;
    readonly rowStride: number;
  }
  interface Boolean extends Slice {
    readonly kind: 'boolean';
    /** Bit-packed, using the same logical addressing as validity. */
    readonly values: Uint8Array;
  }
  interface Text extends Slice {
    readonly kind: 'text';
    readonly bytes: Uint8Array;
    /** Nonnegative monotone UTF-8 byte offsets, including a terminal offset. */
    readonly offsets: Int32Array;
  }
  interface Vector extends Slice {
    readonly kind: 'vector';
    readonly size: number;
    /** Child logical position is (parent.offset + row) * size + lane. Lanes are non-nullable. */
    readonly values: Numeric;
  }
  interface List extends Slice {
    readonly kind: 'list';
    /** Offsets address logical positions in values, including its own slice offset. */
    readonly offsets: Int32Array;
    /** List items are non-nullable; the list itself may be null. */
    readonly values: Column;
  }
  /** Rows of the referenced type, numbered by its Index. A zero validity bit is unwired. */
  interface Reference extends Slice {
    readonly kind: 'reference';
    readonly index: Index;
    readonly values: Uint32Array;
  }
}
