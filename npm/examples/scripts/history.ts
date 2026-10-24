/**
 * Writes the recorded day the Live data page reads as time tiles, into `public/history/`: the voltages
 * of 64 buses in six areas, every 15 s for a day, as a load curve swings them and three disturbances
 * pull areas down and recover. Deterministic: run it again and the same bytes come out. Run it from
 * the examples with `node scripts/history.ts`; it tiles the day with the repository's `latkit tile`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Patch } from 'latkit';

/** Buses, the areas they lie in, and seconds between samples, over a day. */
const BUSES = 64;
const AREAS = ['North', 'South', 'East', 'West', 'Coast', 'Valley'];
const EVERY = 15;
const DAY = 24 * 60 * 60;
/** When each disturbance strikes, the area it strikes, and how deep it pulls. */
const DISTURBANCES = [
  { at: 9.2 * 3600, area: 2, depth: 0.05 },
  { at: 13.8 * 3600, area: 4, depth: 0.07 },
  { at: 18.5 * 3600, area: 0, depth: 0.06 },
];

/** Deterministic numbers in [0, 1), as the examples' `random` makes them. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The system's load at second `t` of the day, from 0 to 1: low at night, peaking morning and evening. */
function load(t: number): number {
  const hour = t / 3600;
  const peak = (at: number, width: number) => Math.exp(-(((hour - at) / width) ** 2));
  return (
    0.35 + 0.35 * peak(8.5, 2.5) + 0.45 * peak(19, 3) + 0.1 * Math.sin((hour / 24) * 2 * Math.PI)
  );
}

/** How far a disturbance pulls an area down, `since` seconds after it struck. */
function dip(since: number, depth: number): number {
  return since < 0 ? 0 : depth * Math.exp(-since / 240) * Math.min(1, since / 20);
}

const next = random(17);
const area = Float64Array.from({ length: BUSES }, (_, i) => i % AREAS.length);
const name = Array.from(
  { length: BUSES },
  (_, i) => `${AREAS[i % AREAS.length]} ${Math.floor(i / AREAS.length) + 1}`,
);
const offset = Float32Array.from({ length: BUSES }, () => next() - 0.5);
const at = Array.from({ length: DAY / EVERY }, (_, k) => k * EVERY);
const values = new Float32Array(at.length * BUSES);
for (const [k, t] of at.entries()) {
  const swing = load(t);
  for (let i = 0; i < BUSES; i++) {
    const a = area[i]!;
    const struck = DISTURBANCES.filter((d) => d.area === a).reduce(
      (sum, d) => sum + dip(t - d.at, d.depth),
      0,
    );
    const noise = (next() - 0.5) * 0.004;
    values[k * BUSES + i] =
      1.03 + 0.025 * offset[i]! - 0.06 * swing - (0.01 * a * swing) / 5 - struck + noise;
  }
}
const day = new Patch('scada')
  .axis('time', 's')
  .set('Signal', { count: BUSES }, { name, area })
  .append('Signal', at, { value: values });

const examples = path.resolve(import.meta.dirname, '..');
const out = path.join(examples, 'public', 'history');
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'latkit-history-')), 'day.latk');
fs.writeFileSync(file, day.toBytes());
fs.rmSync(out, { recursive: true, force: true });
execFileSync(
  'cargo',
  ['run', '--quiet', '-p', 'latkit-cli', '--', 'tile', file, '--output', out, '--chunk', '256'],
  { cwd: path.resolve(examples, '../..'), stdio: 'inherit', timeout: 10 * 60_000 },
);
fs.rmSync(path.dirname(file), { recursive: true, force: true });
console.log(`wrote ${out}`);
