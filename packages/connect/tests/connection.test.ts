import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import type { FieldSelection, Model } from '@latkit/model';
import { connect, serve, messagePort } from '../src/index.js';
import { FixtureModel, collect, failure } from '../../model/tests/fixture.js';
import { axisValues } from '../../model/tests/source.js';
import { reached } from './fixture.js';
const output: readonly FieldSelection[] = [{ from: 'Node', select: ['output'] }];
const solve = { routine: 'solve', values: {} } as const;
async function open(model: Model = new FixtureModel()) {
  const { port1, port2 } = new MessageChannel();
  const serving = serve(messagePort(port2), model);
  void serving.catch(() => undefined);
  const remote = await connect(messagePort(port1));
  return {
    remote,
    async close() {
      await remote.close();
      await serving;
    },
  };
}
describe('connection', () => {
  it('describes and reads a canonical model across MessageChannel', async () => {
    const connection = await open();
    try {
      expect(connection.remote.name).toBe('Fixture');
      expect(connection.remote.routines.map((routine) => routine.id)).toEqual(['solve', 'check']);
      expect((await connection.remote.describe()).components.Node.fields.output).toMatchObject({
        sampled: true,
      });
      const blocks = await collect(
        connection.remote.query({ kind: 'rows', from: 'Node', select: ['value'] }),
      );
      expect(blocks.flatMap((block) => axisValues(block.rows))).toEqual([0, 1, 2, 3]);
    } finally {
      await connection.close();
    }
  });
  it('streams a command to a remote monitor', async () => {
    const model = new FixtureModel();
    const connection = await open(model);
    try {
      const recording = await connection.remote.monitor(output);
      expect(recording.status).toBe('idle');
      const kinds: string[] = [];
      recording.on('change', (update) => kinds.push(update.kind));
      const running = reached(recording, 'running');
      const command = connection.remote.run(solve);
      await running;
      model.frame(0);
      model.frame(1);
      model.finish();
      expect(await command).toEqual({ frames: 2 });
      expect(recording.status).toBe('complete');
      expect(recording.frames).toBe(2);
      expect(recording.range).toEqual([0, 1]);
      expect(kinds).toEqual(['replace', 'status', 'append', 'append', 'status']);
      const blocks = await collect(
        recording.query({
          kind: 'samples',
          from: 'Node',
          select: ['output'],
          window: { kind: 'frames', offset: 0, count: 2 },
        }),
      );
      expect(blocks).toHaveLength(4);
      await recording.close();
      expect(model.monitors.size).toBe(0);
    } finally {
      await connection.close();
    }
  });
  it('serves a model that computes nothing through the same interface', async () => {
    const model = new FixtureModel();
    const quiet: Model = {
      name: model.name,
      routines: [],
      get version() {
        return model.version;
      },
      describe: model.describe.bind(model),
      query: model.query.bind(model),
      retain: model.retain.bind(model),
      on: model.on.bind(model),
      close: model.close.bind(model),
      monitor: () => Promise.reject(failure('invalid-input', 'Nothing here is sampled.')),
      run: () => Promise.reject(failure('invalid-input', 'Nothing here runs.')),
    };
    const connection = await open(quiet);
    try {
      expect(connection.remote.routines).toEqual([]);
      await expect(connection.remote.run(solve)).rejects.toMatchObject({ code: 'invalid-input' });
      await expect(connection.remote.monitor(output)).rejects.toMatchObject({
        code: 'invalid-input',
      });
      expect(await connection.remote.describe()).toBeDefined();
    } finally {
      await connection.close();
      await model.close();
    }
  });
});
