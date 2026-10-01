import * as model from '@latkit/model';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import { fakeDevice } from './fixtures/device.js';
import { draw, renderer, target } from './fixtures/render.js';
import { Source } from './fixtures/source.js';

describe('public contract and allocation boundaries', () => {
  it('exports one clean root with no legacy channel, device-pool, or playback facades', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'validateRgba',
        'createColormap',
        'reverseColormap',
        'sampleColormap',
        'parseColor',
        'resolveColor',
        'colorCss',
        'colormapCss',
        'colormaps',
        'colormapShader',
        'BufferData',
        'TextureData',
        'GpuError',
        'fieldShader',
        'clipStroke',
        'strokeShader',
        'textShader',
        'createTextRasterizer',
        'createCanvasView',
        'createComposition',
        'createGpu',
        'createNativeReader',
        'createPresentation',
        'createRenderTarget',
        'fitCamera',
        'cameraPoint',
        'worldPoint',
        'zoomCamera',
        'resolveScale',
        'scaleValue',
        'scaleParameters',
        'scaleShader',
        'shadeShader',
        'defaultShade',
        'spotlight',
        'premultipliedBlend',
        'outputShader',
        'inputModifiers',
        'localPoint',
        'wheelDelta',
        'createCanvasInput',
        'withinBudget',
      ].sort(),
    );
  });

  it('uses source, type, and index version to validate physical identity', () => {
    const index = { source: 'a', type: 'node', version: 'v' };
    expect(model.sameIndex(index, { ...index })).toBe(true);
    for (const mismatch of [
      { ...index, source: 'b' },
      { ...index, type: 'edge' },
      { ...index, version: 'v2' },
    ])
      expect(() => model.assertIndex(index, mismatch)).toThrow();
    expect(model.rowAt({ kind: 'indices', values: Uint32Array.of(100, 7) }, 1)).toBe(7);
    expect(() => model.rowCount({ kind: 'range', offset: 0xffffffff, count: 2 })).toThrow();
  });

  it('keeps working buffers and textures in the same managed budget', async () => {
    const fake = fakeDevice(),
      gpu = await api.createGpu({ device: fake.device, budget: { gpuBytes: 1024 } });
    const data = gpu.buffer({ size: 512, usage: GPUBufferUsage.STORAGE });
    const texture = gpu.texture({
      size: [8, 8],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    expect(gpu.stats().gpuBytes).toBe(768);
    expect(() => gpu.buffer({ size: 512, usage: GPUBufferUsage.STORAGE })).toThrow(api.GpuError);
    data.destroy();
    texture.destroy();
    expect(gpu.stats().gpuBytes).toBe(0);
    gpu.destroy();
  });

  it('rejects resources from another owner even on the same native device', async () => {
    const fake = fakeDevice(),
      a = await api.createGpu({ device: fake.device }),
      b = await api.createGpu({ device: fake.device });
    const data = a.buffer({ size: 16, usage: GPUBufferUsage.STORAGE });
    await expect(
      draw(b, (frame) => {
        frame.buffer(data);
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    a.destroy();
    b.destroy();
  });

  it('rejects targets from a different device before preparation starts', async () => {
    const a = fakeDevice(),
      b = fakeDevice(),
      gpu = await api.createGpu({ device: a.device });
    let prepared = false;
    await expect(
      gpu.render({
        timeMs: 0,
        views: [
          {
            renderer: renderer(() => {
              prepared = true;
            }),
            target: target(b.device),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(prepared).toBe(false);
    gpu.destroy();
  });

  it('deduplicates whole borrowed backing allocations across cached chunks', async () => {
    const fake = fakeDevice(),
      gpu = await api.createGpu({ device: fake.device });
    const source = new Source(1_000_000, { blockRows: 10000 });
    await draw(gpu, async (frame) => {
      for await (const block of frame.query(source, {
        kind: 'rows',
        from: 'node',
        select: ['value'],
      }))
        void block;
    });
    expect(gpu.stats().cpuBytes).toBeGreaterThanOrEqual(source.values.byteLength);
    expect(gpu.stats().cpuBytes).toBeLessThan(source.values.byteLength + 100_000);
    expect(gpu.stats().stagedBytes).toBe(0);
    gpu.trim();
    expect(gpu.stats().cpuBytes).toBe(0);
    gpu.destroy();
  });

  it('trims all unreferenced caches and leaves owned resources alive', async () => {
    const fake = fakeDevice(),
      gpu = await api.createGpu({ device: fake.device });
    const owned = gpu.buffer({ size: 16, usage: GPUBufferUsage.STORAGE });
    await draw(gpu, (frame) => {
      frame.buffer(new api.BufferData({ size: 256 }));
    });
    gpu.trim();
    expect(gpu.stats().gpuBytes).toBe(16);
    owned.destroy();
    gpu.destroy();
    expect(gpu.stats()).toMatchObject({ cpuBytes: 0, gpuBytes: 0, stagingBytes: 0, entries: 0 });
  });

  it('journals disjoint byte changes and resets newly grown bytes', () => {
    fakeDevice();
    const data = new api.BufferData({ size: 4096 });
    const version = data.version;
    data.write({ data: Uint8Array.of(9), offset: 0 });
    data.write({ data: Uint8Array.of(8), offset: 4000 });
    expect(data.changesSince(version)).toEqual([
      { offset: 0, size: 1 },
      { offset: 4000, size: 1 },
    ]);
    data.resize(1);
    data.resize(4096);
    expect(data.bytes[4000]).toBe(0);
    expect(() => data.write({ data: new Uint8Array(8), offset: 4095 })).toThrow();
  });
});

it('normalizes single-use texture extents before accounting and native allocation', async () => {
  const fake = fakeDevice(),
    gpu = await api.createGpu({ device: fake.device });
  function* size() {
    yield 8;
    yield 4;
  }
  const texture = gpu.texture({
    size: size(),
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  expect(texture.texture.width).toBe(8);
  expect(texture.texture.height).toBe(4);
  expect(gpu.stats().gpuBytes).toBe(128);
  texture.destroy();
  const volume = gpu.texture({
    size: { width: 8, height: 4, depthOrArrayLayers: 2 },
    dimension: '3d',
    mipLevelCount: 4,
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  expect(gpu.stats().gpuBytes).toBe(75);
  volume.destroy();
  gpu.destroy();
});

it('rejects invalid texture extents and sample counts before allocating', async () => {
  const fake = fakeDevice(),
    gpu = await api.createGpu({ device: fake.device });
  const base: GPUTextureDescriptor = {
    size: [8, 8],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  };
  for (const changes of [
    { sampleCount: 2 },
    { size: [8193, 1] },
    { mipLevelCount: 5 },
    { dimension: '1d' as const },
    { sampleCount: 4, mipLevelCount: 2 },
    { size: [8, 8, 2], sampleCount: 4 },
  ])
    expect(() => gpu.texture({ ...base, ...changes })).toThrow(api.GpuError);
  expect(fake.native.createTexture).not.toHaveBeenCalled();
  expect(gpu.stats().gpuBytes).toBe(0);
  gpu.destroy();
});
