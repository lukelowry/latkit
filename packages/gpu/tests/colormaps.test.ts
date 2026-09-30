import { expect, it } from 'vitest';
import { colormaps, createGpu, reverseColormap, type Preparation } from '../src/index.js';
import { fakeDevice } from './fixtures/device.js';
import { draw, renderer, target } from './fixtures/render.js';

it('shares palette textures and bindings across views and frames without uploading again', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const groups: GPUBindGroup[] = [];
  const prepare = (frame: Preparation) => {
    groups.push(frame.colormap(colormaps.viridis));
  };
  const renderTarget = target(fake.device);
  await gpu.render({
    timeMs: 0,
    views: [
      { renderer: renderer(prepare), target: renderTarget },
      { renderer: renderer(prepare), target: renderTarget },
    ],
  });
  await gpu.idle();
  const uploaded = gpu.stats().uploadedBytes;
  expect(fake.queue.writeTexture).toHaveBeenCalledTimes(1);
  await draw(gpu, prepare);
  expect(new Set(groups).size).toBe(1);
  expect(gpu.stats().uploadedBytes).toBe(uploaded);
  expect(
    fake.native.createBindGroup.mock.calls.filter(([d]) => d.label === 'colormap'),
  ).toHaveLength(1);
  await draw(gpu, (frame) => {
    frame.colormap(reverseColormap(colormaps.viridis));
  });
  expect(fake.queue.writeTexture).toHaveBeenCalledTimes(2);
  gpu.trim();
  await draw(gpu, prepare);
  expect(groups[groups.length - 1]).not.toBe(groups[0]);
  expect(fake.queue.writeTexture).toHaveBeenCalledTimes(3);
  gpu.destroy();
});

it('pins palettes until submission completes and scopes resources to the GPU owner', async () => {
  const fake = fakeDevice({ deferCompletion: true }),
    gpu = await createGpu({ device: fake.device });
  let stale!: Preparation;
  await gpu.render({
    timeMs: 0,
    views: [
      {
        target: target(fake.device),
        renderer: renderer((frame) => {
          stale = frame;
          frame.colormap(colormaps.phase);
        }),
      },
    ],
  });
  const texture = fake.textures.find((t) => t.width === colormaps.phase.colors.length + 1)!;
  expect(texture).toBeDefined();
  gpu.trim();
  expect(texture.destroyed).toBe(false);
  expect(() => stale.colormap()).toThrow();
  fake.finish();
  await gpu.idle();
  gpu.trim();
  expect(texture.destroyed).toBe(true);
  const other = await createGpu({ device: fake.device });
  const rendering = other.render({
    timeMs: 0,
    views: [
      {
        target: target(fake.device),
        renderer: renderer((frame) => {
          frame.colormap(colormaps.phase);
        }),
      },
    ],
  });
  await rendering;
  fake.finish();
  await other.idle();
  expect(fake.queue.writeTexture).toHaveBeenCalledTimes(2);
  other.destroy();
  gpu.destroy();
});
