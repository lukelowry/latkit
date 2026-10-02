import { expect, it } from 'vitest';
import { createGpu } from '../src/index.js';
import { fakeDevice } from './fixtures/device.js';
import { draw } from './fixtures/render.js';
import { FieldSource } from './fixtures/field-source.js';
it('resolves full selection extents, reuses static cache, and invalidates relevant changes', async () => {
  const source = new FieldSource(100),
    gpu = await createGpu({ device: fakeDevice().device });
  source.blockRows = 7;
  const request = {
    source: source.data,
    index: source.index,
    rows: { kind: 'range' as const, offset: 5, count: 85 },
    field: 'value',
  };
  const render = () =>
    draw(gpu, async (frame) => {
      expect(await frame.extent(request)).toEqual([5, 89]);
    });
  await render();
  const queries = gpu.stats().queries;
  await render();
  expect(gpu.stats().queries).toBe(queries);
  gpu.destroy();
});
it('ignores null, missing, and nonfinite values, preserving a constant or empty result', async () => {
  const gpu = await createGpu({ device: fakeDevice().device }),
    index = { source: 'd', type: 'node', version: '1' },
    rows = { kind: 'range' as const, offset: 0, count: 4 };
  await draw(gpu, async (frame) => {
    const values = {
      index,
      rows,
      values: {
        kind: 'numeric' as const,
        offset: 0,
        length: 4,
        values: Float64Array.of(NaN, 5, 99, Infinity),
        validity: Uint8Array.of(0b1011),
      },
    };
    expect(await frame.extent({ index, rows, field: values })).toEqual([5, 5]);
    expect(
      await frame.extent({ index, rows: { kind: 'range', offset: 5, count: 1 }, field: values }),
    ).toBeNull();
  });
  gpu.destroy();
});

it('uses a row read for a sampled coordinate when a source does not advertise aggregates', async () => {
  const source = new FieldSource(),
    gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    expect(
      await frame.extent({
        source: source.data,
        index: source.index,
        rows: { kind: 'range', offset: 1, count: 3 },
        field: 'observed',
        window: { kind: 'at', value: 4 },
      }),
    ).toEqual([1e12 + 5, 1e12 + 7]);
  });
  gpu.destroy();
});
it('reduces sampled application values and caches the local result', async () => {
  const source = new FieldSource(),
    gpu = await createGpu({ device: fakeDevice().device });
  const request = {
    source: source.data,
    index: source.index,
    rows: { kind: 'range' as const, offset: 0, count: 8 },
    field: 'observed',
    window: { kind: 'frames' as const, offset: 0, count: 2 },
  };
  await draw(gpu, async (frame) => {
    expect(await frame.extent(request)).toEqual([1e12, 1e12 + 8]);
    const count = gpu.stats().queries;
    expect(await frame.extent(request)).toEqual([1e12, 1e12 + 8]);
    expect(gpu.stats().queries).toBe(count);
  });
  gpu.destroy();
});
