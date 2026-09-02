/**
 * One device shared by many renderers: leases count the borrowers, the device is destroyed when
 * the last lease releases, and a device the platform reports lost is never handed out again.
 */

import { requestDevice, type Options } from './device.js';

/** One reference-counted borrow of the shared device. */
export interface DeviceLease {
  readonly device: GPUDevice;
  /** Return the borrow; idempotent. The device is destroyed with the last release. */
  release(): void;
}

/**
 * Shared-device ownership with generation-safe leases.
 *
 * @remarks
 * Concurrent acquisitions coalesce into one request. A device reported lost is retired, so a
 * later acquisition requests a replacement while leases on the lost generation release
 * harmlessly. The pool holds no device of its own: nothing outlives the last lease.
 */
export interface DevicePool {
  /** Acquire the current device, coalescing concurrent device requests. */
  acquire(): Promise<DeviceLease>;
}

interface DeviceEntry {
  readonly device: GPUDevice;
  refs: number;
  closed: boolean;
}

/** Create a pool whose devices come from `requestDevice(options)`. */
export function createDevicePool(options?: Options): DevicePool {
  return poolOver(() => requestDevice(options));
}

/** Create a pool over an arbitrary device request; `createDevicePool` without the adapter step. */
export function poolOver(request: () => Promise<GPUDevice>): DevicePool {
  let current: DeviceEntry | null = null;
  let pending: Promise<DeviceEntry> | null = null;

  const invalidate = (entry: DeviceEntry): void => {
    entry.closed = true;
    if (current === entry) current = null;
  };

  const release = (entry: DeviceEntry): void => {
    if (entry.refs > 0) entry.refs--;
    if (entry.refs !== 0 || entry.closed || current !== entry) return;

    entry.closed = true;
    current = null;
    entry.device.destroy();
  };

  const createEntry = async (): Promise<DeviceEntry> => {
    const device = await request();
    const entry: DeviceEntry = { device, refs: 0, closed: false };
    current = entry;
    void device.lost.then(() => invalidate(entry));
    return entry;
  };

  const requestEntry = (): Promise<DeviceEntry> => {
    if (pending) return pending;

    const next = createEntry();
    pending = next;
    const clear = (): void => {
      if (pending === next) pending = null;
    };
    void next.then(clear, clear);
    return next;
  };

  return {
    async acquire() {
      for (;;) {
        const entry = current ?? (await requestEntry());
        if (entry.closed || current !== entry) continue;

        entry.refs++;
        let released = false;
        return {
          device: entry.device,
          release: () => {
            if (released) return;
            released = true;
            release(entry);
          },
        };
      }
    },
  };
}
