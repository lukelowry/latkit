/**
 * A refusal: why a document refuses an edit, or an engine a study's values, for the user, and what
 * it is about.
 */

import type { Document } from './document.js';
import type { Model } from './model.js';

/**
 * What a document or an engine refuses: why, for the user, and what it is about: a port or an
 * element of the case, or a study's parameter by its id.
 */
export class Refusal extends Error {
  override readonly name = 'Refusal';

  constructor(
    message: string,
    readonly at: Document.Port | Model.Element | string | null = null,
  ) {
    super(message);
  }
}
