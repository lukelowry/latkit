/**
 * The bench page, one implementation of the contract the runner drives: `bench.ready()` resolves
 * once a GPU device can be made; `bench.list()` names the scenarios and the orders their phases
 * keep; `bench.run(name, size)` builds one at a size on a fresh GPU and measures it; `bench.lost()`
 * says whether that GPU's device was lost. The runner opens a fresh page for every run, so nothing
 * carries over but the browser's shader cache.
 */
import { loadLatkit, type Gpu } from 'latkit';
import { LOAD, scenarios, type Order } from './scenarios.ts';
import { Stage, type Cost } from './stage.ts';

export interface Listed {
  name: string;
  about: string;
  unit: string;
  sizes: readonly number[];
  cold: boolean;
  orders: Record<string, Order>;
}

export interface Run {
  scenario: string;
  size: number;
  /** The adapter and browser: times compare only on the same machine. */
  machine: string;
  /** Every phase in order: `init`, `data`, `load`, then the scenario's. */
  phases: Record<string, Cost>;
  /** Frames drawn in half a second once everything settled. */
  idle: number;
  /** Bytes the budget lets data take. */
  budget: number;
  /** What the views told went wrong. */
  errors: string[];
}

/** What data may take unless a scenario sets it: fixed, so the work counted is every device's. */
const BUDGET = { bytes: 256 * 2 ** 20, uploadPerFrame: 32 * 2 ** 20 };

/** The GPU of the run under way, which `lost` asks after. */
let current: Gpu | undefined;

/** Resolves once a GPU device can be made: a wedged driver hangs here, so the runner asks first. */
async function ready(): Promise<void> {
  (await (await loadLatkit()).Gpu.create()).destroy();
}

/** Whether the run's device was lost: the runner asks after a failure, and stops the sweep if so. */
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
  const latkit = await loadLatkit();
  const gpu = (current = await latkit.Gpu.create());
  const ms = performance.now() - begun;
  gpu.budget = scenario.budget ?? BUDGET;
  const built = scenario.build(size);
  const stage = new Stage(latkit, gpu, await canvases(scenario.views?.(size) ?? 1), size);
  const none = { frames: 0, cpu: 0, cpu95: 0, gpu: 0, gap: 0, resident: 0, steady: false };
  // Each phase says when it starts, so a page that stops answering is known by where it stopped.
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

/** `n` canvases filling the page in a grid, laid out before any view draws. */
async function canvases(n: number): Promise<HTMLCanvasElement[]> {
  const main = document.querySelector('main')!;
  main.style.gridTemplateColumns = `repeat(${Math.ceil(Math.sqrt(n))}, minmax(0, 1fr))`;
  const made = Array.from({ length: n }, () => main.appendChild(document.createElement('canvas')));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return made;
}

/** The adapter, asked for as latkit asks for its own, and the browser. */
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
