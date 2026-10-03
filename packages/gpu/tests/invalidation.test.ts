import { expect, it, vi } from 'vitest';
import { createGpu } from '../src/index.js';
import { fakeDevice } from './fixtures/device.js';
import { renderer, target } from './fixtures/render.js';

it('captures every view before preparation and discards unsubmitted candidates', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({ device: fake.device });
  const captured: number[] = [],
    discarded = vi.fn();
  const make = (id: number) => ({
    capture() {
      captured.push(id);
      return {
        prepare: async () => {
          expect(captured).toEqual([1, 2]);
          return {
            encode() {
              if (id === 2) throw new Error('failed encoding');
            },
            submitted: vi.fn(),
            discard: discarded,
          };
        },
        release() {},
      };
    },
    destroy() {},
  });
  await expect(
    gpu.render({
      timeMs: 0,
      views: [1, 2].map((id) => ({ renderer: make(id), target: target(fake.device) })),
    }),
  ).rejects.toThrow('failed encoding');
  expect(discarded).toHaveBeenCalledTimes(2);
  expect(fake.queue.submit).not.toHaveBeenCalled();
  gpu.destroy();
});

it('notifies all views only after whole-frame submission and releases pins after notification failure', async () => {
  const fake = fakeDevice({ deferCompletion: true }),
    gpu = await createGpu({ device: fake.device });
  const a = vi.fn(() => {
      expect(fake.queue.submit).toHaveBeenCalledTimes(1);
      throw new Error('application hook');
    }),
    b = vi.fn();
  const make = (submitted: () => void) =>
    renderer(
      (frame) => {
        frame.uniforms(Float32Array.of(1));
      },
      undefined,
      submitted,
    );
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
  // The frame's uniform buffer returns to the pool, which trim empties.
  gpu.trim();
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
        { renderer: renderer(() => {}, undefined, submitted), target: target(fake.device) },
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
