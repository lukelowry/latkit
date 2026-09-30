import type { RequestOptions } from './types.js';
/** A tag identifies exact bytes within one resource; it need not be a digest. */
export interface ResourceInfo {
  readonly tag: string;
  readonly size: number;
}
export interface ResourceRead {
  readonly tag: string;
  readonly range?: { readonly offset: number; readonly length: number };
}
export type WritePart =
  | { readonly kind: 'copy'; readonly offset: number; readonly length: number }
  | { readonly kind: 'data'; readonly bytes: Uint8Array };
export interface ResourceWrite {
  /** null requires an absent destination and forbids copy parts. */
  readonly base: string | null;
  /** Output order. Copy ranges address the same immutable base. Literal chunks are immutable. */
  readonly parts: AsyncIterable<WritePart>;
}
/** Access to one stored byte sequence, not a workspace. Pass a distinct grant for each lending.
 * Recipients retain the grant while needed and close it afterwards, including failed setup.
 * Closing a grant never deletes the stored object. A connection loss revokes its remote grants. */
export interface Resource {
  readonly id: string;
  readonly name?: string;
  readonly mediaType?: string;
  stat(options?: RequestOptions): Promise<ResourceInfo | null>;
  /** Pin exactly the requested bytes or reject conflict. A range never silently truncates. */
  read(request: ResourceRead, options?: RequestOptions): Promise<ReadableStream<Uint8Array>>;
  /** Stage output separately; commit completely with an atomic base check or preserve prior bytes.
   * Abort before commit discards staging. A lost reply does not imply rollback; never auto-retry.
   * Providers unable to guarantee conditional publication must omit write. */
  write?(request: ResourceWrite, options?: RequestOptions): Promise<ResourceInfo>;
  /** Release this grant and cancel its pending I/O. Idempotent. */
  close(): Promise<void>;
}
