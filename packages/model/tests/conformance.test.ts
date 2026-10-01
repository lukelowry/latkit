import { MessageChannel } from 'node:worker_threads';
import type { Query, Queryable, QueryBlock, QueryHeader, QueryOptions } from '../src/index.js';
import { blockBuffers } from '../src/index.js';
import { queryConformance } from './conformance.js';
import { FixtureModel } from './fixture.js';

const query = { kind: 'rows', from: 'Node', select: ['value'] } as const;
const expectedRows = [0, 1, 2, 3];
queryConformance('model', async () => {
  const model = new FixtureModel();
  return { source: model, query, expectedRows, close: () => model.close() };
});
queryConformance('monitor', async () => {
  const model = new FixtureModel();
  const recording = await model.monitor([{ from: 'Node', select: ['output'] }]);
  const command = model.run({ routine: 'solve', values: {} });
  model.frame(0);
  model.finish();
  await command;
  return {
    source: recording,
    query,
    expectedRows,
    close: async () => {
      await recording.close();
      await model.close();
    },
  };
});
queryConformance('native transferred query blocks', async () => {
  const model = new FixtureModel();
  // A test of native buffer movement, not an implementation of connect's protocol.
  const forward = async function* (
    q: Query,
    options?: QueryOptions,
  ): AsyncIterable<QueryHeader | QueryBlock> {
    const { port1, port2 } = new MessageChannel();
    try {
      for await (const block of model.query(q, { ...options, buffers: 'owned' })) {
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
      return model.version;
    },
    describe: model.describe.bind(model),
    retain: model.retain.bind(model),
    close: model.close.bind(model),
    query: forward as Queryable['query'],
    on: model.on.bind(model),
  };
  return { source, query, expectedRows, close: () => model.close() };
});
