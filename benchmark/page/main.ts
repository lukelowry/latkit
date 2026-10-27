/**
 * The bench page. It implements the interface the runner drives:
 *
 * - `bench.ready()` resolves once a GPU device can be made.
 * - `bench.list()` lists the scenarios and the growth orders of their phases.
 * - `bench.run(name, size)` builds a scenario at a size on a fresh GPU and measures it.
 * - `bench.lost()` returns whether that GPU's device was lost.
 *
 * The runner opens a fresh page for every run, so only the browser's shader cache carries over.
 */
import { Gpu } from 'latkit';
import { LOAD, scenarios, type Order } from './scenarios.ts';
import { Stage, type Cost } from './stage.ts';

export interface Listed {
  name: string;
  about: string;
  unit: string;
  sizes: readonly number[];
  cold: boolean;
  fetches: boolean;
  orders: Record<string, Order>;
}

export interface Run {
  scenario: string;
  size: number;
  /** The adapter and browser. Times compare only on the same machine. */
  machine: string;
  /** Every phase in order: `init`, `data`, `load`, then the scenario's. */
  phases: Record<string, Cost>;
  /** Frames drawn in the idle frames stepped after everything settled. Views that sleep draw
   * none. */
  idle: number;
  /** The data budget, in bytes. */
  budget: number;
  /** Errors the views reported. */
  errors: string[];
}

/** The GPU budget unless a scenario sets one. It is fixed, not the device's default, so the work
 * counted is the same on every device. */
const BUDGET = { bytes: 256 * 2 ** 20, uploadPerFrame: 32 * 2 ** 20 };

/** The GPU of the current run, which `lost` checks. */
let current: Gpu | undefined;

/** Resolves once a GPU device can be made. A wedged driver hangs here, so the runner calls this
 * first. */
async function ready(): Promise<void> {
  (await Gpu.create()).destroy();
}

/** Whether the run's device was lost. The runner checks after a failure, and stops the sweep if
 * so. */
function lost(): boolean {
  return current?.lost ?? false;
}

function list(): Listed[] {
  return Object.entries(scenarios).map(([name, s]) => ({
    name,
    about: s.about,
    unit: s.unit,
    sizes: s.sizes,
    cold: !!s.cold,
    fetches: !!s.fetches,
    orders: {
      init: { time: 0 },
      data: { time: 1 },
      load: s.load ?? LOAD,
      ...Object.fromEntries(s.phases.map((p) => [p.name, p.order])),
    },
  }));
}

async function run(name: string, size: number): Promise<Run> {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`no scenario ${name}`);
  console.debug('phase init');
  const begun = performance.now();
  const gpu = (current = await Gpu.create());
  const ms = performance.now() - begun;
  gpu.budget = scenario.budget ?? BUDGET;
  const built = scenario.build(size);
  const stage = new Stage(gpu, await canvases(scenario.views?.(size) ?? 1), size);
  const none = { frames: 0, cpu: 0, cpu95: 0, gpu: 0, resident: 0, steady: false };
  // Each phase announces its start, so a page that stops responding shows where it stopped.
  const named = <T>(phase: string, run: () => Promise<T>) => {
    console.debug(`phase ${phase}`);
    return run().catch((error: unknown) => {
      throw new Error(`${phase}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const phases: Record<string, Cost> = {
    init: { ...none, ms, work: gpu.work },
    data: await named('data', () => stage.ingest(built.data)),
    load: await named('load', () => stage.load(built.scene, built.tiles, built.camera)),
  };
  for (const phase of scenario.phases)
    phases[phase.name] = await named(phase.name, () => phase.run(stage));
  const idle = await named('idle', () => stage.idle());
  return {
    scenario: name,
    size,
    machine: await machine(),
    phases,
    idle,
    budget: gpu.budget.bytes,
    errors: stage.errors,
  };
}

/** Adds `n` canvases filling the page in a grid, and waits a frame so they are laid out before any
 * view draws. */
async function canvases(n: number): Promise<HTMLCanvasElement[]> {
  const main = document.querySelector('main')!;
  main.style.gridTemplateColumns = `repeat(${Math.ceil(Math.sqrt(n))}, minmax(0, 1fr))`;
  const made = Array.from({ length: n }, () => main.appendChild(document.createElement('canvas')));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return made;
}

/** Describes the adapter, requested with the options latkit uses, and the Chrome version. */
async function machine(): Promise<string> {
  interface Adapter {
    info?: { vendor?: string; architecture?: string; description?: string };
  }
  interface Options {
    powerPreference: 'high-performance';
  }
  const gpu = (navigator as { gpu?: { requestAdapter(o: Options): Promise<Adapter | null> } }).gpu;
  const info = (await gpu?.requestAdapter({ powerPreference: 'high-performance' }))?.info;
  const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1];
  const adapter = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ');
  return `${adapter || 'unknown adapter'} · Chrome ${chrome}`;
}

declare global {
  interface Window {
    bench: { ready: typeof ready; list: typeof list; run: typeof run; lost: typeof lost };
  }
}
window.bench = { ready, list, run, lost };
