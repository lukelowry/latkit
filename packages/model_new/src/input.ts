import type { Resource } from './resource.js';
/** References are implementation-defined; content is consumed once; resources grant access to one object. */
export type Input =
  | { readonly kind: 'reference'; readonly value: string }
  | { readonly kind: 'resource'; readonly resource: Resource }
  | {
      readonly kind: 'content';
      readonly name?: string;
      readonly mediaType?: string;
      /** Immutable chunks. Cancel on failure. Transports must not detach unowned backing. */
      readonly stream: ReadableStream<Uint8Array>;
    };
/** Provenance contains metadata, never live grants or consumed streams. */
export type InputMetadata =
  | { readonly kind: 'reference'; readonly value: string }
  | {
      readonly kind: 'resource';
      readonly id: string;
      readonly tag: string;
      readonly name?: string;
      readonly mediaType?: string;
    }
  | {
      readonly kind: 'content';
      readonly name?: string;
      readonly mediaType?: string;
      readonly bytes?: number;
    };
