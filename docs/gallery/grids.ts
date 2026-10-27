/**
 * Reads the synthetic grid cases that the example suite fetches from `npm/examples/public/grids`
 * into one dataset named `grid`. It holds buses with their voltage level, the branches between
 * them, machines, and, for a case that simulated a fault, each machine's speed per frame. The
 * suite's `format.ts` describes the files and reads them.
 */
import fs from 'node:fs';
import { Patch, reference } from 'latkit';
import {
  inflate,
  parseCase,
  type CaseFile,
} from '../../npm/examples/src/examples/networks/format.ts';

/** A case, with its dataset `grid` written as a patch. */
export interface Case extends CaseFile {
  readonly patch: Patch;
}

export async function readCase(id: string): Promise<Case> {
  const file = new URL(`../../npm/examples/public/grids/${id}.bin`, import.meta.url);
  const c = parseCase(id, await inflate(fs.readFileSync(file)));
  const { buses: n, branches: m, machines: g } = c.header;
  const patch = new Patch('grid')
    .replace(
      'Bus',
      { count: n },
      {
        lon: c.lon,
        lat: c.lat,
        name: c.names('bus.name'),
        kv: c.kv,
        level: c.level,
        load: c.array('bus.load', Float32Array),
        generation: c.array('bus.generation', Float32Array),
      },
    )
    .replace(
      'Line',
      { count: m },
      {
        from: reference('Bus', c.from),
        to: reference('Bus', c.to),
        kv: c.lineKv,
        level: c.lineLevel,
      },
    )
    .replace(
      'Machine',
      { count: g },
      {
        lon: Float64Array.from(c.machineBus, (b) => c.lon[b]!),
        lat: Float64Array.from(c.machineBus, (b) => c.lat[b]!),
        power: c.array('machine.power', Float32Array),
        mva: c.array('machine.mva', Float32Array),
      },
    );
  if (c.simulation) {
    const { frames, dt, speeds } = c.simulation;
    patch.axis('time', 's');
    for (let f = 0; f < frames; f++)
      patch.append('Machine', f * dt, { speed: speeds.subarray(f * g, (f + 1) * g) });
  }
  return { ...c, patch };
}
