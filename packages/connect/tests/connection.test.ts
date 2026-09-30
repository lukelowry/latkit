import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { connect, serve, messagePort } from '../src/index.js';
import { FixtureService, MemoryFile, collect } from '../../model_new/tests/fixture.js';
import { axisValues } from '../../model_new/tests/source.js';
async function open(service = new FixtureService()) {
  const { port1, port2 } = new MessageChannel();
  const serving = serve(messagePort(port2), service);
  void serving.catch(() => undefined);
  const remote = await connect(messagePort(port1));
  return {
    remote,
    service,
    async close() {
      await remote.close();
      await serving;
    },
  };
}
describe('connection', () => {
  it('opens a service and reads a canonical document across MessageChannel', async () => {
    const connection = await open();
    try {
      expect(connection.remote.id).toBe('fixture');
      const document = await connection.remote.open();
      const blocks = await collect(
        document.query({ kind: 'rows', from: 'Node', select: ['value'] }),
      );
      expect(blocks.flatMap((block) => axisValues(block.rows))).toEqual([0, 1, 2, 3]);
      await document.close();
    } finally {
      await connection.close();
    }
  });
  it('lends a resource back to its host and saves changed ranges', async () => {
    const connection = await open();
    const file = new MemoryFile();
    try {
      const document = await connection.remote.open({ kind: 'resource', resource: file.grant() });
      const blocks = await collect(
        document.query({ kind: 'rows', from: 'Node', select: ['value'], ids: true }),
      );
      const ids = blocks[0].ids!;
      const id = new TextDecoder().decode(ids.bytes.subarray(ids.offsets[0], ids.offsets[1]));
      await document.edit!([{ kind: 'set', id, values: { value: 9 } }]);
      const saved = await document.save!();
      expect(saved.version).toBe(document.version);
      expect(new TextDecoder().decode(file.bytes!)).toBe('[9,2,3,4]');
      expect(file.writes[0].some((part) => part.kind === 'copy')).toBe(true);
      await document.close();
      expect(file.closedGrants).toBe(1);
    } finally {
      await connection.close();
    }
  });
  it('keeps a file-free live peer feasible through the same Model interface', async () => {
    const connection = await open();
    try {
      const document = await connection.remote.open();
      const model = await connection.remote.model(document.id);
      expect(model.documentId).toBe(document.id);
      const recording = await model.monitor!({
        scope: { kind: 'live' },
        fields: [{ from: 'Node', select: ['output'] }],
        retain: { kind: 'all', bytes: 4096, onLimit: 'fail' },
      });
      await recording.ready;
      connection.service.models[0].live(0);
      const blocks = await collect(
        recording.query({
          kind: 'samples',
          from: 'Node',
          select: ['output'],
          window: { kind: 'frames', offset: 0, count: 1 },
        }),
      );
      expect(blocks).toHaveLength(2);
      await recording.stop();
      expect(await recording.done).toMatchObject({ status: 'stopped' });
      await model.close();
      expect(await document.describe()).toBeDefined();
      await document.close();
    } finally {
      await connection.close();
    }
  });
});
