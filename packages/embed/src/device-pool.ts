import { requestDevice } from '@latkit/gpu';

/** One reference-counted borrow of the shared device. */
export interface DeviceLease {
  readonly device: GPUDevice;
  release(): void;
}

interface DeviceEntry {
  readonly device: GPUDevice;
  refs: number;
  closed: boolean;
}

/** Module-local shared-device ownership with generation-safe leases. */
export class DevicePool {
  #current: DeviceEntry | null = null;
  #pending: Promise<DeviceEntry> | null = null;

  constructor(private readonly request: () => Promise<GPUDevice> = requestDevice) {}

  /** Acquire the current device, coalescing concurrent device requests. */
  async acquire(): Promise<DeviceLease> {
    for (;;) {
      const entry = this.#current ?? (await this.#requestEntry());
      if (entry.closed || this.#current !== entry) continue;

      entry.refs++;
      let released = false;
      return {
        device: entry.device,
        release: () => {
          if (released) return;
          released = true;
          this.#release(entry);
        },
      };
    }
  }

  #requestEntry(): Promise<DeviceEntry> {
    if (this.#pending) return this.#pending;

    const pending = this.#createEntry();
    this.#pending = pending;
    void pending.then(
      () => this.#clearPending(pending),
      () => this.#clearPending(pending),
    );
    return pending;
  }

  async #createEntry(): Promise<DeviceEntry> {
    const device = await this.request();
    const entry: DeviceEntry = { device, refs: 0, closed: false };
    this.#current = entry;
    void device.lost.then(() => this.#invalidate(entry));
    return entry;
  }

  #clearPending(pending: Promise<DeviceEntry>): void {
    if (this.#pending === pending) this.#pending = null;
  }

  #invalidate(entry: DeviceEntry): void {
    entry.closed = true;
    if (this.#current === entry) this.#current = null;
  }

  #release(entry: DeviceEntry): void {
    if (entry.refs > 0) entry.refs--;
    if (entry.refs !== 0 || entry.closed || this.#current !== entry) return;

    entry.closed = true;
    this.#current = null;
    entry.device.destroy();
  }
}

/** Shared device pool for every element in this module instance. */
export const devices = new DevicePool();
