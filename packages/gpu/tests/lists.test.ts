import { FieldSource } from './fixtures/field-source.js';
import { expect, it } from 'vitest';
import { createGpu } from '../src/index.js';
import { type FieldValues, type GpuPage } from '../src/kit.js';
import { fakeDevice, bytes } from './fixtures/device.js';
import { draw } from './fixtures/render.js';
import { field } from './fixtures/fields.js';
const index = { source: 'd', type: 'path', version: '1' };
function lists(): FieldValues {
  return {
    index,
    rows: { kind: 'range', offset: 10, count: 3 },
    values: {
      kind: 'list',
      offset: 1,
      length: 3,
      offsets: Int32Array.of(0, 1, 3, 3, 4),
      validity: Uint8Array.of(0b1010),
      values: {
        kind: 'vector',
        size: 2,
        offset: 1,
        length: 4,
        values: {
          kind: 'numeric',
          offset: 1,
          length: 10,
          values: Float64Array.of(
            999,
            88,
            88,
            1e12,
            1e12,
            1e12 + 1,
            1e12 + 2,
            1e12 + 3,
            1e12 + 4,
            1e12 + 5,
            1e12 + 6,
          ),
        },
      },
    },
  };
}
it('uploads sliced list offsets and relative vector items in the shared field ABI', async () => {
  const gpu = await createGpu({ device: fakeDevice().device });
  let page!: GpuPage;
  await draw(gpu, (frame) => {
    page = frame.values(lists(), { float64: 'relative' })[0];
  });
  const list = page.columns.value;
  expect(list.kind).toBe('list');
  if (list.kind !== 'list') throw new Error('Expected list descriptor');
  expect(list.items.components).toBe(2);
  expect(Array.from(list.items.origin!)).toEqual([1e12 + 1, 1e12 + 2]);
  const binding = field(page, list.items).binding,
    data = bytes({ ...binding, size: 24 });
  expect(Array.from(new Float32Array(data.buffer, data.byteOffset, 6))).toEqual([0, 0, 2, 2, 4, 4]);
  gpu.destroy();
});
it('gathers sparse native lists once and can retain controls without uploading them', async () => {
  const gpu = await createGpu({ device: fakeDevice().device }),
    input = lists();
  await draw(gpu, async (frame) => {
    for await (const page of frame.fields({
      source: new FieldSource(),
      from: index.type,
      rows: { index, kind: 'indices', values: Uint32Array.of(12, 10) },
      fields: {
        points: input,
        style: {
          index,
          rows: input.rows,
          values: { kind: 'numeric', offset: 0, length: 3, values: Float32Array.of(1, 2, 3) },
        },
      },
    })) {
      const uploaded = frame.upload(page, { select: ['style'] });
      expect(Object.keys(uploaded[0].columns)).toEqual(['style']);
      const column = page.columns.points;
      expect(column.kind).toBe('list');
      if (column.kind === 'list') {
        expect(Array.from(column.offsets)).toEqual([0, 1, 3]);
        expect(column.values.length).toBe(3);
      }
    }
  });
  gpu.destroy();
});
it('rejects oversized cells and implicit Float64 list conversion', async () => {
  const gpu = await createGpu({ device: fakeDevice().device });
  await expect(
    draw(gpu, (frame) => {
      frame.values(lists());
    }),
  ).rejects.toMatchObject({ code: 'precision' });
  await expect(
    draw(gpu, (frame) => {
      frame.values(lists(), { float64: 'relative', maxPageBytes: 16 });
    }),
  ).rejects.toMatchObject({ code: 'resource-limit' });
  gpu.destroy();
});

it('ignores payloads under null parents when choosing a relative list origin', async () => {
  const gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, (frame) => {
    const page = frame.values(
      {
        index,
        rows: { kind: 'range', offset: 0, count: 2 },
        values: {
          kind: 'list',
          offset: 0,
          length: 2,
          offsets: Int32Array.of(0, 1, 2),
          validity: Uint8Array.of(2),
          values: { kind: 'numeric', offset: 0, length: 2, values: Float64Array.of(1e300, 7) },
        },
      },
      { float64: 'relative' },
    )[0];
    const list = page.columns.value;
    expect(list.kind === 'list' && list.items.origin?.[0]).toBe(7);
  });
  gpu.destroy();
});
