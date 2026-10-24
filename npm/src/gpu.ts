/** The GPU: the device views draw with, the memory they share, and the frames they draw in. */

import type * as bindings from '../pkg/latkit.js';
import { Canvas, type CanvasOptions } from './canvas.js';
import type { Budget, Scene } from './inputs.js';
import { hold, inner, release, wasm, waited, type Wait } from './internal.js';
import { firstDevice, load } from './load.js';
import type { Work } from './outputs.js';
import { View, type ViewOptions } from './view.js';

/** The GPU device views draw with. Views of one GPU draw in one animation frame, sharing its memory. */
export class Gpu {
  #views = new Set<View>();
  #canvases = new Set<Canvas>();
  #listeners = new Set<() => void>();

  private constructor(device: bindings.Gpu) {
    hold(this, device);
  }

  /** Asks for a WebGPU device, loading latkit first: the first call takes the one made as it loaded. */
  static async create(): Promise<Gpu> {
    await load();
    return new Gpu(await (firstDevice() ?? wasm().Gpu.create()));
  }

  /**
   * A view of `scene`, drawing the datasets its `sources` give. A {@link Canvas} shows it, and a
   * {@link Shot} draws it with or without one.
   */
  view(scene: Scene, options: ViewOptions = {}): View {
    const view = View.made(inner<bindings.Gpu>(this, 'Gpu'), scene, () => this.#views.delete(view));
    this.#views.add(view);
    if (options.sources) view.sources = options.sources;
    return view;
  }

  /**
   * A canvas showing views as `layout` places them in `target`: a `<canvas>` element, which sizes
   * itself to its CSS box and passes each view the input landing on it, or an `OffscreenCanvas` in a
   * worker, which keeps the size it is given at `pixelRatio` pixels a CSS pixel.
   */
  canvas(target: HTMLCanvasElement | OffscreenCanvas, options: CanvasOptions = {}): Canvas {
    const canvas = Canvas.made(inner<bindings.Gpu>(this, 'Gpu'), target, options, () =>
      this.#canvases.delete(canvas),
    );
    this.#canvases.add(canvas);
    return canvas;
  }

  /**
   * Calls `listener` with the frame's timestamp every animation frame, before the views draw, so
   * what it changes shows in that frame. Returns a function that stops it.
   */
  on(type: 'frame', listener: (now: number) => void): () => void {
    const handle = inner<bindings.Gpu>(this, 'Gpu').onFrame(listener);
    const stop = (): void => {
      if (this.#listeners.delete(stop)) handle.free();
    };
    this.#listeners.add(stop);
    return stop;
  }

  /** Whether the device was lost; a new `Gpu` is needed. */
  get lost(): boolean {
    return inner<bindings.Gpu>(this, 'Gpu').lost;
  }

  /** How much GPU memory data takes. */
  get budget(): Budget {
    return JSON.parse(inner<bindings.Gpu>(this, 'Gpu').budget) as Budget;
  }

  set budget(budget: Budget) {
    inner<bindings.Gpu>(this, 'Gpu').setBudget(JSON.stringify(budget));
  }

  /** What this GPU did since it was created, counted exactly; see {@link Work}. */
  get work(): Work {
    return JSON.parse(inner<bindings.Gpu>(this, 'Gpu').work) as Work;
  }

  /** Bytes on the GPU every view of it draws from: data, and what each view keeps per row. */
  get resident(): number {
    return inner<bindings.Gpu>(this, 'Gpu').resident;
  }

  /** Bytes waiting to upload, for every view of this GPU. */
  get uploading(): number {
    return inner<bindings.Gpu>(this, 'Gpu').uploading;
  }

  /**
   * Draws one frame now at `now`, milliseconds on the clock animation frames give: the frame
   * listeners, then every canvas that needs a frame. From the first step no animation frames are
   * asked for: a harness, as tests and benchmarks are, steps every frame itself, so a run draws the
   * same frames however fast the device is.
   */
  step(now: number): void {
    inner<bindings.Gpu>(this, 'Gpu').step(now);
  }

  /**
   * Resolves once the GPU finished the work submitted to it, every readback landed, and every
   * pipeline a view or shot asked for compiled: a frame stepped then draws all of it.
   */
  async done(wait: Wait = {}): Promise<void> {
    await waited<void>(inner<bindings.Gpu>(this, 'Gpu').done(), wait, 'the GPU');
  }

  /**
   * Resolves when work a view waits on lands after this call (a readback, a compile, a job, a text,
   * a fetch), or a view asks for a frame.
   */
  async landed(wait: Wait = {}): Promise<void> {
    await waited<void>(inner<bindings.Gpu>(this, 'Gpu').landed(), wait, 'work landing');
  }

  /** Releases this GPU's canvases, views, and frame listeners. Other GPUs and data stay usable. */
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
