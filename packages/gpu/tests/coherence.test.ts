import { expect, it } from 'vitest';
import { createGpu } from '../src/index.js';
import { fakeDevice } from './fixtures/device.js';
import { draw } from './fixtures/render.js';
import { Source } from './fixtures/source.js';

it('refuses to combine two query versions from the same live acquisition', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const source = new Source();
  await expect(
    draw(gpu, async (frame) => {
      for await (const block of frame.query(source, {
        kind: 'rows',
        from: 'node',
        select: ['value'],
      }))
        void block;
      source.publish();
      for await (const block of frame.query(source, {
        kind: 'rows',
        from: 'node',
        select: ['value'],
        rows: { kind: 'range', offset: 0, count: 2 },
      }))
        void block;
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(fake.queue.submit).not.toHaveBeenCalled();
  gpu.destroy();
});

it('does not cancel another view when one view abandons a shared stream', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const source = new Source(10, { blockRows: 2 });
  const { renderer, target } = await import('./fixtures/render.js');
  let count = 0;
  await gpu.render({
    timeMs: 0,
    views: [
      {
        target: target(fake.device),
        renderer: renderer(async (frame) => {
          for await (const block of frame.query(source, {
            kind: 'rows',
            from: 'node',
            select: ['value'],
          })) {
            if (block.kind === 'rows') break;
          }
        }),
      },
      {
        target: target(fake.device),
        renderer: renderer(async (frame) => {
          for await (const block of frame.query(source, {
            kind: 'rows',
            from: 'node',
            select: ['value'],
          }))
            if (block.kind === 'rows' && block.rows.kind === 'range') count += block.rows.count;
        }),
      },
    ],
  });
  expect(count).toBe(10);
  expect(source.reads).toBe(1);
  gpu.destroy();
});
