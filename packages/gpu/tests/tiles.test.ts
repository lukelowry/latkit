import { expect, it } from 'vitest';
import type { FieldsBlock, SampleColumn } from '@latkit/model';
import { createGpu } from '../src/index.js';
import { type GpuPage } from '../src/kit.js';
import { fakeDevice } from './fixtures/device.js';
import { field, rowMap } from './fixtures/fields.js';
import { draw } from './fixtures/render.js';

it('shares frame coordinates across row tiles and physical row maps across frame tiles', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device, pageBytes: 16 });
  const value: SampleColumn = {
    kind: 'numeric',
    values: Float32Array.from({ length: 24 }, (_, i) => i),
    offset: 0,
    length: 24,
    frameStride: 8,
    rowStride: 1,
  };
  const block: FieldsBlock = {
    kind: 'fields',
    index: { source: 'd', type: 'node', version: 'i' },
    rows: { kind: 'indices', values: Uint32Array.of(9, 8, 7, 6, 5, 4, 3, 2) },
    rowOffset: 0,
    columns: { value },
    presence: {},
    samples: { firstFrame: 100, coordinates: Float64Array.of(10, 20, 30) },
  };
  let pages: readonly GpuPage[] = [];
  await draw(gpu, (frame) => {
    pages = frame.upload(block, { select: ['value'] });
  });
  expect(pages).toHaveLength(24);
  expect(field(pages[0], pages[0].samples!.coordinates).binding).toEqual(
    field(pages[1], pages[1].samples!.coordinates).binding,
  );
  expect(rowMap(pages[0])).toEqual(rowMap(pages[8]));
  expect(rowMap(pages[0])).toEqual(rowMap(pages[16]));
  expect(gpu.stats().uploadedBytes).toBe(24 * 4 + 8 * 4 + 3 * 4 + 24 * 156);
  gpu.destroy();
});
