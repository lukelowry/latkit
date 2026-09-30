import type { Queryable, Update } from './query.js';
import type { Resource } from './resource.js';
import type { Export, RequestOptions, Value, Version } from './types.js';
export interface SavedDocument {
  readonly resource: string;
  readonly tag: string;
  readonly version: Version;
}
export interface SaveTarget {
  readonly resource: Resource;
  readonly base: string | null;
}
export interface SaveOptions extends RequestOptions {
  readonly to?: SaveTarget;
}
export interface ReloadOptions extends RequestOptions {
  readonly discardChanges?: boolean;
}
/** Shared domain inputs. Each acquisition has an independent close; attached Models retain inputs.
 * Descriptions/edits are domain behavior. Storage methods may be absent for live peers. */
export interface Document extends Queryable {
  readonly id: string;
  readonly name: string;
  readonly format: string | null;
  readonly saved: SavedDocument | null;
  /** Atomic batch; assertions inspect pre-edit inputs. Resolve aliases across the batch and validate
   * final structure. No-op edits preserve versions; structural changes advance affected indexes.
   * Input changes end affected live captures before publication; isolated commands retain inputs. */
  edit?(edits: readonly Edit[], options?: RequestOptions): Promise<Change>;
  /** Pin current inputs at acceptance; serialize saves. Edits may continue. Publish saved metadata
   * only after conditional storage commit. Retargeting affects the shared document after success.
   * Failed target setup closes its grant. A lost reply may have committed; never auto-retry. */
  save?(options?: SaveOptions): Promise<SavedDocument>;
  /** Atomically reload the bound resource. Dirty inputs require discardChanges:true.
   * Concurrent edits/binding changes during the read reject conflict, even when discard was requested.
   * Failures preserve current inputs and saved metadata. */
  reload?(options?: ReloadOptions): Promise<Change>;
  /** Restore a grant for the same authorized resource identity, closing the superseded grant.
   * Preserve inputs and saved baseline even if storage changed; subsequent saves still check that base. */
  attach?(resource: Resource, options?: RequestOptions): Promise<void>;
  /** Current version only; historical retention is not implied. */
  export?(options?: RequestOptions): Promise<Export>;
  on(event: 'change', listener: (change: Update) => void): () => void;
  on(event: 'saved', listener: (saved: SavedDocument) => void): () => void;
  /** Release this acquisition and its active reads. Other acquisitions/Models remain usable.
   * Last retention disposes native state and closes its Resource grant. Idempotent. */
  close(): Promise<void>;
}

/** Local aliases exist only inside one edit batch. Public identities are always strings. */
export type ElementReference = string | { readonly local: string };

export interface Endpoint {
  readonly component: ElementReference;
  readonly port?: string;
  readonly role: string;
}

/** IDs are implementation-assigned and document-wide. Never reuse an ID for a different entity
 * within a Document's lifetime, including reload. Stale edits must not address unrelated data. */
export type Edit =
  | ({ readonly kind: 'assert'; readonly id: string } & (
      | { readonly exists: false; readonly values?: never; readonly endpoints?: never }
      | {
          readonly exists?: true;
          /** Exact value equality, recursively for lists; null includes absent optional inputs. */
          readonly values?: Readonly<Record<string, Value>>;
          /** Exact endpoint membership, ignoring ordering. Only existing string identities. */
          readonly endpoints?: readonly (Omit<Endpoint, 'component'> & {
            readonly component: string;
          })[];
        }
    ))
  | {
      readonly kind: 'add-component';
      readonly as: string;
      readonly type: string;
      readonly values: Readonly<Record<string, Value>>;
    }
  | {
      readonly kind: 'add-connection';
      readonly as: string;
      readonly type: string;
      readonly endpoints: readonly Endpoint[];
      readonly values?: Readonly<Record<string, Value>>;
    }
  | {
      readonly kind: 'insert';
      readonly as: string;
      readonly table: string;
      readonly values: Readonly<Record<string, Value>>;
    }
  | {
      readonly kind: 'set';
      readonly id: ElementReference;
      readonly values: Readonly<Record<string, Value>>;
    }
  | {
      readonly kind: 'reconnect';
      readonly id: ElementReference;
      readonly endpoints: readonly Endpoint[];
    }
  | { readonly kind: 'remove'; readonly ids: readonly ElementReference[] };

export interface Change {
  readonly version: Version;
  readonly changed: boolean;
  /** Batch alias to assigned stable identity. Empty for batches without creations. */
  readonly created: Readonly<Record<string, string>>;
}
