/** The GPU device. It draws views on their canvases, holds their shared memory, and runs frames. */

import type * as bindings from '../pkg/latkit.js';
import { Canvas, type Target } from './canvas.js';
import type { Budget } from './inputs.js';
import { Handle, inner, stopped, wasm, waited, type Wait } from './internal.js';
import { firstDevice, load } from './load.js';
import type { Work } from './outputs.js';
import type { View } from './view.js';

/**
 * A WebGPU device that views draw with. Views on one `Gpu` share its memory and draw together in
 * each animation frame, so linked views always show the same moment. Views use the first `Gpu`
 * created unless given another, and `View.create` creates one if none exists. Destroying a `Gpu`
 * destroys its views and frame listeners. Other GPUs and datasets stay usable.
 */
export class Gpu extends Handle {
  /** The default GPU for views, and the pending request while it is being created. */
  static #shared: Gpu | undefined;
  static #creating: Promise<Gpu> | undefined;

  #views = new Set<View>();
  #canvases = new Map<Target, Canvas>();
  #listeners = new Set<() => void>();

  private constructor(device: bindings.Gpu) {
    super(device, 'Gpu');
  }

  /**
   * Requests a WebGPU device. The first call takes the device `load()` requested. Create one before
   * any view to set its `budget` first, or create another for views that should not share memory
   * with the rest. Rejects with an `unsupported` error when the browser has no WebGPU device.
   */
  static async create(): Promise<Gpu> {
    await load();
    const gpu = new Gpu(await (firstDevice() ?? wasm().Gpu.create()));
    if (!Gpu.#shared || Gpu.#shared.lost) Gpu.#shared = gpu;
    return gpu;
  }

  /** @internal Returns the default GPU for views, creating it if there is none. */
  static shared(): Promise<Gpu> {
    const shared = Gpu.#shared;
    if (shared && !shared.lost) return Promise.resolve(shared);
    return (Gpu.#creating ??= Gpu.create().finally(() => (Gpu.#creating = undefined)));
  }

  /**
   * Calls `listener` every animation frame with the frame's timestamp in milliseconds. It runs
   * before the views draw, so its changes show in that frame. While any listener is registered, a
   * frame runs on every animation frame. Returns a function that removes the listener.
   */
  on(type: 'frame', listener: (now: number) => void): () => void {
    const handle = device(this).onFrame(listener);
    const stop = (): void => {
      if (this.#listeners.delete(stop)) handle.free();
    };
    this.#listeners.add(stop);
    return stop;
  }

  /**
   * Whether the device was lost. Drawing then does nothing, so create a new `Gpu`. Also true once
   * an internal error stopped latkit.
   */
  get lost(): boolean {
    return stopped() || device(this).lost;
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
    for (const stop of this.#listeners) stop();
  }
}

/** @internal Returns `owner`'s bindings device. */
export function device(owner: Gpu): bindings.Gpu {
  return inner<bindings.Gpu>(owner);
}
