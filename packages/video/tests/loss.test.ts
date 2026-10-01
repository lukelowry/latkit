import { expect, it } from 'vitest';
import type { Gpu } from '@latkit/gpu';
import { observeLoss } from '../src/loss.js';
it('shares GPU loss observation without retaining completed exports or missing prior loss', async () => {
  let lose!: (info: GPUDeviceLostInfo) => void;
  const gpu = {
    lost: new Promise<GPUDeviceLostInfo>((resolve) => {
      lose = resolve;
    }),
  } as Gpu;
  const finished = new AbortController(),
    active = new AbortController();
  observeLoss(gpu, finished)();
  const release = observeLoss(gpu, active);
  lose({ reason: 'unknown', message: 'device removed' } as GPUDeviceLostInfo);
  await gpu.lost;
  expect(finished.signal.aborted).toBe(false);
  expect(active.signal.reason.message).toContain('device removed');
  release();
  const late = new AbortController();
  observeLoss(gpu, late)();
  expect(late.signal.reason.message).toContain('device removed');
});
