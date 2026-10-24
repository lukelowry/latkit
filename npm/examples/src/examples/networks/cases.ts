/**
 * Synthetic grid cases, as the page fetches them from `public/grids`, each gzip-compressed.
 *
 * A case file holds a "LKG1" magic and a u32 header length, then a JSON header naming the case and
 * its counts, then typed arrays on eight-byte boundaries past the header, where its `arrays` place
 * them as [type, offset, length]: each bus's number, name, kV, longitude and latitude, load and
 * generation in MW; each branch's two bus rows, reactance, and whether it transforms; each machine's
 * bus row, name, rating, and output. Simulated cases also hold each machine's speed deviation, frame
 * by frame as int16 of `speedScale` per unit, `dt` seconds apart, and the fault the simulation
 * applied.
 */
import { Data, Patch, reference } from 'latkit';

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

/** A case's simulation: each machine's speed deviation over the seconds simulated. */
export interface Simulation {
  readonly frames: number;
  readonly dt: number;
  readonly duration: number;
  /** Speed deviation in mHz, frame by frame, a value per machine. */
  readonly speeds: Float32Array;
  /** The largest deviation, in mHz, either way. */
  readonly largest: number;
  readonly fault?: { readonly bus: string; readonly on: number; readonly off: number };
}

export interface Case {
  readonly data: Data;
  readonly name: string;
  readonly buses: number;
  readonly lines: number;
  readonly machines: number;
  /** Bytes downloaded, compressed. */
  readonly bytes: number;
  /** Whether its buses have names, which labels show. */
  readonly named: boolean;
  /** Each bus's longitude and latitude, and its load and generation in MW. */
  readonly positions: Float32Array;
  readonly load: Float32Array;
  readonly generation: Float32Array;
  /** Each machine's bus row, and its output in MW. */
  readonly machineBus: Uint32Array;
  readonly machinePower: Float32Array;
  readonly simulation?: Simulation;
}

/** A bus's or line's voltage level: 0 below 100 kV, then 115–161, 230, 345, 500, and 765 kV. */
export function levelOf(kv: number): number {
  return kv >= 700 ? 5 : kv >= 450 ? 4 : kv >= 300 ? 3 : kv >= 200 ? 2 : kv >= 100 ? 1 : 0;
}
export const LEVELS = ['< 100 kV', '115–161 kV', '230 kV', '345 kV', '500 kV', '765 kV'] as const;

const MAGIC = 0x31474b4c;
const text = new TextDecoder();

/** A case file's bytes, read into one dataset named `grid`: buses, lines, machines, and the fault. */
export function readCase(id: string, buffer: ArrayBuffer, downloaded = buffer.byteLength): Case {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== MAGIC)
    throw new Error(`${id} is not a grid case`);
  const length = view.getUint32(4, true);
  const header = JSON.parse(text.decode(new Uint8Array(buffer, 8, length))) as Header;
  const body = Math.ceil((8 + length) / 8) * 8;
  const array = <T>(name: string, of: new (b: ArrayBuffer, o: number, l: number) => T): T => {
    const found = header.arrays[name];
    if (!found) throw new Error(`${id} has no ${name}`);
    return new of(buffer, body + found[1], found[2]);
  };
  const names = (name: string): string[] => {
    const offsets = array(`${name}.offsets`, Uint32Array);
    const bytes = array(`${name}.bytes`, Uint8Array);
    return Array.from({ length: offsets.length - 1 }, (_, i) =>
      text.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!)),
    );
  };
  const n = header.buses;
  const m = header.branches;
  const g = header.machines;
  const position = array('bus.position', Float32Array);
  const kv = array('bus.kv', Float32Array);
  const number = array('bus.number', Uint32Array);
  const ends = array('branch.ends', Uint32Array);
  const machineBus = array('machine.bus', Uint32Array);
  const load = array('bus.load', Float32Array);
  const generation = array('bus.generation', Float32Array);
  const machinePower = array('machine.power', Float32Array);
  const busNames = names('bus.name');
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    lon[b] = position[b * 2]!;
    lat[b] = position[b * 2 + 1]!;
  }
  const from = new Uint32Array(m);
  const to = new Uint32Array(m);
  const lineKv = new Float32Array(m);
  const transformer = Array.from(array('branch.transformer', Uint8Array), (v) => v !== 0);
  for (let e = 0; e < m; e++) {
    const a = ends[e * 2]!;
    const b = ends[e * 2 + 1]!;
    from[e] = number[a]!;
    to[e] = number[b]!;
    lineKv[e] = Math.max(kv[a]!, kv[b]!);
  }
  const machineLon = new Float64Array(g);
  const machineLat = new Float64Array(g);
  for (let k = 0; k < g; k++) {
    machineLon[k] = lon[machineBus[k]!]!;
    machineLat[k] = lat[machineBus[k]!]!;
  }
  const simulated = header.frames !== undefined && header.dt !== undefined;
  const fault = simulated ? header.fault : undefined;
  const patch = new Patch()
    .set('Bus', number, {
      lon,
      lat,
      name: busNames,
      number: Float64Array.from(number),
      kv,
      level: Float32Array.from(kv, levelOf),
      load,
      generation,
    })
    .set(
      'Line',
      { count: m },
      {
        from: reference('Bus', from),
        to: reference('Bus', to),
        kv: lineKv,
        level: Float32Array.from(lineKv, levelOf),
        reactance: array('branch.reactance', Float32Array),
        transformer,
      },
    )
    .set(
      'Machine',
      { count: g },
      {
        lon: machineLon,
        lat: machineLat,
        name: names('machine.name'),
        power: machinePower,
        mva: array('machine.mva', Float32Array),
      },
    );
  if (fault) patch.set('Fault', { count: 1 }, { lon: [lon[fault.bus]!], lat: [lat[fault.bus]!] });
  let simulation: Simulation | undefined;
  if (simulated) {
    const frames = header.frames!;
    const dt = header.dt!;
    // Per unit of 60 Hz, in mHz.
    const scale = (header.speedScale ?? 1) * 60_000;
    const speeds = Float32Array.from(array('machine.speed', Int16Array), (value) => value * scale);
    patch.axis('time', 's');
    for (let f = 0; f < frames; f++)
      patch.append('Machine', f * dt, { speed: speeds.subarray(f * g, (f + 1) * g) });
    simulation = {
      frames,
      dt,
      duration: (frames - 1) * dt,
      speeds,
      largest: 32767 * scale,
      ...(fault
        ? {
            fault: { bus: busNames[fault.bus] ?? `bus ${fault.bus}`, on: fault.on, off: fault.off },
          }
        : {}),
    };
  }
  return {
    data: new Data('grid').apply(patch),
    name: header.case,
    buses: n,
    lines: m,
    machines: g,
    bytes: downloaded,
    named: true,
    positions: position,
    load,
    generation,
    machineBus,
    machinePower,
    ...(simulation ? { simulation } : {}),
  };
}

/** How far a download has come: bytes received, of how many when the response says. */
export type Progress = (received: number, total: number | undefined) => void;

/** Megabytes received, of how many when known, for a status line. */
export const megabytes = (received: number, total: number | undefined) =>
  `${(received / 1e6).toFixed(1)}${total ? ` of ${(total / 1e6).toFixed(1)}` : ''} MB`;

/**
 * A file's bytes, inflated where they arrive gzip-compressed, and how many arrived; `progress`
 * hears of each chunk. A total the response gives that counts fewer bytes than arrive, as a
 * compressed transfer's does, goes untold.
 */
export async function download(
  url: string,
  signal: AbortSignal,
  progress?: Progress,
): Promise<{ readonly bytes: Uint8Array; readonly received: number }> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
  });
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  const total = Number(response.headers.get('content-length')) || undefined;
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    chunks.push(read.value);
    received += read.value.length;
    progress?.(received, total !== undefined && total >= received ? total : undefined);
  }
  const bytes = new Uint8Array(received);
  chunks.reduce((at, chunk) => (bytes.set(chunk, at), at + chunk.length), 0);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { bytes, received: bytes.length };
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return {
    bytes: new Uint8Array(await new Response(inflated).arrayBuffer()),
    received: bytes.length,
  };
}

export async function loadCase(
  id: string,
  signal: AbortSignal,
  progress?: Progress,
): Promise<Case> {
  const url = `${import.meta.env.BASE_URL}grids/${id}.bin`;
  const { bytes, received } = await download(url, signal, progress);
  return readCase(id, bytes.buffer as ArrayBuffer, received);
}
