import { expect, it } from 'vitest';
import type { SamplesBlock } from '@latkit/model';
import { createGpu, type GpuPage } from '../src/index.js';
import { fakeDevice } from './fixtures/device.js';
import { draw } from './fixtures/render.js';

it('shares frame coordinates across row tiles and physical row maps across frame tiles', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device, pageBytes: 16 });
  const block: SamplesBlock = {
    kind: 'samples',
    version: 'v',
    schemaVersion: 's',
    index: { document: 'd', type: 'node', version: 'i' },
    rows: { kind: 'indices', values: Uint32Array.of(9, 8, 7, 6, 5, 4, 3, 2) },
    rowOffset: 0,
    firstFrame: 100,
    coordinates: Float64Array.of(10, 20, 30),
    columns: {
      value: {
        kind: 'numeric',
        values: Float32Array.from({ length: 24 }, (_, i) => i),
        offset: 0,
        length: 24,
        frameStride: 8,
        rowStride: 1,
      },
    },
  };
  let pages: readonly GpuPage[] = [];
  await draw(gpu, (frame) => {
    pages = frame.upload(block, { select: ['value'] });
  });
  expect(pages).toHaveLength(6);
  expect(pages[0].samples?.coordinates.binding).toBe(pages[1].samples?.coordinates.binding);
  expect(pages[0].rowMap).toBe(pages[2].rowMap);
  expect(pages[0].rowMap).toBe(pages[4].rowMap);
  expect(gpu.stats().uploadedBytes).toBe(24 * 4 + 8 * 4 + 3 * 4);
  gpu.destroy();
});
