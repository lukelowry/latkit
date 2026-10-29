/** The GPU device. It draws views on their canvases, holds their shared memory, and runs frames. */

import type * as bindings from '../pkg/latkit.js';
import { Canvas, type Target } from './canvas.js';
import type { Budget } from './inputs.js';
import { Handle, inner, rebind, stopped, wasm, waited, type Wait } from './internal.js';
import { firstDevice, load } from './load.js';
import type { Work } from './outputs.js';
import type { View } from './view.js';

/**
 * A WebGPU device that views draw with. Views on one `Gpu` share its memory and draw together in
 * each animation frame, so linked views always show the same moment. Views use the first `Gpu`
 * created unless given another, and `View.create` creates one if none exists. When the device is
 * lost, latkit requests a new one and moves the views, their canvases, and the frame listeners to
 * it. Destroying a `Gpu` destroys its views and frame listeners. Other GPUs and datasets stay
 * usable.
 */
export class Gpu extends Handle {
  /** The default GPU for views, and the pending request while it is being created. */
  static #shared: Gpu | undefined;
  static #creating: Promise<Gpu> | undefined;

  #views = new Set<View>();
  #canvases = new Map<Target, Canvas>();
  /** Each frame listener, by the function the bindings call, with its bindings handle. */
  #listeners = new Map<(now: number) => void, bindings.Listener>();
  /** The move to a new device, while one is under way. */
  #recovering: Promise<void> | undefined;

  private constructor(device: bindings.Gpu) {
    super(device, 'Gpu');
  }

  /**
   * Requests a WebGPU device. The first call takes the device `load()` requested. Create one before
   * any view to set its `budget` first, or create another for views that should not share memory
   * with the rest. Loading and the request wait within `wait`. Rejects with an `unsupported` error
   * when the browser has no WebGPU device.
   */
  static async create(wait: Wait = {}): Promise<Gpu> {
    await waited(load(), wait, 'loading latkit');
    const gpu = new Gpu(await requested(firstDevice() ?? wasm().Gpu.create(), wait));
    if (!Gpu.#shared || Gpu.#shared.lost) Gpu.#shared = gpu;
    return gpu;
  }

  /** @internal Returns the default GPU for views, creating it if there is none. */
  static shared(wait: Wait = {}): Promise<Gpu> {
    const shared = Gpu.#shared;
    if (shared && !shared.lost) return Promise.resolve(shared);
    Gpu.#creating ??= Gpu.create().finally(() => (Gpu.#creating = undefined));
    return waited(Gpu.#creating, wait, 'requesting a GPU');
  }

  /**
   * Calls `listener` every animation frame with the frame's timestamp in milliseconds. It runs
   * before the views draw, so its changes show in that frame. While any listener is registered, a
   * frame runs on every animation frame. Returns a function that removes the listener.
   */
  on(type: 'frame', listener: (now: number) => void): () => void {
    const called = (now: number): void => listener(now);
    this.#listeners.set(called, device(this).onFrame(called));
    return () => {
      this.#listeners.get(called)?.free();
      this.#listeners.delete(called);
    };
  }

  /**
   * Whether the device is lost. latkit then requests a new one, so this is true only until it
   * arrives, or when there is none. Also true once an internal error stopped latkit.
   */
  get lost(): boolean {
    return stopped() || device(this).lost;
  }

  /**
   * @internal Moves the views, canvases, and frame listeners to a new device, once the device is
   * lost. Calls made while a move is under way share it. Rejects when there is no new device.
   */
  recover(): Promise<void> {
    this.#recovering ??= this.#recover().finally(() => (this.#recovering = undefined));
    return this.#recovering;
  }

  async #recover(): Promise<void> {
    const bound = await requested(wasm().Gpu.create(), {});
    bound.setBudget(device(this).budget);
    for (const view of this.#views) view.moved(bound);
    for (const canvas of this.#canvases.values()) canvas.moved(bound);
    for (const [called, handle] of this.#listeners) {
      handle.free();
      this.#listeners.set(called, bound.onFrame(called));
    }
    rebind<bindings.Gpu>(this, bound).free();
  }

  /**
   * The GPU memory budget for data, shared by every view on this GPU. See {@link Budget}. Defaults
   * to half the device's largest storage buffer, with 32 MiB uploaded per frame.
   */
  get budget(): Budget {
    return JSON.parse(device(this).budget) as Budget;
  }

  set budget(budget: Budget) {
    device(this).setBudget(JSON.stringify(budget));
  }

  /**
   * Exact counts of the work this GPU has done since it was created. See {@link Work}. The same
   * budget, device limits, and frames give the same counts, so tests and benchmarks can assert
   * them.
   */
  get work(): Work {
    return JSON.parse(device(this).work) as Work;
  }

  /** Bytes of GPU memory the views draw from: data pages and each view's per-row data. */
  get resident(): number {
    return device(this).resident;
  }

  /** Bytes waiting to upload to the GPU, across all its views. */
  get uploading(): number {
    return device(this).uploading;
  }

  /**
   * Draws one frame now, at `now` milliseconds on the `requestAnimationFrame` clock. It runs the
   * frame listeners, then draws every canvas that needs a frame. After the first call the GPU
   * stops requesting animation frames, so a test or benchmark that steps every frame draws the
   * same frames on any device.
   */
  step(now: number): void {
    device(this).step(now);
  }

  /**
   * Resolves once the GPU has finished its submitted work, every readback has arrived, and every
   * pipeline a view or shot requested has compiled. A frame stepped after that uses all of them.
   */
  async done(wait: Wait = {}): Promise<void> {
    await waited<void>(device(this).done(), wait, 'waiting for the GPU');
  }

  /**
   * Resolves when work a view waits on arrives after this call (a readback, a pipeline compile, a
   * job, a label text, or a fetch), or when a view requests a frame. A harness that steps frames
   * awaits it to know when to step again.
   */
  async landed(wait: Wait = {}): Promise<void> {
    await waited<void>(device(this).landed(), wait, 'waiting for work');
  }

  /**
   * @internal Keeps `view` until it or the GPU is destroyed, and shows it on `target`, over the
   * views already there. Returns the canvas showing it.
   */
  adopt(view: View, target: Target | null, pixelRatio?: number): Canvas | undefined {
    this.#views.add(view);
    if (!target) return undefined;
    let canvas = this.#canvases.get(target);
    if (!canvas) {
      canvas = Canvas.made(device(this), target, pixelRatio, () => this.#canvases.delete(target));
      this.#canvases.set(target, canvas);
    }
    canvas.add(view);
    return canvas;
  }

  /** @internal Forgets `view`, once it is destroyed. */
  release(view: View): void {
    this.#views.delete(view);
  }

  /** @internal Destroys the GPU's views, canvases, and frame listeners before its device. */
  protected override freeing(): void {
    if (Gpu.#shared === this) Gpu.#shared = undefined;
    for (const view of this.#views) view.destroy();
    for (const canvas of this.#canvases.values()) canvas.destroy();
    for (const handle of this.#listeners.values()) handle.free();
    this.#listeners.clear();
  }
}

/** @internal Returns `owner`'s bindings device. */
export function device(owner: Gpu): bindings.Gpu {
  return inner<bindings.Gpu>(owner);
}

/** The device `request` resolves to, within `wait`. A device that arrives after the wait is freed. */
async function requested(request: Promise<bindings.Gpu>, wait: Wait): Promise<bindings.Gpu> {
  try {
    return await waited(request, wait, 'requesting a GPU');
  } catch (error) {
    request.then(
      (late) => late.free(),
      () => {},
    );
    throw error;
  }
}
