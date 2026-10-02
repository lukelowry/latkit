import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { transactions, blockByteLength } from '@latkit/model';
import { harness, modes, prepareWorker, until } from './harness.js';
import { verifyRows, verifySamples } from '../../../model/tests/scale/verify.js';
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
it('measures checked one-pass delivery and repeated local reads', async () => {
  const sizes = (process.env.LATKIT_SCALE_ROWS ?? '100000,1000000,4000000').split(',').map(Number),
    repeats = Number(process.env.LATKIT_SCALE_REPEATS ?? 3),
    results: unknown[] = [];
  assert.ok(sizes.every((n) => Number.isSafeInteger(n) && n >= 10000 && n <= 16000000));
  assert.ok(repeats >= 1 && repeats <= 20);
  await prepareWorker();
  for (const rows of sizes)
    for (const mode of modes) {
      const run = await harness(mode, rows);
      try {
        const started = performance.now();
        let firstBlockMs = 0,
          maxDeliveryBytes = 0;
        const events = run.model.monitor([{ from: 'Node', select: ['value'] }]);
        async function* measured() {
          for await (const event of events) {
            if (event.kind === 'data') {
              if (!firstBlockMs) firstBlockMs = performance.now() - started;
              maxDeliveryBytes = Math.max(maxDeliveryBytes, blockByteLength(event));
            }
            yield event;
          }
        }
        const iterator = transactions(run.model.schema, measured()),
          item = await iterator.next();
        assert.ok(!item.done);
        const data = item.value;
        await iterator.return(undefined);
        const deliveryMs = performance.now() - started;
        assert.ok(maxDeliveryBytes <= run.model.schema.limits.maxBlockBytes);
        const borrowed: number[] = [],
          owned: number[] = [];
        for (let i = 0; i < repeats; i++) {
          borrowed.push((await verifyRows(data, rows)).elapsedMs);
          owned.push((await verifyRows(data, rows, { buffers: 'owned' })).elapsedMs);
        }
        const sampled = performance.now();
        for await (const observations of transactions(
          run.model.schema,
          run.model.monitor([{ from: 'Node', select: ['output'] }]),
        )) {
          await verifySamples(observations, rows, 3);
        }
        const sampledMs = performance.now() - sampled;
        const stream = run.model
          .monitor([{ from: 'Node', select: ['value'] }])
          [Symbol.asyncIterator]();
        await stream.next();
        await run.pause(true);
        const pending = assert.rejects(stream.next(), { code: 'aborted' });
        await until(run, (m) => m.waiting === 1);
        const cancellation = performance.now();
        await stream.return?.();
        await pending;
        const cancelMs = performance.now() - cancellation;
        await run.pause(false);
        const result = {
          mode,
          rows,
          deliveryMs,
          firstBlockMs,
          borrowedMs: median(borrowed),
          ownedMs: median(owned),
          sampledMs,
          cancelMs,
          maxDeliveryBytes,
        };
        results.push(result);
        console.log(result);
      } finally {
        await run.close();
      }
    }
  const output = fileURLToPath(
    new URL('../../../../output/data-delivery-benchmark.json', import.meta.url),
  );
  await mkdir(fileURLToPath(new URL('../../../../output/', import.meta.url)), { recursive: true });
  await writeFile(output, JSON.stringify({ results }, null, 2));
}, 120000);
