/**
 * Writes `opening.frequency.gz`, which sets each bus's height in the line opening picture. It holds
 * each bus's frequency deviation from 60 Hz at one instant of the branch-opening study's recording
 * (`crates/latkit-cli/examples/branch-opening`), in ACTIVSg70k's bus order, as 16-bit integers in
 * units of 10 µHz. The recording is 168 MB, too large for the repository. One instant is 140 kB.
 *
 *   node docs/gallery/record.ts [seconds] [study]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readCase } from './grids.ts';

interface Metadata {
  readonly bus_ids: readonly number[];
  readonly times: readonly number[];
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const [seconds = '2.5', study = path.join(root, 'target/branch-opening')] = process.argv.slice(2);
const run = path.join(study, 'runs/little-rock-60hz');
const meta = JSON.parse(
  fs.readFileSync(path.join(run, 'frequency_metadata.json'), 'utf8'),
) as Metadata;
const frame = meta.times.findIndex((t) => t >= Number(seconds));
const count = meta.bus_ids.length;
const bytes = Buffer.alloc(count * 4);
const file = fs.openSync(path.join(run, 'frequency.f32'), 'r');
fs.readSync(file, bytes, 0, bytes.length, frame * bytes.length);
fs.closeSync(file);
const hz = new Float32Array(bytes.buffer, bytes.byteOffset, count);

const c = await readCase('activsg70k');
const number = c.array('bus.number', Uint32Array);
const row = new Map(meta.bus_ids.map((id, i) => [id, i]));
const out = Int16Array.from(number, (id) => {
  const i = row.get(id);
  if (i === undefined) throw new Error(`the recording has no bus ${id}`);
  return Math.max(-32767, Math.min(32767, Math.round(hz[i]! * 1e5)));
});
const target = fileURLToPath(new URL('opening.frequency.gz', import.meta.url));
fs.writeFileSync(target, gzipSync(Buffer.from(out.buffer), { level: 9 }));
console.log(
  `${path.relative(root, target)}: ${meta.times[frame]!.toFixed(3)} s, ${(fs.statSync(target).size / 1024).toFixed(0)} kB`,
);
