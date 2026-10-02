import { expect, it } from 'vitest';
import { connect, serve } from '../src/index.js';
import { LiveModel, inputPatch, transaction } from '../../model/tests/live.js';
import { open, transports, subscribed } from './fixture.js';
it('negotiates schema and separate command capability', async () => {
  const c = await open();
  try {
    expect(c.remote.name).toBe(c.model.name);
    expect(c.remote.schema).toEqual(c.model.schema);
    expect(c.remote.commands!.routines).toEqual(c.model.commands.routines);
    expect(await c.remote.commands!.run({ routine: 'echo', values: {} })).toEqual({
      routine: 'echo',
    });
    for (const method of ['retain', 'query', 'describe', 'export', 'run', 'on'])
      expect(method in c.remote).toBe(false);
  } finally {
    await c.close();
  }
});
it.each([false, true])('serves passive models without commands (framed=%s)', async (framed) => {
  const model = new LiveModel(),
    [client, server] = transports(framed),
    serving = serve(server, model),
    remote = await connect(client);
  try {
    expect(remote.commands).toBeUndefined();
    const events = remote.monitor([{ from: 'Node', select: ['value'] }]);
    await subscribed(model);
    const publish = model.publish([inputPatch()]);
    expect((await transaction(events)).map((e) => e.kind)).toEqual(['begin', 'data', 'end']);
    await publish;
  } finally {
    await remote.close();
    await serving;
  }
});
