/** The GPU device: it creates views and canvases, owns their shared memory, and runs frames. */

import type * as bindings from '../pkg/latkit.js';
import { Canvas, type Panel } from './canvas.js';
import type { Source } from './data.js';
import type { Budget, Scene } from './inputs.js';
import { Handle, inner, wasm, waited, type Wait } from './internal.js';
import { firstDevice, load } from './load.js';
import type { Work } from './outputs.js';
import { View } from './view.js';

/**
 * A WebGPU device that views draw with. The views and canvases of one `Gpu` share its memory and
 * draw together in each animation frame, so linked views always show the same moment. Destroying
 * it destroys its canvases, views, and frame listeners; other GPUs and datasets stay usable.
 */
export class Gpu extends Handle {
  #views = new Set<View>();
  #canvases = new Set<Canvas>();
  #listeners = new Set<() => void>();

  private constructor(device: bindings.Gpu) {
    super(device, 'Gpu');
  }

  /**
   * Requests a WebGPU device; the first call takes the one `load()` requested. Rejects with an
   * `unsupported` error when the browser has no WebGPU device.
   */
  static async create(): Promise<Gpu> {
    await load();
    return new Gpu(await (firstDevice() ?? wasm().Gpu.create()));
  }

  /**
   * Creates a view that draws `scene`. Show it in a {@link Canvas}, or draw it into pictures with a
   * `Shot`, with or without a canvas.
   */
  view(
    scene: Scene,
    options: {
      /** The datasets the scene draws; see {@link View.sources}. */
      sources?: readonly Source[];
    } = {},
  ): View {
    const view = View.made(device(this), scene, () => this.#views.delete(view));
    this.#views.add(view);
    if (options.sources) view.sources = options.sources;
    return view;
  }

  /**
   * Creates a canvas that shows views in `target`. A `<canvas>` element sizes itself to its CSS box
   * at the device pixel ratio, and passes pointer, wheel, and key input to the views in its panels.
   * An `OffscreenCanvas`, as in a worker, keeps the size it is given and takes no input.
   */
  canvas(
    target: HTMLCanvasElement | OffscreenCanvas,
    options: {
      /** The views shown and their regions; see {@link Canvas.layout}. None by default. */
      layout?: readonly Panel[];
      /** Pixels per CSS pixel of an `OffscreenCanvas`, 1 by default. */
      pixelRatio?: number;
    } = {},
  ): Canvas {
    const canvas = Canvas.made(device(this), target, options, () => this.#canvases.delete(canvas));
    this.#canvases.add(canvas);
    return canvas;
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

  /** @internal Destroys the GPU's canvases, views, and frame listeners before its device. */
  protected override freeing(): void {
    for (const canvas of this.#canvases) canvas.destroy();
    for (const view of this.#views) view.destroy();
    for (const stop of this.#listeners) stop();
  }
}

function device(owner: Gpu): bindings.Gpu {
  return inner<bindings.Gpu>(owner);
}
