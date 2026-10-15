/**
 * The quick benchmark. Loads the network page's grids in Chrome, from 240 buses to two million, and
 * holds each to its budget:
 *
 * - load: milliseconds from choosing the grid to its first frame drawing it, every row it draws on
 *   the GPU: a large grid's first look, an even sample of its rows, while its tiles are placed;
 * - hitch: the longest a frame took to record while it loaded;
 * - GPU and CPU: milliseconds per frame while the camera pans and zooms, the median of a second of
 *   frames, read from the view's own stats;
 * - idle: frames drawn in half a second once the camera stopped and the view settled, which should
 *   be none.
 *
 * Frames run uncapped, so the GPU keeps its full clock and its time measures work, not waiting. The
 * budgets are a laptop's integrated GPU's. It takes about half a minute.
 *
 * `node gate/bench.ts`; `cargo xtask bench` runs it over a release build. Every wait races a deadline.
 */

import path from 'node:path';
import type { Page } from 'playwright-core';
import { createServer } from 'vite';
import { STEP, deadline, launch } from './browser.ts';

/** A grid of the network page, by the start of its name, and its budgets. */
interface Budget {
  grid: string;
  load: number;
  hitch: number;
  gpu: number;
  cpu: number;
}

// About twice what each measures today. On the same machine the TypeScript implementation took
// 0.9–1.5 s to draw the first three, and 2.6–9 ms of GPU a frame at a million buses; drawing every
// row whole took 3.2 ms at one and two million. A grid denser than a screen draws the tiles in view.
// The page opens on the first grid, so the second is measured first: each measured grid replaces one.
const BUDGETS: Budget[] = [
  { grid: 'ACTIVSg70k', load: 250, hitch: 15, gpu: 1.4, cpu: 0.3 },
  { grid: 'WECC 240-bus', load: 60, hitch: 10, gpu: 0.8, cpu: 0.3 },
  { grid: 'Lattice, 1,000,000', load: 250, hitch: 100, gpu: 1.4, cpu: 0.3 },
  { grid: 'North America, 2,000,000', load: 1300, hitch: 110, gpu: 1.2, cpu: 0.3 },
];
/** Frames a view may draw once nothing moves: none. */
const IDLE = 0;

/** What one grid measured. */
interface Measured {
  load: number;
  hitch: number;
  gpu: number;
  cpu: number;
  idle: number;
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const examples = path.dirname(here);

/** In the page: chooses grid `label` and measures it. */
async function measure(label: string): Promise<Measured> {
  interface Stats {
    frames: number;
    rows: number;
    drawn: number;
    uploading: number;
    complete: boolean;
    cpuMs: number;
    gpuMs: number;
  }
  interface View {
    stats: Stats;
    camera: { center: number[]; zoom: number; pitch: number; bearing: number };
  }
  const view = (window as unknown as { stage: { views: View[] } }).stage.views[0]!;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  /** Waits until a frame drew everything and no frame has drawn for 300 ms, or `limit` ms went by. */
  const settled = async (limit: number) => {
    const until = performance.now() + limit;
    let frames = view.stats.frames;
    let still = performance.now();
    while (performance.now() < until && (!view.stats.complete || performance.now() - still < 300)) {
      await wait(50);
      if (view.stats.frames !== frames) [frames, still] = [view.stats.frames, performance.now()];
    }
  };
  const detail = () => document.querySelector('.detail')?.textContent ?? '';
  const select = [...document.querySelectorAll('label.field')]
    .find((l) => l.querySelector('span')?.textContent === 'Grid')!
    .querySelector('select')!;
  // What loads beside the grid, as the map does, lands first.
  await settled(20000);
  // Load: until the page says the grid is in and a frame drew it, every row it draws uploaded.
  const rows = view.stats.rows;
  const began = performance.now();
  select.selectedIndex = [...select.options].findIndex((o) => o.textContent!.startsWith(label));
  select.dispatchEvent(new Event('change'));
  let hitch = 0;
  for (let i = 0; i < 2000; i++) {
    await frame();
    hitch = Math.max(hitch, view.stats.cpuMs);
    const loaded = detail().startsWith(label) && !detail().includes('loading');
    const s = view.stats;
    const drawn = s.rows !== rows && s.drawn > 0 && s.uploading === 0;
    if (loaded && drawn) break;
  }
  const load = performance.now() - began;
  // What lands off the frame lands: lanes, segment counts, the tiles in view.
  await settled(5000);
  // A second of panning and zooming about where the page framed the grid.
  const start = view.camera;
  const gpu: number[] = [];
  const cpu: number[] = [];
  const moving = performance.now();
  for (let i = 0; performance.now() - moving < 1000; i++) {
    const t = (performance.now() - moving) / 1000;
    const span = 0.2 * 2 ** -start.zoom * 360;
    view.camera = {
      ...start,
      center: [
        start.center[0]! + span * Math.sin(t * 3),
        start.center[1]! + span * 0.5 * Math.cos(t * 3),
      ],
      zoom: start.zoom + 0.3 * Math.sin(t * 2),
    };
    await frame();
    if (i > 10) {
      gpu.push(view.stats.gpuMs);
      cpu.push(view.stats.cpuMs);
    }
  }
  view.camera = start;
  // Readbacks under way land; uncapped frames starve them, so this waits longer than a page would.
  await settled(3000);
  const before = view.stats.frames;
  await wait(500);
  return { load, hitch, gpu: median(gpu), cpu: median(cpu), idle: view.stats.frames - before };
}

/** Opens the network page in `url` and measures every grid; returns the failures. */
async function bench(url: string): Promise<string[]> {
  // Uncapped frames keep the GPU at its full clock; developer features time it to the nanosecond.
  const browser = await launch([
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    '--enable-webgpu-developer-features',
  ]);
  const failures: string[] = [];
  try {
    const page: Page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 2,
    });
    page.on('pageerror', (error) => failures.push(`page: ${error.message.slice(0, 300)}`));
    page.on(
      'console',
      (m) => m.type() === 'error' && failures.push(`console: ${m.text().slice(0, 300)}`),
    );
    await deadline(page.goto(`${url}#network`), STEP, 'open the network page');
    const ready = () =>
      !!(window as unknown as { stage?: { views: { stats: { frames: number } }[] } }).stage
        ?.views[0]?.stats.frames;
    await deadline(
      page.waitForFunction(ready, undefined, { timeout: STEP }),
      STEP + 1000,
      'a first frame',
    );
    console.log(
      'grid                         load ms      hitch ms    GPU ms      CPU ms      idle',
    );
    for (const budget of BUDGETS) {
      const got = await deadline(
        page.evaluate(measure, budget.grid),
        STEP,
        `measure ${budget.grid}`,
      );
      const cell = (value: number, limit: number, digits: number) =>
        `${value.toFixed(digits).padStart(6)}/${String(limit).padEnd(5)}`;
      console.log(
        `${budget.grid.padEnd(28)} ${cell(got.load, budget.load, 0)} ${cell(got.hitch, budget.hitch, 0)} ` +
          `${cell(got.gpu, budget.gpu, 2)} ${cell(got.cpu, budget.cpu, 2)} ${got.idle}`,
      );
      const over = (what: string, value: number, limit: number) =>
        value > limit ? [`${budget.grid}: ${what} ${value.toFixed(2)}, over ${limit}`] : [];
      failures.push(
        ...over('load ms', got.load, budget.load),
        ...over('hitch ms', got.hitch, budget.hitch),
        ...over('GPU ms', got.gpu, budget.gpu),
        ...over('CPU ms', got.cpu, budget.cpu),
        ...over('idle frames', got.idle, IDLE),
      );
    }
  } finally {
    await browser.close();
  }
  return failures;
}

const server = await createServer({
  root: examples,
  configFile: path.join(examples, 'vite.config.ts'),
  server: { port: 5220, strictPort: false },
  logLevel: 'error',
});
await deadline(server.listen(), STEP, 'serve the suite');
let failures: string[];
try {
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('the suite has no address');
  failures = await bench(url);
} finally {
  await server.close();
}
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
