/**
 * The documentation's performance table, from a committed baseline: each scenario at the largest
 * size it ran, what opening took, and what a frame took while it moved and was picked from.
 *
 *   node benchmark/docs.ts [baselines/MACHINE.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios } from './page/scenarios.ts';

interface Measured {
  time: number;
  gpu: number;
}
interface Baseline {
  machine: string;
  times: Record<string, Record<string, Record<string, Measured>>>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const baselines = path.join(here, 'baselines');
const file =
  process.argv[2] ??
  path.join(
    baselines,
    fs
      .readdirSync(baselines)
      .filter((f) => f.endsWith('.json') && f !== 'work.json')
      .sort()
      .at(-1)!,
  );
const baseline = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;

/** Phases that run every frame, as the view moves or plays. */
const MOVING = ['pan', 'zoom', 'move', 'scrub', 'narrow', 'stream'];
/** Phases that answer the pointer. */
const PICKING = ['pick', 'hover'];

const ms = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
const most = (phases: Record<string, Measured>, names: string[], of: (m: Measured) => number) => {
  const found = names.filter((n) => phases[n]).map((n) => of(phases[n]!));
  return found.length ? ms(Math.max(...found)) : '';
};
const quote = (cell: string) => (/[",]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

const rows = [['Scenario', 'Largest', 'Open (ms)', 'Frame (ms)', 'GPU (ms)', 'Pick (ms)']];
for (const [name, sizes] of Object.entries(baseline.times)) {
  const scenario = scenarios[name];
  if (!scenario) continue;
  const largest = Object.keys(sizes)
    .map(Number)
    .sort((a, b) => a - b)
    .at(-1)!;
  const phases = sizes[String(largest)]!;
  rows.push([
    scenario.about[0]!.toUpperCase() + scenario.about.slice(1),
    `${largest.toLocaleString('en-US')} ${scenario.unit}`,
    phases.load ? ms(phases.load.time) : '',
    most(phases, MOVING, (m) => m.time),
    most(phases, MOVING, (m) => m.gpu),
    most(phases, PICKING, (m) => m.time),
  ]);
}
const out = path.join(here, '../docs/_static/performance.csv');
fs.writeFileSync(out, rows.map((r) => r.map(quote).join(',')).join('\n') + '\n');
console.log(
  `${path.relative(process.cwd(), out)}: ${rows.length - 1} scenarios on ${baseline.machine}`,
);
