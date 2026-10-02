import { expect, it } from 'vitest';
import { pair, collect } from '../../connect/tests/fixture.js';
import {
  createData,
  selectBatches,
  bitAt,
  numberAt,
  sampleAt,
  textAt,
  validateBlock,
  rowCount,
  type Data,
  type EnvelopeBlock,
  type EnvelopeQuery,
  type NumericColumn,
  type SampleColumn,
} from '@latkit/model';
import { createGpu } from '../src/index.js';
import {
  resolveScale,
  scaleValue,
  scaleParameters,
  withinBudget,
  type GpuPage,
  type NativeFields,
} from '../src/kit.js';
import { fakeDevice } from './fixtures/device.js';
import { field } from './fixtures/fields.js';
import { draw } from './fixtures/render.js';
import { HistorySource } from './fixtures/history.js';
const query: EnvelopeQuery = {
  kind: 'envelope',
  from: 'node',
  select: ['value'],
  rows: { kind: 'range', offset: 0, count: 2 },
  window: { kind: 'range', between: [0, 6] },
  buckets: 3,
};

it('reads text without GPU allocation and decodes the requested sliced cell only', async () => {
  const source = new HistorySource(),
    gpu = await createGpu({ device: fakeDevice().device });
  await draw(gpu, async (frame) => {
    for await (const tile of frame.fields({
      source: source.data,
      from: 'node',
      fields: { label: 'label' },
      ids: true,
    })) {
      expect(tile.columns.label.kind).toBe('text');
      if (tile.columns.label.kind !== 'text') throw new Error();
      expect(tile.columns.label.bytes.buffer).toBe(source.labels.bytes.buffer);
      expect(textAt(tile.columns.label, 0)).toBe('\u03b1');
      expect(textAt(tile.columns.label, 1)).toBe('beta');
      expect(textAt(tile.ids!, 0)).toBe('\u03b1');
      expect(() => frame.upload(tile, { select: ['label'] })).toThrow();
    }
  });
  expect(gpu.stats()).toMatchObject({ uploadedBytes: 0, gpuBytes: 0 });
  gpu.destroy();
});
it('keeps sampled strides/native backing and broadcasts static columns without expanding them', async () => {
  const source = new HistorySource(),
    gpu = await createGpu({ device: fakeDevice().device });
  const native: NativeFields[] = [],
    pages: GpuPage[] = [];
  await draw(gpu, async (frame) => {
    for await (const tile of frame.fields({
      source: source.data,
      from: 'node',
      fields: { value: 'value', weight: 'weight', label: 'label' },
      window: { kind: 'frames', offset: source.firstFrame, count: 2 },
    })) {
      native.push(tile);
      pages.push(...frame.upload(tile, { select: ['value', 'weight'], float64: 'relative' }));
      expect((tile.columns.value as NumericColumn).values.buffer).toBe(source.values.buffer);
      expect(sampleAt(tile.columns.value as SampleColumn, { row: 1, frame: 1 })).toBeNull();
      expect(numberAt(tile.columns.weight as NumericColumn, 1)).toBe(11);
    }
  });
  expect(native).toHaveLength(1);
  expect(pages[0].samples?.firstFrame).toBe(source.firstFrame);
  expect(field(pages[0], 'weight').frameStride).toBe(0);
  expect((native[0].columns.weight as NumericColumn).values.length).toBe(2);
  gpu.destroy();
});
it('rejects incompatible observation coordinates rather than silently resampling bindings', async () => {
  const a = new HistorySource(),
    b = new HistorySource(Float64Array.of(0, 0.5, 1, 2, 3, 4, 6));
  const gpu = await createGpu({ device: fakeDevice().device });
  await expect(
    draw(gpu, async (frame) => {
      for await (const _ of frame.fields({
        source: a.data,
        from: 'node',
        fields: { a: 'value', b: { source: b.data, from: 'node', field: 'value' } },
        window: { kind: 'frames', offset: a.firstFrame, count: 2 },
      }))
        void _;
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  gpu.destroy();
});
it('reduces unsorted native tiles to exact extrema identities, preserves gaps, and uploads the native envelope ABI', async () => {
  const source = new HistorySource();
  source.reverseFrames = true;
  const gpu = await createGpu({ device: fakeDevice().device, validate: true });
  let result!: EnvelopeBlock, page!: GpuPage;
  await draw(gpu, async (frame) => {
    for await (const block of frame.envelope({ source: source.data, query })) {
      result = block;
      page = frame.upload(block, { select: ['value'] })[0];
    }
  });
  expect(validateBlock(source.schema, query, result)).toEqual([]);
  const column = result.columns.value;
  expect([...column.values.values]).toEqual([
    9, 2, 10, 10, 1, 1, 1, 1, 8, 4, 8, 4, 3, 3, 8, 8, 2, 2, 2, 2, 9, 0, 9, 0,
  ]);
  expect([...column.frames.subarray(0, 4)]).toEqual([0, 1, 2, 2].map((i) => source.firstFrame + i));
  expect([...column.coordinates.subarray(0, 4)]).toEqual([0, 1, 1, 1]);
  expect(Array.from({ length: 6 }, (_, i) => bitAt(column.continuous, i))).toEqual([
    true,
    false,
    true,
    false,
    true,
    true,
  ]);
  const descriptor = page.columns.value;
  if (descriptor.kind !== 'envelope') throw new Error('Expected native envelope descriptor');
  expect(descriptor.values.components).toBe(4);
  expect(descriptor.frames.origin?.[0]).toBe(source.firstFrame);
  expect(page.envelope).toEqual({ firstBucket: 0, count: 3 });
  const uploaded = gpu.stats().uploadedBytes,
    requests = gpu.stats().queries;
  await draw(gpu, async (frame) => {
    for await (const block of frame.envelope({ source: source.data, query }))
      frame.upload(block, { select: ['value'] });
  });
  expect(gpu.stats().queries).toBe(requests);
  expect(gpu.stats().uploadedBytes).toBe(uploaded);
  gpu.destroy();
});
it('includes boundary duplicates and context, leaves empty buckets invalid, and bounds summary working storage', async () => {
  const source = new HistorySource(),
    gpu = await createGpu({ device: fakeDevice().device, maxBlockBytes: 8192 });
  const q = {
    ...query,
    window: { kind: 'range' as const, between: [1, 3] as const, context: { before: 1, after: 1 } },
    buckets: 4,
  };
  await draw(gpu, async (frame) => {
    for await (const block of frame.envelope({ source: source.data, query: q })) {
      const c = block.columns.value;
      expect(c.coordinates[0]).toBe(0);
      expect(c.coordinates[15]).toBe(4);
      expect(bitAt(c.values.validity, 4)).toBe(false);
    }
  });
  await expect(
    draw(gpu, async (frame) => {
      for await (const b of frame.envelope({
        source: source.data,
        query: { ...query, buckets: 1e6 },
      }))
        void b;
    }),
  ).rejects.toMatchObject({ code: 'resource-limit' });
  gpu.trim();
  expect(gpu.stats().cpuBytes).toBe(0);
  gpu.destroy();
});
it('reduces delivered samples after the transport and producer have closed', async () => {
  const source = new HistorySource();
  const h = await pair(
    {
      monitor: (fields, { signal, maxBatchBytes }) =>
        selectBatches(source.data, fields, { signal, maxBlockBytes: maxBatchBytes }),
    },
    {},
    source.schema,
  );
  let data;
  try {
    const publications = await collect(h.model.monitor([{ from: 'node', select: ['value'] }]));
    data = createData(h.model.schema, 'v1', publications.flat());
  } finally {
    await h.close();
  }
  const gpu = await createGpu({ device: fakeDevice().device, validate: true });
  await draw(gpu, async (frame) => {
    for await (const block of frame.envelope({ source: data, query })) {
      expect([...block.columns.value.values.values].slice(0, 4)).toEqual([9, 2, 10, 10]);
      expect(frame.upload(block, { select: ['value'] })[0].columns.value.kind).toBe('envelope');
    }
  });
  gpu.destroy();
});
it('keeps null, constant, reversed output ranges and relative Float64 scale semantics consistent', () => {
  expect(scaleValue(5, resolveScale({}, null))).toBeNull();
  expect(scaleValue(NaN, resolveScale({}, [0, 1]))).toBeNull();
  expect(scaleValue(9, resolveScale({ range: [8, 2] }, [5, 5]))).toBe(5);
  expect(scaleValue(1e12 + 0.25, resolveScale({ range: [2, 0] }, [1e12, 1e12 + 1]))).toBe(1.5);
  const params = scaleParameters(resolveScale({ range: [2, 0] }, [1e12, 1e12 + 1]), {
    origin: 1e12,
  });
  expect([...params]).toEqual([0, 1, 2, -2, 1, 1, 0, 0]);
  expect(scaleValue(2, resolveScale({ clamp: false }, [0, 1]))).toBe(2);
  expect(scaleValue(Number.MIN_VALUE, resolveScale({}, [0, Number.MIN_VALUE]))).toBe(1);
  expect(scaleValue(0, resolveScale({}, [-Number.MAX_VALUE, Number.MAX_VALUE]))).toBe(0.5);
});
it('never publishes a partial picking result after its cooperative budget expires', () => {
  const result = withinBudget((check) => {
    for (let i = 0; i < 1e7; i++) check();
    return 42;
  }, 0.001);
  expect(result.complete).toBe(false);
  expect(withinBudget(() => 42)).toMatchObject({ complete: true, value: 42 });
});

it('rejects missing rows inside declared sampled coverage and preserves frame identities with float32 values', async () => {
  const source = new HistorySource(),
    missing = new HistorySource();
  const absent: Data = {
    ...missing.data,
    tables: {
      node: {
        ...missing.data.tables.node,
        fields: {
          ...missing.data.tables.node.fields,
          value: createData(missing.data.schema, 'empty', [
            {
              kind: 'rows',
              index: missing.index,
              rows: missing.data.tables.node.rows,
              columns: {},
            },
          ]).tables.node.fields.value,
        },
      },
    },
  };
  const gpu = await createGpu({ device: fakeDevice().device });
  await expect(
    draw(gpu, async (frame) => {
      for await (const tile of frame.fields({
        source: source.data,
        from: 'node',
        fields: {
          value: 'value',
          overlay: {
            source: absent,
            from: 'node',
            field: 'value',
            rows: { kind: 'range', offset: 0, count: 1 },
          },
        },
        window: { kind: 'frames', offset: source.firstFrame, count: 2 },
      }))
        void tile;
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  await draw(gpu, async (frame) => {
    for await (const block of frame.envelope({ source: source.data, query })) {
      const column = frame.upload(block, { select: ['value'], float64: 'float32' })[0].columns
        .value;
      if (column.kind !== 'envelope') throw new Error('Expected envelope');
      expect(column.values.origin).toBeUndefined();
      expect(column.frames.origin?.[0]).toBe(source.firstFrame);
      expect(column.coordinates.origin).toBeDefined();
    }
  });
  gpu.trim();
  expect(gpu.stats().cpuBytes).toBe(0);
  gpu.destroy();
});
it('streams a million historical observations into bounded native summaries', async () => {
  const frames = 131072,
    source = new HistorySource(
      Float64Array.from({ length: frames }, (_, i) => i),
      8,
    );
  source.blockFrames = 1024;
  const cpuBytes = 16 * 1024 ** 2,
    stagingBytes = 2 * 1024 ** 2;
  const gpu = await createGpu({
    device: fakeDevice().device,
    budget: { cpuBytes, stagingBytes },
    maxBlockBytes: 128 * 1024,
  });
  let rows = 0;
  await draw(gpu, async (frame) => {
    for await (const block of frame.envelope({
      source: source.data,
      query: {
        ...query,
        rows: { kind: 'range', offset: 0, count: 8 },
        window: { kind: 'range', between: [0, frames - 1] },
        buckets: 512,
      },
    })) {
      rows += rowCount(block.rows);
      expect(block.columns.value.frames[0]).toBe(source.firstFrame);
      expect(block.columns.value.frames[block.bucketCount * 4 - 1]).toBe(
        source.firstFrame + frames - 1,
      );
    }
  });
  expect(rows).toBe(8);
  expect(gpu.stats().peakCpuBytes).toBeLessThanOrEqual(cpuBytes);
  expect(gpu.stats().peakStagingBytes).toBeLessThanOrEqual(stagingBytes);
  gpu.trim();
  expect(gpu.stats().cpuBytes).toBe(0);
  gpu.destroy();
});
