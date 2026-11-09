/** The GPU device. It draws views on their canvases, holds their shared memory, and runs frames. */

import type * as bindings from '../pkg/latkit.js';
import { Canvas, type Target } from './canvas.js';
import type { Budget } from './inputs.js';
import {
  due,
  Handle,
  inner,
  rebind,
  stopped,
  wasm,
  waited,
  type Due,
  type Wait,
} from './internal.js';
import { firstDevice, load, shadersLoaded } from './load.js';
import type { Work } from './outputs.js';
import type { View } from './view.js';

/**
 * A WebGL2 device that views draw with. Views on one `Gpu` share its memory and draw together in
 * each animation frame, so linked views always show the same moment. Views use the first `Gpu`
 * created unless given another, and `View.create` creates one if none exists. When the device is
 * lost, latkit requests a new one once the page is in the foreground, and moves the views, their
 * canvases, and the frame listeners to it. The views stay the same views: what they were asked,
 * their listeners, and pictures and videos drawing them carry over. Destroying a `Gpu` destroys
 * its views and frame listeners. Other GPUs and datasets stay usable.
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
  /** The work done on the devices this GPU moved from. */
  #before: Work | undefined;

  private constructor(device: bindings.Gpu) {
    super(device, 'Gpu');
  }

  /**
   * Requests a WebGL2 device. The first call takes the device `load()` requested. Create one before
   * any view to set its `budget` first, or create another for views that should not share memory
   * with the rest. Loading and the request wait within `wait`. Rejects with an `unsupported` error
   * when the browser has no WebGL2 device, and with an `io` error when the shaders could not be
   * downloaded. The next call downloads them again.
   */
  static async create(wait: Wait = {}): Promise<Gpu> {
    const until = due(wait);
    await waited(load(), until, 'loading latkit');
    await waited(shadersLoaded(), until, "loading latkit's shaders");
    const gpu = new Gpu(await requested(firstDevice() ?? wasm().Gpu.create(), until));
    if (!Gpu.#shared || Gpu.#shared.lost) Gpu.#shared = gpu;
    return gpu;
  }

  /** @internal Returns the default GPU for views, creating it if there is none. */
  static shared(wait: Wait = {}): Promise<Gpu> {
    const shared = Gpu.#shared;
    if (shared && !shared.lost) return Promise.resolve(shared);
    Gpu.#creating ??= Gpu.create().finally(() => (Gpu.#creating = undefined));
    return waited(Gpu.#creating, due(wait), 'requesting a GPU');
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
   * arrives, or when there is none. Also true once an internal error stopped latkit. latkit also
   * gives up a device that has no memory to grow its data, and the new one gets the budget lowered
   * to what the old one gave.
   */
  get lost(): boolean {
    return stopped() || device(this).lost;
  }

  /**
   * @internal Moves the views, canvases, and frame listeners to a new device, once the device is
   * lost. The views stay the same views. Calls made while a move is under way share it. Rejects
   * when there is no new device.
   */
  recover(): Promise<void> {
    this.#recovering ??= this.#recover().finally(() => (this.#recovering = undefined));
    return this.#recovering;
  }

  /** @internal Destroys the device, as a browser does when it loses one. For tests of the move. */
  lose(): void {
    device(this).lose();
  }

  async #recover(): Promise<void> {
    const bound = await replacement();
    bound.setBudget(device(this).budget);
    this.#before = this.work;
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
   * to half the device's addressable word-texture capacity, at most 1 GiB, with 32 MiB uploaded per frame.
   */
  get budget(): Budget {
    return JSON.parse(device(this).budget) as Budget;
  }

  set budget(budget: Budget) {
    device(this).setBudget(JSON.stringify(budget));
  }

  /**
   * Exact counts of the work this GPU has done since it was created, on every device it moved to.
   * See {@link Work}. The same budget, device limits, and frames give the same counts, so tests and
   * benchmarks can assert them.
   */
  get work(): Work {
    const work = JSON.parse(device(this).work) as Work;
    const before = this.#before;
    if (before) for (const key of Object.keys(work) as (keyof Work)[]) work[key] += before[key];
    return work;
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
   * frame listeners, then draws every canvas that needs a frame. Resolves once the GPU has finished
   * the frame and its readbacks have arrived. Pipelines may still compile: a view waiting for one
   * wakes when it lands. After the first call the GPU stops requesting animation frames, so a test
   * or benchmark that steps every frame draws the same frames on any device.
   */
  async step(now: number, wait: Wait = {}): Promise<void> {
    await waited<void>(device(this).step(now), due(wait), 'drawing a frame');
  }

  /**
   * Resolves once the GPU has finished the work submitted before the call, with the readbacks it
   * copies, and every pipeline a view or shot requested has compiled. A frame stepped after that
   * uses all of them.
   */
  async done(wait: Wait = {}): Promise<void> {
    await waited<void>(device(this).done(), due(wait), 'waiting for the GPU');
  }

  /**
   * Resolves when work a view waits on arrives after this call (a readback, a pipeline compile, a
   * job, a label text, or a fetch), or when a view requests a frame. A harness that steps frames
   * awaits it to know when to step again.
   */
  async landed(wait: Wait = {}): Promise<void> {
    await waited<void>(device(this).landed(), due(wait), 'waiting for work');
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

/**
 * A device to replace a lost one. It is asked for once the page shows, since a page in the
 * background, as a phone's often is when its device is lost, may be refused one. If the page went
 * to the background before it came, it is asked for once more when the page shows again.
 */
async function replacement(): Promise<bindings.Gpu> {
  await shown();
  try {
    return await requested(wasm().Gpu.create(), due());
  } catch (error) {
    if (!hidden()) throw error;
    await shown();
    return requested(wasm().Gpu.create(), due());
  }
}

/** Whether the page is in the background. A worker never is. */
function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Resolves once the page is in the foreground, at once if it is or in a worker. */
function shown(): Promise<void> {
  if (!hidden()) return Promise.resolve();
  return new Promise((resolve) => {
    const showing = (): void => {
      if (hidden()) return;
      document.removeEventListener('visibilitychange', showing);
      resolve();
    };
    document.addEventListener('visibilitychange', showing);
  });
}

/** The device `request` resolves to, within `until`. A device that arrives after it is freed. */
async function requested(request: Promise<bindings.Gpu>, until: Due): Promise<bindings.Gpu> {
  try {
    return await waited(request, until, 'requesting a GPU');
  } catch (error) {
    request.then(
      (late) => late.free(),
      () => {},
    );
    throw error;
  }
}
