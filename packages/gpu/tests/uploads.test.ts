import { describe, expect, it } from 'vitest';
import type { RowsBlock, SamplesBlock } from '@latkit/model';
import { BufferData, createGpu, type GpuPage } from '../src/index.js';
import { bytes, fakeDevice, record } from './fixtures/device.js';
import { field } from './fixtures/fields.js';
import { draw, renderer, target } from './fixtures/render.js';

function block(values: Float32Array | Float64Array | Int32Array | Uint32Array): RowsBlock {
  return {
    kind: 'rows',
    version: 'v0',
    index: { source: 'd', type: 'node', version: 'i0' },
    rows: { kind: 'range', offset: 0, count: values.length },
    position: 0,
    columns: { value: { kind: 'numeric', values, offset: 0, length: values.length } },
  };
}
const f32 = (binding: GPUBufferBinding) => {
  const data = bytes(binding);
  return Array.from(new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4));
};

describe('native numeric uploads', () => {
  it('uploads a borrowed Float32 view without an intermediate numeric copy', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const source = new Float32Array([90, 10, 20, 91]);
    const value = block(source.subarray(1, 3));
    let page!: GpuPage;
    await draw(gpu, (frame) => {
      page = frame.upload(value, { select: ['value'] })[0];
    });
    expect(f32(field(page).binding)).toEqual([10, 20]);
    expect(fake.queue.writeBuffer.mock.calls[0][2]).toBe(source.buffer);
    expect(fake.queue.writeBuffer.mock.calls[0][3]).toBe(4);
    expect(gpu.stats().peakStagingBytes).toBe(0);
    gpu.destroy();
  });

  it('shares uploaded pages between views and unchanged frames', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const value = block(Float32Array.of(1, 2));
    const pages: GpuPage[] = [];
    const a = renderer((frame) => {
      pages.push(frame.upload(value, { select: ['value'] })[0]);
    });
    const b = renderer((frame) => {
      pages.push(frame.upload(value, { select: ['value'] })[0]);
    });
    const request = {
      timeMs: 0,
      views: [
        { renderer: a, target: target(fake.device) },
        { renderer: b, target: target(fake.device) },
      ],
    };
    await gpu.render(request);
    await gpu.idle();
    await gpu.render(request);
    await gpu.idle();
    expect(new Set(pages).size).toBe(1);
    expect(gpu.stats().uploads).toBe(2);
    expect(gpu.stats().uploadHits).toBe(3);
    gpu.destroy();
  });

  it('preserves unsigned integer values without Float32 narrowing', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    let page!: GpuPage;
    await draw(gpu, (frame) => {
      page = frame.upload(block(Uint32Array.of(0xffffffff, 16777217)), { select: ['value'] })[0];
    });
    const data = bytes(field(page).binding);
    expect((page.columns.value as import('../src/index.js').GpuValueField).type).toBe('uint32');
    expect([...new Uint32Array(data.buffer, data.byteOffset, 2)]).toEqual([0xffffffff, 16777217]);
    gpu.destroy();
  });

  it('preserves sparse physical rows, sample strides, offsets, and nulls', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const value: SamplesBlock = {
      kind: 'samples',
      version: 'v',
      index: { source: 'd', type: 'node', version: 'i' },
      rows: { kind: 'indices', values: Uint32Array.of(1000000000, 7) },
      rowOffset: 40,
      firstFrame: 900,
      coordinates: Float64Array.of(1e12, 1e12 + 0.25),
      columns: {
        value: {
          kind: 'numeric',
          values: Float32Array.of(999, 10, 20, 99, 99, 30, 40),
          offset: 1,
          length: 6,
          frameStride: 4,
          rowStride: 1,
          validity: Uint8Array.of(0b00100110),
        },
      },
    };
    let page!: GpuPage;
    await draw(gpu, (frame) => {
      page = frame.upload(value, { select: ['value'] })[0];
    });
    expect(page.rows).toEqual(value.rows);
    expect(field(page).rowStride).toBe(1);
    expect(field(page).frameStride).toBe(4);
    expect(f32(field(page).binding)).toEqual([10, 20, 99, 99, 30, 40]);
    expect(bytes(field(page).validity!.binding)[0]).toBe(0b0111);
    expect(page.samples?.firstFrame).toBe(900);
    expect(page.samples?.coordinates.origin?.[0]).toBe(1e12);
    expect(f32(field(page, page.samples!.coordinates).binding)).toEqual([0, 0.25]);
    expect(gpu.stats().uploadedBytes).toBeLessThan(300);
    gpu.destroy();
  });

  it('tiles above device binding limits instead of rejecting the complete dataset', async () => {
    const fake = fakeDevice({
      limits: {
        maxStorageBufferBindingSize: 256,
        maxBufferSize: 256,
        minStorageBufferOffsetAlignment: 16,
      },
    });
    const gpu = await createGpu({ device: fake.device });
    const values = Float32Array.from({ length: 81 }, (_, i) => i + 1);
    let pages: readonly GpuPage[] = [];
    await draw(gpu, (frame) => {
      pages = frame.upload(block(values), { select: ['value'] });
    });
    expect(pages).toHaveLength(3);
    expect(pages.flatMap((page) => f32(field(page).binding))).toEqual([...values]);
    expect(pages.map((page) => page.rows)).toEqual([
      { kind: 'range', offset: 0, count: 32 },
      { kind: 'range', offset: 32, count: 32 },
      { kind: 'range', offset: 64, count: 17 },
    ]);
    expect(fake.buffers.every((buffer) => buffer.size <= 256)).toBe(true);
    gpu.destroy();
  });

  it('requires a Float64 policy and rebases before narrowing', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const value = block(Float64Array.of(1e12, 1e12 + 0.25, 1e12 + 0.5));
    await expect(
      draw(gpu, (frame) => {
        frame.upload(value, { select: ['value'] });
      }),
    ).rejects.toMatchObject({ code: 'precision' });
    let page!: GpuPage;
    await draw(gpu, (frame) => {
      page = frame.upload(value, { select: ['value'], float64: 'relative' })[0];
    });
    expect((page.columns.value as import('../src/index.js').GpuValueField).origin?.[0]).toBe(1e12);
    expect(f32(field(page).binding)).toEqual([0, 0.25, 0.5]);
    gpu.destroy();
  });

  it('handles sliced vector parents and child offsets', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const value: RowsBlock = {
      ...block(Float32Array.of(0, 0)),
      columns: {
        value: {
          kind: 'vector',
          offset: 1,
          length: 2,
          size: 2,
          validity: Uint8Array.of(0b10),
          values: {
            kind: 'numeric',
            offset: 1,
            length: 6,
            values: Float64Array.of(999, 1, 2, 1e12, 1e12 + 1, 1e12 + 2, 1e12 + 3),
          },
        },
      },
    };
    let page!: GpuPage;
    await draw(gpu, (frame) => {
      page = frame.upload(value, { select: ['value'], float64: 'relative' })[0];
    });
    expect([...(page.columns.value as import('../src/index.js').GpuValueField).origin!]).toEqual([
      1e12,
      1e12 + 1,
    ]);
    expect(f32(field(page).binding)).toEqual([0, 0, 0, 0]);
    expect(bytes(field(page).validity!.binding)[0]).toBe(1);
    gpu.destroy();
  });

  it('rejects unrepresentable finite values and rolls back allocations', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    await expect(
      draw(gpu, (frame) => {
        frame.upload(block(Float64Array.of(1e300)), { select: ['value'], float64: 'float32' });
      }),
    ).rejects.toMatchObject({ code: 'precision' });
    expect(gpu.stats().gpuBytes).toBe(0);
    gpu.destroy();
  });

  it('bounds GPU and CPU residency without silently dropping pages', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device, budget: { gpuBytes: 1024 }, pageBytes: 512 });
    await expect(
      draw(gpu, (frame) => {
        frame.upload(block(new Float32Array(1024)), { select: ['value'] });
      }),
    ).rejects.toMatchObject({ code: 'resource-limit' });
    expect(gpu.stats().peakGpuBytes).toBeLessThanOrEqual(1024);
    expect(gpu.stats().gpuBytes).toBe(0);
    gpu.destroy();
  });
});

describe('mutable and frame-local buffers', () => {
  it('uploads only touched aligned bytes and keeps independent consumer revisions', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const data = new BufferData({ size: 8192 });
    await draw(gpu, (frame) => {
      frame.buffer(data);
    });
    const before = gpu.stats().uploadedBytes;
    data.write({ offset: 4000, data: Uint8Array.of(1, 2, 3) });
    await draw(gpu, (frame) => {
      frame.buffer(data);
    });
    expect(gpu.stats().uploadedBytes - before).toBe(4);
    const second = await createGpu({ device: fake.device });
    await draw(second, (frame) => {
      frame.buffer(data);
    });
    expect(second.stats().uploadedBytes).toBe(8192);
    second.destroy();
    gpu.destroy();
  });

  it('uses copy-on-write while earlier submissions hold a mutable buffer', async () => {
    const fake = fakeDevice({ deferCompletion: true }),
      gpu = await createGpu({ device: fake.device });
    const data = new BufferData({ size: 4 });
    data.write({ data: Float32Array.of(1) });
    let first!: GPUBufferBinding, second!: GPUBufferBinding;
    await gpu.render({
      timeMs: 0,
      views: [
        {
          target: target(fake.device),
          renderer: renderer((frame) => {
            first = frame.buffer(data);
          }),
        },
      ],
    });
    data.write({ data: Float32Array.of(2) });
    await gpu.render({
      timeMs: 1,
      views: [
        {
          target: target(fake.device),
          renderer: renderer((frame) => {
            second = frame.buffer(data);
          }),
        },
      ],
    });
    expect(f32(first)).toEqual([1]);
    expect(f32(second)).toEqual([2]);
    expect(first.buffer !== second.buffer || first.offset !== second.offset).toBe(true);
    fake.finish();
    await gpu.idle();
    gpu.destroy();
  });

  it('does not overwrite earlier draws when several views upload uniforms', async () => {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device });
    const observed: number[] = [];
    const make = (value: number) => {
      let uniform!: GPUBufferBinding;
      return renderer(
        (frame) => {
          uniform = frame.uniforms(Float32Array.of(value));
        },
        (frame) => {
          record(frame.encoder, () => observed.push(f32(uniform)[0]));
        },
      );
    };
    await gpu.render({
      timeMs: 0,
      views: [1, 2, 3].map((value) => ({ renderer: make(value), target: target(fake.device) })),
    });
    await gpu.idle();
    expect(observed).toEqual([1, 2, 3]);
    expect(fake.queue.submit).toHaveBeenCalledTimes(1);
    expect(gpu.stats().gpuBytes).toBe(0);
    gpu.destroy();
  });
});
