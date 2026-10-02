import { expect, it } from 'vitest';
import { connected, subscribed } from '../../connect/tests/fixture.js';
import { inputPatch, transaction } from '../../model/tests/live.js';
import { createData, type NumericColumn } from '@latkit/model';
import { createGpu } from '../src/index.js';
import { type GpuPage } from '../src/kit.js';
import { bytes, fakeDevice } from './fixtures/device.js';
import { field } from './fixtures/fields.js';
import { draw } from './fixtures/render.js';

it('reads and uploads the same native contract through connect without a renderer transport adapter', async () => {
  const h = await connected();
  const patch = inputPatch(100000);
  (patch.columns.value as NumericColumn).values.set(
    Float64Array.from({ length: 100000 }, (_, i) => i),
  );
  const stream = h.remote.monitor([{ from: 'Node', select: ['value'] }]);
  await subscribed(h.model);
  const publishing = h.model.publish([patch]);
  const events = await transaction(stream);
  await publishing;
  const remote = createData(
    h.remote.schema,
    'v1',
    events.flatMap((event) => (event.kind === 'data' ? [event.patch] : [])),
  );
  const source = { index: patch.index, values: (patch.columns.value as NumericColumn).values };
  await h.close();
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device, validate: true });
  try {
    const pages: GpuPage[] = [];
    await draw(gpu, async (frame) => {
      for await (const block of frame.query(remote, {
        kind: 'rows',
        from: 'Node',
        select: ['value'],
        rows: { kind: 'range', offset: 99990, count: 10 },
      }))
        if (block.kind === 'rows')
          pages.push(...frame.upload(block, { select: ['value'], float64: 'float32' }));
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
          float64: 'float32',
        }))
          fields.push(page);
    });
    const prepared = bytes(field(fields[0]).binding);
    expect([...new Float32Array(prepared.buffer, prepared.byteOffset, 10)]).toEqual(
      Array.from({ length: 10 }, (_, i) => 99990 + i),
    );
    expect(source.values.byteLength).toBe(800000);
    gpu.destroy();
  } finally {
    gpu.destroy();
  }
});
