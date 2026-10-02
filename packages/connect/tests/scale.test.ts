import { beforeAll, describe, expect, it } from 'vitest';
import { transactions, read } from '@latkit/model';
import { harness, modes, prepareWorker, until } from './scale/harness.js';
import { verifyRows, verifySamples, inputAt } from '../../model/tests/scale/verify.js';
beforeAll(prepareWorker, 30000);
describe.each(modes)('one-pass delivery over %s', (mode) => {
  it('delivers a million rows once, then checks every cell locally after disconnect', async () => {
    const count = 1000003,
      run = await harness(mode, count);
    let closed = false;
    try {
      for await (const data of transactions(
        run.model.schema,
        run.model.monitor([{ from: 'Node', select: ['value'] }], { maxBlockBytes: 32768 }),
      )) {
        await run.close();
        closed = true;
        const result = await verifyRows(data, count, { buffers: 'owned', maxBlockBytes: 32768 });
        expect(result.maxBackingBytes).toBeLessThanOrEqual(32768);
        expect(result.blocks).toBeGreaterThan(250);
        const selection = [count - 1, 3, 65537, 0, 8192];
        await verifyRows(
          data,
          selection.length,
          {},
          {
            kind: 'rows',
            from: 'Node',
            select: ['value'],
            rows: {
              kind: 'indices',
              index: data.tables.Node.index,
              values: Uint32Array.from(selection),
            },
          },
          (i) => selection[i],
        );
        break;
      }
    } finally {
      if (!closed) await run.close();
    }
  }, 30000);
  it('delivers sampled tiles with exact frame identities', async () => {
    const run = await harness(mode, 10003);
    try {
      for await (const data of transactions(
        run.model.schema,
        run.model.monitor([{ from: 'Node', select: ['output'] }]),
      )) {
        await verifySamples(data, 10003, 3);
      }
    } finally {
      await run.close();
    }
  });
  it('applies pull backpressure and interrupts pending delivery', async () => {
    const run = await harness(mode, 1000003);
    try {
      const stream = run.model
        .monitor([{ from: 'Node', select: ['value'] }])
        [Symbol.asyncIterator]();
      await stream.next();
      expect((await run.metrics()).generatedBytes).toBe(0);
      await stream.next();
      const before = await run.metrics();
      await new Promise((r) => setTimeout(r, 10));
      expect((await run.metrics()).blocks).toBe(before.blocks);
      await run.pause(true);
      const pending = expect(stream.next()).rejects.toMatchObject({ code: 'aborted' });
      await until(run, (m) => m.waiting === 1);
      await stream.return?.();
      await pending;
      await until(run, (m) => m.active === 0);
      await run.pause(false);
    } finally {
      await run.close();
    }
  });
  it('multiplexes bounded subscriptions with independent local reductions', async () => {
    const count = 10003,
      run = await harness(mode, count, 8192, {
        limits: { maxInFlightBytes: 32768, maxMetadataBytes: 4096 },
      });
    try {
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for await (const data of transactions(
            run.model.schema,
            run.model.monitor([{ from: 'Node', select: ['value'] }], { maxBlockBytes: 4096 }),
          )) {
            const expected = Array.from({ length: count }, (_, i) => i)
              .filter((row) => inputAt(row) >= 490)
              .sort((a, b) => inputAt(b) - inputAt(a) || a - b)
              .slice(11, 81);
            await verifyRows(
              data,
              expected.length,
              {},
              {
                kind: 'rows',
                from: 'Node',
                select: ['value'],
                where: [{ field: 'value', operator: 'greaterThanOrEqual', value: 490 }],
                orderBy: [{ field: 'value', direction: 'descending' }],
                offset: 11,
                limit: 70,
              },
              (i) => expected[i],
            );
            for await (const block of read(data, {
              kind: 'aggregate',
              from: 'Node',
              select: ['value'],
              measures: ['min', 'max'],
            }))
              if (block.kind === 'aggregate')
                expect(block.values.value).toEqual({ count, min: -504, max: 504 });
          }
        }),
      );
      expect((await run.metrics()).active).toBe(0);
    } finally {
      await run.close();
    }
  }, 30000);
});
