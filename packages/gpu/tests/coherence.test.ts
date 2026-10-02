import { expect, it } from 'vitest';
import { createGpu } from '../src/index.js';
import { Source } from './fixtures/source.js';
import { fakeDevice } from './fixtures/device.js';
import { draw } from './fixtures/render.js';
it('prepares independently versioned application data without requiring a common provider', async () => {
  const a = new Source(4),
    b = new Source(4);
  b.publish();
  const gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    for (const data of [a.data, b.data])
      for await (const block of frame.query(data, {
        kind: 'rows',
        from: 'node',
        select: ['value'],
      }))
        if (block.kind === 'rows') expect(block.version).toBe(data.version);
  });
  gpu.destroy();
});
it('leaving one computation does not cancel another consumer of its data', async () => {
  const data = new Source(100, { blockRows: 10 }).data,
    gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    const query = { kind: 'rows', from: 'node', select: ['value'] } as const;
    await Promise.all([
      (async () => {
        for await (const block of frame.query(data, query)) {
          if (block.kind === 'rows') break;
        }
      })(),
      (async () => {
        let n = 0;
        for await (const block of frame.query(data, query))
          if (block.kind === 'rows') n += block.columns.value.length;
        expect(n).toBe(100);
      })(),
    ]);
  });
  gpu.destroy();
});
