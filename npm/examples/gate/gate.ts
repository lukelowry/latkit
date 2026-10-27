/**
 * The browser gate. It times the pipelines of every shader variant in Chrome against a budget, then
 * opens each page of the suite in a fresh browser and moves the pointer over it.
 *
 * A pipeline fails if it does not compile or is over budget. A page fails on a console or page
 * error, a pipeline compiled at first use, or no exported picture. A page is slow if it draws no
 * frame in time, or misses frames in a row while it opens or under the pointer. A slow page is
 * opened again, cold, and fails only if every open is slow: a machine stall slows one open, but a
 * slow page slows them all. Every wait races a deadline.
 *
 * On SwiftShader (`--software`, and always on Linux) the CPU draws, slower than any budget, so the
 * gate only checks that every pipeline compiles. Pages and times are judged only on a GPU.
 *
 * Usage: `node gate/gate.ts <dir holding shaders.json> [--software] [page...]`, which
 * `cargo xtask browser` runs. Naming pages visits only those and skips timing the shaders. Chrome
 * is `$LATKIT_CHROME`, or else the newest Chromium that Playwright installed.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { STEP, deadline, errorsOf, launch, serve, type Chrome } from './browser.ts';
import { quantile } from './quantile.ts';

/** Maximum milliseconds Chrome may take to compile one pipeline cold. The slowest takes about
 * 0.35 s. A view opens no sooner than its slowest pipeline; the others compile in parallel. */
const COMPILE_BUDGET = 800;
/** Maximum milliseconds from opening a page cold to its views' first frames. A first frame draws
 * everything its scene uses. Every pipeline compiles in parallel, off Chrome's GPU thread. */
const FIRST_FRAME_BUDGET = 1000;
/** Maximum consecutive display frames a page may miss while it opens or under the pointer. The
 * machine sets the display rate: 60 Hz on a panel, 32 Hz over Remote Desktop, where single vblanks
 * slip. Nothing compiles on Chrome's GPU thread, so no frame waits on latkit. Pipelines compiled at
 * first use are counted separately, as `work.late`. */
const MISSED = 1;
/** Milliseconds between display frames beyond which the gate logs what the views were doing. */
const LONG = 50;
/** Maximum cold opens per page to draw its first frame in time without missing frames. An error on
 * any open fails the page at once. */
const OPENS = 2;

/** The failures of one open of a page: its errors, and the ways it was slow. */
interface Opened {
  wrong: string[];
  slow: string[];
}

/** A gap between display frames longer than `LONG`. It records each view's last CPU and GPU frame
 * times and `waiting` list, and the GPU work done since the previous frame. */
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

/** A shader variant listed in shaders.json. `append` is source added after the file's own. */
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

/** Launches Chrome without its shader disk cache, so every pipeline compiles cold, as on a first
 * visit. */
function cold(): Promise<Chrome> {
  return launch(['--disable-gpu-shader-disk-cache'], software);
}

/** Lists the pipelines of the variants in `dir`: one per compute entry point, or one draw, for each
 * set of constants. */
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

/** Runs in the page. Creates each pipeline cold, sequentially, and times it. Only its source
 * reaches the page, so it must be self-contained. */
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
    // Like latkit's draw pipelines, these test against depth, which the backdrop writes.
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

/** Times every pipeline and returns the failures: compile errors and, on a GPU, pipelines over
 * `COMPILE_BUDGET`. */
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

/** Waits up to `budget` ms until every view of `page` has opened. A view has opened once nothing is
 * waiting, or once it has drawn 30 frames waiting only on `fit`, since a plot of streaming data
 * refits its value range every frame. A view draws only after every pipeline its scene uses has
 * compiled, so nothing is left to compile by then. */
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

/** Opens page `id` until an open is in time or has errors, at most `OPENS` times. Returns the
 * failures of the last open. */
async function visit(url: string, id: string): Promise<string[]> {
  for (let n = 1; ; n++) {
    const { wrong, slow } = await open(url, id);
    if (wrong.length || !slow.length || n === OPENS) return [...wrong, ...slow];
    console.log(`  ${id}: ${slow.join('; ')}; opening it again`);
  }
}

/** Opens page `id` in a fresh browser and waits for its first frames. Then it works every view with
 * the pointer and keys (hovering a grid of points, zooming, dragging, clicking, right-clicking, and
 * stepping with Tab and the arrows) and exports a picture. */
async function open(url: string, id: string): Promise<Opened> {
  const chrome = await cold();
  try {
    const context = await deadline(
      chrome.browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }),
      STEP,
      'a browser context',
    );
    const page = await deadline(context.newPage(), STEP, 'a page');
    const opened: Opened = { wrong: errorsOf(page), slow: [] };
    const { wrong, slow } = opened;
    // Tracks the longest gap between animation frames since the last reset, the last 120 gaps,
    // whose median is the display's frame interval, and each gap longer than `LONG` with what the
    // views were doing.
    await page.addInitScript((long: number) => {
      interface Stage {
        views: { stats: { cpuMs: number; gpuMs: number }; waiting: string[] }[];
        gpu: { work: Record<string, number> };
      }
      const w = window as unknown as {
        gap: number;
        gaps: number[];
        long: Long[];
        resetGap(): void;
        stage?: Stage;
      };
      let last = 0;
      let work: Record<string, number> = {};
      const gaps: number[] = [];
      w.gap = 0;
      w.gaps = gaps;
      w.long = [];
      w.resetGap = () => {
        w.gap = 0;
        w.long = [];
        last = 0;
      };
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
    /** Logs each frame longer than `LONG` since the last reset, labeled with `doing`. */
    const tell = async (doing: string) => {
      const long = await page.evaluate(() => (window as unknown as { long: Long[] }).long);
      for (const frame of long) console.log(`  ${id}: ${describe(frame)} ${doing}`);
    };
    const started = performance.now();
    await deadline(page.goto(`${url}#${id}`), STEP, `open ${id}`);
    /** Waits up to `budget` ms until every view has drawn more than `frames` frames. */
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
      slow.push(`no frame within ${FIRST_FRAME_BUDGET} ms`);
      return opened;
    }
    const first = performance.now() - started;
    // Stalls count from the views' first frames, since the page shows nothing that could stall
    // while it loads.
    await page.evaluate(() => (window as unknown as { resetGap(): void }).resetGap());
    await deadline(settled(page, STEP), STEP + 1000, `${id}'s opening`);
    await deadline(page.waitForTimeout(500), STEP, 'settle');
    const opening = await page.evaluate(() => (window as unknown as { gap: number }).gap);
    await tell('opening');
    let longest = { gap: 0, step: '' };
    /** Performs `step` and waits two frames. Records the longest gap between frames with its step,
     * and logs each frame longer than `LONG`. */
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
      // Right-click raises a menu intent listing what lies under the point. Tab and the arrow keys
      // step through rows.
      await act(`menu on canvas ${c}`, () => page.mouse.click(cx, cy, { button: 'right' }));
      await act(`step with Tab on canvas ${c}`, () => page.keyboard.press('Tab'));
      await act(`step with an arrow on canvas ${c}`, () => page.keyboard.press('ArrowRight'));
      await act(`stop stepping on canvas ${c}`, () => page.keyboard.press('Escape'));
    }
    // Every page exports a picture of its views. A shot draws them and a worker writes the PNG.
    await page.locator('main canvas').first().focus();
    await deadline(page.keyboard.press('x'), STEP, 'press x to export a picture');
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
      // Explain the failure with the views' `waiting` lists and the page's status text.
      const said = await page.evaluate(() => {
        const views = (window as unknown as { stage?: { views: { waiting: string[] }[] } }).stage
          ?.views;
        const waiting = (views ?? []).map((view) => view.waiting.join('+') || 'nothing');
        const status = [...document.querySelectorAll('.status, [role=status], output')]
          .map((element) => element.textContent?.trim())
          .filter(Boolean);
        return `views waiting on ${waiting.join(', ')}; page status: ${status.join(' | ') || 'nothing'}`;
      });
      wrong.push(`no picture exported: ${said}`);
    }
    const { gap, step } = longest;
    const { gaps, late } = await page.evaluate(() => {
      const w = window as unknown as {
        gaps: number[];
        stage?: { gpu: { work: { late: number } } };
      };
      return { gaps: w.gaps, late: w.stage?.gpu.work.late ?? 0 };
    });
    const interval = gaps.length ? quantile(gaps, 0.5) : 1000 / 60;
    // A gap of n intervals missed n - 1 frames, so a gap over MISSED + 1.5 intervals missed more
    // than MISSED.
    const budget = (MISSED + 1.5) * interval;
    console.log(
      `${id}: first frame ${first.toFixed(0)} ms, frames every ${interval.toFixed(0)} ms, longest while ` +
        `opening ${opening.toFixed(0)} ms; longest under the pointer ${gap.toFixed(0)} ms, on ${step || 'nothing'}`,
    );
    const missed = (ms: number) => Math.round(ms / interval) - 1;
    if (opening > budget)
      slow.push(`missed ${missed(opening)} frames in a row opening (${opening.toFixed(0)} ms)`);
    if (gap > budget)
      slow.push(`missed ${missed(gap)} frames in a row on ${step} (${gap.toFixed(0)} ms)`);
    if (late > 0)
      wrong.push(`${late} pipelines compiled at first use, delaying the frames that use them`);
    return opened;
  } finally {
    await chrome.close();
  }
}

/** Formats a frame longer than `LONG` for the log: each view's last CPU and GPU times and `waiting`
 * list, and the GPU work done, with byte counts in MB. */
function describe({ gap, cpuMs, gpuMs, waiting, work }: Long): string {
  const ms = (list: number[]) => list.map((n) => n.toFixed(1)).join('/');
  const waited = waiting.map((list) => list.join('+') || 'nothing').join(', ');
  const bytes = new Set(['uploaded', 'written', 'cleared']);
  const done = Object.entries(work)
    .map(([kind, n]) => `${kind} ${bytes.has(kind) ? `${(n / 1e6).toFixed(2)} MB` : n}`)
    .join(', ');
  return `frame of ${gap.toFixed(0)} ms (cpu ${ms(cpuMs)} ms, gpu ${ms(gpuMs)} ms, waiting on ${waited}; ${done || 'no work'})`;
}

/** Serves the suite and visits the pages named in `only`, or, if it is empty, every page in the
 * example picker. */
async function suite(only: string[]): Promise<string[]> {
  const { url, close } = await serve(examples, 5210, 'the suite');
  try {
    const chrome = await cold();
    let ids: string[];
    try {
      const page = await deadline(chrome.browser.newPage(), STEP, 'a page');
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
    await close();
  }
}

const [dir, ...only] = args.filter((arg) => arg !== '--software');
if (!dir) {
  console.error('usage: node gate/gate.ts <dir holding shaders.json> [--software] [page...]');
  process.exit(2);
}
if (software)
  console.log('SwiftShader draws on the CPU, so the gate only checks that pipelines compile');
const shaders =
  only.length && !software ? [] : (await compileBudget(dir)).map((f) => `shaders: ${f}`);
const failures = [...shaders, ...(software ? [] : await suite(only))];
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
