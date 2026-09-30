import { expect, it } from 'vitest';
import { createGpu, type FieldsRequest, type GpuPage } from '../src/index.js';
import { bytes, deferred, fakeDevice } from './fixtures/device.js';
import { field, values } from './fixtures/fields.js';
import { FieldSource } from './fixtures/field-source.js';
import { draw, renderer, target } from './fixtures/render.js';

function request(source: FieldSource): FieldsRequest {
  return {
    source,
    index: source.index,
    rows: { kind: 'range', offset: 0, count: source.count },
    fields: {
      x: 'value',
      same: 'value',
      position: 'position',
      color: 'color',
      visible: 'visible',
      observation: 'observed',
    },
    float64: 'relative',
  };
}
it('batches fields by dependency and preserves static CPU/GPU residency across recording append', async () => {
  const source = new FieldSource(),
    fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const pages: GpuPage[][] = [];
  const render = async () => {
    const result: GpuPage[] = [];
    await draw(gpu, async (frame) => {
      for await (const page of frame.fields(request(source))) result.push(page);
    });
    pages.push(result);
  };
  await render();
  expect(source.requests).toHaveLength(2);
  expect((source.requests[0] as { select: readonly string[] }).select).toEqual([
    'color',
    'position',
    'value',
    'visible',
  ]);
  expect(field(pages[0][0], 'x').binding).toEqual(field(pages[0][0], 'same').binding);
  const bytesBefore = gpu.stats().uploadedBytes;
  await render();
  expect(source.requests).toHaveLength(2);
  expect(gpu.stats().uploadedBytes).toBe(bytesBefore);
  source.publish({ kind: 'append', version: 'v1', frames: { offset: 1, count: 1 } });
  await render();
  expect(source.requests).toHaveLength(3);
  expect(field(pages[0][0], 'position').binding).toEqual(field(pages[2][0], 'position').binding);
  expect(values(pages[2][0], 'x')).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  gpu.destroy();
  expect(source.listeners.size).toBe(0);
});

it('aligns reordered multi-block inputs and explicit sparse observations without dropping draw rows', async () => {
  const source = new FieldSource(),
    observed = new FieldSource();
  observed.captured = new Set([1, 3]);
  source.reversed = true;
  source.blockRows = 2;
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const input = request(source);
  let page!: GpuPage;
  await draw(gpu, async (frame) => {
    for await (const result of frame.fields({
      ...input,
      fields: {
        value: 'value',
        overlay: {
          source: observed,
          from: 'node',
          field: 'observed',
          rows: { kind: 'indices', index: source.index, values: Uint32Array.of(1, 3) },
        },
      },
    }))
      page = result;
  });
  expect(values(page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(bytes(field(page, 'overlay').presence!.binding)[0]).toBe(0b1010);
  expect((page.columns.overlay as import('../src/index.js').GpuValueField).origin?.[0]).toBe(
    1e12 + 1,
  );
  await expect(
    draw(gpu, async (frame) => {
      for await (const _page of frame.fields({
        ...input,
        fields: { overlay: { source: observed, from: 'node', field: 'observed' } },
      })) {
        /* consume */
      }
    }),
  ).rejects.toMatchObject({ code: 'uncaptured' });
  gpu.destroy();
});

it('keeps boolean/vector types even when an explicit overlay has no rows', async () => {
  const source = new FieldSource(),
    fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  let page!: GpuPage;
  await draw(gpu, async (frame) => {
    for await (const result of frame.fields({
      ...request(source),
      fields: {
        visible: {
          source,
          from: 'node',
          field: 'visible',
          rows: { kind: 'range', offset: 99, count: 0 },
        },
        position: {
          source,
          from: 'node',
          field: 'position',
          rows: { kind: 'range', offset: 99, count: 0 },
        },
      },
    }))
      page = result;
  });
  expect(source.requests).toHaveLength(0);
  expect((page.columns.visible as import('../src/index.js').GpuValueField).type).toBe('boolean');
  expect((page.columns.position as import('../src/index.js').GpuValueField).components).toBe(2);
  expect(bytes(field(page, 'position').presence!.binding)[0]).toBe(0);
  gpu.destroy();
});

it('reuses native local slices without staging and rejects stale index identity', async () => {
  const source = new FieldSource(4096),
    fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device, pageBytes: 4096 });
  const input = {
    index: source.index,
    rows: { kind: 'range' as const, offset: 0, count: 4096 },
    values: {
      kind: 'numeric' as const,
      offset: 0,
      length: 4096,
      values: Float32Array.from({ length: 4096 }, (_, i) => i),
    },
  };
  const result: number[] = [];
  await draw(gpu, async (frame) => {
    for await (const page of frame.fields({ ...request(source), fields: { value: input } }))
      result.push(...values(page));
  });
  expect(result).toEqual([...input.values.values]);
  expect(gpu.stats().stagedBytes).toBe(0);
  await expect(
    draw(gpu, async (frame) => {
      for await (const _page of frame.fields({
        ...request(source),
        fields: { value: { ...input, index: { ...source.index, version: 'stale' } } },
      })) {
        /* consume */
      }
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  gpu.destroy();
});

it('bounds the binding count when ten fields occupy more than two slabs', async () => {
  const fake = fakeDevice({
      limits: {
        maxStorageBufferBindingSize: 1024,
        minStorageBufferOffsetAlignment: 256,
        maxStorageBuffersPerShaderStage: 3,
      },
    }),
    gpu = await createGpu({ device: fake.device, pageBytes: 1024 });
  const source = new FieldSource(40),
    fields: FieldsRequest['fields'] = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        'v' + i,
        {
          index: source.index,
          rows: { kind: 'range', offset: 0, count: 40 },
          values: {
            kind: 'numeric',
            offset: 0,
            length: 40,
            values: Float32Array.from({ length: 40 }, (_, row) => i * 100 + row),
          },
        },
      ]),
    );
  let pages: GpuPage[] = [];
  const render = () =>
    draw(gpu, async (frame) => {
      pages = [];
      for await (const page of frame.fields({ ...request(source), fields })) pages.push(page);
    });
  await render();
  for (let i = 0; i < 10; i++)
    expect(pages.flatMap((page) => values(page, 'v' + i))).toEqual(
      Array.from({ length: 40 }, (_, row) => i * 100 + row),
    );
  expect(
    fake.native.createBindGroup.mock.calls.every(
      ([descriptor]) => [...descriptor.entries].length === 3,
    ),
  ).toBe(true);
  expect(gpu.stats().gpuCopiedBytes).toBeGreaterThan(0);
  const before = gpu.stats();
  await render();
  expect(gpu.stats().uploadedBytes).toBe(before.uploadedBytes);
  expect(gpu.stats().gpuCopiedBytes).toBe(before.gpuCopiedBytes);
  gpu.destroy();
});

it('aligns native block boundaries across sources without materializing matching columns', async () => {
  const a = new FieldSource(1000),
    b = new FieldSource(1000);
  a.blockRows = 71;
  b.blockRows = 113;
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const actual: number[] = [];
  await draw(gpu, async (frame) => {
    for await (const page of frame.fields({
      source: a,
      index: a.index,
      rows: { kind: 'range', offset: 0, count: 1000 },
      fields: { value: 'value', other: { source: b, from: 'node', field: 'value' } },
      float64: 'relative',
    })) {
      expect(page.rowOffset).toBe(actual.length);
      actual.push(...values(page));
      expect(values(page, 'other')).toEqual(values(page));
    }
  });
  expect(actual).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  expect(gpu.stats().stagedBytes).toBe(0);
  expect(a.requests).toHaveLength(1);
  expect(b.requests).toHaveLength(1);
  gpu.destroy();
});

it('observes source closure even when every field was served from cache', async () => {
  const source = new FieldSource(),
    fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const prepare = async (frame: import('../src/index.js').Preparation) => {
    for await (const _page of frame.fields(request(source))) {
      /* consume */
    }
  };
  await draw(gpu, prepare);
  const entered = deferred<void>(),
    gate = deferred<void>();
  const task = gpu.render({
    timeMs: 0,
    views: [
      {
        target: target(fake.device),
        renderer: renderer(async (frame) => {
          await prepare(frame);
          entered.resolve();
          await gate.promise;
        }),
      },
    ],
  });
  await entered.promise;
  const result = expect(task).rejects.toMatchObject({ code: 'closed' });
  await source.close();
  await result;
  gate.resolve();
  expect(fake.queue.submit).toHaveBeenCalledTimes(1);
  gpu.destroy();
});
