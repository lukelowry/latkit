import { expect, it } from 'vitest';
import { createGpu } from '../src/index.js';
import { type NativeFields } from '../src/kit.js';
import { fakeDevice } from './fixtures/device.js';
import { FieldSource } from './fixtures/field-source.js';
import { draw } from './fixtures/render.js';

it('exposes native precision and aliasing without another query, and budgets retained data', async () => {
  const source = new FieldSource(),
    fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  let native!: NativeFields, release!: () => void, again!: () => void;
  await draw(gpu, async (frame) => {
    for await (const page of frame.fields({
      source,
      from: source.index.type,
      rows: { index: source.index, kind: 'range', offset: 0, count: 8 },
      fields: { position: 'position', value: 'value', alias: 'value' },
    })) {
      native = page;
      expect(native.columns.value).toBe(native.columns.alias);
      expect(native.columns.position.kind).toBe('vector');
      if (native.columns.position.kind === 'vector')
        expect(native.columns.position.values.values[0]).toBe(1e12);
      release = native.retain();
      const before = gpu.stats().cpuBytes;
      again = native.retain();
      expect(gpu.stats().cpuBytes - before).toBe(224);
    }
  });
  expect(source.requests).toHaveLength(1);
  expect(() => native.retain()).toThrow();
  gpu.trim();
  expect(gpu.stats().cpuBytes).toBeGreaterThan(0);
  release();
  release();
  again();
  gpu.trim();
  expect(gpu.stats().cpuBytes).toBe(0);
  gpu.destroy();
});
it('exposes presence separately from null validity on partial native overlays', async () => {
  const source = new FieldSource(),
    observed = new FieldSource();
  observed.captured = new Set([1, 3]);
  const gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    for await (const page of frame.fields({
      source,
      from: source.index.type,
      rows: { index: source.index, kind: 'range', offset: 0, count: 8 },
      fields: {
        value: {
          source: observed,
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
        source,
        from: source.index.type,
        rows: { index: source.index, kind: 'range', offset: 0, count: 8 },
        fields: { value: 'missing' },
      })) {
        /* consume */
      }
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  expect(source.requests).toHaveLength(0);
  gpu.destroy();
});
