/** The GPU device: it draws views on their canvases, owns their shared memory, and runs frames. */

import type * as bindings from '../pkg/latkit.js';
import { Canvas, type Target } from './canvas.js';
import type { Budget } from './inputs.js';
import { Handle, inner, wasm, waited, type Wait } from './internal.js';
import { firstDevice, load } from './load.js';
import type { Work } from './outputs.js';
import type { View } from './view.js';

/**
 * A WebGPU device that views draw with. The views of one `Gpu` share its memory and draw together
 * in each animation frame, so linked views always show the same moment. Views use the first `Gpu`
 * created unless given another, and `View.create` creates it when there is none. Destroying it
 * destroys its views and frame listeners; other GPUs and datasets stay usable.
 */
export class Gpu extends Handle {
  /** The GPU views use when given none, and the request for it while one is being created. */
  static #shared: Gpu | undefined;
  static #creating: Promise<Gpu> | undefined;

  #views = new Set<View>();
  #canvases = new Map<Target, Canvas>();
  #listeners = new Set<() => void>();

  private constructor(device: bindings.Gpu) {
    super(device, 'Gpu');
  }

  /**
   * Requests a WebGPU device; the first call takes the one `load()` requested. Create one before
   * any view to set its `budget` first, or another for views that should not share memory with the
   * rest. Rejects with an `unsupported` error when the browser has no WebGPU device.
   */
  static async create(): Promise<Gpu> {
    await load();
    const gpu = new Gpu(await (firstDevice() ?? wasm().Gpu.create()));
    if (!Gpu.#shared || Gpu.#shared.lost) Gpu.#shared = gpu;
    return gpu;
  }

  /** @internal The GPU views use when given none, created when there is none. */
  static shared(): Promise<Gpu> {
    const shared = Gpu.#shared;
    if (shared && !shared.lost) return Promise.resolve(shared);
    return (Gpu.#creating ??= Gpu.create().finally(() => (Gpu.#creating = undefined)));
  }

  /**
   * Calls `listener` every animation frame with the frame's timestamp in milliseconds, before the
   * views draw, so changes it makes show in that frame. While any listener is registered, a frame
   * runs every animation frame. Returns a function that removes the listener.
   */
  on(type: 'frame', listener: (now: number) => void): () => void {
    const handle = device(this).onFrame(listener);
    const stop = (): void => {
      if (this.#listeners.delete(stop)) handle.free();
    };
    this.#listeners.add(stop);
    return stop;
  }

  /** Whether the device was lost. Drawing then does nothing; create a new `Gpu`. */
  get lost(): boolean {
    return device(this).lost;
  }

  /**
   * The GPU memory budget for data, shared by every view of this GPU; see {@link Budget}. Defaults
   * to half the device's largest storage buffer, and 32 MiB uploaded per frame.
   */
  get budget(): Budget {
    return JSON.parse(device(this).budget) as Budget;
  }

  set budget(budget: Budget) {
    device(this).setBudget(JSON.stringify(budget));
  }

  /**
   * Exact counts of the work this GPU has done since it was created; see {@link Work}. The counts
   * repeat for the same budget, device limits, and frames, so tests and benchmarks can assert them.
   */
  get work(): Work {
    return JSON.parse(device(this).work) as Work;
  }

  /** Bytes of GPU memory its views draw from: data pages, and each view's per-row data. */
  get resident(): number {
    return device(this).resident;
  }

  /** Bytes waiting to upload to the GPU, across its views. */
  get uploading(): number {
    return device(this).uploading;
  }

  /**
   * Draws one frame now, at `now` milliseconds on the `requestAnimationFrame` clock: it runs the
   * frame listeners, then draws every canvas that needs a frame. After the first call, the GPU
   * requests no more animation frames, so a test or benchmark that steps every frame draws the
   * same frames on any device.
   */
  step(now: number): void {
    device(this).step(now);
  }

  /**
   * Resolves once the GPU has finished its submitted work, every readback has arrived, and every
   * pipeline a view or shot requested has compiled. A frame stepped after that uses all of it.
   */
  async done(wait: Wait = {}): Promise<void> {
    await waited<void>(device(this).done(), wait, 'waiting for the GPU');
  }

  /**
   * Resolves when, after this call, work a view is waiting on arrives (a readback, a pipeline
   * compile, a job, a label text, or a fetch), or a view requests a frame. A harness that steps
   * frames awaits it to know when to step again.
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
