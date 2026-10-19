/**
 * The browser gate. Times every shader variant's pipelines in Chrome against a budget, then opens
 * every page of the suite in a fresh browser and moves the pointer over it. It fails on a pipeline
 * over budget or failing to compile, a console error, a page that draws no frame in time, or a frame
 * that stalls while the page opens or under the pointer. Every wait races a deadline.
 *
 * `node gate/gate.ts <dir holding shaders.json> [page...]`; `cargo xtask browser` runs it. Naming
 * pages visits only those, without timing the shaders. Chrome is `$LATKIT_CHROME`, or the newest
 * Chromium Playwright installed.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { createServer } from 'vite';
import { STEP, deadline, launch, type Chrome } from './browser.ts';

/** Milliseconds Chrome may take to make any one pipeline, cold: the slowest takes about 0.35 s. */
const COMPILE_BUDGET = 800;
/** Milliseconds from opening a page to its views' first frames: about 0.5 s, now and then 1.2 s. */
const FIRST_FRAME_BUDGET = 2000;
/** Milliseconds between two animation frames while a page opens. Chrome holds frames back while its
 * GPU process compiles the pipelines a first frame makes, up to about 1.3 s. */
const OPENING_BUDGET = 2500;
/** Milliseconds between two animation frames while the pointer moves over a page: nothing compiles
 * then, so the longest takes 20–50 ms. */
const STALL_BUDGET = 80;

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const examples = path.dirname(here);

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
  return launch(['--disable-gpu-shader-disk-cache']);
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
        : t.ms > COMPILE_BUDGET
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
    // The longest gap between animation frames since the last reset.
    await page.addInitScript(() => {
      const w = window as unknown as { gap: number; resetGap(): void };
      let last = 0;
      w.gap = 0;
      w.resetGap = () => {
        w.gap = 0;
        last = 0;
      };
      const tick = (now: number) => {
        if (last) w.gap = Math.max(w.gap, now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
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
    // The two frames after a scene's first make the pipelines its input needs; then frames go on
    // while what they made compiles: wait both out.
    await deadline(
      drawn(2, 2 * OPENING_BUDGET),
      2 * OPENING_BUDGET + 1000,
      `${id}'s input pipelines`,
    );
    await deadline(page.waitForTimeout(1500), STEP, 'settle');
    const opening = await page.evaluate(() => (window as unknown as { gap: number }).gap);
    let longest = { gap: 0, step: '' };
    /** Does `step` and waits two frames; keeps the longest gap between frames and its step. */
    const act = async (step: string, action: () => Promise<void>) => {
      await page.evaluate(() => (window as unknown as { resetGap(): void }).resetGap());
      await deadline(action(), STEP, step);
      await frames(page);
      const gap = await page.evaluate(() => (window as unknown as { gap: number }).gap);
      if (gap > longest.gap) longest = { gap, step };
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
    await deadline(page.keyboard.press('x'), STEP, 'ask for a picture');
    const saved = page.waitForFunction(
      () => document.body.innerText.includes('Saved views.png'),
      undefined,
      {
        timeout: STEP,
        polling: 100,
      },
    );
    try {
      await deadline(saved, STEP + 1000, `${id}'s picture`);
    } catch {
      failures.push('no picture exported');
    }
    const { gap, step } = longest;
    console.log(
      `${id}: first frame ${first.toFixed(0)} ms, longest while opening ${opening.toFixed(0)} ms; ` +
        `longest under the pointer ${gap.toFixed(0)} ms, on ${step || 'nothing'}`,
    );
    if (opening > OPENING_BUDGET)
      failures.push(`a frame took ${opening.toFixed(0)} ms opening, over ${OPENING_BUDGET}`);
    if (gap > STALL_BUDGET)
      failures.push(`a frame took ${gap.toFixed(0)} ms on ${step}, over ${STALL_BUDGET}`);
  } finally {
    await chrome.close();
  }
  return failures;
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
      const links = page.locator('nav a');
      await deadline(links.first().waitFor(), STEP, 'the page bar');
      ids = (await links.evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))).map(
        (h) => h.slice(1),
      );
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

const [dir, ...only] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node gate/gate.ts <dir holding shaders.json> [page...]');
  process.exit(2);
}
const shaders = only.length ? [] : (await compileBudget(dir)).map((f) => `shaders: ${f}`);
const failures = [...shaders, ...(await suite(only))];
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
