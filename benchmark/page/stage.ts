/**
 * Where a run happens, and the one way anything in it is measured. The stage steps every frame
 * itself, a sixtieth of a second apart on its own clock, and each frame waits for the GPU (its work
 * done, its readbacks landed, the pipelines asked for compiled), never for time: a run draws the same
 * frames however fast the device is, so what it counts repeats. A phase is an action, timed from when
 * it starts until everything settled: no view wants a frame, every view is complete, and no tile is
 * loading; work under way that wakes no frame is waited for as it lands. A steady phase acts before
 * each of a number of frames, so each act shows in its own frame, and its CPU and GPU time are per
 * frame. A lost device fails the phase at once, and every wait races a deadline.
 */
import {
  Data,
  Patch,
  Tiles,
  type Camera,
  type Gpu,
  type Scene,
  type View,
  type Work,
} from 'latkit';

/** Writes a dataset's rows into a patch, from arrays made beforehand. */
export type Write = (patch: Patch) => Patch;

/** What a phase cost. */
export interface Cost {
  /** Milliseconds from the action until everything settled. */
  ms: number;
  /** Frames drawn meanwhile. */
  frames: number;
  /** Milliseconds every view together took to record a frame on the CPU: median, 95th percentile. */
  cpu: number;
  cpu95: number;
  /** Milliseconds a frame took on the GPU, median; 0 where the device cannot measure. */
  gpu: number;
  /** What the GPU did until everything settled. */
  work: Work;
  /** Bytes of data pages on the GPU afterwards. */
  resident: number;
  /** Whether it acted every frame, so `cpu` is its time; else `ms` is. */
  steady: boolean;
}

/** Milliseconds between stepped frames: a display's sixtieth of a second. */
const FRAME = 1000 / 60;
/** The most frames a phase may take to settle: ten seconds of a display's frames. */
const MOST = 600;
/** Frames stepped once everything settled, in which nothing should draw. */
const IDLE = 10;
/** Milliseconds a frame, or work landing, may take: past it, something hangs. */
const DEADLINE = 30_000;
/** The longest a phase may take; the runner grows sizes within it. */
export const LIMIT = 10_000;
/** Frames a steady phase takes before it measures. */
export const WARM = 10;

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

/** What the frames a phase stepped drew. */
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
  /** Errors the views told: a mark that does not fit its data fails the run. */
  readonly errors: string[] = [];
  readonly #data = new Map<string, Data>();
  /** The stepped frames' clock, milliseconds. */
  #now = performance.now();

  constructor(gpu: Gpu, canvases: readonly HTMLCanvasElement[], size: number) {
    [this.gpu, this.canvases, this.size] = [gpu, canvases, size];
    // Stepped from the start, so no animation frame draws while views load either.
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

  /** The axis coordinates dataset `name` recorded. */
  span(name: string): [number, number] {
    return this.#data.get(name)!.describe().span ?? [0, 1];
  }

  /** Takes each dataset in: latkit's work alone, the arrays made beforehand. */
  ingest(data: Record<string, Write>): Promise<Cost> {
    return this.once(() => {
      for (const [name, write] of Object.entries(data))
        this.#data.set(name, new Data(name).apply(write(new Patch())));
    });
  }

  /** Opens a view on each canvas and draws `scene`: from nothing to everything drawn. */
  load(scene: Scene, tiles: Record<string, string> = {}, camera?: Camera): Promise<Cost> {
    const sources = [
      ...this.#data.values(),
      ...Object.entries(tiles).map(([name, url]) => new Tiles(name, url)),
    ];
    return this.once(() => {
      for (const canvas of this.canvases) {
        const view = this.gpu.view(scene, { sources });
        this.gpu.canvas(canvas, { layout: [{ view }] });
        view.on('error', (error) =>
          this.errors.push(`${error.path ?? ''} ${error.message}`.trim()),
        );
        if (camera) view.camera = camera;
        else view.fit('all');
        this.views.push(view);
      }
    });
  }

  /** Draws `scene` in every view. */
  set scene(scene: Scene) {
    for (const view of this.views) view.scene = scene;
  }

  /** Writes a patch into dataset `name`, which every view draws from the next frame. */
  apply(name: string, write: Write): void {
    this.#data.get(name)!.apply(write(new Patch()));
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
    return this.#phase(false, async (drawn) => {
      await this.until(Promise.resolve().then(act), drawn, true);
      await this.#settle(drawn, true);
    });
  }

  /** `answer`, stepping frames until it comes: what waits on a frame, as a pick or a hover told
   * does, gets one, and what waits on work landing is waited for. */
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
      } else await Promise.race([coming, this.gpu.landed().catch(() => {})]);
    }
    return answer;
  }

  /** Calls `act(i)` before each of `count` frames, and measures until everything settled. */
  steady(count: number, act: (i: number) => void): Promise<Cost> {
    return this.#phase(true, async (drawn) => {
      for (let i = 0; i < count; i++) {
        act(i);
        await this.#frame(drawn, i >= WARM);
      }
      await this.#settle(drawn, false);
    });
  }

  /** Frames drawn over `IDLE` frames stepped once everything settled: none, for views that sleep. */
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

  /** Steps one frame, once the GPU is done with the last, and counts what the views drew in it:
   * their CPU and GPU time, when `measuring`. */
  async #frame(drawn: Drawn, measuring: boolean): Promise<void> {
    if (this.gpu.lost) throw new Error('the GPU device was lost');
    const before = this.views.map((v) => v.stats.frames);
    this.gpu.step((this.#now += FRAME));
    await deadline(this.gpu.done(), DEADLINE, 'a frame');
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

  /** Steps frames until everything settled: no view wants a frame, every view is complete, and no
   * tile is loading. Work under way that wakes no frame, as a layout or a fetch, is waited for as it
   * lands. What a once phase draws is `measuring`. */
  async #settle(drawn: Drawn, measuring: boolean): Promise<void> {
    await deadline(this.gpu.done(), DEADLINE, 'the GPU');
    for (let frames = 0; frames < MOST;) {
      if (this.gpu.lost) throw new Error('the GPU device was lost');
      if (this.views.some((v) => v.wantsFrame)) {
        await this.#frame(drawn, measuring);
        frames++;
        continue;
      }
      if (this.views.every((v) => v.complete && !v.stats.tilesLoading)) return;
      await deadline(this.gpu.landed(), DEADLINE, `${this.#waiting()} landing`);
    }
    throw new Error(
      `still drawing after ${MOST} frames: waiting on ${this.#waiting() || 'nothing'}`,
    );
  }

  /** What the views wait on. */
  #waiting(): string {
    const tiles = this.views.some((v) => v.stats.tilesLoading) ? ['tiles'] : [];
    return [...new Set(this.views.flatMap((v) => v.waiting)), ...tiles].join(', ');
  }
}
