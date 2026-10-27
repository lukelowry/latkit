/**
 * Reads the synthetic grid cases that the example suite fetches from `npm/examples/public/grids`
 * into one dataset named `grid`. It holds buses with their voltage level, the lines between them,
 * machines, and, for a case that simulated a fault, each machine's speed per frame. The suite's
 * `format.ts` describes the files and reads them.
 */
import fs from 'node:fs';
import { Data, reference } from 'latkit';
import { inflate, parseCase, type CaseFile } from '../../npm/examples/src/pages/grids/format.ts';

/** A case's arrays, and its dataset `grid`. */
export interface Case extends CaseFile {
  readonly grid: Data;
}

export async function readCase(id: string): Promise<Case> {
  const file = new URL(`../../npm/examples/public/grids/${id}.bin`, import.meta.url);
  const c = parseCase(id, await inflate(fs.readFileSync(file)));
  const machineLon = Float64Array.from(c.machineBus, (b) => c.lon[b]!);
  const machineLat = Float64Array.from(c.machineBus, (b) => c.lat[b]!);
  const grid = new Data('grid')
    .replace('Bus', {
      lon: c.lon,
      lat: c.lat,
      name: c.names('bus.name'),
      kv: c.kv,
      level: c.level,
      load: c.array('bus.load', Float32Array),
      generation: c.array('bus.generation', Float32Array),
    })
    .replace('Line', {
      from: reference('Bus', c.from),
      to: reference('Bus', c.to),
      kv: c.lineKv,
      level: c.lineLevel,
    })
    .replace('Machine', {
      lon: machineLon,
      lat: machineLat,
      power: c.array('machine.power', Float32Array),
      mva: c.array('machine.mva', Float32Array),
    });
  if (c.simulation) {
    const { frames, dt, speeds } = c.simulation;
    const times = Array.from({ length: frames }, (_, f) => f * dt);
    grid.axis('time', 's').append('Machine', times, { speed: speeds });
  }
  return { ...c, grid };
}
