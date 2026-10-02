import { expect, it } from 'vitest';
import { createData, read, validateDataEvent, type DataBatch } from '@latkit/model';
import { connected, subscribed } from './fixture.js';
import { inputBatch, transaction } from '../../model/tests/live.js';
it.each([false, true])(
  'delivers once and keeps application values usable after disconnect (framed=%s)',
  async (framed) => {
    const h = await connected(framed);
    const stream = h.remote.monitor([{ from: 'Node', select: ['value'] }]);
    await subscribed(h.model);
    const batch = inputBatch(10000);
    const published = h.model.publish([batch]);
    const events = await transaction(stream);
    await published;
    const batches: DataBatch[] = [];
    for (const event of events) {
      expect(validateDataEvent(h.remote.schema, event)).toEqual([]);
      if (event.kind === 'data') batches.push(event.block);
    }
    const data = createData(h.remote.schema, 'v1', batches);
    await h.close();
    expect(h.model.subscribers.size).toBe(0);
    let count = 0;
    for await (const b of read(data, { kind: 'rows', from: 'Node', select: ['value'] }))
      if (b.kind === 'rows') {
        const c = b.columns.value;
        if (c.kind !== 'numeric') throw new Error('wrong column');
        for (let i = 0; i < c.length; i++)
          expect(c.values[c.offset + i]).toBe((count++ % 1009) - 504);
      }
    expect(count).toBe(10000);
    expect((batch.columns.value as { values: Float64Array }).values.byteLength).toBe(80000);
    expect('retain' in h.remote).toBe(false);
    expect('query' in h.remote).toBe(false);
    expect('run' in h.remote).toBe(false);
  },
);
it('monitors without any command, and commands neither reset nor complete subscriptions', async () => {
  const h = await connected();
  const stream = h.remote.monitor([{ from: 'Node', select: ['value'] }]);
  await subscribed(h.model);
  for (let i = 0; i < 2; i++) {
    const publish = h.model.publish([inputBatch()], String(i));
    expect((await transaction(stream))[0].version).toBe(String(i));
    await publish;
    expect(await h.remote.commands!.run({ routine: 'echo', values: {} })).toEqual({
      routine: 'echo',
    });
    expect(h.model.subscribers.size).toBe(1);
  }
  await stream[Symbol.asyncIterator]().return?.();
  await h.close();
});
it('aborts a pending subscription pull without closing another subscriber', async () => {
  const h = await connected();
  const abort = new AbortController();
  const a = h.remote
    .monitor([{ from: 'Node', select: ['value'] }], { signal: abort.signal })
    [Symbol.asyncIterator]();
  const b = h.remote.monitor([{ from: 'Node', select: ['value'] }]);
  await subscribed(h.model, 2);
  const pending = a.next();
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  const publish = h.model.publish([inputBatch()]);
  expect(await transaction(b)).toHaveLength(3);
  await publish;
  await h.close();
});
