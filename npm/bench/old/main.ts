/**
 * The old packages behind the bench page's contract, for one comparison before they go: the
 * scenarios they can draw, from the same generators, timed the same way, from an action to the
 * frame showing it, once no frame has drawn for a while and the GPU is idle. Their work counts
 * differ, so only times are kept, in baselines/old.json. Deleted with `packages/`.
 */
import { createDiagram } from '@latkit/diagram';
import { createGpu, type Gpu } from '@latkit/gpu';
import { appendData, createData, textColumn, type Data } from '@latkit/model';
import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';
import type { Patch, Work } from 'latkit';
import type { Listed, Run } from '../page/main.ts';
import type { Order } from '../page/scenarios.ts';
import { LIMIT, deadline, type Cost, type Write } from '../page/stage.ts';
import * as make from '../page/data.ts';

const STILL = 300;
const WARM = 10;
const FRAMES = 120;
const HISTORY = 1024;
const DECADES = [1e3, 1e4, 1e5, 1e6, 2e6];
const NONE: Work = {
  uploaded: 0,
  written: 0,
  evaluated: 0,
  readbacks: 0,
  jobs: 0,
  texts: 0,
  pipelines: 0,
};

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (xs: number[], q: number) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]! : 0;

// Data: what a `Write` gives a patch, recorded, then built as the old model's columns.

interface Recorded {
  tables: Map<string, { count: number; fields: Record<string, unknown> }>;
  frames: { at: number; table: string; fields: Record<string, Float32Array> }[];
}

function record(write: Write): Recorded {
  const recorded: Recorded = { tables: new Map(), frames: [] };
  const patch = {
    axis: () => patch,
    set(table: string, ids: number, fields: Record<string, unknown>) {
      const was = recorded.tables.get(table);
      recorded.tables.set(table, { count: ids, fields: { ...was?.fields, ...fields } });
      return patch;
    },
    append(at: number, table: string, fields: Record<string, Float32Array>) {
      recorded.frames.push({ at, table, fields });
      return patch;
    },
    forget: () => patch,
  };
  write(patch as unknown as Patch);
  return recorded;
}

interface Hints {
  /** Fields of positions on the earth. */
  geographic?: string[];
  /** Reference fields that are a diagram's ports. */
  direction?: Record<string, 'in' | 'out'>;
  /** Whether rows carry ids, as a diagram needs. */
  ids?: boolean;
}

const index = (type: string) => ({ source: 'bench', type, version: '1' });
const numeric = (values: Float32Array | Float64Array | Uint32Array) => ({
  kind: 'numeric' as const,
  offset: 0,
  length: values.length,
  values,
});

/** One frame of every sampled field, as a sample batch. */
function samples(table: string, rows: number, first: number, frames: Recorded['frames']) {
  const fields = Object.keys(frames[0]!.fields);
  const columns = Object.fromEntries(
    fields.map((name) => {
      const values = new Float32Array(rows * frames.length);
      frames.forEach((f, i) => values.set(f.fields[name]!, i * rows));
      return [name, { ...numeric(values), rowStride: 1, frameStride: rows }];
    }),
  );
  return {
    kind: 'samples' as const,
    index: index(table),
    rows: { kind: 'range' as const, offset: 0, count: rows },
    firstFrame: first,
    coordinates: Float64Array.from(frames, (f) => f.at),
    columns,
  };
}

/** The schema and batches of what `write` writes. */
function prepare(write: Write, hints: Hints = {}) {
  const recorded = record(write);
  const types: Record<string, { fields: Record<string, object> }> = {};
  const batches: object[] = [];
  for (const [table, { count, fields }] of recorded.tables) {
    const defs: Record<string, object> = {};
    const columns: Record<string, object> = {};
    for (const [name, values] of Object.entries(fields)) {
      if (values && typeof values === 'object' && 'reference' in values) {
        const { reference, ids } = values as { reference: string; ids: unknown };
        const rows =
          typeof ids === 'number'
            ? Array.from({ length: ids }, (_, i) => i)
            : (ids as ArrayLike<number | null>);
        const array = new Uint32Array(count);
        const validity = new Uint8Array(Math.ceil(count / 8));
        let nullable = false;
        for (let i = 0; i < count; i++) {
          const id = rows[i];
          if (id === null || id === undefined) nullable = true;
          else {
            array[i] = id;
            validity[i >>> 3]! |= 1 << (i & 7);
          }
        }
        const direction = hints.direction?.[name];
        defs[name] = {
          type: { kind: 'reference', to: reference },
          ...(nullable || direction ? { nullable: true } : {}),
          ...(direction ? { direction } : {}),
        };
        columns[name] = {
          kind: 'reference',
          index: index(reference),
          offset: 0,
          length: count,
          values: array,
          ...(nullable ? { validity } : {}),
        };
      } else if (values instanceof Float64Array || values instanceof Float32Array) {
        const geographic = hints.geographic?.includes(name);
        defs[name] = {
          type: values instanceof Float64Array ? 'float64' : 'float32',
          ...(geographic ? { geographic: true } : {}),
        };
        columns[name] = numeric(values);
      } else if (Array.isArray(values) && typeof values[0] === 'string') {
        defs[name] = { type: 'text' };
        columns[name] = textColumn(values as string[]);
      }
    }
    const sampled = recorded.frames.find((f) => f.table === table);
    for (const name of Object.keys(sampled?.fields ?? {}))
      defs[name] = { type: 'float32', sampled: true };
    types[table] = { fields: defs };
    batches.push({
      kind: 'rows',
      index: index(table),
      rows: { kind: 'range', offset: 0, count },
      columns,
      ...(hints.ids
        ? { ids: textColumn(Array.from({ length: count }, (_, i) => `${table}${i}`)) }
        : {}),
    });
    const frames = recorded.frames.filter((f) => f.table === table);
    if (frames.length) batches.push(samples(table, count, 0, frames));
  }
  const schema = {
    ...(recorded.frames.length ? { axis: { name: 'time', unit: 's' } } : {}),
    types,
  };
  const at = recorded.frames.map((f) => f.at);
  const span: [number, number] | undefined = at.length ? [at[0]!, at.at(-1)!] : undefined;
  return { schema, batches, span };
}

// Views and the one way they are measured.

interface OldCamera {
  center: [number, number];
  scale: number;
  pitch?: number;
  bearing?: number;
}

interface OldView {
  set(patch: object): void;
  stats(): { frames: number; prepareMs?: number; refining?: boolean };
  pick(point: [number, number], options?: { radiusPx?: number }): Promise<unknown>;
  readonly camera: OldCamera;
  destroy(): void;
}

class Sampler {
  measuring = false;
  drew = performance.now();
  frames = 0;
  gap = 0;
  readonly cpu: number[] = [];
  readonly stage: OldStage;
  #drawn = -1;
  #last = performance.now();
  #running = true;

  constructor(stage: OldStage) {
    this.stage = stage;
    this.#drawn = stage.view?.stats().frames ?? -1;
    requestAnimationFrame(this.#tick);
  }

  stop(): void {
    this.#running = false;
  }

  #tick = (now: number): void => {
    if (!this.#running) return;
    this.gap = Math.max(this.gap, now - this.#last);
    this.#last = now;
    const stats = this.stage.view?.stats();
    if (stats && stats.frames !== this.#drawn) {
      this.#drawn = stats.frames;
      this.frames++;
      this.drew = now;
      if (this.measuring) this.cpu.push(stats.prepareMs ?? 0);
    }
    requestAnimationFrame(this.#tick);
  };
}

class OldStage {
  readonly gpu: Gpu;
  readonly canvas: HTMLCanvasElement;
  readonly size: number;
  view?: OldView;
  data!: Data;
  span: [number, number] = [0, 1];

  constructor(gpu: Gpu, canvas: HTMLCanvasElement, size: number) {
    [this.gpu, this.canvas, this.size] = [gpu, canvas, size];
  }

  get middle(): [number, number] {
    return [this.canvas.clientWidth / 2, this.canvas.clientHeight / 2];
  }

  once(act: () => unknown): Promise<Cost> {
    return this.#phase(false, async (s) => {
      s.measuring = true;
      await act();
    });
  }

  steady(count: number, act: (i: number) => unknown): Promise<Cost> {
    return this.#phase(true, async (s) => {
      for (let i = 0; i < count; i++) {
        s.measuring = i >= WARM;
        await act(i);
        await frame();
      }
      s.measuring = false;
    });
  }

  async idle(): Promise<number> {
    const sampler = new Sampler(this);
    try {
      await this.#settled(sampler);
      const before = sampler.frames;
      await wait(500);
      return sampler.frames - before;
    } finally {
      sampler.stop();
    }
  }

  async #phase(steady: boolean, drive: (s: Sampler) => Promise<void>): Promise<Cost> {
    const sampler = new Sampler(this);
    const begun = performance.now();
    try {
      await deadline(drive(sampler), LIMIT, 'the action');
      const acted = performance.now();
      await this.#settled(sampler);
      return {
        ms: Math.max(acted, sampler.drew) - begun,
        frames: sampler.frames,
        cpu: quantile(sampler.cpu, 0.5),
        cpu95: quantile(sampler.cpu, 0.95),
        gpu: 0,
        gap: sampler.gap,
        work: NONE,
        resident: 0,
        steady,
      };
    } finally {
      sampler.stop();
    }
  }

  /** Waits until no frame drew for `STILL` ms, nothing refines, and the GPU finished what it was given. */
  async #settled(sampler: Sampler): Promise<void> {
    const until = performance.now() + LIMIT;
    while (performance.now() - sampler.drew < STILL || this.view?.stats().refining) {
      if (this.gpu.signal.aborted) throw new Error('the GPU device was lost');
      if (performance.now() > until) throw new Error(`not settled within ${LIMIT} ms`);
      await wait(20);
    }
    await deadline(this.gpu.idle(), LIMIT, 'the GPU finishing its work');
  }
}

// Phases, as the new page's, in the old API.

interface OldPhase {
  name: string;
  order: Order;
  run(s: OldStage): Promise<Cost>;
}

const pan: OldPhase = {
  name: 'pan',
  order: { time: 0 },
  run: (s) => {
    const start = s.view!.camera;
    const reach = 200 / start.scale;
    return s.steady(FRAMES, (i) => {
      const t = (2 * Math.PI * i) / FRAMES;
      s.view!.set({
        camera: {
          center: [
            start.center[0] + reach * Math.sin(t),
            start.center[1] + 0.5 * reach * Math.sin(2 * t),
          ],
          scale: start.scale * 2 ** (0.3 * Math.sin(2 * t)),
        },
      });
    });
  },
};

const zoom: OldPhase = {
  name: 'zoom',
  order: { time: 0 },
  run: (s) => {
    const start = s.view!.camera;
    return s.steady(FRAMES, (i) => {
      s.view!.set({ camera: { scale: start.scale * 2 ** (2 * Math.sin((Math.PI * i) / FRAMES)) } });
    });
  },
};

const pick: OldPhase = {
  name: 'pick',
  order: { time: 0, bytes: 0 },
  run: (s) => s.once(() => s.view!.pick(s.middle, { radiusPx: 6 })),
};

const stream: OldPhase = {
  name: 'stream',
  order: { time: 1, bytes: 1 },
  run: (s) => {
    const feed = make.feed(s.size, HISTORY, FRAMES, HISTORY).map((write, i) => {
      const recorded = record(write);
      return samples('Signal', s.size, HISTORY + i, recorded.frames);
    });
    return s.steady(FRAMES, (i) => {
      s.data = appendData(s.data, [feed[i]!] as never);
      s.view!.set({ source: s.data });
    });
  },
};

const scrub: OldPhase = {
  name: 'scrub',
  order: { time: 0, bytes: 0 },
  run: (s) => {
    const [a, b] = s.span;
    return s.steady(FRAMES, (i) => s.view!.set({ at: a + ((b - a) * i) / FRAMES }));
  },
};

const narrow: OldPhase = {
  name: 'narrow',
  order: { time: 0, bytes: 0 },
  run: (s) => {
    const [a, b] = s.span;
    return s.steady(FRAMES, (i) =>
      s.view!.set({ camera: { x: [a + ((b - a) * 0.9 * i) / FRAMES, b] } }),
    );
  },
};

// Scenarios: the ones the old packages draw.

interface OldScenario {
  about: string;
  unit: string;
  sizes: readonly number[];
  data(size: number): Write;
  hints?: Hints;
  open(gpu: Gpu, canvas: HTMLCanvasElement, data: Data, span: [number, number]): OldView;
  phases: OldPhase[];
}

const monitor = (gpu: Gpu, canvas: HTMLCanvasElement, data: Data, span: [number, number]) =>
  createMonitor(gpu, {
    canvas,
    source: data,
    traces: { v: { from: 'Signal', y: 'v' } },
    camera: { x: span },
  } as never) as unknown as OldView;

const scenarios: Record<string, OldScenario> = {
  points: {
    about: 'vertices on a plane, colored through a colormap',
    unit: 'rows',
    sizes: DECADES,
    data: (n) => make.scatter(n),
    open: (gpu, canvas, data) =>
      createNetwork(gpu, {
        canvas,
        source: data,
        vertices: {
          Point: { x: 'x', y: 'y', color: { field: 'v', domain: [0, 1], colormap: 'viridis' } },
        },
        camera: { projection: 'flat', fit: true },
      } as never) as unknown as OldView,
    phases: [pan, zoom, pick],
  },
  grid: {
    about: 'a lattice grid on the globe: buses, and the geodesic lines between them',
    unit: 'buses',
    sizes: DECADES,
    data: (n) => make.lattice(n),
    hints: { geographic: ['lon', 'lat'] },
    open: (gpu, canvas, data) =>
      createNetwork(gpu, {
        canvas,
        source: data,
        vertices: {
          Bus: {
            x: 'lon',
            y: 'lat',
            color: { field: 'load', domain: [0, 1], colormap: 'viridis' },
          },
        },
        edges: { Line: { ends: ['from', 'to'], widthPx: 0.6 } },
        camera: { projection: 'globe', fit: true },
      } as never) as unknown as OldView,
    phases: [pan, zoom, pick],
  },
  diagram: {
    about: 'blocks with ports in trees of 64, laid out in layers, wires routed around them',
    unit: 'blocks',
    sizes: [1e2, 1e3, 1e4],
    data: (n) => make.blocks(n),
    hints: { ids: true, direction: { in: 'in', out: 'out' } },
    open: (gpu, canvas, data) =>
      createDiagram(gpu, {
        canvas,
        source: data,
        vertices: { Block: { labels: { field: 'name' } } },
        edges: { Net: { route: 'orthogonal' } },
        layout: { algorithm: 'layered' },
      } as never) as unknown as OldView,
    phases: [pan],
  },
  traces: {
    about: 'a plot of traces 1,024 frames long, fed a frame every animation frame',
    unit: 'traces',
    sizes: [10, 1e2, 1e3, 1e4],
    data: (n) => make.traces(n, HISTORY),
    open: monitor,
    phases: [stream, scrub, narrow],
  },
  history: {
    about: 'one trace with a long history: levels of detail',
    unit: 'frames',
    sizes: [1e3, 1e4, 1e5, 1e6],
    data: (n) => make.traces(1, n),
    open: monitor,
    phases: [scrub, narrow],
  },
};

function list(): Listed[] {
  return Object.entries(scenarios).map(([name, s]) => ({
    name,
    about: s.about,
    unit: s.unit,
    sizes: s.sizes,
    cold: false,
    orders: {
      init: { time: 0 },
      data: { time: 1 },
      load: { time: 1 },
      ...Object.fromEntries(s.phases.map((p) => [p.name, p.order])),
    },
  }));
}

/** The old GPU as the runs make it: on the adapter latkit asks for, so the two compare. */
const OPTIONS = {
  powerPreference: 'high-performance',
  budget: { cpuBytes: 1024 * 2 ** 20, gpuBytes: 1024 * 2 ** 20 },
} as const;

/** The GPU of the run under way, which `lost` asks after. */
let current: Gpu | undefined;

/** Resolves once a GPU device can be made: a wedged driver hangs here, so the runner asks first. */
async function ready(): Promise<void> {
  (await createGpu(OPTIONS)).destroy();
}

/** Whether the run's device was lost: its GPU's signal aborts then. */
function lost(): boolean {
  return current?.signal.aborted ?? false;
}

/** Says that `phase` starts, so the runner names where a page stopped answering. */
const announce = (phase: string) => console.debug(`phase ${phase}`);

async function run(name: string, size: number): Promise<Run> {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`no scenario ${name}`);
  announce('init');
  const begun = performance.now();
  const gpu = (current = await createGpu(OPTIONS));
  const init = performance.now() - begun;
  const { schema, batches, span } = prepare(scenario.data(size), scenario.hints);
  const canvas = document.querySelector('main')!.appendChild(document.createElement('canvas'));
  await frame();
  const stage = new OldStage(gpu, canvas, size);
  stage.span = span ?? [0, 1];
  const none = { frames: 0, cpu: 0, cpu95: 0, gpu: 0, gap: 0, resident: 0, steady: false };
  const errors: string[] = [];
  const phases: Record<string, Cost> = { init: { ...none, ms: init, work: NONE } };
  announce('data');
  phases.data = await stage.once(() => {
    stage.data = createData(schema as never, batches as never);
  });
  announce('load');
  phases.load = await stage.once(() => {
    stage.view = scenario.open(gpu, canvas, stage.data, stage.span);
    (stage.view as unknown as { on(type: string, f: (e: Error) => void): void }).on('error', (e) =>
      errors.push(e.message),
    );
  });
  for (const phase of scenario.phases) {
    announce(phase.name);
    phases[phase.name] = await phase.run(stage);
  }
  announce('idle');
  const idle = await stage.idle();
  return {
    scenario: name,
    size,
    machine: await machine(),
    phases,
    idle,
    budget: Number.MAX_SAFE_INTEGER,
    errors,
  };
}

/** The adapter, asked for as the old GPU asks for its own, and the browser. */
async function machine(): Promise<string> {
  interface Adapter {
    info?: { vendor?: string; architecture?: string; description?: string };
  }
  interface Options {
    powerPreference: typeof OPTIONS.powerPreference;
  }
  const gpu = (navigator as { gpu?: { requestAdapter(o: Options): Promise<Adapter | null> } }).gpu;
  const info = (await gpu?.requestAdapter({ powerPreference: OPTIONS.powerPreference }))?.info;
  const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1];
  const adapter = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ');
  return `${adapter || 'unknown adapter'} · Chrome ${chrome}`;
}

window.bench = { ready, list, run, lost };
