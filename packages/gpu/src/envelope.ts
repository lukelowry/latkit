import type { Data, EnvelopeBlock, EnvelopeQuery } from '@latkit/model';
import type { Preparation } from './render.js';
export interface EnvelopeRequest {
  readonly source: Data;
  readonly query: EnvelopeQuery;
}
/** Envelope reduction is local data computation, shared by every consumer. */
export class Envelopes {
  async *prepare(
    { source, query }: EnvelopeRequest,
    frame: Pick<Preparation, 'query' | 'signal'>,
  ): AsyncGenerator<EnvelopeBlock> {
    for await (const block of frame.query(source, query)) if (block.kind !== 'schema') yield block;
  }
}
