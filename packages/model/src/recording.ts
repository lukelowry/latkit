import type { Index, RowAxis } from './data.js';
import type { FieldSelection, Queryable } from './query.js';
import type { CommandEntry, Diagnostic } from './routine.js';
import type { Axis, Domain, Export, Failure, RequestOptions, Version } from './types.js';

export type MonitorScope =
  { readonly kind: 'live' } | { readonly kind: 'command'; readonly id: string };

export type Retention =
  | { readonly kind: 'all'; readonly bytes: number; readonly onLimit: 'stop' | 'fail' }
  | {
      readonly kind: 'rolling';
      readonly bytes: number;
      readonly frames?: number;
      readonly onLimit: 'stop' | 'fail';
    };

/** Resolved once at binding. Each type/field appears once; selections may differ between fields. */
export interface RecordedFields {
  readonly from: string;
  readonly select: readonly string[];
  readonly index: Index;
  readonly rows: RowAxis;
}

export interface MonitorConfig {
  readonly scope: MonitorScope;
  /** Nonempty. Type/field pairs are unique; row identities resolve only at binding. */
  readonly fields: readonly FieldSelection[];
  /**
   * Observation payload and sample-index budget, not duplicated input/provenance charges. Admit
   * complete frames only. Shared immutable inputs and native work use implementation-level budgets.
   * Consumer-held borrowed blocks may keep allocations alive after eviction; this is no RSS cap.
   */
  readonly retain: Retention;
  /** Optional diagnostic ring; overflow drops oldest diagnostics and advances firstSequence. */
  readonly diagnostics?: { readonly bytes: number };
}

export type RecordingStatus = 'armed' | 'monitoring' | 'stopped' | 'failed';
export type RecordingOutcome =
  | {
      readonly status: 'stopped';
      readonly reason:
        | 'requested'
        | 'command-finished'
        | 'document-changed'
        | 'limit'
        | 'model-reset'
        | 'model-closed'
        | 'released';
    }
  | { readonly status: 'failed'; readonly error: Failure };

/**
 * Retained inputs and observations with one fixed input identity after binding. Isolated commands
 * never appear in live capture or another command's capture. Correlated live commands can use
 * command scope too; their capture ends before current inputs change. Command capture ends after terminal
 * output flush, even on command failure: consult command provenance for that outcome. Capture
 * failure is separate. Live capture ends before input changes; isolated capture survives edits/reload.
 * Coordinates never restart; incompatible output rejects rather than silently shifting coordinates.
 */
export interface Recording extends Queryable {
  readonly id: string;
  /** Producer identity, never an ownership link; null when no producer is known. */
  readonly modelId: string | null;
  readonly scope: MonitorScope;
  readonly documentId: string;
  /** Null while armed/unbound; describe/query/retain/export reject busy until bound; use ready to await binding. */
  readonly documentVersion: Version | null;
  readonly status: RecordingStatus;
  readonly fields: readonly RecordedFields[] | null;
  readonly axis: Axis | null;
  /** Resolve after publishing bound inputs/schema/coverage/axis. Reject on binding failure or any
   * capture termination before binding (aborted), or release of this acquisition (closed).
   * Observe rejection internally so unused promises do not cause unhandled rejections. */
  readonly ready: Promise<void>;
  readonly firstFrame: number;
  /** Total admitted frames, including evicted frames. Retained interval: [firstFrame, frameCount). */
  readonly frameCount: number;
  /** Retained coordinate interval; null when no frames are retained. */
  readonly range: Domain | null;
  readonly error: Failure | null;
  /** Shared capture outcome. Unsettled waits reject closed on acquisition release, disconnected on
   * connection loss. Already settled ready/done promises never change. */
  readonly done: Promise<RecordingOutcome>;
  /**
   * Invocation order. Content inputs retain metadata, not streams. History freezes when capture ends.
   * Provenance is never silently evicted; inability to retain it fails capture with resource-limit.
   * Page versions must match when combining pages. The schema block-byte bound applies.
   */
  commands(
    page: { readonly offset?: number; readonly limit: number },
    options?: RequestOptions,
  ): Promise<{
    readonly version: Version;
    readonly items: readonly CommandEntry[];
    readonly total: number;
  }>;
  diagnostics(
    page: { readonly after?: number; readonly limit: number },
    options?: RequestOptions,
  ): Promise<{
    readonly version: Version;
    readonly items: readonly Diagnostic[];
    /** Earliest retained diagnostic; null when none. */
    readonly firstSequence: number | null;
    /** Greatest evicted sequence; null if no diagnostic has been discarded. */
    readonly discardedThrough: number | null;
  }>;
  /** End capture and flush writes without cancelling commands. Responsive and idempotent. */
  stop(): Promise<void>;
  /** Consistent retained inputs, schema, observations, and provenance. Media type identifies format. */
  export(options?: RequestOptions): Promise<Export>;
  /** Release this acquisition and cancel its direct queries; emit a local closed change. Other
   * acquisitions and retained Queryables survive. Last acquisition ends capture with released and
   * releases unretained data. Preserve settled promises; reject unresolved ready/done with closed.
   * Observe rejections internally. Idempotent; closing is not a shared capture status. */
  close(): Promise<void>;
}
