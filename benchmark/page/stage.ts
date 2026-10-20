/**
 * Where a run happens, and the one way anything in it is measured. A phase is an action, timed from
 * when it starts to the frame where every view is complete and still; a steady phase acts in each of
 * a number of frames, through the GPU's frame listener, so each act shows in its own frame, and its
 * CPU and GPU time are per frame. Both count what the GPU did until everything settled. A lost
 * device fails the phase at once. Every wait races a deadline.
 */
import {
  Patch,
  type Camera,
  type Data,
  type Gpu,
  type Latkit,
  type Scene,
  type View,
  type Work,
} from 'latkit';

/** Writes a dataset's rows into a patch, from arrays made beforehand. */
export type Write = (patch: Patch) => Patch;

/** What a phase cost. */
export interface Cost {
  /** Milliseconds from the action to the frame where every view was complete. */
  ms: number;
  /** Frames drawn meanwhile. */
  frames: number;
  /** Milliseconds every view together took to record a frame on the CPU: median, 95th percentile. */
  cpu: number;
  cpu95: number;
  /** Milliseconds a frame took on the GPU, median; 0 where the device cannot measure. */
  gpu: number;
  /** The longest wait between animation frames: what a person sees as a stall. */
  gap: number;
  /** What the GPU did until everything settled. */
  work: Work;
  /** Bytes of data pages on the GPU afterwards. */
  resident: number;
  /** Whether it acted every frame, so `cpu` is its time; else `ms` is. */
  steady: boolean;
}

/** Milliseconds without a frame, once every view is complete, that count as still. */
export const STILL = 100;
/** Milliseconds idle frames are counted over once everything settled. */
export const IDLE = 250;
/** The longest a phase may act, and then take to settle; the runner grows sizes within it. */
export const LIMIT = 20_000;
/** Frames a steady phase takes before it measures. */
export const WARM = 10;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (xs: number[], q: number) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]! : 0;

/** `work`, or an error naming `what` once `ms` pass. */
export function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class Stage {
  readonly latkit: Latkit;
  readonly gpu: Gpu;
  readonly canvases: readonly HTMLCanvasElement[];
  /** The scenario's size. */
  readonly size: number;
  readonly views: View[] = [];
  /** Errors the views told: a mark that does not fit its data fails the run. */
  readonly errors: string[] = [];
  scene!: Scene;
  readonly #data = new Map<string, Data>();

  constructor(latkit: Latkit, gpu: Gpu, canvases: readonly HTMLCanvasElement[], size: number) {
    [this.latkit, this.gpu, this.canvases, this.size] = [latkit, gpu, canvases, size];
  }

  get view(): View {
    return this.views[0]!;
  }

  /** The middle of the first view, in its CSS pixels. */
  get middle(): [number, number] {
    const canvas = this.canvases[0]!;
    return [canvas.clientWidth / 2, canvas.clientHeight / 2];
  }

  /** Units across `px` CSS pixels at the middle of the first view. */
  across(px: number): number {
    const [x, y] = this.middle;
    const [a, b] = [this.view.ground([x, y]), this.view.ground([x + px, y])];
    return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 1;
  }

  /** Rows of `table` in dataset `name`. */
  count(name: string, table: string): number {
    return this.#data.get(name)!.ids(table).length;
  }

  /** The axis coordinates dataset `name` recorded. */
  span(name: string): [number, number] {
    return this.#data.get(name)!.span ?? [0, 1];
  }

  /** Takes each dataset in: latkit's work alone, the arrays made beforehand. */
  ingest(data: Record<string, Write>): Promise<Cost> {
    const { Data } = this.latkit;
    return this.once(() => {
      for (const [name, write] of Object.entries(data))
        this.#data.set(name, new Data(name).apply(write(new Patch())));
    });
  }

  /** Opens a view on each canvas and draws `scene`: from nothing to everything drawn. */
  load(scene: Scene, tiles: Record<string, string> = {}, camera?: Camera): Promise<Cost> {
    this.scene = scene;
    return this.once(() => {
      for (const canvas of this.canvases) {
        const view = this.gpu.view(scene);
        this.gpu.canvas(canvas).show([view]);
        view.on('error', (error) =>
          this.errors.push(`${error.path ?? ''} ${error.message}`.trim()),
        );
        for (const data of this.#data.values()) view.setData(data);
        for (const [name, url] of Object.entries(tiles)) view.setTiles(name, url);
        if (camera) view.camera = camera;
        else view.fit('all');
        this.views.push(view);
      }
    });
  }

  /** Shows `scene` in every view. */
  show(scene: Scene): void {
    this.scene = scene;
    for (const view of this.views) view.show(scene);
  }

  /** Writes a patch into dataset `name` and gives every view the next version. */
  apply(name: string, write: Write): void {
    const data = this.#data.get(name)!.apply(write(new Patch()));
    for (const view of this.views) view.setData(data);
  }

  /** Sends a pointer event at `point`, CSS pixels in the first view, as a person's would arrive. */
  pointer(type: string, [x, y]: [number, number], buttons = 0): void {
    const canvas = this.canvases[0]!;
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new PointerEvent(type, {
        clientX: box.left + x,
        clientY: box.top + y,
        buttons,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        bubbles: true,
      }),
    );
  }

  /** Acts once, and measures until everything settled. */
  once(act: () => unknown): Promise<Cost> {
    return this.#phase(false, async (sampler) => {
      sampler.measuring = true;
      await act();
    });
  }

  /** Calls `act(i)` in each of `count` frames, before the views draw, and measures until everything
   * settled. */
  steady(count: number, act: (i: number) => void): Promise<Cost> {
    return this.#phase(
      true,
      (sampler) =>
        new Promise<void>((resolve, reject) => {
          let i = 0;
          sampler.act = () => {
            if (i === count) {
              [sampler.act, sampler.measuring] = [undefined, false];
              return resolve();
            }
            sampler.measuring = i >= WARM;
            try {
              act(i++);
            } catch (error) {
              sampler.act = undefined;
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
        }),
    );
  }

  /** Frames drawn over `IDLE` ms once everything settled: none, for views that sleep. */
  async idle(): Promise<number> {
    const sampler = new Sampler(this.gpu, this.views);
    try {
      await this.#settled(sampler);
      const before = sampler.frames;
      await wait(IDLE);
      return sampler.frames - before;
    } finally {
      sampler.stop();
    }
  }

  async #phase(steady: boolean, drive: (sampler: Sampler) => Promise<void>): Promise<Cost> {
    const before = this.gpu.work;
    const sampler = new Sampler(this.gpu, this.views);
    const begun = performance.now();
    try {
      await deadline(drive(sampler), LIMIT, 'the action');
      const acted = performance.now();
      await this.#settled(sampler);
      const after = this.gpu.work;
      const work = Object.fromEntries(
        Object.entries(after).map(([k, v]) => [k, v - before[k as keyof Work]]),
      ) as unknown as Work;
      return {
        ms: Math.max(acted, sampler.drew) - begun,
        frames: sampler.frames,
        cpu: quantile(sampler.cpu, 0.5),
        cpu95: quantile(sampler.cpu, 0.95),
        gpu: quantile(sampler.gpu, 0.5),
        gap: sampler.gap,
        work,
        resident: this.views[0]?.stats.resident ?? 0,
        steady,
      };
    } finally {
      sampler.stop();
    }
  }

  /** Waits until every view is complete and none drew for `STILL` ms; fails at once if the device
   * was lost, and past `LIMIT` names what the views still waited on. */
  async #settled(sampler: Sampler): Promise<void> {
    const until = performance.now() + LIMIT;
    const waiting = () => [...new Set(this.views.flatMap((v) => v.stats.waiting))];
    while (!(waiting().length === 0 && performance.now() - sampler.drew >= STILL)) {
      if (this.gpu.lost) throw new Error('the GPU device was lost');
      if (performance.now() > until) {
        const on = waiting();
        throw new Error(
          `not settled within ${LIMIT} ms: ${on.length ? `waiting on ${on.join(', ')}` : 'still drawing'}`,
        );
      }
      await wait(20);
    }
  }
}

/**
 * Watches every frame through the GPU's frame listener, which runs before the views draw: when it
 * came, and what the views drew since the last. A steady phase acts in the same listener, after the
 * sample, so each act shows in its own frame and two acts never share one.
 */
class Sampler {
  measuring = false;
  /** When a view last drew. */
  drew = performance.now();
  frames = 0;
  gap = 0;
  readonly cpu: number[] = [];
  readonly gpu: number[] = [];
  /** What a steady phase does in each frame. */
  act?: () => void;
  readonly stop: () => void;
  readonly #views: readonly View[];
  readonly #drawn: Map<View, number>;
  #last = performance.now();

  constructor(gpu: Gpu, views: readonly View[]) {
    this.#views = views;
    this.#drawn = new Map(views.map((v) => [v, v.stats.frames]));
    this.stop = gpu.on('frame', (now) => {
      this.#sample(now);
      this.act?.();
    });
  }

  /** What the views drew since the last frame: the frame the last act showed in. Views opened since
   * the sampler began, as loading opens them, start from no frames. */
  #sample(now: number): void {
    this.gap = Math.max(this.gap, now - this.#last);
    this.#last = now;
    let [drew, cpu, gpu] = [false, 0, 0];
    for (const view of this.#views) {
      const stats = view.stats;
      if (stats.frames === (this.#drawn.get(view) ?? 0)) continue;
      this.#drawn.set(view, stats.frames);
      [drew, cpu, gpu] = [true, cpu + stats.cpuMs, gpu + stats.gpuMs];
    }
    if (!drew) return;
    this.frames++;
    this.drew = now;
    if (this.measuring) {
      this.cpu.push(cpu);
      if (gpu) this.gpu.push(gpu);
    }
  }
}
