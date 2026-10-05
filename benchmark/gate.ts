/**
 * The benchmark regression gate.
 *
 *   node benchmark/gate.ts base.json head.json   check head against benchmark/work.json
 *   node benchmark/gate.ts --update              record this run's work as benchmark/work.json
 *
 * It fails only when exact work per run grows. Timings vary between runs, even on one machine, so it
 * reports benchmarks that ran slower than the base branch, and time per item that grows faster than
 * linearly with size, without failing.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

type Work = Record<string, Record<string, number>>;
interface Benchmark {
  readonly name: string;
  readonly min: number;
  readonly median: number;
}
interface Report {
  readonly files: readonly {
    readonly groups: readonly {
      readonly fullName: string;
      readonly benchmarks: readonly Benchmark[];
    }[];
  }[];
}

const SLOWER = 1.25,
  SLACK_MS = 0.02,
  // Across a 100× size range, cache misses alone can double the time per item; quadratic work
  // multiplies it by a hundred.
  SUPERLINEAR = 3;
const committed = new URL('./work.json', import.meta.url),
  results = new URL('./.results/work/', import.meta.url);

/** This run's work, merged from every group's file. */
function measured(): Work {
  if (!existsSync(results)) return {};
  return Object.assign(
    {},
    ...readdirSync(results).map(
      (file) => JSON.parse(readFileSync(new URL(file, results), 'utf8')) as Work,
    ),
  ) as Work;
}
/** Timings in milliseconds by `group > benchmark`. */
function timings(path: string): Map<string, Benchmark> {
  const report = JSON.parse(readFileSync(path, 'utf8')) as Report,
    result = new Map<string, Benchmark>();
  for (const file of report.files)
    for (const group of file.groups) {
      const name = group.fullName.split(' > ').at(-1)!;
      for (const benchmark of group.benchmarks) {
        if (!Number.isFinite(benchmark.min) || !Number.isFinite(benchmark.median))
          throw new Error(`Benchmark did not complete: ${name} > ${benchmark.name}`);
        result.set(name + ' > ' + benchmark.name, benchmark);
      }
    }
  return result;
}

if (process.argv[2] === '--update') {
  const work = measured();
  writeFileSync(committed, JSON.stringify(sort(work), null, 2) + '\n');
  console.log('Recorded work for ' + Object.keys(work).length + ' benchmarks.');
  process.exit(0);
}

const [basePath, headPath] = process.argv.slice(2),
  failures: string[] = [],
  notes: string[] = [],
  timed: string[] = [];

// 1. Exact work per run may not grow.
const expected = existsSync(committed) ? (JSON.parse(readFileSync(committed, 'utf8')) as Work) : {},
  work = measured();
for (const [name, counters] of Object.entries(expected)) {
  const now = work[name];
  if (!now) {
    notes.push('no work recorded: ' + name);
    continue;
  }
  for (const [counter, value] of Object.entries(counters)) {
    const current = now[counter] ?? 0;
    if (current > value) failures.push(`work ${name}: ${counter} ${value} → ${current}`);
    else if (current < value) notes.push(`less work ${name}: ${counter} ${value} → ${current}`);
  }
}
for (const name of Object.keys(work))
  if (!expected[name]) notes.push('new benchmark without recorded work: ' + name);

// 2. Time against the base branch, measured on the same machine. Noise rarely slows both the fastest
// and the median run.
const head = timings(headPath);
if (basePath && existsSync(basePath)) {
  const base = timings(basePath),
    slower = (now: number, before: number) => now > before * SLOWER + SLACK_MS;
  for (const [name, time] of head) {
    const before = base.get(name);
    if (before && slower(time.min, before.min) && slower(time.median, before.median))
      timed.push(`slower ${name}: ${before.median.toFixed(3)} → ${time.median.toFixed(3)} ms`);
  }
} else notes.push('no base timings; skipped the comparison against the base branch');

// 3. Time per item may grow at most 3× from the smallest to the largest size.
const scaled = new Map<string, { size: number; perItem: number }[]>();
for (const [name, { median: time }] of head) {
  // Groups are named `<package> <size> <unit>`, such as `network 100000 buses`.
  const match = /^(.*?) (\d+) (\w+) > (.*)$/.exec(name);
  if (!match) continue;
  const key = match[1] + ' ' + match[3] + ' > ' + match[4],
    size = Number(match[2]);
  scaled.set(key, [...(scaled.get(key) ?? []), { size, perItem: time / size }]);
}
for (const [name, points] of scaled) {
  if (points.length < 2) continue;
  points.sort((a, b) => a.size - b.size);
  const first = points[0],
    last = points.at(-1)!;
  if (last.perItem > first.perItem * SUPERLINEAR)
    timed.push(
      `superlinear ${name}: ${(first.perItem * 1e6).toFixed(1)} → ${(last.perItem * 1e6).toFixed(1)} ns per item`,
    );
}

for (const note of notes) console.log(note);
if (timed.length)
  console.log('Timings to check by hand; one run can differ by 2×:\n' + timed.join('\n'));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Benchmarks pass: ${head.size} timed, ${Object.keys(work).length} with recorded work.`);

function sort(work: Work): Work {
  return Object.fromEntries(Object.entries(work).sort(([a], [b]) => a.localeCompare(b)));
}
