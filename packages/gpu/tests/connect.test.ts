import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { connect, messagePort, serve } from '@latkit/connect';
import { createGpu, type GpuPage } from '../src/index.js';
import { bytes, fakeDevice } from './fixtures/device.js';
import { field } from './fixtures/fields.js';
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
    const stored = bytes(field(pages[0]).binding);
    expect([...new Float32Array(stored.buffer, stored.byteOffset, 10)]).toEqual(
      Array.from({ length: 10 }, (_, i) => 99990 + i),
    );
    const fields: GpuPage[] = [];
    await draw(gpu, async (frame) => {
      for await (const native of frame.fields({
        source: remote,
        from: source.index.type,
        rows: { index: source.index, kind: 'range', offset: 99990, count: 10 },
        fields: { value: 'value' },
      }))
        for (const page of frame.upload(native, {
          select: Object.keys(native.columns),
          float64: 'relative',
        }))
          fields.push(page);
    });
    const prepared = bytes(field(fields[0]).binding);
    expect([...new Float32Array(prepared.buffer, prepared.byteOffset, 10)]).toEqual(
      Array.from({ length: 10 }, (_, i) => 99990 + i),
    );
    expect(source.values.byteLength).toBe(400000);
    gpu.destroy();
    expect(source.closes).toBe(0);
    expect(await remote.describe()).toEqual(source.schema);
  } finally {
    gpu.destroy();
    await remote.close();
    await serving;
    channel.port1.close();
    channel.port2.close();
  }
  expect(source.closes).toBe(0);
});
