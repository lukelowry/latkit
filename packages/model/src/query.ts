import type { Column, Index, RowAxis, SampleColumn, RowSelection, TextColumn } from './data.js';
import type { Schema } from './schema.js';
import type { Domain, RequestOptions, Scalar, Version } from './types.js';

// TODO(API REDESIGN): Grid IS A BAD NAME. Replace the old table-specific Grid API with
// this general Queryable surface throughout Latkit; do not introduce another Grid facade.

export interface QueryOptions extends RequestOptions {
  /**
   * Default borrowed: immutable published backing remains valid after eviction/close. Never detach.
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
  query(query: EndpointsQuery, options?: QueryOptions): AsyncIterable<QueryHeader | EndpointsBlock>;
  query(query: LinksQuery, options?: QueryOptions): AsyncIterable<QueryHeader | LinksBlock>;
  query(query: AggregateQuery, options?: QueryOptions): AsyncIterable<QueryHeader | AggregateBlock>;
  query(query: Query, options?: QueryOptions): AsyncIterable<QueryHeader | QueryBlock>;
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
  | { readonly kind: 'range'; readonly between: Domain }
  | { readonly kind: 'at'; readonly value: number };

/**
 * Sampled numeric fields. At selects the last duplicate coordinate; before first is empty.
 * Native floating-point observations may be nonfinite; aggregates exclude them.
 * Evicted ranges reject expired. Future frame ranges reject invalid-input. No silent truncation.
 */
export interface SamplesQuery extends FieldSelection {
  readonly kind: 'samples';
  readonly window: SampleWindow;
}

/** All endpoints of matching connections, including those outside the involving selection. */
export interface EndpointsQuery {
  readonly kind: 'endpoints';
  readonly from: string;
  readonly rows?: RowSelection;
  readonly involving?: { readonly components: readonly string[] };
}

/**
 * Optional projection with no geometric meaning. For each named port, follow incident through-type
 * connections to endpoints with the requested role and component type. Exactly one qualifying
 * endpoint supplies that side of the link; zero makes the link invalid, multiple reject invalid-input.
 */
export interface LinksQuery {
  readonly kind: 'links';
  readonly from: string;
  readonly rows?: RowSelection;
  readonly ports: readonly [source: string, target: string];
  readonly through: string;
  /** Role identifying the through-connection's opposite component. */
  readonly role: string;
  readonly to: string;
}

export interface AggregateQuery extends FieldSelection {
  readonly kind: 'aggregate';
  readonly measures: readonly ('min' | 'max')[];
  /** Required for sampled data, forbidden for inputs; the two cannot be mixed. */
  readonly window?: SampleWindow;
}

export type Query = RowsQuery | SamplesQuery | EndpointsQuery | LinksQuery | AggregateQuery;
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
  readonly schemaVersion: Version;
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
 * absolute even after eviction. Columns address frame * frameStride + row * rowStride relative to
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

/** CSR segments in selected connection order. Segments of one connection are contiguous and cover
 * [0, totalEndpoints) exactly once. A huge connection may span blocks. Dictionary indices are local
 * to each block; component row numbers belong to their declared Index. */
export interface EndpointsBlock extends Block {
  readonly kind: 'endpoints';
  readonly index: Index;
  readonly connections: Uint32Array;
  readonly offsets: Int32Array;
  readonly firstEndpoint: Uint32Array;
  readonly totalEndpoints: Uint32Array;
  readonly componentIndexes: readonly Index[];
  readonly componentType: Uint32Array;
  readonly componentRow: Uint32Array;
  readonly portNames: readonly (string | null)[];
  readonly port: Uint32Array;
  readonly roleNames: readonly string[];
  readonly role: Uint32Array;
}

/** Exactly one opposite component per named port. Missing links have a zero validity bit.
 * Ambiguous links reject invalid-input; implementations must never choose one arbitrarily. */
export interface LinksBlock extends Block {
  readonly kind: 'links';
  readonly index: Index;
  readonly rows: RowAxis;
  readonly targetIndex: Index;
  readonly source: Uint32Array;
  readonly target: Uint32Array;
  readonly validity: Uint8Array;
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

export type QueryBlock = RowsBlock | SamplesBlock | EndpointsBlock | LinksBlock | AggregateBlock;

/**
 * Notify in publication order after a complete change; versions are equality tokens, not sortable. One commit may emit several notifications with the same version; no older commit's
 * notifications may follow them. Replace/schema invalidate all data caches; structure invalidates
 * the named indices and dependent connectivity; data invalidates those types' values. Append and
 * evict affect only those frame intervals. Status/closed never advance the data version.
 */
export type Update =
  | {
      readonly kind: 'replace' | 'schema';
      readonly version: Version;
      readonly schemaVersion: Version;
    }
  | { readonly kind: 'data'; readonly version: Version; readonly types: readonly string[] }
  | { readonly kind: 'structure'; readonly version: Version; readonly indexes: readonly Index[] }
  | {
      readonly kind: 'append';
      readonly version: Version;
      readonly frames: { readonly offset: number; readonly count: number };
    }
  | { readonly kind: 'evict'; readonly version: Version; readonly beforeFrame: number }
  | { readonly kind: 'commands' | 'diagnostics'; readonly version: Version }
  | { readonly kind: 'status' | 'closed' };
