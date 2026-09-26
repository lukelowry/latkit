import { describe, expect, it, vi } from 'vitest';

import { createAttachment } from '../src/attachment.js';
import type { DeviceLease, DevicePool } from '../src/pool.js';

interface FakeDevice {
  readonly device: GPUDevice;
  lose(info?: Partial<GPUDeviceLostInfo>): void;
}

function fakeDevice(): FakeDevice {
  let lose!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => (lose = resolve));
  return {
    device: { lost } as unknown as GPUDevice,
    lose: (info = {}) => lose({ reason: 'unknown', message: 'lost for test', ...info } as never),
  };
}

/** A pool handing out fresh fake devices; `hold` gates the next acquisitions, `fail` rejects them. */
function fakePool() {
  const devices: FakeDevice[] = [];
  const releases = vi.fn((_device: GPUDevice) => {});
  let gate: Promise<void> | null = null;
  let failure: Error | null = null;
  const pool: DevicePool = {
    async acquire(): Promise<DeviceLease> {
      if (gate) await gate;
      if (failure) throw failure;
      const entry = fakeDevice();
      devices.push(entry);
      return { device: entry.device, release: () => releases(entry.device) };
    },
  };
  return {
    pool,
    devices,
    releases,
    hold(): () => void {
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
    fail(error: Error | null): void {
      failure = error;
    },
  };
}

function canvas(): HTMLCanvasElement {
  return {} as HTMLCanvasElement;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(bind?: (device: GPUDevice, canvas: HTMLCanvasElement) => void) {
  const devices = fakePool();
  const log: string[] = [];
  const lost: Array<{ reason: string; message: string; recovering: boolean }> = [];
  const released: Array<{ device: GPUDevice; canvas: HTMLCanvasElement }> = [];
  const handlers = {
    release: (_binding: { device: GPUDevice; canvas: HTMLCanvasElement }) => {},
    attached: (_bound: boolean) => {},
    lost: () => {},
  };
  const attachment = createAttachment<{ device: GPUDevice; canvas: HTMLCanvasElement }>({
    devices: devices.pool,
    bind(device, target, cleanup) {
      bind?.(device, target);
      cleanup(() => log.push('cleanup'));
      log.push('bind');
      return { device, canvas: target };
    },
    release(binding) {
      released.push(binding);
      log.push('release');
      handlers.release(binding);
    },
    attached(bound) {
      log.push(`attached ${bound}`);
      handlers.attached(bound);
    },
    lost(loss) {
      lost.push(loss);
      log.push('lost');
      handlers.lost();
    },
  });
  return { attachment, devices, log, lost, released, handlers };
}

describe('createAttachment', () => {
  it('binds a canvas over a leased device and releases it in order on detach', async () => {
    const h = harness();
    const target = canvas();

    await expect(h.attachment.attach(target)).resolves.toBe(true);
    expect(h.attachment.canvas).toBe(target);
    expect(h.attachment.binding).toEqual({ device: h.devices.devices[0]!.device, canvas: target });

    h.attachment.detach();
    expect(h.log).toEqual(['bind', 'attached true', 'release', 'cleanup', 'attached false']);
    expect(h.devices.releases).toHaveBeenCalledExactlyOnceWith(h.devices.devices[0]!.device);
    expect(h.attachment.canvas).toBeNull();
    expect(h.attachment.binding).toBeNull();
  });

  it('joins an attach to the canvas already bound or binding', async () => {
    const h = harness();
    const target = canvas();
    const open = h.devices.hold();

    const first = h.attachment.attach(target);
    expect(h.attachment.attach(target)).toBe(first);
    expect(h.attachment.canvas).toBe(target);
    expect(h.attachment.binding).toBeNull();
    open();
    await expect(first).resolves.toBe(true);
    await expect(h.attachment.attach(target)).resolves.toBe(true);
    expect(h.devices.devices).toHaveLength(1);
    expect(h.log.filter((entry) => entry === 'bind')).toHaveLength(1);
  });

  it('resolves false for an attach a newer attach or a detach overtook, and returns its lease', async () => {
    const h = harness();
    const open = h.devices.hold();
    const overtaken = h.attachment.attach(canvas());
    const next = canvas();
    const current = h.attachment.attach(next);
    open();

    await expect(overtaken).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    expect(h.attachment.canvas).toBe(next);
    expect(h.devices.releases).toHaveBeenCalledOnce();

    const gate = h.devices.hold();
    const detached = h.attachment.attach(canvas());
    h.attachment.detach();
    gate();
    await expect(detached).resolves.toBe(false);
    expect(h.attachment.binding).toBeNull();
    // The live binding's lease, then the lease the detached attach never used.
    expect(h.devices.releases).toHaveBeenCalledTimes(3);
  });

  it('resolves false when a superseded acquisition later fails', async () => {
    const h = harness();
    const open = h.devices.hold();
    const pending = h.attachment.attach(canvas());
    h.attachment.detach();
    h.devices.fail(new Error('old acquisition failed'));
    open();
    await expect(pending).resolves.toBe(false);
    expect(h.attachment.canvas).toBeNull();
    expect(h.log).toEqual([]);

    h.devices.fail(null);
    await expect(h.attachment.attach(canvas())).resolves.toBe(true);
  });

  it('detaches with a canvas only while that canvas is the current one', async () => {
    const h = harness();
    const target = canvas();
    await h.attachment.attach(target);

    h.attachment.detach(canvas());
    expect(h.attachment.binding).not.toBeNull();
    h.attachment.detach(target);
    expect(h.attachment.binding).toBeNull();
  });

  it('keeps nothing when bind throws, and lets the same canvas attach again', async () => {
    let refuse = true;
    const h = harness(() => {
      if (refuse) throw new TypeError('A Core WebGPU device is required');
    });
    const target = canvas();

    await expect(h.attachment.attach(target)).rejects.toThrow('A Core WebGPU device is required');
    expect(h.devices.releases).toHaveBeenCalledOnce();
    expect(h.attachment.canvas).toBeNull();
    expect(h.log).toEqual([]);

    refuse = false;
    await expect(h.attachment.attach(target)).resolves.toBe(true);
  });

  it('runs every cleanup when one throws, the lease last', async () => {
    const devices = fakePool();
    const order: string[] = [];
    const attachment = createAttachment({
      devices: devices.pool,
      bind(_device, _canvas, cleanup) {
        cleanup(() => order.push('first'));
        cleanup(() => {
          throw new Error('cleanup failed');
        });
        cleanup(() => order.push('last'));
        return {};
      },
      release: () => {},
      attached: () => {},
      lost: () => {},
    });
    devices.releases.mockImplementation(() => order.push('lease'));
    await attachment.attach(canvas());
    attachment.detach();
    expect(order).toEqual(['last', 'first', 'lease']);
  });

  it('surfaces a lease failure and forgets the canvas it was for', async () => {
    const h = harness();
    h.devices.fail(new Error('No Core WebGPU adapter is available'));
    const target = canvas();

    await expect(h.attachment.attach(target)).rejects.toThrow('No Core WebGPU adapter');
    expect(h.attachment.canvas).toBeNull();
    h.devices.fail(null);
    await expect(h.attachment.attach(target)).resolves.toBe(true);
  });

  it('stands down when host code the binding ran detached', async () => {
    const h = harness(() => h.attachment.detach());
    await expect(h.attachment.attach(canvas())).resolves.toBe(false);
    expect(h.attachment.binding).toBeNull();
    expect(h.log).toEqual(['bind', 'cleanup']);
    expect(h.devices.releases).toHaveBeenCalledOnce();
  });

  it('lets an attach made from a release handler own the outcome', async () => {
    const h = harness();
    const next = canvas();
    await h.attachment.attach(canvas());
    let moved: Promise<boolean> | null = null;
    h.handlers.attached = (bound) => {
      if (!bound && !moved) moved = h.attachment.attach(next);
    };

    await expect(h.attachment.attach(canvas())).resolves.toBe(false);
    await expect(moved).resolves.toBe(true);
    expect(h.attachment.canvas).toBe(next);
  });

  it('recovers a lost device on a replacement for the same canvas', async () => {
    const h = harness();
    const target = canvas();
    await h.attachment.attach(target);

    h.devices.devices[0]!.lose({ reason: 'unknown', message: 'lost for test' });
    await settle();

    expect(h.lost).toEqual([{ reason: 'unknown', message: 'lost for test', recovering: true }]);
    expect(h.log).toEqual([
      'bind',
      'attached true',
      'release',
      'cleanup',
      'attached false',
      'lost',
      'bind',
      'attached true',
    ]);
    expect(h.attachment.binding).toEqual({ device: h.devices.devices[1]!.device, canvas: target });
    expect(h.devices.releases).toHaveBeenCalledExactlyOnceWith(h.devices.devices[0]!.device);
  });

  it('reports a recovery that cannot lease a replacement and stays detached', async () => {
    const h = harness();
    await h.attachment.attach(canvas());
    h.devices.fail(new Error('No Core WebGPU adapter is available'));

    h.devices.devices[0]!.lose({ reason: 'destroyed', message: 'normal shutdown' });
    await settle();

    expect(h.lost).toEqual([
      { reason: 'destroyed', message: 'normal shutdown', recovering: true },
      { reason: 'unavailable', message: 'No Core WebGPU adapter is available', recovering: false },
    ]);
    expect(h.attachment.binding).toBeNull();
    expect(h.attachment.canvas).toBeNull();
  });

  it('stays detached when a loss handler detaches', async () => {
    const h = harness();
    await h.attachment.attach(canvas());
    h.handlers.lost = () => h.attachment.detach();

    h.devices.devices[0]!.lose();
    await settle();

    expect(h.lost).toEqual([{ reason: 'unknown', message: 'lost for test', recovering: true }]);
    expect(h.attachment.binding).toBeNull();
    expect(h.devices.devices).toHaveLength(1);
  });

  it('reports no recovery when a release handler attached anew first', async () => {
    const h = harness();
    const next = canvas();
    await h.attachment.attach(canvas());
    let moved: Promise<boolean> | null = null;
    h.handlers.attached = (bound) => {
      if (!bound && !moved) moved = h.attachment.attach(next);
    };

    h.devices.devices[0]!.lose();
    await settle();

    await expect(moved).resolves.toBe(true);
    expect(h.lost).toEqual([{ reason: 'unknown', message: 'lost for test', recovering: false }]);
    expect(h.attachment.binding?.canvas).toBe(next);
    expect(h.devices.devices).toHaveLength(2);
  });

  it('ignores a loss for a device it no longer holds, and after destroy', async () => {
    const h = harness();
    await h.attachment.attach(canvas());
    h.attachment.detach();
    h.devices.devices[0]!.lose();
    await settle();
    expect(h.lost).toEqual([]);

    await h.attachment.attach(canvas());
    h.attachment.destroy();
    h.devices.devices[1]!.lose();
    await settle();
    expect(h.lost).toEqual([]);
  });

  it('releases without saying so on destroy, and refuses to attach afterwards', async () => {
    const h = harness();
    await h.attachment.attach(canvas());
    h.attachment.destroy();
    h.attachment.destroy();

    expect(h.log).toEqual(['bind', 'attached true', 'release', 'cleanup']);
    await expect(h.attachment.attach(canvas())).rejects.toThrow('destroyed');
  });
});
