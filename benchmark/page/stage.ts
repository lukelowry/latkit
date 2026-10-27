/**
 * The stage a run happens on, and the single way anything in a run is measured.
 *
 * The stage steps every frame itself, 1/60 s apart on its own clock. Each frame waits for the GPU
 * (its work done, its readbacks back, and the requested pipelines compiled), never for time. So a
 * run draws the same frames however fast the device is, and its work counts repeat.
 *
 * A phase is an action, timed from its start until everything settles: no view wants a frame,
 * every view is complete, and no tile is loading. Work in progress that wakes no frame is awaited
 * until it finishes. A steady phase acts before each of a set number of frames, so each action
 * shows in its own frame, and its CPU and GPU times are per frame. A lost device fails the phase at
 * once, and every wait has a deadline that cancels the work it waits on.
 */
import { Data, Patch, Tiles, View, type Camera, type Gpu, type Scene, type Work } from 'latkit';
import { quantile } from '../../npm/examples/gate/quantile.ts';

/** Writes a dataset's rows into a patch, from arrays made beforehand. */
export type Write = (patch: Patch) => Patch;

/** The cost of a phase. */
export interface Cost {
  /** Milliseconds from the action until everything settled. */
  ms: number;
  /** Frames drawn in that time. */
  frames: number;
  /** CPU milliseconds all views together took to record a frame: the median here, and the 95th
   * percentile in `cpu95`. */
  cpu: number;
  cpu95: number;
  /** Median GPU milliseconds per frame, or 0 where the device cannot measure it. */
  gpu: number;
  /** The GPU work done until everything settled. */
  work: Work;
  /** Bytes resident on the GPU afterwards: data pages, and each view's per-row data. */
  resident: number;
  /** Whether the phase acted every frame. If so, `cpu` is its time; otherwise `ms` is. */
  steady: boolean;
}

/** Milliseconds between stepped frames: 1/60 s, as on a 60 Hz display. */
const FRAME = 1000 / 60;
/** Maximum frames a phase may take to settle: 10 s at 60 frames a second. */
const MOST = 600;
/** Frames stepped after everything settled, in which nothing should draw. */
const IDLE = 10;
/** Maximum milliseconds a frame, or a wait for work to finish, may take. Longer means a hang. */
const DEADLINE = 30_000;
/** Milliseconds a phase should take at most. The runner stops growing a scenario's size once a
 * phase would exceed it. */
export const LIMIT = 10_000;
/** Frames a steady phase runs before it starts measuring. */
export const WARM = 10;

/** The frames a phase drew, and the CPU and GPU times of those measured. */
interface Drawn {
  frames: number;
  cpu: number[];
  gpu: number[];
}

export class Stage {
  readonly gpu: Gpu;
  readonly canvases: readonly HTMLCanvasElement[];
  /** The scenario's size. */
  readonly size: number;
  readonly views: View[] = [];
  /** Errors the views reported. Any error, such as a mark that does not fit its data, fails the
   * run. */
  readonly errors: string[] = [];
  readonly #data = new Map<string, Data>();
  /** The clock of the stepped frames, in milliseconds. */
  #now = performance.now();

  constructor(gpu: Gpu, canvases: readonly HTMLCanvasElement[], size: number) {
    [this.gpu, this.canvases, this.size] = [gpu, canvases, size];
    // Step from the start, so no animation frame draws while the views load either.
    gpu.step(this.#now);
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
    const [a, b] = [this.view.position([x, y]), this.view.position([x + px, y])];
    return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 1;
  }

  /** Rows of `table` in dataset `name`. */
  count(name: string, table: string): number {
    return this.#data
      .get(name)!
      .describe()
      .tables.find((t) => t.name === table)!.rows;
  }

  /** The range of axis coordinates dataset `name` recorded, or [0, 1] if none. */
  span(name: string): [number, number] {
    return this.#data.get(name)!.describe().span ?? [0, 1];
  }

  /** Applies each dataset to a new `Data`. The arrays are made beforehand, so this times latkit
   * alone. */
  ingest(data: Record<string, Write>): Promise<Cost> {
    return this.once(() => {
      for (const [name, write] of Object.entries(data))
        this.#data.set(name, new Data(name).apply(write(new Patch())));
    });
  }

  /** Opens a view on each canvas and draws `scene`, measuring from nothing until everything is
   * drawn. */
  load(scene: Scene, tiles: Record<string, string> = {}, camera?: Camera): Promise<Cost> {
    const sources = [
      ...this.#data.values(),
      ...Object.entries(tiles).map(([name, url]) => new Tiles(name, url)),
    ];
    return this.once(async () => {
      for (const canvas of this.canvases) {
        const view = await View.create(canvas, scene, { gpu: this.gpu, sources, camera });
        view.on('error', (error) =>
          this.errors.push(`${error.path ?? ''} ${error.message}`.trim()),
        );
        this.views.push(view);
      }
    });
  }

  /** Draws `scene` in every view. */
  set scene(scene: Scene) {
    for (const view of this.views) view.scene = scene;
  }

  /** Applies a patch to dataset `name`. Every view draws the change from the next frame. */
  apply(name: string, write: Write): void {
    this.#data.get(name)!.apply(write(new Patch()));
  }

  /** Dispatches a pointer event at `[x, y]`, in CSS pixels in the first view, as a real pointer
   * would. */
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

  /** Performs `act` once and measures until everything settles. */
  once(act: () => unknown): Promise<Cost> {
    return this.#phase(false, async (drawn) => {
      await this.until(Promise.resolve().then(act), drawn, true);
      await this.#settle(drawn, true);
    });
  }

  /** Steps frames until `answer` settles, then returns it. A frame is stepped whenever a view wants
   * one, as a pending pick or hover event does. Otherwise it waits for work to finish. Throws if
   * the device is lost, or after `MOST` frames or `DEADLINE` ms. */
  async until<T>(
    answer: Promise<T>,
    drawn: Drawn = { frames: 0, cpu: [], gpu: [] },
    measuring = false,
  ): Promise<T> {
    let came = false;
    const coming = answer.then(
      () => (came = true),
      () => (came = true),
    );
    const late = performance.now() + DEADLINE;
    for (let frames = 0; !came;) {
      if (this.gpu.lost) throw new Error('the GPU device was lost');
      if (frames > MOST || performance.now() > late)
        throw new Error(
          `no answer after ${frames} frames: waiting on ${this.#waiting() || 'nothing'}`,
        );
      if (this.views.some((v) => v.wantsFrame)) {
        await this.#frame(drawn, measuring);
        frames++;
      } else {
        // Waits for the answer or for work to land, then stops waiting for work, so no wait is left
        // pending.
        const answered = new AbortController();
        const timeout = AbortSignal.timeout(Math.max(0, late - performance.now()));
        const landed = this.gpu.landed({ signal: AbortSignal.any([answered.signal, timeout]) });
        await Promise.race([coming, landed.catch(() => {})]);
        answered.abort();
      }
    }
    return answer;
  }

  /** Calls `act(i)` before each of `count` frames, and measures until everything settles. Frames
   * after the first `WARM` are measured. */
  steady(count: number, act: (i: number) => void): Promise<Cost> {
    return this.#phase(true, async (drawn) => {
      for (let i = 0; i < count; i++) {
        act(i);
        await this.#frame(drawn, i >= WARM);
      }
      await this.#settle(drawn, false);
    });
  }

  /** Counts the frames drawn in `IDLE` frames stepped after everything settles. Views that sleep
   * draw none. */
  async idle(): Promise<number> {
    const drawn: Drawn = { frames: 0, cpu: [], gpu: [] };
    await this.#settle(drawn, false);
    const before = drawn.frames;
    for (let i = 0; i < IDLE; i++) await this.#frame(drawn, false);
    return drawn.frames - before;
  }

  async #phase(steady: boolean, drive: (drawn: Drawn) => Promise<void>): Promise<Cost> {
    const before = this.gpu.work;
    const drawn: Drawn = { frames: 0, cpu: [], gpu: [] };
    const begun = performance.now();
    await drive(drawn);
    const ms = performance.now() - begun;
    const after = this.gpu.work;
    const work = Object.fromEntries(
      Object.entries(after).map(([k, v]) => [k, v - before[k as keyof Work]]),
    ) as unknown as Work;
    return {
      ms,
      frames: drawn.frames,
      cpu: quantile(drawn.cpu, 0.5),
      cpu95: quantile(drawn.cpu, 0.95),
      gpu: quantile(drawn.gpu, 0.5),
      work,
      resident: this.gpu.resident,
      steady,
    };
  }

  /** Steps one frame and waits for the GPU to finish it. Counts the frame if any view drew, and
   * when `measuring` records the views' summed CPU and GPU times. */
  async #frame(drawn: Drawn, measuring: boolean): Promise<void> {
    if (this.gpu.lost) throw new Error('the GPU device was lost');
    const before = this.views.map((v) => v.stats.frames);
    this.gpu.step((this.#now += FRAME));
    await this.gpu.done({ signal: AbortSignal.timeout(DEADLINE) });
    let [drew, cpu, gpu] = [false, 0, 0];
    this.views.forEach((view, i) => {
      const stats = view.stats;
      if (stats.frames === before[i]) return;
      [drew, cpu, gpu] = [true, cpu + stats.cpuMs, gpu + stats.gpuMs];
    });
    if (!drew) return;
    drawn.frames++;
    if (measuring) {
      drawn.cpu.push(cpu);
      if (gpu) drawn.gpu.push(gpu);
    }
  }

  /** Steps frames until everything settles: no view wants a frame, every view is complete, and no
   * tile is loading. Work in progress that wakes no frame, such as a layout or a fetch, is awaited
   * until it finishes. `measuring` is true for a once phase, whose every frame is measured. */
  async #settle(drawn: Drawn, measuring: boolean): Promise<void> {
    await this.gpu.done({ signal: AbortSignal.timeout(DEADLINE) });
    for (let frames = 0; frames < MOST;) {
      if (this.gpu.lost) throw new Error('the GPU device was lost');
      if (this.views.some((v) => v.wantsFrame)) {
        await this.#frame(drawn, measuring);
        frames++;
        continue;
      }
      if (this.views.every((v) => v.complete && !v.stats.tilesLoading)) return;
      await this.gpu.landed({ signal: AbortSignal.timeout(DEADLINE) }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`waiting on ${this.#waiting() || 'nothing'}: ${message}`);
      });
    }
    throw new Error(
      `still drawing after ${MOST} frames: waiting on ${this.#waiting() || 'nothing'}`,
    );
  }

  /** Lists what the views are waiting on, including tiles. */
  #waiting(): string {
    const tiles = this.views.some((v) => v.stats.tilesLoading) ? ['tiles'] : [];
    return [...new Set(this.views.flatMap((v) => v.waiting)), ...tiles].join(', ');
  }
}
