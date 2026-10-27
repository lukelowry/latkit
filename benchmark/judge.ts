/**
 * Judges the runs. These rules hold on any machine: no errors, no frames drawn while idle, no
 * pipeline compiled at first use, resident data within its budget, no phase growing faster than its
 * order, and no more work than the work baseline.
 *
 * Frames are stepped, each waiting for the GPU. So in a phase that acts once and settles, the
 * `EXACT` counts, which only the data and the frames drawn set, may not exceed the baseline at all,
 * unless the scenario fetches its data. Other counts, and every count of a steady phase, vary with
 * the frame a job or fetch finishes in, so they may reach `STEADY` times the baseline.
 *
 * On the machine the times baseline was taken on, no phase's fastest repeat may be much slower than
 * its baseline. A machine stall slows one repeat, but a regression slows every one.
 */
import type { Work } from 'latkit';
import { quantile } from '../npm/examples/gate/quantile.ts';
import type { Listed, Run } from './page/main.ts';

/** A phase at one size, summarized across repeats: its fastest times and its least work. */
export interface Summary {
  /** Milliseconds: CPU time per frame for a steady phase, else the whole phase. */
  time: number;
  gpu: number;
  steady: boolean;
  /** Median frames drawn. */
  frames: number;
  work: Work & { resident: number };
}

type By<T> = Record<string, Record<number, Record<string, T>>>;
export type WorkBaseline = By<Summary['work']>;
export interface TimeBaseline {
  machine: string;
  times: By<{ time: number; gpu: number }>;
}
export type Growth = Partial<Record<'time' | 'gpu' | 'uploaded' | 'resident', number>>;
export interface Verdict {
  failures: string[];
  notes: string[];
  summaries: By<Summary>;
  /** The fitted growth exponent of each measure, by scenario and phase. */
  exponents: Record<string, Record<string, Growth>>;
}

/** How far a fitted exponent may exceed its order, allowing for noise and a change of regime
 * between sizes. */
const SLACK = 0.2;
/** Milliseconds a phase that acts once may finish later than its baseline: one timer tick. A tick
 * is 15.6 ms on Windows, so a readback comes back on one tick or the next. */
const TICK = 16;
/** Minimum bytes an upload counts as: one page, 4,096 rows of four bytes. */
const PAGE = 4096 * 4;
/** Floors for costs too small to fit an exponent to or to call slower. Smaller costs count as
 * these. A frame's CPU time comes from the page's clock, which steps by 0.1 ms, so its floor is
 * five steps. A phase that acts once finishes on a timer tick. */
const FLOOR = { frame: 0.5, action: TICK, bytes: 64 * 1024 };
/** Factor by which the fastest repeat may be slower than the baseline. */
const SLOWER = 1.25;
/** Work counts that only the data and the frames drawn set. They repeat exactly once a phase
 * settles. */
const EXACT = new Set([
  'uploaded',
  'uploads',
  'evaluated',
  'packed',
  'jobs',
  'pipelines',
  'late',
  'resident',
]);
/** Factor by which other work counts may exceed the baseline. The frame a job or fetch finishes in
 * changes label placements and tiles by up to about 1.7×. A per-frame blowup changes far more. */
const STEADY = 2;
/** Minimum baseline values for work held within `STEADY`: one for byte counts, one for the rest. */
const WORK_FLOOR = { bytes: 64 * 1024, count: 8 };
const BYTES = new Set(['uploaded', 'written', 'resident']);

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mib = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;

/** The least-squares slope of log cost against log size, which is the cost's growth exponent. */
function slope(points: (readonly [number, number])[]): number {
  const xs = points.map(([n]) => Math.log(n));
  const ys = points.map(([, c]) => Math.log(c));
  const [mx, my] = [sum(xs) / xs.length, sum(ys) / ys.length];
  return sum(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / sum(xs.map((x) => (x - mx) ** 2));
}

function summarize(runs: Run[]): By<Summary> {
  const out: By<Summary> = {};
  const groups = Map.groupBy(runs, (r) => `${r.scenario}\0${r.size}`);
  for (const group of groups.values()) {
    const { scenario, size, phases } = group[0]!;
    for (const [phase, { steady }] of Object.entries(phases)) {
      const costs = group.map((r) => r.phases[phase]!);
      const frames = costs.map((c) => c.frames);
      const work = costs.map((c) => ({ ...c.work, resident: c.resident }));
      ((out[scenario] ??= {})[size] ??= {})[phase] = {
        steady,
        time: Math.min(...costs.map((c) => (steady ? c.cpu : c.ms))),
        gpu: Math.min(...costs.map((c) => c.gpu)),
        frames: quantile(frames, 0.5),
        work: Object.fromEntries(
          Object.keys(work[0]!).map((k) => [
            k,
            Math.min(...work.map((w) => w[k as keyof typeof w])),
          ]),
        ) as unknown as Summary['work'],
      };
    }
  }
  return out;
}

export function judge(
  runs: Run[],
  list: Listed[],
  base: { work?: WorkBaseline; times?: TimeBaseline },
): Verdict {
  const failures: string[] = [];
  const notes: string[] = [];
  for (const r of runs) {
    const at = `${r.scenario} at ${r.size}`;
    for (const error of r.errors) failures.push(`${at}: ${error}`);
    if (r.idle) failures.push(`${at}: ${r.idle} frames drawn while nothing changed`);
    for (const [phase, { work }] of Object.entries(r.phases))
      if (work.late)
        failures.push(
          `${at}, ${phase}: ${work.late} pipelines compiled at first use instead of ahead of time`,
        );
    const resident = Math.max(...Object.values(r.phases).map((c) => c.resident));
    if (resident > r.budget)
      failures.push(`${at}: ${mib(resident)} resident, over its ${mib(r.budget)} budget`);
  }
  const summaries = summarize(runs);
  const exponents: Verdict['exponents'] = {};
  const sameMachine = !!base.times && base.times.machine === runs[0]?.machine;
  for (const scenario of list) {
    const bySize = summaries[scenario.name];
    if (!bySize) continue;
    const sizes = Object.keys(bySize)
      .map(Number)
      .sort((a, b) => a - b);
    for (const [phase, order] of Object.entries(scenario.orders)) {
      const at = sizes.filter((n) => bySize[n]![phase]);
      if (!at.length) continue;
      const steady = bySize[at[0]!]![phase]!.steady;
      const grows = (read: (s: Summary) => number, floor: number) =>
        at.length > 1
          ? slope(at.map((n) => [n, Math.max(read(bySize[n]![phase]!), floor)] as const))
          : undefined;
      const fit: Growth = {
        time: grows((s) => s.time, steady ? FLOOR.frame : FLOOR.action),
        gpu: grows((s) => s.gpu, FLOOR.frame),
        // Changes upload whole pages, so each upload counts as at least a page of bytes.
        uploaded: grows((s) => Math.max(s.work.uploaded, s.work.uploads * PAGE), FLOOR.bytes),
        resident: grows((s) => s.work.resident, FLOOR.bytes),
      };
      (exponents[scenario.name] ??= {})[phase] = fit;
      const past = (what: string, e: number | undefined, limit: number | undefined) => {
        if (e !== undefined && limit !== undefined && e > limit + SLACK)
          failures.push(
            `${scenario.name} ${phase}: ${what} grows as n^${e.toFixed(2)}, past n^${limit}`,
          );
      };
      past('time', fit.time, order.time);
      past('uploaded bytes', fit.uploaded, order.bytes);
      // Resident bytes are the data's footprint, which loading sets. Later phases only add to it.
      if (phase === 'load') past('resident bytes', fit.resident, order.resident ?? order.bytes);
      for (const n of at) {
        const now = bySize[n]![phase]!;
        const where = `${scenario.name} at ${n}, ${phase}`;
        const baseline: Partial<Summary['work']> = base.work?.[scenario.name]?.[n]?.[phase] ?? {};
        for (const [k, was] of Object.entries(baseline) as [keyof Summary['work'], number][]) {
          const is = now.work[k];
          const floor = BYTES.has(k) ? WORK_FLOOR.bytes : WORK_FLOOR.count;
          const exact = !now.steady && !scenario.fetches && EXACT.has(k);
          const most = exact ? was : Math.max(was, floor) * STEADY;
          if (is > most) failures.push(`${where}: ${k} ${is}, was ${was}`);
          else if (is < was) notes.push(`${where}: ${k} ${is}, was ${was}; --update records it`);
        }
        const then = sameMachine ? base.times!.times[scenario.name]?.[n]?.[phase] : undefined;
        const floor = now.steady ? FLOOR.frame : TICK;
        if (then && now.time > then.time * SLOWER + floor)
          failures.push(`${where}: ${now.time.toFixed(2)} ms, was ${then.time.toFixed(2)}`);
        else if (then && now.time < then.time / SLOWER)
          notes.push(
            `${where}: ${now.time.toFixed(2)} ms, was ${then.time.toFixed(2)}; --update records it`,
          );
      }
    }
  }
  return { failures, notes, summaries, exponents };
}

const map = <T>(v: Verdict, read: (s: Summary) => T): By<T> =>
  Object.fromEntries(
    Object.entries(v.summaries).map(([s, bySize]) => [
      s,
      Object.fromEntries(
        Object.entries(bySize).map(([n, byPhase]) => [
          n,
          Object.fromEntries(Object.entries(byPhase).map(([p, x]) => [p, read(x)])),
        ]),
      ),
    ]),
  );

/** Merges `run` into `base`. Each scenario size this run measured replaces the base's entry, and
 * the rest is kept. */
function over<T>(run: By<T>, base: By<T> = {}): By<T> {
  const out = structuredClone(base);
  for (const [scenario, bySize] of Object.entries(run))
    Object.assign((out[scenario] ??= {}), bySize);
  return out;
}

/** The new work baseline: this run's work merged into `base`. */
export function work(v: Verdict, base?: WorkBaseline): WorkBaseline {
  const measured = map(v, (s) => s.work);
  return over(measured, base);
}

/** The new times baseline for `machine`: this run's times merged into `base` if `base` was taken
 * on the same machine, else this run's times alone. */
export function times(v: Verdict, machine: string, base?: TimeBaseline): TimeBaseline {
  const measured = map(v, (s) => ({ time: s.time, gpu: s.gpu }));
  return { machine, times: over(measured, base?.machine === machine ? base.times : undefined) };
}
