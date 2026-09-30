import { MessageChannel } from 'node:worker_threads';
import type { Query, Queryable, QueryBlock, QueryHeader, QueryOptions } from '../src/index.js';
import { blockBuffers } from '../src/index.js';
import { queryConformance } from './conformance.js';
import { FixtureModel, readOnlyDocument } from './fixture.js';

const query = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const expectedRows = [0, 1, 2, 3];
queryConformance('hardcoded document', async () => ({
  source: readOnlyDocument(),
  query,
  expectedRows,
  close: async () => {},
}));
queryConformance('editable document', async () => {
  const model = new FixtureModel();
  return { source: model.document, query, expectedRows, close: () => model.close() };
});
queryConformance('native transferred query blocks', async () => {
  const model = new FixtureModel();
  // A test of native buffer movement, not an implementation of port's RPC/lifetime protocol.
  const forward = async function* (
    q: Query,
    options?: QueryOptions,
  ): AsyncIterable<QueryHeader | QueryBlock> {
    const { port1, port2 } = new MessageChannel();
    try {
      for await (const block of model.document.query(q, { ...options, buffers: 'owned' })) {
        const received = new Promise<QueryHeader | QueryBlock>((resolve) =>
          port2.once('message', resolve),
        );
        port1.postMessage(
          block,
          block.kind === 'schema' ? [] : (blockBuffers(block) as ArrayBuffer[]),
        );
        yield await received;
      }
    } finally {
      port1.close();
      port2.close();
    }
  };
  const source: Queryable = {
    get version() {
      return model.document.version;
    },
    describe: model.document.describe.bind(model.document),
    query: forward as Queryable['query'],
    on: model.document.on.bind(model.document),
  };
  return { source, query, expectedRows, close: () => model.close() };
});
