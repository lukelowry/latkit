/**
 * The benchmark runner. It runs each scenario at increasing sizes, each run in a fresh page, then
 * judges and reports the results.
 *
 *   cargo xtask bench [--quick] [--only a,b] [--repeats n] [--update] [--software]
 *
 * `--quick` runs each scenario once at its smallest size. It checks every phase and the work
 * baseline in under a minute on a GPU. Growth and times are judged only in a full sweep.
 * `--repeats` sets the runs per size (3 by default). `--update` merges this run's results into the
 * committed baselines, keeping entries it did not run; only a full sweep on the GPU writes times.
 * `--software` draws with SwiftShader on the CPU, as Linux always does. Work counts the same there,
 * times are only reported, and no shader can hang the GPU.
 *
 * A scenario moves to its next size only while every phase's fastest repeat at the last size,
 * scaled up by the phase's order, stays within `LIMIT`. The fastest repeat is used because a
 * machine stall slows one repeat, while a scenario too large for the next size slows every one. A
 * failure ends its scenario. A lost device or a page that stops responding ends the sweep, since
 * the next scenario would meet a resetting driver, and repeated resets are what wedge a driver.
 * Every wait races a deadline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  STEP,
  deadline,
  errorsOf,
  launch,
  serve,
  type Chrome,
} from '../npm/examples/gate/browser.ts';
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
/** Gives WebGPU timestamps, which measure each frame's GPU time, full precision; Chrome otherwise
 * rounds them to 100 µs. The page steps each frame as soon as the GPU finishes the last, so the
 * display's frame rate never affects a run. */
const FLAGS = ['--enable-webgpu-developer-features'];
/** The page size. It is the same on every machine so work counts compare, and small enough that
 * SwiftShader draws a frame quickly. */
const PAGE = { viewport: { width: 800, height: 500 }, deviceScaleFactor: 2 };
/** Maximum milliseconds between a page's phase announcements. Each phase announces its start, then
 * acts and settles within its own limits. */
const QUIET = 2 * LIMIT + 20_000;

/** A failed run. A `fatal` failure stops the sweep. */
class Failure extends Error {
  readonly fatal: boolean;
  constructor(message: string, fatal: boolean) {
    super(message);
    this.fatal = fatal;
  }
}

/** Resolves with `work`, or rejects once more than `QUIET` ms have passed since `heard()`, the time
 * the page last announced a phase. */
function watched<T>(work: Promise<T>, heard: () => number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const silent = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (performance.now() - heard() > QUIET)
        reject(new Error(`${what} reported no phase for ${QUIET} ms`));
    }, 1_000);
  });
  return Promise.race([work, silent]).finally(() => clearInterval(timer));
}

/** Finds the first phase that would exceed `LIMIT` at `size`. Each phase's fastest time among the
 * repeats `last`, all at one size, is scaled to `size` by its time order, linearly if it has none.
 * Returns that phase and its fastest time. */
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

const { url, close } = await serve(here, 5230, 'the bench');
const runs: Run[] = [];
const failures: string[] = [];
const notes: string[] = [];
let list: Listed[] = [];

/** Runs `scenario` once at `size` in a fresh page of `warm`. A cold scenario runs in a fresh Chrome
 * without a shader cache instead. */
async function measure(warm: Chrome, scenario: Listed, size: number): Promise<Run> {
  if (!scenario.cold) return visit(warm, scenario, size);
  const cold = await launch([...FLAGS, '--disable-gpu-shader-disk-cache'], software);
  try {
    return await visit(cold, scenario, size);
  } finally {
    await cold.close();
  }
}

/** Runs once in a fresh page of `chrome`. A failure is fatal if the device was lost, or if the page
 * cannot report whether it was. */
async function visit(chrome: Chrome, scenario: Listed, size: number): Promise<Run> {
  const page = await deadline(chrome.browser.newPage(PAGE), STEP, 'open a page');
  const errors = errorsOf(page);
  let [phase, heard] = ['opening', performance.now()];
  page.on('console', (m) => {
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
      'check whether the device was lost',
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
  // A wedged driver hangs when a device is made, so the sweep starts only after one is made.
  await deadline(
    page.evaluate(() => window.bench.ready()),
    15_000,
    'create a GPU device (a hung driver blocks here; reset it before benchmarking)',
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
      // An unmeasured first run fills the shader cache, so the measured runs load warm. Only cold
      // scenarios (`start`) load cold.
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
          'the GPU device was lost or the page stopped responding, so the sweep stopped. Reset the driver before running again',
        );
        break;
      }
    }
  }
} finally {
  await warm.close();
  await close();
}

const read = <T>(file: string): T | undefined =>
  fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : undefined;
const write = (file: string, value: unknown) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
const machines = [...new Set(runs.map((r) => r.machine))];
if (machines.length > 1)
  failures.push(
    `runs used different GPUs, so their times are not comparable: ${machines.join('; ')}`,
  );
if (!runs.length) failures.push('nothing ran');
const machine = machines[0] ?? 'unknown';
const slug = machine
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');
const workFile = path.join(baselines, 'work.json');
const timesFile = path.join(baselines, `${slug}.json`);
// Times are held to a baseline, and written to one, only by a full sweep on the GPU. A quick run
// makes one run per scenario without a warm-up, and SwiftShader's times measure the CPU.
const timed = !flags.quick && !software;
const verdict = judge(runs, list, {
  work: read<WorkBaseline>(workFile),
  times: timed ? read<TimeBaseline>(timesFile) : undefined,
});
console.log(`\n${machine}`);
console.log(report(list, verdict));
if (runs.length) {
  fs.mkdirSync(results, { recursive: true });
  write(path.join(results, `${Date.now()}.json`), { machine, runs });
}
// Baselines are written only when every run completed without errors. --update accepts whatever
// they measured, slower or faster.
if (flags.update) {
  if (failures.length || runs.some((r) => r.errors.length)) {
    failures.push('baselines not written: a run failed or reported errors');
  } else {
    fs.mkdirSync(baselines, { recursive: true });
    write(workFile, work(verdict, read<WorkBaseline>(workFile)));
    if (timed) write(timesFile, times(verdict, machine, read<TimeBaseline>(timesFile)));
  }
}
console.log('');
for (const note of [...notes, ...verdict.notes]) console.log(`note ${note}`);
const failed = [...failures, ...verdict.failures];
for (const failure of failed) console.error(`FAIL ${failure}`);
process.exit(failed.length ? 1 : 0);
