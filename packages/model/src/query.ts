import type {
  Column,
  Index,
  RowAxis,
  SampleColumn,
  RowSelection,
  TextColumn,
  NumericColumn,
} from './data.js';
import type { Schema } from './schema.js';
import type { Domain, RequestOptions, Scalar, Version } from './types.js';

// TODO(API REDESIGN): Grid IS A BAD NAME. Replace the old table-specific Grid API with
// this general Queryable surface throughout Latkit; do not introduce another Grid facade.

export interface QueryOptions extends RequestOptions {
  /**
   * Default borrowed: immutable published backing remains valid after close. Never detach.
   * Borrowed backing cannot be reused for mutable working storage while published views survive.
   * Owned: producer relinquishes every alias to every returned backing allocation; caller may
   * mutate/transfer it. No SharedArrayBuffer or alias into another block is allowed in owned mode.
   * Sparse gathers and ownership conversion may copy; zero-copy is permitted, never promised.
   */
  readonly buffers?: 'borrowed' | 'owned';
  readonly maxBlockBytes?: number;
}

/** Exactly one per iteration, including empty reads. Immutable and authoritative for that read. */
export interface QueryHeader {
  readonly kind: 'schema';
  readonly version: Version;
  readonly schema: Schema;
}

/** The same field/row vocabulary is used by queries and monitoring.
 * For sampled reads, omitted rows select the physical-order intersection of captured coverage for
 * all sampled fields used by the query; explicit rows must be captured for each of those fields. */
export interface FieldSelection {
  readonly from: string;
  readonly select: readonly string[];
  readonly rows?: RowSelection;
}

/** Acquisition limits, independent of later query cancellation. */
export interface RetainOptions extends RequestOptions {
  /** Sampled sources only. Omitted retains all currently available observations. */
  readonly window?: SampleWindow;
  /** Protected native backing and indexes, including whole allocations behind slices.
   * Implementations impose finite defaults and shared limits, deduplicating shared backing.
   * Admission may reserve storage conservatively; this is not a process-memory limit. */
  readonly maxBytes?: number;
}

export interface Queryable {
  readonly version: Version;
  describe(options?: RequestOptions): Promise<Schema>;
  /**
   * One coherent version per iteration, fixed on first pull. No eager collection. Pulls apply
   * backpressure; return/throw/abort release this request. Abort also interrupts a pending pull.
   * Each block satisfies the smaller requested/schema byte bound. Even a single oversized cell
   * fails resource-limit. Previously delivered blocks remain valid; failures may follow them.
   * Exactly one schema header precedes data, even for an empty read. Schema and version are pinned
   * atomically on first pull. Block versions must match the header. Row counts use an empty data
   * block if requested; aggregates emit null measures/count zero for an empty selection.
   */
  query(query: RowsQuery, options?: QueryOptions): AsyncIterable<QueryHeader | RowsBlock>;
  query(query: SamplesQuery, options?: QueryOptions): AsyncIterable<QueryHeader | SamplesBlock>;
  query(query: EnvelopeQuery, options?: QueryOptions): AsyncIterable<QueryHeader | EnvelopeBlock>;
  query(query: AggregateQuery, options?: QueryOptions): AsyncIterable<QueryHeader | AggregateBlock>;
  query(query: Query, options?: QueryOptions): AsyncIterable<QueryHeader | QueryBlock>;
  /**
   * Atomically acquire fixed schema, inputs, row identities and observation coverage without
   * executing queries. Resolve window/context once. Appends and a monitor starting over never
   * alter this grant. Queries resolve against the fixed observation index and reject invalid-input
   * if any selected frame lies outside the grant; never silently clip to narrower coverage.
   * Retaining again creates an independent acquisition of the same version, optionally narrowed.
   * No data-change events. Survives the originating acquisition and its Model's close. Signal
   * governs acquisition only. Unknown coverage rejects; failed or cancelled admission leaves no
   * retained resources.
   */
  retain(options?: RetainOptions): Promise<Queryable>;
  /** Release only this acquisition and cancel its direct queries. Independent retained sources and
   * already returned blocks remain valid. Remote acquisitions still require their transport.
   * Emit a local closed change; later operations reject closed. Idempotent. */
  close(): Promise<void>;
  /** Publish before notification. Listeners must not throw. */
  on(event: 'change', listener: (change: Update) => void): () => void;
}

export interface RowsQuery extends FieldSelection {
  readonly kind: 'rows';
  /** Physical row order by default; explicit selections retain their order. Unknown ids reject.
   * Resolve range/index selections against this type; incompatible Index metadata rejects conflict. */
  readonly rows?: RowSelection;
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

export type SampleWindow =
  | { readonly kind: 'frames'; readonly offset: number; readonly count: number }
  | SampleRange
  | { readonly kind: 'at'; readonly value: number };

export interface SampleRange {
  readonly kind: 'range';
  readonly between: Domain;
  /**
   * Extra retained frames strictly before/after the inclusive interval; omitted counts are zero.
   * Counts are nonnegative safe integers, measured in frames, not distinct coordinates.
   * Include every boundary duplicate inside the interval. With no interior frames, use the
   * immediate predecessor/successor at the insertion point. Clip context to recorded bounds.
   * Resolve both boundaries and context against the same pinned read, without waiting for
   * future frames. Aggregates include these same context frames when requested.
   */
  readonly context?: { readonly before?: number; readonly after?: number };
}

/**
 * Sampled numeric fields. At selects the last duplicate coordinate; before first is empty.
 * Native floating-point observations may be nonfinite; aggregates exclude them.
 * Future frame ranges reject invalid-input.
 * Only optional range context clips to recorded bounds; requested data is never silently truncated.
 */
export interface SamplesQuery extends FieldSelection {
  readonly kind: 'samples';
  readonly window: SampleWindow;
}

/** Optional native summary capability, advertised in Schema.queries.
 * Equal-width coordinate buckets partition the inclusive window; only the final bucket includes
 * its right boundary. A zero-width window requires one bucket. Duplicate coordinates stay in the
 * same bucket. Context observations belong to the first/last bucket, respectively.
 * Each slot is a finite source observation: first, minimum, maximum, last, in that fixed order.
 * Extrema ties choose the earliest absolute frame. Slots may repeat; consumers order/deduplicate
 * by frame when drawing. Null/nonfinite observations clear continuity, never become extrema.
 * Empty buckets have all slots invalid and continuity false. Gaps cannot be reconstructed from
 * a summary: never connect a discontinuous bucket without refining the raw samples.
 * Appends preserve absolute frame identities.
 */
export interface EnvelopeQuery extends FieldSelection {
  readonly kind: 'envelope';
  readonly window: SampleRange;
  readonly buckets: number;
}

export interface AggregateQuery extends FieldSelection {
  readonly kind: 'aggregate';
  readonly measures: readonly ('min' | 'max')[];
  /** Required for sampled data, forbidden for inputs; the two cannot be mixed. */
  readonly window?: SampleWindow;
}

export type Query = RowsQuery | SamplesQuery | EnvelopeQuery | AggregateQuery;
export type Filter =
  | { readonly field: string; readonly operator: 'equal' | 'notEqual'; readonly value: Scalar }
  | {
      readonly field: string;
      readonly operator: 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual';
      readonly value: number;
    }
  | { readonly field: string; readonly operator: 'contains'; readonly value: string };

interface Block {
  readonly kind: Query['kind'];
  readonly version: Version;
}

export interface RowsBlock extends Block {
  readonly kind: 'rows';
  readonly index: Index;
  /** Physical indices in result order; position starts at zero after filtering, sorting, and offset/limit. */
  readonly rows: RowAxis;
  readonly position: number;
  readonly ids?: TextColumn;
  readonly total?: number;
  readonly columns: Readonly<Record<string, Column>>;
}

/**
 * Rectangular tiles partition both selected rows and frames without overlaps or gaps.
 * rowOffset is a position in the query's row selection; rows are physical indices. firstFrame is
 * absolute. Columns address frame * frameStride + row * rowStride relative to
 * each column's logical slice and its own strides. Padding values/validity bits are ignored.
 * Coordinate arrays may alias. Omitted rows select the physical-order intersection of captured
 * rows for all selected fields. Explicit rows must be captured for every selected field.
 */
export interface SamplesBlock extends Block {
  readonly kind: 'samples';
  readonly index: Index;
  readonly rows: RowAxis;
  readonly rowOffset: number;
  readonly firstFrame: number;
  readonly coordinates: Float64Array;
  readonly columns: Readonly<Record<string, SampleColumn>>;
}

/** Row-major: ((row * bucketCount + bucket) * 4 + slot).
 * Value validity also governs coordinates/frames. Their arrays have exactly values.length slots;
 * values.offset addresses only values/validity, not the coordinate/frame arrays.
 */
export interface EnvelopeColumn {
  readonly values: NumericColumn;
  readonly coordinates: Float64Array;
  readonly frames: Float64Array;
  /** Bit-packed per row/bucket. True iff nonempty and every source observation is finite/valid. */
  readonly continuous: Uint8Array;
}
/** Complete rectangular row/bucket coverage, including empty buckets; no overlaps or gaps.
 * rowOffset is in selection order; firstBucket is in the query's bucket axis. */
export interface EnvelopeBlock extends Block {
  readonly kind: 'envelope';
  readonly index: Index;
  readonly rows: RowAxis;
  readonly rowOffset: number;
  readonly firstBucket: number;
  readonly bucketCount: number;
  readonly columns: Readonly<Record<string, EnvelopeColumn>>;
}

/** Each requested field appears exactly once over the stream. Counts exclude null/nonfinite data. */
export interface AggregateBlock extends Block {
  readonly kind: 'aggregate';
  readonly values: Readonly<
    Record<
      string,
      { readonly count: number; readonly min?: number | null; readonly max?: number | null }
    >
  >;
}

export type QueryBlock = RowsBlock | SamplesBlock | EnvelopeBlock | AggregateBlock;

/**
 * Notify in publication order after a complete change; versions are equality tokens, not sortable.
 * Replace invalidates all data caches: a monitor emits it when a command starts it over. Append
 * affects only those frames. Status and closed never advance the data version.
 */
export type Update =
  | { readonly kind: 'replace'; readonly version: Version }
  | {
      readonly kind: 'append';
      readonly version: Version;
      readonly frames: { readonly offset: number; readonly count: number };
    }
  | { readonly kind: 'status' | 'closed' };
