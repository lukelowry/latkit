import type { Document } from './document.js';
import type { Input } from './input.js';
import type { Recording } from './recording.js';
import type { Model } from './model.js';
import type { RequestOptions } from './types.js';
export type OpenInput =
  Input | { readonly kind: 'empty'; readonly format: string; readonly name?: string };
export interface Format {
  readonly id: string;
  readonly label: string;
  readonly mediaTypes: readonly string[];
  readonly extensions: readonly string[];
  readonly reads: boolean;
  readonly writes: boolean;
  readonly creates: boolean;
}
/** Provisioning for one implementation. No file storage, parser, or isolated execution is required.
 * A live/co-simulation implementation can expose a hardcoded Document, live routines, and monitoring.
 * Methods check access in their application-provided authority scope; IDs alone never grant access. */
export interface ModelService {
  readonly id: string;
  readonly label: string;
  readonly formats: readonly Format[];
  /** New logical document; source optional. Immutable storage/parse caches may be shared and bounded.
   * Resource grants are retained by the document or closed if opening fails. */
  open(input?: OpenInput, options?: RequestOptions): Promise<Document>;
  /** Acquire a separate reference to an existing authorized document. Unknown/expired IDs reject closed. */
  document(id: string, options?: RequestOptions): Promise<Document>;
  /** Independent compute context retaining the named document. May reject busy for exclusive peers. */
  model(documentId: string, options?: RequestOptions): Promise<Model>;
  /** Independent acquisition of an authorized recording. Unknown/released IDs reject closed.
   * No archival policy is implied; IDs are not access grants. */
  recording(id: string, options?: RequestOptions): Promise<Recording>;
}
