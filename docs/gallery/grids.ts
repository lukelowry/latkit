/**
 * The synthetic grid cases the example suite fetches from `npm/examples/public/grids`, read into one
 * dataset named `grid`: buses with their voltage level, branches between them, machines, and where
 * a case simulated a fault, each machine's speed frame by frame. The format is the suite's own: a
 * "LKG1" magic, a JSON header, and typed arrays it places.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Patch, reference } from 'latkit/core';

interface Header {
  readonly case: string;
  readonly buses: number;
  readonly branches: number;
  readonly machines: number;
  readonly frames?: number;
  readonly dt?: number;
  readonly speedScale?: number;
  readonly fault?: { readonly bus: number; readonly on: number; readonly off: number };
  readonly arrays: Readonly<
    Record<string, readonly [type: string, offset: number, length: number]>
  >;
}

export interface Case {
  readonly name: string;
  readonly header: Header;
  readonly patch: Patch;
  /** Each bus's longitude and latitude, back to back. */
  readonly positions: Float32Array;
  /** Each machine's bus row. */
  readonly machineBus: Uint32Array;
  /** One of the case's arrays by name, such as `branch.reactance`. */
  readonly array: <T>(name: string, of: new (b: ArrayBuffer, o: number, l: number) => T) => T;
}

/** A voltage level: 0 below 100 kV, then 115–161, 230, 345, 500, and 765 kV. */
export function levelOf(kv: number): number {
  return kv >= 700 ? 5 : kv >= 450 ? 4 : kv >= 300 ? 3 : kv >= 200 ? 2 : kv >= 100 ? 1 : 0;
}

export function readCase(id: string): Case {
  const file = fileURLToPath(new URL(`../../npm/examples/public/grids/${id}.bin`, import.meta.url));
  const raw = fs.readFileSync(file);
  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x31474b4c) throw new Error(`${id} is not a grid case`);
  const length = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length))) as Header;
  const body = Math.ceil((8 + length) / 8) * 8;
  const array = <T>(name: string, of: new (b: ArrayBuffer, o: number, l: number) => T): T => {
    const found = header.arrays[name];
    if (!found) throw new Error(`${id} has no ${name}`);
    return new of(buffer, body + found[1], found[2]);
  };
  const names = (name: string): string[] => {
    const offsets = array(`${name}.offsets`, Uint32Array);
    const text = array(`${name}.bytes`, Uint8Array);
    const decoder = new TextDecoder();
    return Array.from({ length: offsets.length - 1 }, (_, i) =>
      decoder.decode(text.subarray(offsets[i]!, offsets[i + 1]!)),
    );
  };
  const [n, m, g] = [header.buses, header.branches, header.machines];
  const position = array('bus.position', Float32Array);
  const kv = array('bus.kv', Float32Array);
  const ends = array('branch.ends', Uint32Array);
  const machineBus = array('machine.bus', Uint32Array);
  const generation = array('bus.generation', Float32Array);
  const from = new Uint32Array(m);
  const to = new Uint32Array(m);
  const lineKv = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    [from[e], to[e]] = [ends[2 * e]!, ends[2 * e + 1]!];
    lineKv[e] = Math.max(kv[from[e]!]!, kv[to[e]!]!);
  }
  const lon = Float64Array.from({ length: n }, (_, b) => position[2 * b]!);
  const lat = Float64Array.from({ length: n }, (_, b) => position[2 * b + 1]!);
  const patch = Patch.to('grid')
    .replace(
      'Bus',
      { count: n },
      {
        lon,
        lat,
        name: names('bus.name'),
        kv,
        level: Float32Array.from(kv, levelOf),
        load: array('bus.load', Float32Array),
        generation,
      },
    )
    .replace(
      'Line',
      { count: m },
      {
        from: reference('Bus', from),
        to: reference('Bus', to),
        kv: lineKv,
        level: Float32Array.from(lineKv, levelOf),
      },
    )
    .replace(
      'Machine',
      { count: g },
      {
        lon: Float64Array.from(machineBus, (b) => lon[b]!),
        lat: Float64Array.from(machineBus, (b) => lat[b]!),
        power: array('machine.power', Float32Array),
        mva: array('machine.mva', Float32Array),
      },
    );
  if (header.frames !== undefined && header.dt !== undefined) {
    // Per unit of 60 Hz, in mHz.
    const scale = (header.speedScale ?? 1) * 60_000;
    const speeds = Float32Array.from(array('machine.speed', Int16Array), (v) => v * scale);
    patch.axis('time', 's');
    for (let f = 0; f < header.frames; f++)
      patch.append(f * header.dt, 'Machine', { speed: speeds.subarray(f * g, (f + 1) * g) });
  }
  return { name: header.case, header, patch, positions: position, machineBus, array };
}
