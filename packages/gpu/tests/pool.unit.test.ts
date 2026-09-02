import { describe, expect, it, vi } from 'vitest';

import { poolOver } from '../src/pool.js';

describe('DevicePool', () => {
  it('coalesces acquisition and destroys the device after the final lease', async () => {
    const requested = deferred<GPUDevice>();
    const request = vi.fn(() => requested.promise);
    const pool = poolOver(request);
    const device = fakeDevice();

    const firstPending = pool.acquire();
    const secondPending = pool.acquire();
    expect(request).toHaveBeenCalledOnce();

    requested.resolve(device.value);
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(first.device).toBe(device.value);
    expect(second.device).toBe(device.value);

    first.release();
    first.release();
    expect(device.destroy).not.toHaveBeenCalled();
    second.release();
    expect(device.destroy).toHaveBeenCalledOnce();
  });

  it('isolates replacement devices from leases belonging to a lost generation', async () => {
    const first = fakeDevice();
    const second = fakeDevice();
    const request = vi
      .fn<() => Promise<GPUDevice>>()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value);
    const pool = poolOver(request);

    const oldLease = await pool.acquire();
    first.lost.resolve({ reason: 'unknown', message: 'test loss' } as GPUDeviceLostInfo);
    await flushMicrotasks();

    const newLease = await pool.acquire();
    expect(newLease.device).toBe(second.value);
    expect(request).toHaveBeenCalledTimes(2);

    oldLease.release();
    expect(second.destroy).not.toHaveBeenCalled();
    newLease.release();
    expect(second.destroy).toHaveBeenCalledOnce();
  });

  it('clears a failed request so a later acquisition can retry', async () => {
    const device = fakeDevice();
    const request = vi
      .fn<() => Promise<GPUDevice>>()
      .mockRejectedValueOnce(new Error('adapter failed'))
      .mockResolvedValueOnce(device.value);
    const pool = poolOver(request);

    await expect(pool.acquire()).rejects.toThrow('adapter failed');
    const lease = await pool.acquire();

    expect(request).toHaveBeenCalledTimes(2);
    lease.release();
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakeDevice(): {
  readonly value: GPUDevice;
  readonly lost: Deferred<GPUDeviceLostInfo>;
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  const lost = deferred<GPUDeviceLostInfo>();
  const destroy = vi.fn();
  return {
    value: { lost: lost.promise, destroy } as unknown as GPUDevice,
    lost,
    destroy,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
