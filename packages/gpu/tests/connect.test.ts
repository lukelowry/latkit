import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { connect, messagePort, serve } from '@latkit/connect';
import { createGpu, type GpuPage } from '../src/index.js';
import { bytes, fakeDevice } from './fixtures/device.js';
import { draw } from './fixtures/render.js';
import { Source } from './fixtures/source.js';

it('reads and uploads the same native contract through connect without a renderer transport adapter', async () => {
  const channel = new MessageChannel();
  const source = new Source(100000, { blockRows: 16384 });
  const serving = serve(messagePort(channel.port1), source, { kind: 'queryable' });
  const remote = await connect(messagePort(channel.port2), { kind: 'queryable' });
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device, validate: true });
  try {
    const pages: GpuPage[] = [];
    await draw(gpu, async (frame) => {
      for await (const block of frame.query(remote, {
        kind: 'rows',
        from: 'node',
        select: ['value'],
        rows: { kind: 'range', offset: 99990, count: 10 },
      }))
        if (block.kind === 'rows') pages.push(...frame.upload(block, { select: ['value'] }));
    });
    expect(pages).toHaveLength(1);
    expect(pages[0].index).toEqual(source.index);
    expect(pages[0].rows).toEqual({ kind: 'range', offset: 99990, count: 10 });
    const stored = bytes(pages[0].columns.value.binding);
    expect([...new Float32Array(stored.buffer, stored.byteOffset, 10)]).toEqual(
      Array.from({ length: 10 }, (_, i) => 99990 + i),
    );
    expect(source.values.byteLength).toBe(400000);
    gpu.destroy();
    expect(source.closes).toBe(0);
    expect((await remote.describe()).version).toBe(source.schema.version);
  } finally {
    gpu.destroy();
    await remote.close();
    await serving;
    channel.port1.close();
    channel.port2.close();
  }
  expect(source.closes).toBe(0);
});
