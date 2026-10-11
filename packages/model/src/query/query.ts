import type { Column, Index, Domain } from '../data/column.js';

/** Bound of one block when a read names none, for `read` and the Reader alike. */
export const BLOCK_BYTES = 1024 ** 2;

/** Options of work a signal can stop. */
export interface RequestOptions {
  readonly signal?: AbortSignal;
}

/** What a read asks of one type's fields: its rows, samples, a summary of them, or their extremes. */
export type Query = Query.Rows | Query.Samples | Query.Envelope | Query.Aggregate;
export declare namespace Query {
  interface Options extends RequestOptions {
    /**
     * Default borrowed: immutable application backing remains valid after the read ends. Never
     * detach. Borrowed backing cannot be reused for mutable working storage while published views
     * survive. Owned: read copies exposed buffers into independent allocations; caller may
     * mutate/transfer it. No SharedArrayBuffer or alias into another block is allowed in owned
     * mode. Sparse gathers and ownership conversion may copy; zero-copy is permitted, never
     * promised.
     */
    readonly buffers?: 'borrowed' | 'owned';
    /** Bound of one block. Defaults to 1 MiB. */
    readonly maxBlockBytes?: number;
  }
  /**
   * Fields of a type, and its rows: what queries and monitoring select. For sampled reads, omitted
   * rows select the physical-order intersection of captured coverage for all sampled fields used by
   * the query; explicit rows must be captured for each of those fields.
   */
  interface Selection {
    readonly from: string;
    readonly select: readonly string[];
    readonly rows?: Index.Selection;
  }
  interface Rows extends Selection {
    readonly kind: 'rows';
    /**
     * Physical row order by default; explicit selections retain their order. Unknown ids reject.
     * Resolve range/index selections against this type; incompatible Index metadata rejects
     * conflict.
     */
    readonly rows?: Index.Selection;
    /** Include stable domain identities only when needed. */
    readonly ids?: boolean;
    readonly where?: readonly Filter[];
    /** Missing values last; physical row number breaks ties, independent of locale. */
    readonly orderBy?: readonly {
      readonly field: string;
      readonly direction: 'ascending' | 'descending';
    }[];
    readonly offset?: number;
    readonly limit?: number;
    /** Total matches before offset/limit, repeated consistently on every block. */
    readonly count?: boolean;
    /** Required for sampled selections/predicates/order. Latest frame at or before this coordinate. */
    readonly at?: number;
  }
  /** The frames a sampled read covers: a span of them, a coordinate range, or the one at a coordinate. */
  type Window =
    | { readonly kind: 'frames'; readonly offset: number; readonly count: number }
    | Range
    | { readonly kind: 'at'; readonly value: number };
  interface Range {
    readonly kind: 'range';
    readonly between: Domain;
    /**
     * Extra available frames strictly before/after the inclusive interval; omitted counts are zero.
     * Counts are nonnegative safe integers, measured in frames, not distinct coordinates. Include
     * every boundary duplicate inside the interval. With no interior frames, use the immediate
     * predecessor/successor at the insertion point. Clip context to recorded bounds. Resolve both
     * boundaries and context against the same immutable value, without waiting for future frames.
     * Aggregates include these same context frames when requested.
     */
    readonly context?: { readonly before?: number; readonly after?: number };
  }
  /**
   * Sampled numeric fields. At selects the last duplicate coordinate; before first is empty.
   * Native floating-point observations may be nonfinite; aggregates exclude them. Future frame
   * ranges reject invalid-input. Only optional range context clips to recorded bounds; requested
   * data is never silently truncated.
   */
  interface Samples extends Selection {
    readonly kind: 'samples';
    readonly window: Window;
  }
  /**
   * Local summary computed over supplied samples. Equal-width coordinate buckets partition the
   * inclusive window; only the final bucket includes its right boundary. A zero-width window
   * requires one bucket. Duplicate coordinates stay in the same bucket. Context observations belong
   * to the first/last bucket, respectively. Each slot is a finite source observation: first,
   * minimum, maximum, last, in that fixed order. Extrema ties choose the earliest absolute frame.
   * Slots may repeat; consumers order/deduplicate by frame when drawing. Null/nonfinite observations
   * clear continuity, never become extrema. Empty buckets have all slots invalid and continuity
   * false. Gaps cannot be reconstructed from a summary: never connect a discontinuous bucket
   * without refining the raw samples. Appends preserve absolute frame identities.
   */
  interface Envelope extends Selection {
    readonly kind: 'envelope';
    readonly window: Range;
    readonly buckets: number;
  }
  interface Aggregate extends Selection {
    readonly kind: 'aggregate';
    readonly measures: readonly ('min' | 'max')[];
    /** Required for sampled data, forbidden for inputs; the two cannot be mixed. */
    readonly window?: Window;
  }
  type Filter =
    | {
        readonly field: string;
        readonly operator: 'equal' | 'notEqual';
        readonly value: number | string | boolean | null;
      }
    | {
        readonly field: string;
        readonly operator: 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual';
        readonly value: number;
      }
    | { readonly field: string; readonly operator: 'contains'; readonly value: string };
}

/** What a read yields: bounded pieces of its result, each of the query's kind. */
export type Block = Block.Rows | Block.Samples | Block.Envelope | Block.Aggregate;
export declare namespace Block {
  /** The block a query of its kind yields. */
  type Of<Q extends Query> = Q extends Query.Rows
    ? Rows
    : Q extends Query.Samples
      ? Samples
      : Q extends Query.Envelope
        ? Envelope
        : Q extends Query.Aggregate
          ? Aggregate
          : Block;
  interface Rows {
    readonly kind: 'rows';
    readonly index: Index;
    /** Physical indices in result order. */
    readonly rows: Index.Rows;
    /** Position of the first row in the result, after filtering, sorting, and offset/limit. */
    readonly rowOffset: number;
    readonly ids?: Column.Text;
    readonly total?: number;
    readonly columns: Readonly<Record<string, Column>>;
  }
  /**
   * Rectangular tiles partition both selected rows and frames without overlaps or gaps. rowOffset
   * is a position in the query's row selection; rows are physical indices. firstFrame is absolute.
   * Columns address frame * frameStride + row * rowStride relative to each column's logical slice
   * and its own strides. Padding values/validity bits are ignored. Coordinate arrays may alias.
   * Omitted rows select the physical-order intersection of captured rows for all selected fields.
   * Explicit rows must be captured for every selected field.
   */
  interface Samples {
    readonly kind: 'samples';
    readonly index: Index;
    readonly rows: Index.Rows;
    readonly rowOffset: number;
    readonly firstFrame: number;
    readonly coordinates: Float64Array;
    readonly columns: Readonly<Record<string, Column.Sample>>;
  }
  /**
   * Row-major: ((row * bucketCount + bucket) * 4 + slot). Value validity also governs
   * coordinates/frames. Their arrays have exactly values.length slots; values.offset addresses only
   * values/validity, not the coordinate/frame arrays.
   */
  interface EnvelopeColumn {
    readonly values: Column.Numeric;
    readonly coordinates: Float64Array;
    readonly frames: Float64Array;
    /** Bit-packed per row/bucket. True iff nonempty and every source observation is finite/valid. */
    readonly continuous: Uint8Array;
  }
  /**
   * Complete rectangular row/bucket coverage, including empty buckets; no overlaps or gaps.
   * rowOffset is in selection order; firstBucket is in the query's bucket axis.
   */
  interface Envelope {
    readonly kind: 'envelope';
    readonly index: Index;
    readonly rows: Index.Rows;
    readonly rowOffset: number;
    readonly firstBucket: number;
    readonly bucketCount: number;
    readonly columns: Readonly<Record<string, EnvelopeColumn>>;
  }
  /** Each requested field appears exactly once over the stream. Counts exclude null/nonfinite data. */
  interface Aggregate {
    readonly kind: 'aggregate';
    readonly values: Readonly<
      Record<
        string,
        { readonly count: number; readonly min?: number | null; readonly max?: number | null }
      >
    >;
  }
  /**
   * Fields a reader joined to one physical row order. Presence marks the rows a binding covers and
   * is distinct from validity. Address columns using this block's row and sample axes.
   */
  interface Fields {
    readonly kind: 'fields';
    readonly index: Index;
    readonly rows: Index.Rows;
    /** Position of the first row among the request's rows. */
    readonly rowOffset: number;
    readonly ids?: Column.Text;
    readonly columns: Readonly<Record<string, Column>>;
    readonly presence: Readonly<Record<string, Uint8Array>>;
    /** Sample columns carry strides; static columns broadcast without expanding their buffers. */
    readonly samples?: { readonly firstFrame: number; readonly coordinates: Float64Array };
  }
}
