import { expect, it } from 'vitest';
import { pair, batch, fields, collect } from '../../connect/tests/fixture.js';
import { createData, type NumericColumn } from '@latkit/model';
import { createGpu } from '../src/index.js';
import { type GpuPage } from '../src/kit.js';
import { bytes, fakeDevice } from './fixtures/device.js';
import { field } from './fixtures/fields.js';
import { draw } from './fixtures/render.js';

it('reads and uploads the same native contract through connect without a renderer transport adapter', async () => {
  const patch = batch(100000);
  (patch.columns.value as NumericColumn).values.set(
    Float64Array.from({ length: 100000 }, (_, i) => i),
  );
  const h = await pair({
    monitor: function* () {
      yield patch;
    },
  });
  let remote;
  try {
    const publications = await collect(h.model.monitor(fields));
    remote = createData(h.model.schema, publications.flat());
  } finally {
    await h.close();
  }
  const source = { index: patch.index, values: (patch.columns.value as NumericColumn).values };
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device, validate: true });
  try {
    const pages: GpuPage[] = [];
    await draw(gpu, async (frame) => {
      for await (const block of frame.reader.read(remote, {
        kind: 'rows',
        from: 'Node',
        select: ['value'],
        rows: { kind: 'range', offset: 99990, count: 10 },
      }))
        pages.push(
          ...frame.upload(
            { ...block, kind: 'fields', presence: {} },
            { select: ['value'], float64: 'float32' },
          ),
        );
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
      for await (const native of frame.reader.fields({
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
