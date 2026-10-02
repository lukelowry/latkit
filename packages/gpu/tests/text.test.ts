import { expect, it, vi } from 'vitest';
import { createGpu } from '../src/index.js';
import { type TextPage, type TextRasterizer, type TextRun } from '../src/kit.js';
import { distanceField } from '../src/distance-field.js';
import { bytes, deferred, fakeDevice } from './fixtures/device.js';
import { draw, renderer, target } from './fixtures/render.js';

function rasterizer(): TextRasterizer & {
  rasterize: ReturnType<typeof vi.fn<TextRasterizer['rasterize']>>;
} {
  return {
    rasterize: vi.fn<TextRasterizer['rasterize']>(async (input) => ({
      width: 8,
      height: 8,
      coverage: new Uint8Array(64).fill(255),
      advance: input.text.length / 2,
      left: -0.1,
      top: -0.75,
      ascent: 0.75,
      descent: 0.2,
    })),
  };
}
const run = (text = 'office العربية'): TextRun => ({
  text,
  size: 16,
  position: [20, 40],
  anchor: 42,
  color: [0.25, 0.5, 1, 0.8],
});

it('shares shaping, atlas regions, and text geometry across views and unchanged frames', async () => {
  const fake = fakeDevice(),
    raster = rasterizer(),
    gpu = await createGpu({ device: fake.device, text: { rasterizer: raster, atlasSize: 64 } });
  const runs = [run()];
  let pages: readonly TextPage[] = [];
  const a = renderer(async (frame) => {
    pages = await frame.text({ runs });
  });
  const b = renderer(async (frame) => {
    await frame.text({ runs });
  });
  await gpu.render({
    timeMs: 0,
    views: [
      { renderer: a, target: target(fake.device) },
      { renderer: b, target: target(fake.device) },
    ],
  });
  await gpu.idle();
  expect(raster.rasterize).toHaveBeenCalledTimes(1);
  expect(raster.rasterize.mock.calls[0][0].text).toBe(runs[0].text);
  expect(fake.queue.writeTexture).toHaveBeenCalledTimes(1);
  expect(gpu.stats().uploads).toBe(2);
  const metrics = await gpu.measureText(runs[0]);
  expect(metrics.advance).toBe(runs[0].text.length / 2);
  const before = gpu.stats();
  await draw(gpu, async (frame) => {
    pages = await frame.text({ runs });
  });
  expect(gpu.stats().uploadedBytes).toBe(before.uploadedBytes);
  const descriptor = (pages[0].bindGroup as unknown as { descriptor: GPUBindGroupDescriptor })
    .descriptor;
  const binding = [...descriptor.entries][0].resource as GPUBufferBinding,
    data = bytes(binding);
  expect(new Uint32Array(data.buffer, data.byteOffset)[12]).toBe(42);
  expect(new Float32Array(data.buffer, data.byteOffset)[8]).toBe(0.25);
  gpu.destroy();
  expect(gpu.stats().gpuBytes).toBe(0);
  expect(gpu.stats().entries).toBe(0);
});

it('appends nonoverlapping atlas regions while prior frames remain in flight', async () => {
  const fake = fakeDevice({ deferCompletion: true }),
    gpu = await createGpu({
      device: fake.device,
      text: { rasterizer: rasterizer(), atlasSize: 64 },
    });
  for (const text of ['first', 'second'])
    await gpu.render({
      timeMs: 0,
      views: [
        {
          target: target(fake.device),
          renderer: renderer(async (frame) => {
            await frame.text({ runs: [run(text)] });
          }),
        },
      ],
    });
  const writes = fake.queue.writeTexture.mock.calls;
  expect(writes).toHaveLength(2);
  expect(writes[0][0].texture).toBe(writes[1][0].texture);
  expect(writes[0][0].origin).not.toEqual(writes[1][0].origin);
  fake.finish();
  await gpu.idle();
  gpu.destroy();
});

it('font revision invalidates shaping and an aborted reader does not cancel another reader', async () => {
  const fake = fakeDevice(),
    gate = deferred<void>(),
    raster = rasterizer();
  raster.rasterize.mockImplementationOnce(async () => {
    await gate.promise;
    return {
      width: 1,
      height: 1,
      coverage: Uint8Array.of(255),
      left: 0,
      top: 0,
      advance: 1,
      ascent: 1,
      descent: 0,
    };
  });
  const gpu = await createGpu({ device: fake.device, text: { rasterizer: raster, atlasSize: 64 } }),
    controller = new AbortController();
  const first = gpu.measureText(run(), { signal: controller.signal }),
    second = gpu.measureText(run());
  const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejection;
  gate.resolve();
  await second;
  expect(raster.rasterize).toHaveBeenCalledTimes(1);
  await gpu.measureText({ ...run(), font: { family: 'sans-serif', revision: '2' } });
  expect(raster.rasterize).toHaveBeenCalledTimes(2);
  gpu.destroy();
});

it('evicts bounded text caches and rebuilds cleanly after trim', async () => {
  const fake = fakeDevice(),
    raster = rasterizer(),
    gpu = await createGpu({
      device: fake.device,
      text: { rasterizer: raster, atlasSize: 64 },
      budget: { gpuBytes: 16384 },
    });
  const runs = [run()];
  await draw(gpu, async (frame) => {
    await frame.text({ runs });
  });
  gpu.trim();
  expect(gpu.stats().gpuBytes).toBe(0);
  await draw(gpu, async (frame) => {
    await frame.text({ runs });
  });
  expect(raster.rasterize).toHaveBeenCalledTimes(2);
  gpu.destroy();
});

it('distance fields preserve inside/outside, antialiasing, and transparent padding', () => {
  const field = distanceField(Uint8Array.of(255, 128, 0), 3, 1, 2);
  expect(field[2 * 7 + 2]).toBeGreaterThan(128);
  expect(field[2 * 7 + 3]).toBeCloseTo(128, 0);
  expect(field[2 * 7 + 4]).toBeLessThan(128);
  expect(field[0]).toBe(0);
});

it('rejects a renderer that leaves asynchronous text preparation unawaited', async () => {
  const fake = fakeDevice(),
    gate = deferred<void>(),
    raster = rasterizer();
  raster.rasterize.mockImplementationOnce(async () => {
    await gate.promise;
    return {
      width: 1,
      height: 1,
      coverage: Uint8Array.of(255),
      left: 0,
      top: 0,
      advance: 1,
      ascent: 1,
      descent: 0,
    };
  });
  const gpu = await createGpu({ device: fake.device, text: { rasterizer: raster, atlasSize: 64 } });
  await expect(
    draw(gpu, (frame) => {
      void frame.text({ runs: [run()] }).catch(() => {});
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  expect(fake.queue.submit).not.toHaveBeenCalled();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gpu.destroy();
});
