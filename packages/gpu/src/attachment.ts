/**
 * One controller's binding to a canvas over a device pool: attach, detach, supersession, and
 * recovery from device loss, written once for every renderer.
 */

import type { DevicePool } from './pool.js';

/** A controller's binding to one canvas at a time. */
export interface Attachment<B> {
  /** The canvas bound or requested, including during device recovery, or null. */
  readonly canvas: HTMLCanvasElement | null;
  /** The live binding, or null while detached or still binding. */
  readonly binding: B | null;
  /**
   * Release the current binding, lease a device, and bind `canvas`. Attaching the canvas already
   * bound or binding joins that attach.
   *
   * @returns True once bound; false as soon as a newer attach or a detach takes over first.
   * @throws GpuUnavailableError when no device can be leased, and whatever `bind` throws.
   */
  attach(canvas: HTMLCanvasElement): Promise<boolean>;
  /** Release the binding; with `canvas`, only while that canvas is the one bound or binding. */
  detach(canvas?: HTMLCanvasElement): void;
  /** Detach for good; a later attach rejects. */
  destroy(): void;
}

/**
 * Create the attach lifecycle a controller shares with every other.
 *
 * @remarks
 * A device the platform loses is released and a replacement leased for the same canvas, unless a
 * handler of `release`, `attached(false)`, or `lost` detached or attached anew first: that call
 * owns the outcome, and the loss reports `recovering: false`. Attaching the same canvas joins
 * the recovery request; its promise waits for the replacement binding.
 */
export function createAttachment<B>(spec: {
  readonly devices: DevicePool;
  /** Build what draws into `canvas`; throw to refuse the device. Cleanups run in reverse on release. */
  bind(device: GPUDevice, canvas: HTMLCanvasElement, cleanup: (release: () => void) => void): B;
  /** Told on every release, before its cleanups run and before `attached(false)`. */
  release(binding: B): void;
  /** Bound, or released; never told after `destroy`. */
  attached(bound: boolean): void;
  /** The device was lost, or no replacement could be leased. */
  lost(loss: {
    readonly reason: string;
    readonly message: string;
    readonly recovering: boolean;
  }): void;
}): Attachment<B> {
  let destroyed = false;
  /** The one binding request that owns the canvas, including while recovering a lost device. */
  let target: Target | null = null;
  let bound: { readonly binding: B; readonly cleanups: Array<() => void> } | null = null;

  function attach(canvas: HTMLCanvasElement): Promise<boolean> {
    if (destroyed) return Promise.reject(new Error('the controller is destroyed'));
    if (target?.canvas === canvas) return target.done;
    return start(canvas);
  }

  /** Publish ownership before any callback can join, replace, or cancel this request. */
  function start(canvas: HTMLCanvasElement, loss?: GPUDeviceLostInfo): Promise<boolean> {
    const next = request(canvas);
    const previous = target;
    target = next;
    previous?.resolve(false);
    void bindTo(next, loss).then(next.resolve, next.reject);
    return next.done;
  }

  /** Acquire and bind only for the current request; every stale acquisition returns its lease. */
  async function bindTo(own: Target, loss?: GPUDeviceLostInfo): Promise<boolean> {
    const cleanups: Array<() => void> = [];
    try {
      unbind();
      if (loss && !destroyed) {
        spec.lost({
          reason: loss.reason ?? 'unknown',
          message: loss.message || 'WebGPU device was lost',
          recovering: target === own,
        });
      }
      if (target !== own) return false;
      const lease = await spec.devices.acquire();
      cleanups.push(() => lease.release());
      if (target !== own) {
        cleanup(cleanups);
        return false;
      }
      const binding = spec.bind(lease.device, own.canvas, (release) => cleanups.push(release));
      // Host code the binding ran may have detached or attached anew.
      if (target !== own) {
        cleanup(cleanups);
        return false;
      }
      cleanups.push(onLost(lease.device, (info) => lose(own, info)));
      bound = { binding, cleanups };
    } catch (error) {
      cleanup(cleanups);
      if (target !== own) return false;
      target = null;
      if (loss) {
        const message = error instanceof Error ? error.message : String(error);
        spec.lost({ reason: 'unavailable', message, recovering: false });
      }
      throw error;
    }
    spec.attached(true);
    return target === own;
  }

  function detach(canvas?: HTMLCanvasElement): void {
    if (canvas && target?.canvas !== canvas) return;
    const previous = target;
    target = null;
    previous?.resolve(false);
    unbind();
  }

  function unbind(): void {
    const current = bound;
    if (!current) return;
    bound = null;
    try {
      spec.release(current.binding);
    } finally {
      cleanup(current.cleanups);
    }
    if (!destroyed) spec.attached(false);
  }

  /** Recovery is another binding request: the same ownership and joining rules apply. */
  function lose(own: Target, info: GPUDeviceLostInfo): void {
    if (target !== own) return;
    // bindTo reports an owned recovery failure through lost; superseded work resolves false.
    void start(own.canvas, info).catch(() => {});
  }

  return {
    get canvas() {
      return target?.canvas ?? null;
    },
    get binding() {
      return bound?.binding ?? null;
    },
    attach,
    detach,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      detach();
    },
  };
}

/** One canvas request, whose identity is also the authority to bind or recover it. */
interface Target {
  readonly canvas: HTMLCanvasElement;
  readonly done: Promise<boolean>;
  resolve(bound: boolean): void;
  reject(error: unknown): void;
}

function request(canvas: HTMLCanvasElement): Target {
  let resolve!: Target['resolve'];
  let reject!: Target['reject'];
  const done = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { canvas, done, resolve, reject };
}

/** Run cleanups newest first; each is best-effort, so one failure cannot strand the rest. */
function cleanup(cleanups: Array<() => void>): void {
  for (let i = cleanups.length - 1; i >= 0; i--) {
    try {
      cleanups[i]!();
    } catch {
      // Keep releasing: the lease, registered first, must always run.
    }
  }
  cleanups.length = 0;
}

/** Relay one device loss until the returned call stops it. */
function onLost(device: GPUDevice, listener: (info: GPUDeviceLostInfo) => void): () => void {
  let active: ((info: GPUDeviceLostInfo) => void) | null = listener;
  void device.lost.then((info) => active?.(info));
  return () => {
    active = null;
  };
}
