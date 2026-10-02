import { expect, it } from 'vitest';
import { read, createData, transactions, validateDataEvent, type DataEvent } from '../src/index.js';
import { LiveModel, inputPatch, transaction } from './live.js';
it('passively receives data before, during and after an unrelated routine', async () => {
  const model = new LiveModel(),
    a = model.monitor([{ from: 'Node', select: ['value'] }]),
    b = model.monitor([{ from: 'Node', select: ['value'] }]);
  for (let i = 0; i < 3; i++) {
    const publication = model.publish([inputPatch()], String(i));
    const [x, y] = await Promise.all([transaction(a), transaction(b)]);
    await publication;
    expect(x).toEqual(y);
    for (const event of x) expect(validateDataEvent(model.schema, event)).toEqual([]);
    if (i === 1) await model.commands.run({ routine: 'echo', values: {} });
  }
  await a.return?.();
  await b.return?.();
  expect(model.subscribers.size).toBe(0);
});
it('a later subscriber receives future publications without replay', async () => {
  const model = new LiveModel(),
    a = model.monitor([{ from: 'Node', select: ['value'] }]);
  const first = model.publish([inputPatch()], 'first');
  await transaction(a);
  await first;
  const b = model.monitor([{ from: 'Node', select: ['value'] }]);
  const second = model.publish([inputPatch()], 'second');
  expect(
    (await Promise.all([transaction(a), transaction(b)])).map((events) => events[0].version),
  ).toEqual(['second', 'second']);
  await second;
  model.end();
});
it('delivers only selected fields and rows, and frees an abandoned subscription', async () => {
  const model = new LiveModel(),
    stream = model.monitor([
      { from: 'Node', select: ['value'], rows: { kind: 'range', offset: 1, count: 2 } },
    ]);
  const publish = model.publish([inputPatch()]);
  const events = await transaction(stream);
  await publish;
  expect(events.find((e) => e.kind === 'data')).toMatchObject({
    patch: { rows: { kind: 'range', offset: 1, count: 2 } },
  });
  const data = createData(
    model.schema,
    'v1',
    events.flatMap((e) => (e.kind === 'data' ? [e.patch] : [])),
  );
  await stream.return?.();
  model.end();
  let rows = 0;
  for await (const block of read(data, { kind: 'rows', from: 'Node', select: ['value'] }))
    if (block.kind === 'rows') rows += block.columns.value.length;
  expect(rows).toBe(2);
});
it('aborts a waiting receiver and does not change other consumers', async () => {
  const model = new LiveModel(),
    controller = new AbortController(),
    stream = model.monitor([{ from: 'Node', select: ['value'] }], { signal: controller.signal });
  const next = stream.next();
  controller.abort();
  await expect(next).rejects.toMatchObject({ code: 'aborted' });
  expect(model.subscribers.size).toBe(0);
});
it.each(
  [
    [{ kind: 'data', version: 'x', patch: inputPatch() }],
    [
      { kind: 'begin', version: 'x', initial: false },
      { kind: 'end', version: 'y' },
    ],
    [
      { kind: 'begin', version: 'x', initial: false },
      { kind: 'begin', version: 'x', initial: false },
    ],
  ].map((events) => ({ events })),
)('rejects incomplete or inconsistent transaction structure', async ({ events }) => {
  async function* source() {
    yield* events as DataEvent[];
  }
  await expect(
    (async () => {
      for await (const _ of transactions(new LiveModel().schema, source())) void _;
    })(),
  ).rejects.toBeDefined();
});
