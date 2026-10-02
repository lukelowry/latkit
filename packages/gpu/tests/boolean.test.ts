import { expect, it } from 'vitest';
import type { RowsBlock } from '@latkit/model';
import { createGpu } from '../src/index.js';
import { type GpuPage } from '../src/kit.js';
import { bytes, fakeDevice } from './fixtures/device.js';
import { field } from './fixtures/fields.js';
import { draw } from './fixtures/render.js';

it('keeps boolean values and null validity as separate packed bitmaps', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const block: RowsBlock = {
    kind: 'rows',
    version: 'v',
    index: { source: 'd', type: 'node', version: 'i' },
    rows: { kind: 'range', offset: 1000000, count: 3 },
    position: 0,
    columns: {
      visible: {
        kind: 'boolean',
        values: Uint8Array.of(0b00010100),
        offset: 2,
        length: 3,
        validity: Uint8Array.of(0b00001100),
      },
    },
  };
  let page!: GpuPage;
  await draw(gpu, (frame) => {
    page = frame.upload(block, { select: ['visible'] })[0];
  });
  const column = page.columns.visible;
  expect(column.kind === 'value' && column.type).toBe('boolean');
  expect(field(page, 'visible').offset).toBe(2);
  expect(bytes(field(page, 'visible').binding)[0]).toBe(0b00010100);
  expect(field(page, 'visible').validity?.offset).toBe(2);
  expect(bytes(field(page, 'visible').validity!.binding)[0]).toBe(0b00001100);
  expect(gpu.stats().uploadedBytes).toBe(104);
  gpu.destroy();
});
