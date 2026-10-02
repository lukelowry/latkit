import { expect, it, vi } from 'vitest';
import { createGpu } from '../src/index.js';
import { type Invalidation } from '../src/kit.js';
import { deferred, fakeDevice } from './fixtures/device.js';
import { renderer, target } from './fixtures/render.js';

it('refresh completes an acquired frame, while replacement cancels before submission', async () => {
  for (const change of ['refresh', 'replace'] as const) {
    const fake = fakeDevice(),
      gpu = await createGpu({ device: fake.device }),
      entered = deferred<void>(),
      gate = deferred<void>();
    let notify!: (change: Invalidation) => void;
    const submitted = vi.fn(),
      view = {
        ...renderer(async () => {
          entered.resolve();
          await gate.promise;
        }),
        on: (_event: 'invalidate', listener: (change: Invalidation) => void) => {
          notify = listener;
          return vi.fn();
        },
        submitted,
      };
    const pending = gpu.render({
      timeMs: 0,
      views: [{ renderer: view, target: target(fake.device) }],
    });
    await entered.promise;
    const result =
      change === 'replace'
        ? expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        : pending;
    notify(change);
    gate.resolve();
    await result;
    expect(fake.queue.submit).toHaveBeenCalledTimes(change === 'refresh' ? 1 : 0);
    expect(submitted).toHaveBeenCalledTimes(change === 'refresh' ? 1 : 0);
    gpu.destroy();
  }
});

it('notifies all views only after whole-frame submission and releases pins after notification failure', async () => {
  const fake = fakeDevice({ deferCompletion: true }),
    gpu = await createGpu({ device: fake.device });
  const a = vi.fn(() => {
      expect(fake.queue.submit).toHaveBeenCalledTimes(1);
      throw new Error('application hook');
    }),
    b = vi.fn();
  const make = (submitted: () => void) => ({
    ...renderer((frame) => {
      frame.uniforms(Float32Array.of(1));
    }),
    submitted,
  });
  await expect(
    gpu.render({
      timeMs: 0,
      views: [
        { target: target(fake.device), renderer: make(a) },
        { target: target(fake.device), renderer: make(b) },
      ],
    }),
  ).rejects.toThrow('Frame submitted');
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
  expect(gpu.stats().gpuBytes).toBeGreaterThan(0);
  fake.finish();
  await gpu.idle();
  expect(gpu.stats().gpuBytes).toBe(0);
  gpu.destroy();
});

it('does not commit interaction state when a later view fails encoding', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device }),
    submitted = vi.fn();
  await expect(
    gpu.render({
      timeMs: 0,
      views: [
        { renderer: { ...renderer(() => {}), submitted }, target: target(fake.device) },
        {
          renderer: renderer(
            () => {},
            () => {
              throw new Error('encoding');
            },
          ),
          target: target(fake.device),
        },
      ],
    }),
  ).rejects.toThrow('encoding');
  expect(submitted).not.toHaveBeenCalled();
  expect(fake.queue.submit).not.toHaveBeenCalled();
  gpu.destroy();
});
