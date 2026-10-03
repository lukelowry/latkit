import { expect, it } from 'vitest';
import { deferred } from '../src/core.js';
import { Op } from '../src/frame.js';
import { pair, batch, fields } from './fixture.js';

it('drains more than 128 publications and 64 MiB in order after consumer pressure', async () => {
  const count = 160,
    elements = 65536;
  const arrived = deferred<void>();
  const p = await pair(
    {
      limits: { streamWindowBytes: 96 * 1024 ** 2, maxBufferedBytes: 96 * 1024 ** 2 },
      monitor: function* () {
        const value = batch(elements);
        const column = value.columns.value;
        if (column.kind !== 'numeric') throw new Error('Expected numeric');
        for (let i = 0; i < count; i++) {
          column.values.fill(i);
          yield value;
        }
      },
      commands: { ping: { parameters: {}, run: () => 'pong' } },
    },
    { limits: { streamWindowBytes: 96 * 1024 ** 2, maxBufferedBytes: 96 * 1024 ** 2 } },
  );
  let received = 0;
  p.socket.on('message', (data) => {
    if (data instanceof Buffer && data.readUInt16LE(6) === Op.publication && ++received === count)
      arrived.resolve();
    else if (
      data instanceof ArrayBuffer &&
      new DataView(data).getUint32(4, true) === Op.publication &&
      ++received === count
    )
      arrived.resolve();
  });
  try {
    const stream = p.model.monitor!(fields);
    await arrived.promise;
    let consumed = 0;
    for await (const publication of stream) {
      const column = publication[0].columns.value;
      if (column.kind !== 'numeric') throw new Error('Expected numeric');
      expect(column.values[0]).toBe(consumed);
      expect(column.values[elements - 1]).toBe(consumed);
      consumed++;
    }
    expect(consumed).toBe(count);
    await expect(p.model.commands.ping.run({})).resolves.toBe('pong');
  } finally {
    await p.close();
  }
}, 15000);
