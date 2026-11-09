/**
 * Judges the runs. These rules hold on any machine: no errors, no frames drawn while idle, no
 * pipeline compiled at first use, resident data within its budget, no phase growing faster than its
 * order, and no more work than the work baseline.
 *
 * Frames are stepped, each waiting for the GPU. So in a phase that acts once and settles, the
 * `EXACT` counts, which only the data and the frames drawn set, may not exceed the baseline at all,
 * unless the scenario fetches its data. Other counts, and every count of a steady phase, vary with
 * the frame a job finishes in, so they may reach `STEADY` times the baseline, and `FETCHED` times
 * in a scenario that fetches. WebAssembly memory may reach `SLOWER` times the baseline, plus a
 * mebibyte, or `FETCHED` times where fetches land at different times.
 *
 * On the GPU the times baseline was taken on, no phase's fastest repeat may be much slower than its
 * baseline: its time, its GPU time per frame, and its slowest frames. A machine stall slows one
 * repeat, but a regression slows every one. The allowances are those two sweeps of the same code
 * measured apart, with room to spare.
 *
 * Every phase measured needs a baseline. One without fails, unless this run records it with
 * `--update`, or the scenario reached a size larger than any its baseline has, as a faster machine
 * can.
 */
import type { Work } from 'latkit';
import { quantile } from '../npm/examples/gate/quantile.ts';
import type { Listed, Run } from './page/main.ts';

/** A phase at one size, summarized across repeats: its fastest times and its least work. */
export interface Summary {
  /** Milliseconds: CPU time per frame for a steady phase, else the whole phase. */
  time: number;
  /** GPU milliseconds per frame, or 0 where the device cannot measure it. */
  gpu: number;
  /** A steady phase's 95th percentile of CPU time per frame: its slowest frames. */
  tail: number;
  steady: boolean;
  /** Median frames drawn. */
  frames: number;
  work: Work & { resident: number; heap: number };
}

type By<T> = Record<string, Record<number, Record<string, T>>>;
export type WorkBaseline = By<Summary['work']>;
export interface TimeBaseline {
  /** The GPU and browser the times were taken on. */
  machine: string;
  times: By<{ time: number; gpu: number; tail: number }>;
}
export type Growth = Partial<Record<'time' | 'gpu' | 'uploaded' | 'resident' | 'heap', number>>;
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
/** Milliseconds loading may finish later than its baseline, beyond `SLOWER`. Loading waits on
 * compiles and browser tasks, so between sweeps it finishes as much as 70 ms either side. */
const LOADING = 5 * TICK;
/** Factor by which a steady phase's slowest frames may be slower than the baseline's. Few frames
 * set them, so they vary more than the median. */
const TAIL = 1.5;
/** Factor and milliseconds by which a steady phase's GPU time per frame may exceed the baseline.
 * The GPU lowers its clocks between stepped frames, so between sweeps its time per frame varies
 * from a third to over four times, a few milliseconds at most. A blowup still shows. */
const GPU = { slower: 3, floor: 1 };
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
/** Factor by which other work counts may exceed the baseline. The frame a job finishes in changes
 * the label texts set by up to about 1.7×. A per-frame blowup changes far more. */
const STEADY = 2;
/** Factor by which other work counts, and memory, may exceed the baseline in a scenario that
 * fetches. When tiles land decides what is replaced: the bytes freed vary by over 2×. */
const FETCHED = 3;
/** Minimum baseline values for work held within `STEADY`: one for byte counts, one for the rest. */
const WORK_FLOOR = { bytes: 64 * 1024, count: 8 };
const BYTES = new Set(['uploaded', 'written', 'resident', 'heap']);
const MIB = 2 ** 20;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mib = (n: number) => `${(n / MIB).toFixed(1)} MiB`;

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
      const work = costs.map((c) => ({ ...c.work, resident: c.resident, heap: c.heap }));
      ((out[scenario] ??= {})[size] ??= {})[phase] = {
        steady,
        time: Math.min(...costs.map((c) => (steady ? c.cpu : c.ms))),
        gpu: Math.min(...costs.map((c) => c.gpu)),
        tail: steady ? Math.min(...costs.map((c) => c.cpu95)) : 0,
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
  base: {
    work?: WorkBaseline;
    /** This GPU's times, on a run that judges times. */
    times?: TimeBaseline;
    /** Whether times are judged: a full sweep on a GPU. */
    timed: boolean;
    /** Whether this run records the baselines, so a missing one is only noted. */
    updating: boolean;
  },
): Verdict {
  const failures: string[] = [];
  const notes: string[] = [];
  /** Reports a phase measured without a baseline. */
  const unrecorded = (what: string, recorded: Record<number, unknown> | undefined, n: number) => {
    const largest = Math.max(0, ...Object.keys(recorded ?? {}).map(Number));
    const message = `${what}: no baseline; --update records it`;
    (base.updating || (largest > 0 && n > largest) ? notes : failures).push(message);
  };
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
  if (base.times && base.times.machine !== runs[0]?.machine)
    notes.push(
      `times were recorded on ${base.times.machine}, and this run is on ${runs[0]?.machine}`,
    );
  const steadyTimes = Object.values(summaries).flatMap((bySize) =>
    Object.values(bySize).flatMap((byPhase) => Object.values(byPhase).filter((s) => s.steady)),
  );
  if (base.timed && steadyTimes.length && steadyTimes.every((s) => !s.gpu))
    failures.push('the GPU reported no frame times, so GPU time was not judged');
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
        heap: grows((s) => s.work.heap, FLOOR.bytes),
      };
      (exponents[scenario.name] ??= {})[phase] = fit;
      const past = (what: string, e: number | undefined, limit: number | undefined) => {
        if (e !== undefined && limit !== undefined && e > limit + SLACK)
          failures.push(
            `${scenario.name} ${phase}: ${what} grows as n^${e.toFixed(2)}, past n^${limit}`,
          );
      };
      past('time', fit.time, order.time);
      // Only a steady phase measures GPU time per frame. A frame draws what is in view, so it may
      // grow linearly unless the phase says otherwise.
      if (steady && base.timed) past('GPU time', fit.gpu, order.gpu ?? 1);
      past('uploaded bytes', fit.uploaded, order.bytes);
      // Resident bytes and memory are the data's footprint, which loading sets. Later phases only
      // add to it.
      if (phase === 'load') {
        past('resident bytes', fit.resident, order.resident ?? order.bytes);
        past('WebAssembly memory', fit.heap, order.resident ?? order.bytes);
      }
      for (const n of at) {
        const now = bySize[n]![phase]!;
        const where = `${scenario.name} at ${n}, ${phase}`;
        const recorded = base.work?.[scenario.name];
        const baseline = recorded?.[n]?.[phase];
        if (!baseline) unrecorded(`${where} work`, recorded, n);
        for (const [k, was] of Object.entries(baseline ?? {}) as [
          keyof Summary['work'],
          number,
        ][]) {
          const is = now.work[k];
          const floor = BYTES.has(k) ? WORK_FLOOR.bytes : WORK_FLOOR.count;
          const exact = !now.steady && !scenario.fetches && EXACT.has(k);
          const most = exact
            ? was
            : scenario.fetches
              ? Math.max(was, floor) * FETCHED
              : k === 'heap'
                ? was * SLOWER + MIB
                : Math.max(was, floor) * STEADY;
          if (is > most) failures.push(`${where}: ${k} ${is}, was ${was}`);
          else if (is < was && k !== 'heap')
            notes.push(`${where}: ${k} ${is}, was ${was}; --update records it`);
        }
        if (!base.times) continue;
        const timesOf = base.times.times[scenario.name];
        const then = timesOf?.[n]?.[phase];
        if (!then) {
          unrecorded(`${where} time`, timesOf, n);
          continue;
        }
        const floor = now.steady
          ? FLOOR.frame
          : phase === 'load' || phase === 'init'
            ? LOADING
            : TICK;
        const compare = (what: string, is: number, was: number, factor: number, least: number) => {
          if (!is || !was) return;
          const show = (ms: number) => `${ms.toFixed(2)} ms`;
          if (is > was * factor + least)
            failures.push(`${where}: ${what} ${show(is)}, was ${show(was)}`);
          else if (is < was / factor)
            notes.push(`${where}: ${what} ${show(is)}, was ${show(was)}; --update records it`);
        };
        compare(now.steady ? 'CPU per frame' : 'time', now.time, then.time, SLOWER, floor);
        if (now.steady) {
          compare('GPU per frame', now.gpu, then.gpu, GPU.slower, GPU.floor);
          compare('slowest frames', now.tail, then.tail, TAIL, 2 * FLOOR.frame);
        }
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

/** The new times baseline of this GPU: this run's times merged into `base`, now taken on
 * `machine`. */
export function times(v: Verdict, machine: string, base?: TimeBaseline): TimeBaseline {
  const measured = map(v, (s) => ({ time: s.time, gpu: s.gpu, tail: s.tail }));
  return { machine, times: over(measured, base?.times) };
}
