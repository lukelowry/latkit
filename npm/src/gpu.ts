/** The GPU device: it creates views and canvases, owns their shared memory, and runs frames. */

import type * as bindings from '../pkg/latkit.js';
import { Canvas, type CanvasOptions } from './canvas.js';
import type { Budget, Scene } from './inputs.js';
import { hold, inner, release, wasm, waited, type Wait } from './internal.js';
import { firstDevice, load } from './load.js';
import type { Work } from './outputs.js';
import { View, type ViewOptions } from './view.js';

/**
 * A WebGPU device that views draw with. The views and canvases of one `Gpu` share its memory and
 * draw together in each animation frame, so linked views always show the same moment.
 */
export class Gpu {
  #views = new Set<View>();
  #canvases = new Set<Canvas>();
  #listeners = new Set<() => void>();

  private constructor(device: bindings.Gpu) {
    hold(this, device);
  }

  /**
   * Requests a WebGPU device, calling `load()` first. The first call reuses the device that
   * `load()` requested. Rejects with an `unsupported` error when the browser has no WebGPU device.
   */
  static async create(): Promise<Gpu> {
    await load();
    return new Gpu(await (firstDevice() ?? wasm().Gpu.create()));
  }

  /**
   * Creates a view that draws `scene` from the datasets in `options.sources`. Show it in a
   * {@link Canvas}, or draw it into pictures with a `Shot`, with or without a canvas. Throws an
   * `invalid` error for an invalid scene.
   */
  view(scene: Scene, options: ViewOptions = {}): View {
    const view = View.made(inner<bindings.Gpu>(this, 'Gpu'), scene, () => this.#views.delete(view));
    this.#views.add(view);
    if (options.sources) view.sources = options.sources;
    return view;
  }

  /**
   * Creates a canvas that shows views in `target`, placed by `options.layout`. A `<canvas>` element
   * sizes itself to its CSS box at the device pixel ratio, and passes pointer, wheel, and key input
   * to the views in its panels. An `OffscreenCanvas`, as in a worker, keeps the size it is given at
   * `options.pixelRatio` pixels per CSS pixel, and takes no input. Throws an `invalid` error for an
   * invalid layout, such as a view already shown in another panel.
   */
  canvas(target: HTMLCanvasElement | OffscreenCanvas, options: CanvasOptions = {}): Canvas {
    const canvas = Canvas.made(inner<bindings.Gpu>(this, 'Gpu'), target, options, () =>
      this.#canvases.delete(canvas),
    );
    this.#canvases.add(canvas);
    return canvas;
  }

  /**
   * Calls `listener` every animation frame with the frame's timestamp in milliseconds, before the
   * views draw, so changes it makes show in that frame. While any listener is registered, a frame
   * runs every animation frame. Returns a function that removes the listener.
   */
  on(type: 'frame', listener: (now: number) => void): () => void {
    const handle = inner<bindings.Gpu>(this, 'Gpu').onFrame(listener);
    const stop = (): void => {
      if (this.#listeners.delete(stop)) handle.free();
    };
    this.#listeners.add(stop);
    return stop;
  }

  /** Whether the device was lost. Drawing then does nothing; create a new `Gpu`. */
  get lost(): boolean {
    return inner<bindings.Gpu>(this, 'Gpu').lost;
  }

  /**
   * The GPU memory budget for data, shared by every view of this GPU; see {@link Budget}. Defaults
   * to half the device's largest storage buffer, and 32 MiB uploaded per frame.
   */
  get budget(): Budget {
    return JSON.parse(inner<bindings.Gpu>(this, 'Gpu').budget) as Budget;
  }

  set budget(budget: Budget) {
    inner<bindings.Gpu>(this, 'Gpu').setBudget(JSON.stringify(budget));
  }

  /**
   * Exact counts of the work this GPU has done since it was created; see {@link Work}. The counts
   * repeat for the same budget, device limits, and frames, so tests and benchmarks can assert them.
   */
  get work(): Work {
    return JSON.parse(inner<bindings.Gpu>(this, 'Gpu').work) as Work;
  }

  /**
   * Bytes of GPU memory the views of this GPU draw from: data pages, and each view's per-row data.
   */
  get resident(): number {
    return inner<bindings.Gpu>(this, 'Gpu').resident;
  }

  /** Bytes waiting to upload to the GPU, across every view of this GPU. */
  get uploading(): number {
    return inner<bindings.Gpu>(this, 'Gpu').uploading;
  }

  /**
   * Draws one frame immediately at time `now`, in milliseconds on the `requestAnimationFrame`
   * clock: it runs the frame listeners, then draws every canvas that needs a frame. After the first
   * call, this GPU stops requesting animation frames. A test or benchmark that steps every frame
   * itself then draws the same frames on any device.
   */
  step(now: number): void {
    inner<bindings.Gpu>(this, 'Gpu').step(now);
  }

  /**
   * Resolves once the GPU has finished all submitted work, every readback has arrived, and every
   * pipeline a view or shot requested has compiled. A frame stepped after that uses all of it.
   */
  async done(wait: Wait = {}): Promise<void> {
    await waited<void>(inner<bindings.Gpu>(this, 'Gpu').done(), wait, 'waiting for the GPU');
  }

  /**
   * Resolves when, after this call, work a view is waiting on arrives (a readback, a pipeline
   * compile, a job, a label text, or a fetch), or a view requests a frame. A harness that steps
   * frames awaits it to know when to step again.
   */
  async landed(wait: Wait = {}): Promise<void> {
    await waited<void>(inner<bindings.Gpu>(this, 'Gpu').landed(), wait, 'waiting for work');
  }

  /**
   * Destroys this GPU's canvases, views, and frame listeners, then frees the device. Other GPUs and
   * datasets stay usable. Calling it again does nothing; other methods throw afterwards.
   */
  destroy(): void {
    const device = release<bindings.Gpu>(this);
    if (!device) return;
    for (const canvas of this.#canvases) canvas.destroy();
    for (const view of this.#views) view.destroy();
    for (const stop of this.#listeners) stop();
    device.free();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}
