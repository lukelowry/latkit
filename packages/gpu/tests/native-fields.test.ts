import { expect, it } from 'vitest';
import { createGpu } from '../src/index.js';
import { type NativeFields } from '../src/kit.js';
import { fakeDevice } from './fixtures/device.js';
import { FieldSource } from './fixtures/field-source.js';
import { draw } from './fixtures/render.js';

it('exposes immutable columns that need no acquisition or release', async () => {
  const source = new FieldSource(),
    gpu = await createGpu({ device: fakeDevice().device });
  let native!: NativeFields;
  await draw(gpu, async (frame) => {
    for await (const page of frame.fields({
      source: source.data,
      from: 'node',
      fields: { position: 'position', value: 'value', alias: 'value' },
    })) {
      native = page;
      expect(page.columns.value).toBe(page.columns.alias);
      expect('retain' in page).toBe(false);
    }
  });
  gpu.trim();
  gpu.destroy();
  expect(native.columns.position.kind).toBe('vector');
  if (native.columns.position.kind === 'vector')
    expect(native.columns.position.values.values[0]).toBe(1e12);
});
it('exposes presence separately from null validity on partial native overlays', async () => {
  const source = new FieldSource(),
    observed = new FieldSource();
  observed.captured = new Set([1, 3]);
  const gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    for await (const page of frame.fields({
      source: source.data,
      from: source.index.type,
      rows: { index: source.index, kind: 'range', offset: 0, count: 8 },
      fields: {
        value: {
          source: observed.data,
          from: 'node',
          field: 'observed',
          rows: { kind: 'indices', index: source.index, values: Uint32Array.of(1, 3) },
        },
      },
    })) {
      expect(page.presence.value[0]).toBe(0b1010);
      expect(page.columns.value.validity).toBeUndefined();
    }
  });
  gpu.destroy();
});
it('rejects unknown native fields before executing a query', async () => {
  const source = new FieldSource(),
    gpu = await createGpu({ device: fakeDevice().device });
  await expect(
    draw(gpu, async (frame) => {
      for await (const _page of frame.fields({
        source: source.data,
        from: source.index.type,
        rows: { index: source.index, kind: 'range', offset: 0, count: 8 },
        fields: { value: 'missing' },
      })) {
        /* consume */
      }
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  gpu.destroy();
});
