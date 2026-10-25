/**
 * The benchmark: each scenario up its sizes, each run in a fresh page, judged and reported.
 *
 *   cargo xtask bench [--quick] [--only a,b] [--repeats n] [--update] [--software]
 *
 * --quick runs each scenario once at its smallest size, a smoke test of every phase and the work
 * gate in under a minute on a GPU; how phases grow, and their times, take the full sweep. --update lays this run's
 * baselines over the committed ones, keeping what it did not run; --software draws with SwiftShader
 * on the CPU, as Linux always does: its work counts the same, its times only report, and no shader
 * can hang the GPU.
 *
 * A scenario climbs its sizes while the last one's phases, each at its fastest repeat and grown as
 * its order says, fit a phase's limit: a stall of the machine slows one repeat, a scenario too large
 * for the next size every one. A failure ends its scenario; a lost device, or a page that stopped
 * answering, ends the sweep, since the next scenario would meet a resetting driver, and resets in a
 * row are what wedge one. Every wait races a deadline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { STEP, deadline, launch, type Chrome } from '../npm/examples/gate/browser.ts';
import { judge, times, work, type TimeBaseline, type WorkBaseline } from './judge.ts';
import { report } from './report.ts';
import type { Listed, Run } from './page/main.ts';
import { LIMIT } from './page/stage.ts';

const { values: flags } = parseArgs({
  options: {
    quick: { type: 'boolean' },
    only: { type: 'string' },
    repeats: { type: 'string' },
    update: { type: 'boolean' },
    software: { type: 'boolean' },
  },
});
const repeats = flags.quick ? 1 : Number(flags.repeats ?? 3);
if (!Number.isInteger(repeats) || repeats < 1)
  throw new Error(`--repeats takes a count, not ${flags.repeats}`);
const only = flags.only?.split(',');
const software = flags.software || process.platform === 'linux';
const here = path.dirname(fileURLToPath(import.meta.url));
const baselines = path.join(here, 'baselines');
const results = path.resolve(here, '../target/bench');
/** Timestamps, for what a frame costs the GPU. The page steps its frames, each as soon as the GPU
 * finished the last, so the display's pace never enters a run. */
const FLAGS = ['--enable-webgpu-developer-features'];
/** The same page on every machine, so what it counts compares, and small enough that SwiftShader
 * draws a frame quickly. */
const PAGE = { viewport: { width: 800, height: 500 }, deviceScaleFactor: 2 };
/** Milliseconds a page may say nothing: each phase says when it starts, then acts and settles
 * within its limits. */
const QUIET = 2 * LIMIT + 20_000;

/** A failed run, and whether the sweep stops there. */
class Failure extends Error {
  readonly fatal: boolean;
  constructor(message: string, fatal: boolean) {
    super(message);
    this.fatal = fatal;
  }
}

/** `work`, or an error once the page has said nothing for `QUIET` ms since `heard()`. */
function watched<T>(work: Promise<T>, heard: () => number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const silent = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (performance.now() - heard() > QUIET)
        reject(new Error(`${what} said nothing for ${QUIET} ms`));
    }, 1_000);
  });
  return Promise.race([work, silent]).finally(() => clearInterval(timer));
}

/** The first phase of the repeats `last` at one size that, at its fastest and grown to `size` as its
 * order says (linearly where it says nothing), would pass a phase's limit, and its fastest. */
function outgrown(
  last: Run[],
  size: number,
  orders: Listed['orders'],
): [string, number] | undefined {
  const from = last[0]!.size;
  for (const phase of Object.keys(last[0]!.phases)) {
    const ms = Math.min(...last.map((run) => run.phases[phase]?.ms ?? Infinity));
    if (ms * (size / from) ** (orders[phase]?.time ?? 1) > LIMIT) return [phase, ms];
  }
  return undefined;
}

const server = await createServer({
  root: here,
  configFile: path.join(here, 'vite.config.ts'),
  logLevel: 'error',
  server: { port: 5230, strictPort: false },
});
await deadline(server.listen(), STEP, 'serve the bench');
const address = server.resolvedUrls?.local[0];
if (!address) throw new Error('the bench has no address');
const url = address;
const runs: Run[] = [];
const failures: string[] = [];
const notes: string[] = [];
let list: Listed[] = [];

/** One run of `scenario` at `size`: in a fresh page of `warm`, or, for a cold scenario, of a fresh
 * Chrome without a shader cache. */
async function measure(warm: Chrome, scenario: Listed, size: number): Promise<Run> {
  if (!scenario.cold) return visit(warm, scenario, size);
  const cold = await launch([...FLAGS, '--disable-gpu-shader-disk-cache'], software);
  try {
    return await visit(cold, scenario, size);
  } finally {
    await cold.close();
  }
}

/** One run in a fresh page of `chrome`; a failure is fatal when the device was lost, or the page
 * cannot say. */
async function visit(chrome: Chrome, scenario: Listed, size: number): Promise<Run> {
  const page = await deadline(chrome.browser.newPage(PAGE), STEP, 'open a page');
  const errors: string[] = [];
  let [phase, heard] = ['opening', performance.now()];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'debug' && m.text().startsWith('phase '))
      [phase, heard] = [m.text().slice(6), performance.now()];
  });
  try {
    await deadline(page.goto(url), STEP, 'open the bench page');
    const run = await watched(
      page.evaluate(([name, n]) => window.bench.run(name, n), [scenario.name, size] as const),
      () => heard,
      `${scenario.name} at ${size}`,
    );
    run.errors.push(...errors);
    return run;
  } catch (error) {
    const lost = await deadline(
      page.evaluate(() => window.bench.lost()),
      5_000,
      'ask after the device',
    ).catch(() => true);
    throw new Failure(
      `${scenario.name} at ${size}, ${phase}: ${String(error).split('\n')[0]}`,
      lost,
    );
  } finally {
    await deadline(page.close(), 5_000, 'close the page').catch(() => {});
  }
}

const warm = await launch(FLAGS, software);
try {
  const page = await deadline(warm.browser.newPage(PAGE), STEP, 'open a page');
  await deadline(page.goto(url), STEP, 'open the bench page');
  // Making a device is where a wedged driver hangs, so the sweep starts only once one is made.
  await deadline(
    page.evaluate(() => window.bench.ready()),
    15_000,
    'make a GPU device: a wedged driver hangs here, and needs a reset before benchmarking',
  );
  list = await deadline(
    page.evaluate(() => window.bench.list()),
    STEP,
    'list the scenarios',
  );
  await deadline(page.close(), 5_000, 'close the page').catch(() => {});
  const unknown = only?.filter((name) => !list.some((s) => s.name === name)) ?? [];
  if (unknown.length)
    throw new Error(
      `no scenario ${unknown.join(', ')}; there are ${list.map((s) => s.name).join(', ')}`,
    );
  for (const scenario of list.filter((s) => !only || only.includes(s.name))) {
    const sizes = flags.quick ? scenario.sizes.slice(0, 1) : scenario.sizes;
    try {
      // A first run fills the shader cache, so the measured ones load warm; `start` alone loads cold.
      if (!scenario.cold && !flags.quick) await measure(warm, scenario, sizes[0]!);
      let last: Run[] = [];
      for (const size of sizes) {
        const outgrew = last.length ? outgrown(last, size, scenario.orders) : undefined;
        if (outgrew) {
          const [phase, ms] = outgrew;
          notes.push(
            `${scenario.name} stops before ${size}: its ${phase} took ${ms.toFixed(0)} ms at ${last[0]!.size}`,
          );
          break;
        }
        last = [];
        for (let r = 0; r < repeats; r++) {
          const run = await measure(warm, scenario, size);
          console.log(
            `  ${scenario.name} at ${size}: loaded in ${run.phases.load?.ms.toFixed(0)} ms` +
              (run.errors.length ? `, ${run.errors.length} errors` : ''),
          );
          runs.push(run);
          last.push(run);
        }
      }
    } catch (error) {
      const failure = error instanceof Failure ? error : new Failure(String(error), true);
      failures.push(failure.message.slice(0, 400));
      console.log(`  ${failure.message.slice(0, 300)}`);
      if (failure.fatal) {
        failures.push(
          'the GPU lost its device or stopped answering, so the sweep stops: reset the driver before running again',
        );
        break;
      }
    }
  }
} finally {
  await warm.close();
  await server.close();
}

const read = <T>(file: string): T | undefined =>
  fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : undefined;
const write = (file: string, value: unknown) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
const machines = [...new Set(runs.map((r) => r.machine))];
if (machines.length > 1)
  failures.push(
    `runs drew on different GPUs, so their times cannot compare: ${machines.join('; ')}`,
  );
if (!runs.length) failures.push('nothing ran');
const machine = machines[0] ?? 'unknown';
const slug = machine
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');
const workFile = path.join(baselines, 'work.json');
const timesFile = path.join(baselines, `${slug}.json`);
// A quick run, once each without a warm-up, holds no times to the baselines its warm repeats took.
const verdict = judge(runs, list, {
  work: read<WorkBaseline>(workFile),
  times: flags.quick ? undefined : read<TimeBaseline>(timesFile),
});
console.log(`\n${machine}`);
console.log(report(list, verdict));
if (runs.length) {
  fs.mkdirSync(results, { recursive: true });
  write(path.join(results, `${Date.now()}.json`), { machine, runs });
}
// Baselines come only from runs that all completed without errors; what they measured, slower or
// faster, is what --update accepts.
if (flags.update) {
  if (failures.length || runs.some((r) => r.errors.length)) {
    failures.push('baselines not written: a run failed or reported errors');
  } else {
    fs.mkdirSync(baselines, { recursive: true });
    write(workFile, work(verdict, read<WorkBaseline>(workFile)));
    write(timesFile, times(verdict, machine, read<TimeBaseline>(timesFile)));
  }
}
console.log('');
for (const note of [...notes, ...verdict.notes]) console.log(`note ${note}`);
const failed = [...failures, ...verdict.failures];
for (const failure of failed) console.error(`FAIL ${failure}`);
process.exit(failed.length ? 1 : 0);
