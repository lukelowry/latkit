/**
 * The browser gate. Times every shader variant's pipelines in Chrome against a budget, then opens
 * every page of the suite in a fresh browser and moves the pointer over it. It fails on a pipeline
 * over budget or failing to compile, a console error, a page that draws no frame in time, a page
 * missing frames in a row while it opens or under the pointer, or a pipeline compiled where first
 * used. Every wait races a deadline.
 *
 * On SwiftShader (`--software`, as Linux always is), the CPU draws, slower than any budget, so the
 * gate only checks that every pipeline compiles: pages and times are judged on a GPU.
 *
 * `node gate/gate.ts <dir holding shaders.json> [--software] [page...]`; `cargo xtask browser` runs
 * it. Naming pages visits only those, without timing the shaders. Chrome is `$LATKIT_CHROME`, or the
 * newest Chromium Playwright installed.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { createServer } from 'vite';
import { STEP, deadline, launch, type Chrome } from './browser.ts';

/** Milliseconds Chrome may take to compile any one pipeline, cold: the slowest takes about 0.35 s,
 * and a view opens no sooner than the slowest it uses, the rest compiling beside it. */
const COMPILE_BUDGET = 800;
/** Milliseconds from opening a page, cold, to its views' first frames, which draw everything their
 * scenes use: every pipeline compiles side by side, off Chrome's GPU thread. */
const FIRST_FRAME_BUDGET = 1000;
/** Display frames in a row a page may miss while it opens or the pointer moves over it. Frames come
 * at the display's pace, which the machine sets: 60 Hz on a panel, 32 Hz over Remote Desktop, whose
 * vblanks slip one at a time. Nothing compiles on Chrome's GPU thread, so no frame waits on latkit;
 * what it compiles where first used is counted apart, as `work.late`. */
const MISSED = 1;
/** Milliseconds between display frames past which the gate tells what the views were doing. */
const LONG = 50;

/** A gap between display frames past `LONG`: how long, each view's last frame on the CPU and the
 * GPU and what it waited on, and the work the GPU did since the frame before. */
interface Long {
  gap: number;
  cpuMs: number[];
  gpuMs: number[];
  waiting: string[][];
  work: Record<string, number>;
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const examples = path.dirname(here);
const args = process.argv.slice(2);
const software = args.includes('--software') || process.platform === 'linux';

/** A variant of shaders.json: its file, whether it draws, its compute entries, and its constants. */
interface Variant {
  file: string;
  draws: boolean;
  compute: string[];
  constants: Record<string, number>[];
  append: string;
}

/** One pipeline to time in the page. */
interface Pipeline {
  label: string;
  code: string;
  draws: boolean;
  entry: string;
  constants: Record<string, number>;
}

interface Timing {
  label: string;
  ms: number;
  error?: string;
}

/** Chrome compiling cold on every launch, as a first visit does. */
function cold(): Promise<Chrome> {
  return launch(['--disable-gpu-shader-disk-cache'], software);
}

/** Every pipeline the variants in `dir` make: each compute entry, or the draw, per constants. */
function pipelines(dir: string): Pipeline[] {
  const variants = JSON.parse(fs.readFileSync(path.join(dir, 'shaders.json'), 'utf8')) as Variant[];
  return variants.flatMap((variant) => {
    const code = `${fs.readFileSync(path.join(dir, variant.file), 'utf8')}\n${variant.append}`;
    const name = variant.file.replace(/\.wgsl$/, '');
    const entries = variant.draws ? ['vertex'] : variant.compute;
    return variant.constants.flatMap((constants) => {
      const set = Object.entries(constants).map(([k, v]) => `${k}=${v}`);
      return entries.map((entry) => ({
        label: [name, variant.draws ? '' : entry, ...set].filter(Boolean).join(' '),
        code,
        draws: variant.draws,
        entry,
        constants,
      }));
    });
  });
}

/** In the page: makes each pipeline cold, one at a time, and times it. Runs from its source alone. */
async function time({
  pipelines,
  step,
}: {
  pipelines: Pipeline[];
  step: number;
}): Promise<Timing[]> {
  interface Device {
    createShaderModule(descriptor: { code: string }): unknown;
    createComputePipelineAsync(descriptor: unknown): Promise<unknown>;
    createRenderPipelineAsync(descriptor: unknown): Promise<unknown>;
  }
  interface Adapter {
    limits: Record<string, number>;
    requestDevice(descriptor: unknown): Promise<Device>;
  }
  const gpu = (
    navigator as unknown as { gpu: { requestAdapter(o: unknown): Promise<Adapter | null> } }
  ).gpu;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const limits = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      maxBufferSize: limits.maxBufferSize,
      maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
    },
  });
  const timings: Timing[] = [];
  const modules = new Map<string, unknown>();
  for (const pipeline of pipelines) {
    let module = modules.get(pipeline.code);
    if (!module)
      modules.set(pipeline.code, (module = device.createShaderModule({ code: pipeline.code })));
    const constants = pipeline.constants;
    // Draws test against depth, as latkit's do; the backdrop writes it.
    const made = pipeline.draws
      ? device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex', constants },
          fragment: {
            module,
            entryPoint: 'fragment',
            constants,
            targets: [{ format: 'rgba8unorm' }],
          },
          primitive: { topology: 'triangle-list' },
          depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'greater-equal',
          },
        })
      : device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: pipeline.entry, constants },
        });
    const started = performance.now();
    try {
      await Promise.race([
        made,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`no pipeline after ${step} ms`)), step),
        ),
      ]);
      timings.push({ label: pipeline.label, ms: performance.now() - started });
    } catch (error) {
      timings.push({
        label: pipeline.label,
        ms: performance.now() - started,
        error: String(error).slice(0, 300),
      });
    }
  }
  return timings;
}

/** Times every pipeline against the budget; returns the failures. */
async function compileBudget(dir: string): Promise<string[]> {
  const blank = http.createServer((_, response) =>
    response.end('<!doctype html><title>gate</title>'),
  );
  await new Promise<void>((resolve) => blank.listen(0, '127.0.0.1', resolve));
  const { port } = blank.address() as { port: number };
  const chrome = await cold();
  try {
    const page = await chrome.browser.newPage();
    await deadline(page.goto(`http://127.0.0.1:${port}/`), STEP, 'open a blank page');
    const all = pipelines(dir);
    // Each pipeline races its own deadline in the page.
    const timed = page.evaluate(time, { pipelines: all, step: STEP });
    const timings = await deadline(timed, (all.length + 1) * STEP, 'time pipelines');
    timings.sort((a, b) => b.ms - a.ms);
    const total = timings.reduce((sum, t) => sum + t.ms, 0);
    console.log(`shaders: ${timings.length} pipelines in ${(total / 1000).toFixed(1)} s; slowest:`);
    for (const t of timings.slice(0, 8))
      console.log(`  ${t.ms.toFixed(0).padStart(6)} ms  ${t.label}`);
    return timings.flatMap((t) =>
      t.error
        ? [`${t.label}: ${t.error}`]
        : !software && t.ms > COMPILE_BUDGET
          ? [`${t.label}: ${t.ms.toFixed(0)} ms, over ${COMPILE_BUDGET}`]
          : [],
    );
  } finally {
    await chrome.close();
    blank.close();
  }
}

/** Resolves after two animation frames. */
function frames(page: Page): Promise<void> {
  const two = page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return deadline(two, STEP, 'animation frames');
}

/** Waits, for at most `budget` ms, until every view of `page` has opened: it was complete, or it drew
 * 30 frames waiting on nothing but its fit, as a plot of streaming data measuring its value range
 * again does every frame. A view draws once every pipeline its scene uses compiled, so then nothing
 * is left to compile. */
async function settled(page: Page, budget: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        stage?: { views: { stats: { frames: number }; waiting: string[] }[] };
        opened?: Set<number>;
        refitting?: Map<number, number>;
      };
      const views = w.stage?.views ?? [];
      w.opened ??= new Set();
      w.refitting ??= new Map();
      views.forEach(({ stats: { frames }, waiting }, i) => {
        if (!waiting.length) w.opened!.add(i);
        if (waiting.join() !== 'fit') w.refitting!.delete(i);
        else if (!w.refitting!.has(i)) w.refitting!.set(i, frames);
        else if (frames - w.refitting!.get(i)! >= 30) w.opened!.add(i);
      });
      return views.length > 0 && w.opened.size === views.length;
    },
    undefined,
    { timeout: budget, polling: 50 },
  );
}

/** Opens page `id` in a fresh browser, waits for its first frames, then moves the pointer over
 * every view: hovering a grid of points, zooming, panning, and clicking. Returns the failures. */
async function visit(url: string, id: string): Promise<string[]> {
  const failures: string[] = [];
  const chrome = await cold();
  try {
    const context = await chrome.browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`console: ${message.text().slice(0, 300)}`);
    });
    page.on('pageerror', (error) => failures.push(`page: ${error.message.slice(0, 300)}`));
    // The longest gap between animation frames since the last reset, and the display's frame
    // interval: the median of the latest gaps; and each gap past `LONG`, with what the views did.
    await page.addInitScript((long: number) => {
      interface Stage {
        views: { stats: { cpuMs: number; gpuMs: number }; waiting: string[] }[];
        gpu: { work: Record<string, number> };
      }
      const w = window as unknown as {
        gap: number;
        long: Long[];
        resetGap(): void;
        interval(): number;
        stage?: Stage;
      };
      let last = 0;
      let work: Record<string, number> = {};
      const gaps: number[] = [];
      w.gap = 0;
      w.long = [];
      w.resetGap = () => {
        w.gap = 0;
        w.long = [];
        last = 0;
      };
      w.interval = () => [...gaps].sort((a, b) => a - b)[gaps.length >> 1] ?? 1000 / 60;
      const tick = (now: number) => {
        const stage = w.stage;
        const done = stage?.gpu.work ?? {};
        if (last) {
          const gap = now - last;
          w.gap = Math.max(w.gap, gap);
          gaps.push(gap);
          if (gaps.length > 120) gaps.shift();
          if (gap > long && stage) {
            const delta = Object.entries(done)
              .map(([kind, n]) => [kind, n - (work[kind] ?? 0)] as const)
              .filter(([, n]) => n > 0);
            w.long.push({
              gap,
              cpuMs: stage.views.map((view) => view.stats.cpuMs),
              gpuMs: stage.views.map((view) => view.stats.gpuMs),
              waiting: stage.views.map((view) => view.waiting),
              work: Object.fromEntries(delta),
            });
          }
        }
        work = done;
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, LONG);
    /** Tells the frames past `LONG` since the last reset, while `doing`. */
    const tell = async (doing: string) => {
      const long = await page.evaluate(() => (window as unknown as { long: Long[] }).long);
      for (const frame of long) console.log(`  ${id}: ${describe(frame)} ${doing}`);
    };
    const opened = performance.now();
    await deadline(page.goto(`${url}#${id}`), STEP, `open ${id}`);
    /** Waits until every view has drawn more than `frames` frames, for at most `budget` ms. */
    const drawn = (frames: number, budget: number) =>
      page.waitForFunction(
        (frames) => {
          const views = (
            window as unknown as { stage?: { views: { stats: { frames: number } }[] } }
          ).stage?.views;
          return !!views?.length && views.every((view) => view.stats.frames > frames);
        },
        frames,
        { timeout: budget, polling: 50 },
      );
    try {
      await deadline(
        drawn(0, FIRST_FRAME_BUDGET),
        FIRST_FRAME_BUDGET + 1000,
        `${id}'s first frame`,
      );
    } catch {
      failures.push(`no frame within ${FIRST_FRAME_BUDGET} ms`);
      return failures;
    }
    const first = performance.now() - opened;
    // What stalls while the views open, from their first frames: what the page did loading before
    // them shows nothing to stall.
    await page.evaluate(() => (window as unknown as { resetGap(): void }).resetGap());
    await deadline(settled(page, STEP), STEP + 1000, `${id}'s opening`);
    await deadline(page.waitForTimeout(500), STEP, 'settle');
    const opening = await page.evaluate(() => (window as unknown as { gap: number }).gap);
    await tell('opening');
    let longest = { gap: 0, step: '' };
    /** Does `step` and waits two frames; keeps the longest gap between frames and its step, and
     * tells each frame past `LONG`. */
    const act = async (step: string, action: () => Promise<void>) => {
      await page.evaluate(() => (window as unknown as { resetGap(): void }).resetGap());
      await deadline(action(), STEP, step);
      await frames(page);
      const gap = await page.evaluate(() => (window as unknown as { gap: number }).gap);
      if (gap > longest.gap) longest = { gap, step };
      await tell(`on ${step}`);
    };
    const canvases = await page.locator('main canvas').all();
    for (const [c, canvas] of canvases.entries()) {
      const box = await deadline(canvas.boundingBox(), STEP, 'a canvas');
      if (!box) continue;
      const at = (x: number, y: number) => [box.x + box.width * x, box.y + box.height * y] as const;
      for (let y = 1; y < 5; y++) {
        for (let x = 1; x < 7; x++) {
          await act(`hover ${x}/7, ${y}/5 of canvas ${c}`, () =>
            page.mouse.move(...at(x / 7, y / 5), { steps: 3 }),
          );
        }
      }
      const [cx, cy] = at(0.5, 0.5);
      await act(`move to the middle of canvas ${c}`, () => page.mouse.move(cx, cy));
      await act(`zoom in on canvas ${c}`, () => page.mouse.wheel(0, -240));
      await act(`zoom out on canvas ${c}`, () => page.mouse.wheel(0, 240));
      await act(`drag on canvas ${c}`, async () => {
        await page.mouse.down();
        await page.mouse.move(cx + 80, cy + 40, { steps: 6 });
        await page.mouse.up();
      });
      await act(`click canvas ${c}`, () => page.mouse.click(cx, cy));
      // The intents whose picks list what lies under a point, and the keys stepping through rows.
      await act(`menu on canvas ${c}`, () => page.mouse.click(cx, cy, { button: 'right' }));
      await act(`step with Tab on canvas ${c}`, () => page.keyboard.press('Tab'));
      await act(`step with an arrow on canvas ${c}`, () => page.keyboard.press('ArrowRight'));
      await act(`stop stepping on canvas ${c}`, () => page.keyboard.press('Escape'));
    }
    // Every page exports a picture of its views: a shot draws them and a worker writes the PNG.
    await page.locator('main canvas').first().focus();
    await deadline(page.keyboard.press('x'), STEP, 'ask for a picture');
    const saved = page.waitForFunction(
      () => document.body.textContent?.includes('Saved views.png'),
      undefined,
      {
        timeout: STEP,
        polling: 100,
      },
    );
    try {
      await deadline(saved, STEP + 1000, `${id}'s picture`);
    } catch {
      // What the views waited on, and what the page said, name why.
      const said = await page.evaluate(() => {
        const views = (window as unknown as { stage?: { views: { waiting: string[] }[] } }).stage
          ?.views;
        const waiting = (views ?? []).map((view) => view.waiting.join('+') || 'nothing');
        const status = [...document.querySelectorAll('.status, [role=status], output')]
          .map((element) => element.textContent?.trim())
          .filter(Boolean);
        return `views waiting on ${waiting.join(', ')}; the page said ${status.join(' | ') || 'nothing'}`;
      });
      failures.push(`no picture exported: ${said}`);
    }
    const { gap, step } = longest;
    const { interval, late } = await page.evaluate(() => {
      const w = window as unknown as {
        interval(): number;
        stage?: { gpu: { work: { late: number } } };
      };
      return { interval: w.interval(), late: w.stage?.gpu.work.late ?? 0 };
    });
    // A gap of n intervals missed n - 1 frames; past MISSED + 1.5 intervals, more than MISSED did.
    const budget = (MISSED + 1.5) * interval;
    console.log(
      `${id}: first frame ${first.toFixed(0)} ms, frames every ${interval.toFixed(0)} ms, longest while ` +
        `opening ${opening.toFixed(0)} ms; longest under the pointer ${gap.toFixed(0)} ms, on ${step || 'nothing'}`,
    );
    const missed = (ms: number) => Math.round(ms / interval) - 1;
    if (opening > budget)
      failures.push(`missed ${missed(opening)} frames in a row opening (${opening.toFixed(0)} ms)`);
    if (gap > budget)
      failures.push(`missed ${missed(gap)} frames in a row on ${step} (${gap.toFixed(0)} ms)`);
    if (late > 0)
      failures.push(
        `${late} pipelines compiled where first used, holding back the frames using them`,
      );
  } finally {
    await chrome.close();
  }
  return failures;
}

/** A frame past `LONG` as the gate tells it: what each view's last frame took on the CPU and the GPU
 * and waited on, and the work the GPU did, bytes in MB. */
function describe({ gap, cpuMs, gpuMs, waiting, work }: Long): string {
  const ms = (list: number[]) => list.map((n) => n.toFixed(1)).join('/');
  const waited = waiting.map((list) => list.join('+') || 'nothing').join(', ');
  const bytes = new Set(['uploaded', 'written', 'cleared']);
  const done = Object.entries(work)
    .map(([kind, n]) => `${kind} ${bytes.has(kind) ? `${(n / 1e6).toFixed(2)} MB` : n}`)
    .join(', ');
  return `frame of ${gap.toFixed(0)} ms (cpu ${ms(cpuMs)} ms, gpu ${ms(gpuMs)} ms, waiting on ${waited}; ${done || 'no work'})`;
}

/** Serves the suite and visits `only` its pages, or every page its bar lists. */
async function suite(only: string[]): Promise<string[]> {
  const server = await createServer({
    root: examples,
    configFile: path.join(examples, 'vite.config.ts'),
    server: { port: 5210, strictPort: false },
    logLevel: 'error',
  });
  await deadline(server.listen(), STEP, 'serve the suite');
  try {
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('the suite has no address');
    const chrome = await cold();
    let ids: string[];
    try {
      const page = await chrome.browser.newPage();
      await deadline(page.goto(url), STEP, 'open the suite');
      const picker = page.getByRole('combobox', { name: 'Example', exact: true });
      await deadline(picker.waitFor(), STEP, 'the example picker');
      ids = await picker
        .locator('option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    } finally {
      await chrome.close();
    }
    const failures: string[] = [];
    for (const id of only.length ? ids.filter((id) => only.includes(id)) : ids) {
      failures.push(...(await visit(url, id)).map((f) => `${id}: ${f}`));
    }
    return failures;
  } finally {
    await server.close();
  }
}

const [dir, ...only] = args.filter((arg) => arg !== '--software');
if (!dir) {
  console.error('usage: node gate/gate.ts <dir holding shaders.json> [--software] [page...]');
  process.exit(2);
}
if (software)
  console.log('SwiftShader draws on the CPU: pipelines must compile, untimed; no pages');
const shaders =
  only.length && !software ? [] : (await compileBudget(dir)).map((f) => `shaders: ${f}`);
const failures = [...shaders, ...(software ? [] : await suite(only))];
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
