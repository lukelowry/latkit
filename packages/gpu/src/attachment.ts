/**
 * One controller's binding to a canvas over a device pool: attach, detach, supersession, and
 * recovery from device loss, written once for every renderer.
 */

import type { DevicePool } from './pool.js';

/** A controller's binding to one canvas at a time. */
export interface Attachment<B> {
  /** The canvas bound or binding, or null. */
  readonly canvas: HTMLCanvasElement | null;
  /** The live binding, or null while detached or still binding. */
  readonly binding: B | null;
  /**
   * Release the current binding, lease a device, and bind `canvas`. Attaching the canvas already
   * bound or binding joins that attach.
   *
   * @returns True once bound; false when a newer attach or a detach took over first.
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
 * owns the outcome, and the loss reports `recovering: false`.
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
  /** Bumped by every attach, detach, and destroy, so an overtaken attach stands down. */
  let generation = 0;
  let destroyed = false;
  let target: { readonly canvas: HTMLCanvasElement; readonly done: Promise<boolean> } | null = null;
  let bound: { readonly binding: B; readonly cleanups: Array<() => void> } | null = null;

  function attach(canvas: HTMLCanvasElement): Promise<boolean> {
    if (destroyed) return Promise.reject(new Error('the controller is destroyed'));
    if (target?.canvas === canvas) return target.done;
    const own = ++generation;
    target = null;
    unbind();
    // A handler of the release attached or detached; that call owns the outcome.
    if (own !== generation) return Promise.resolve(false);
    const done = bindTo(own, canvas);
    target = { canvas, done };
    return done;
  }

  async function bindTo(own: number, canvas: HTMLCanvasElement): Promise<boolean> {
    const cleanups: Array<() => void> = [];
    try {
      const lease = await spec.devices.acquire();
      cleanups.push(() => lease.release());
      if (own !== generation) {
        cleanup(cleanups);
        return false;
      }
      const binding = spec.bind(lease.device, canvas, (release) => cleanups.push(release));
      // Host code the binding ran may have detached or attached anew.
      if (own !== generation) {
        cleanup(cleanups);
        return false;
      }
      cleanups.push(onLost(lease.device, (info) => lose(own, canvas, info)));
      bound = { binding, cleanups };
    } catch (error) {
      cleanup(cleanups);
      if (own !== generation) return false;
      target = null;
      throw error;
    }
    spec.attached(true);
    return true;
  }

  function detach(canvas?: HTMLCanvasElement): void {
    if (canvas && target?.canvas !== canvas) return;
    generation++;
    target = null;
    unbind();
  }

  function unbind(): void {
    const current = bound;
    if (!current) return;
    bound = null;
    spec.release(current.binding);
    cleanup(current.cleanups);
    if (!destroyed) spec.attached(false);
  }

  /** Release a lost device and re-attach, unless a handler detached or attached anew first. */
  function lose(own: number, canvas: HTMLCanvasElement, info: GPUDeviceLostInfo): void {
    if (own !== generation || destroyed) return;
    target = null;
    unbind();
    const message = info.message || 'WebGPU device was lost';
    spec.lost({ reason: info.reason ?? 'unknown', message, recovering: own === generation });
    if (own !== generation || destroyed) return;
    const recovery = attach(canvas);
    const mark = generation;
    recovery.catch((error: unknown) => {
      if (destroyed || mark !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      spec.lost({ reason: 'unavailable', message, recovering: false });
    });
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
      generation++;
      target = null;
      unbind();
    },
  };
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
