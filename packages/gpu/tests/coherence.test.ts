import { expect, it } from 'vitest';
import type { NumericColumn } from '@latkit/model';
import { createGpu } from '../src/index.js';
import { Source } from './fixtures/source.js';
import { fakeDevice } from './fixtures/device.js';
import { draw } from './fixtures/render.js';
it('prepares independent application data without requiring a common provider', async () => {
  const a = new Source(4),
    b = new Source(4);
  b.publish();
  const gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    for (const source of [a, b])
      for await (const block of frame.reader.read(source.data, {
        kind: 'rows',
        from: 'node',
        select: ['value'],
      }))
        expect((block.columns.value as NumericColumn).values.buffer).toBe(source.values.buffer);
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
        for await (const _block of frame.reader.read(data, query)) break;
      })(),
      (async () => {
        let n = 0;
        for await (const block of frame.reader.read(data, query)) n += block.columns.value.length;
        expect(n).toBe(100);
      })(),
    ]);
  });
  gpu.destroy();
});
