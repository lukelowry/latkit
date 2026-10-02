import { expect, it } from 'vitest';
import { createGpu } from '../src/index.js';
import { TextureData } from '../src/kit.js';
import { fakeDevice } from './fixtures/device.js';
import { draw, renderer, target } from './fixtures/render.js';

it('shares texture uploads and updates only changed rows per consumer', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const pixels = new TextureData({ width: 32, height: 32, format: 'r8unorm' });
  let first!: GPUTexture, second!: GPUTexture;
  await draw(gpu, (frame) => {
    first = frame.texture(pixels);
    second = frame.texture(pixels);
  });
  expect(first).toBe(second);
  expect(gpu.stats().uploadedBytes).toBe(1024);
  pixels.write({ x: 3, y: 8, width: 2, height: 1, data: Uint8Array.of(1, 2) });
  await draw(gpu, (frame) => {
    second = frame.texture(pixels);
  });
  expect(second).toBe(first);
  expect(gpu.stats().uploadedBytes).toBe(1056);
  const other = await createGpu({ device: fake.device });
  await draw(other, (frame) => {
    frame.texture(pixels);
  });
  expect(other.stats().uploadedBytes).toBe(1024);
  other.destroy();
  gpu.destroy();
});

it('uses a new texture while an earlier frame retains old pixels', async () => {
  const fake = fakeDevice({ deferCompletion: true }),
    gpu = await createGpu({ device: fake.device });
  const pixels = new TextureData({ width: 4, height: 4 });
  let first!: GPUTexture, second!: GPUTexture;
  await gpu.render({
    timeMs: 0,
    views: [
      {
        renderer: renderer((frame) => {
          first = frame.texture(pixels);
        }),
        target: target(fake.device),
      },
    ],
  });
  pixels.touch();
  await gpu.render({
    timeMs: 0,
    views: [
      {
        renderer: renderer((frame) => {
          second = frame.texture(pixels);
        }),
        target: target(fake.device),
      },
    ],
  });
  expect(second).not.toBe(first);
  expect(gpu.stats().uploadedBytes).toBe(128);
  fake.finish();
  await gpu.idle();
  gpu.destroy();
});

it('preserves overlapping pixels when the atlas grows and resets the upload extent', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const pixels = new TextureData({ width: 2, height: 2, format: 'r8unorm' });
  pixels.write({ x: 0, y: 0, width: 2, height: 2, data: Uint8Array.of(1, 2, 3, 4) });
  await draw(gpu, (frame) => {
    frame.texture(pixels);
  });
  pixels.resize({ width: 3, height: 3 });
  expect([...pixels.bytes]).toEqual([1, 2, 0, 3, 4, 0, 0, 0, 0]);
  await draw(gpu, (frame) => {
    frame.texture(pixels);
  });
  expect(gpu.stats().uploadedBytes).toBe(13);
  gpu.destroy();
});
