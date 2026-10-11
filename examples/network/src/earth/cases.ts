/**
 * Synthetic grid cases and Natural Earth borders, as the page loads them from `public/grids`, each
 * file gzip-compressed.
 *
 * A case file holds a "LKG1" magic and a u32 header length, then a JSON header naming the case and
 * its counts, then typed arrays on eight-byte boundaries past the header, where its `arrays` place
 * them as [type, offset, length]: each bus's number, name, kV, longitude and latitude, load and
 * generation in MW; each branch's two bus rows, reactance, and whether it transforms; each machine's
 * bus row, name, rating, and output. Simulated cases also hold each machine's speed deviation, frame
 * by frame as int16 of `speedScale` per unit, `dt` seconds apart, and the fault the simulation
 * applied.
 *
 * The borders file holds a u32 header length and a JSON header of layers, each a type and its line
 * and point counts, then every layer's line starts as u32, then every layer's points as float32
 * longitude and latitude: coasts, countries, and provinces.
 */
import { appendData, createData, textColumn, type Data, type Index, type Schema } from '@latkit/model';
import { flags, lists, numeric, references, rows, text, vector } from '../shared/columns.js';
import { download, type Progress } from './download.js';

interface Header {
  readonly case: string;
  readonly buses: number;
  readonly branches: number;
  readonly machines: number;
  readonly frames?: number;
  readonly dt?: number;
  readonly speedScale?: number;
  readonly fault?: { readonly bus: number; readonly on: number; readonly off: number };
  readonly arrays: Readonly<Record<string, readonly [type: string, offset: number, length: number]>>;
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
export interface GridCase {
  readonly data: Data;
  readonly name: string;
  readonly buses: number;
  readonly lines: number;
  readonly machines: number;
  /** Bytes downloaded, compressed. */
  readonly bytes: number;
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
const POSITION = { type: { kind: 'vector', size: 2, items: 'float32' }, geographic: true } as const;
const NUMBER = { type: 'float32' } as const;

/** A case's file, read into one Data value: buses, lines, machines, and the fault, if simulated. */
export function readCase(id: string, buffer: ArrayBuffer, downloaded = buffer.byteLength): GridCase {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error(`${id} is not a grid case`);
  const length = view.getUint32(4, true),
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length))) as Header,
    body = Math.ceil((8 + length) / 8) * 8;
  const array = <T>(name: string, of: new (b: ArrayBuffer, o: number, l: number) => T): T => {
    const found = header.arrays[name];
    if (!found) throw new Error(`${id} has no ${name}`);
    return new of(buffer, body + found[1], found[2]);
  };
  const offsets = (name: string) => {
      const found = array(`${name}.offsets`, Uint32Array);
      return new Int32Array(found.buffer, found.byteOffset, found.length);
    },
    names = (name: string) => text(offsets(name), array(`${name}.bytes`, Uint8Array));
  const n = header.buses,
    m = header.branches,
    g = header.machines,
    index = (type: string): Index => ({ source: `case-${id}`, type, version: '1' }),
    position = array('bus.position', Float32Array),
    kv = array('bus.kv', Float32Array),
    number = array('bus.number', Uint32Array),
    ends = array('branch.ends', Uint32Array),
    machineBus = array('machine.bus', Uint32Array);
  const from = new Uint32Array(m),
    to = new Uint32Array(m),
    lineKv = new Float32Array(m),
    circuits = new Map<string, number>(),
    lineIds: string[] = [];
  for (let e = 0; e < m; e++) {
    const a = ends[e * 2]!,
      b = ends[e * 2 + 1]!,
      pair = `${number[a]}–${number[b]}`,
      circuit = (circuits.get(pair) ?? 0) + 1;
    from[e] = a;
    to[e] = b;
    lineKv[e] = Math.max(kv[a]!, kv[b]!);
    circuits.set(pair, circuit);
    lineIds.push(circuit > 1 ? `${pair} #${circuit}` : pair);
  }
  const machinePosition = new Float32Array(g * 2);
  for (let k = 0; k < g; k++) {
    machinePosition[k * 2] = position[machineBus[k]! * 2]!;
    machinePosition[k * 2 + 1] = position[machineBus[k]! * 2 + 1]!;
  }
  const simulated = header.frames !== undefined && header.dt !== undefined,
    fault = simulated ? header.fault : undefined,
    busNames = names('bus.name');
  const schema: Schema = {
    ...(simulated ? { axis: { name: 'Time', unit: 's' } } : {}),
    types: {
      Bus: {
        fields: {
          position: POSITION,
          name: { type: 'text' },
          number: { type: 'uint32' },
          kv: NUMBER,
          level: NUMBER,
          load: NUMBER,
          generation: NUMBER,
        },
      },
      Line: {
        fields: {
          from: { type: { kind: 'reference', to: 'Bus' } },
          to: { type: { kind: 'reference', to: 'Bus' } },
          kv: NUMBER,
          level: NUMBER,
          reactance: NUMBER,
          transformer: { type: 'boolean' },
        },
      },
      Machine: {
        fields: {
          position: POSITION,
          name: { type: 'text' },
          power: NUMBER,
          mva: NUMBER,
          ...(simulated ? { speed: { type: 'float32', sampled: true } } : {}),
        },
      },
      ...(fault ? { Fault: { fields: { position: POSITION } } } : {}),
    },
  };
  const load = array('bus.load', Float32Array),
    generation = array('bus.generation', Float32Array),
    machinePower = array('machine.power', Float32Array);
  let data = createData(schema, [
    rows(
      index('Bus'),
      n,
      {
        position: vector(position),
        name: busNames,
        number: numeric(number),
        kv: numeric(kv),
        level: numeric(Float32Array.from(kv, levelOf)),
        load: numeric(load),
        generation: numeric(generation),
      },
      textColumn(Array.from(number, String)),
    ),
    rows(
      index('Line'),
      m,
      {
        from: references(index('Bus'), from),
        to: references(index('Bus'), to),
        kv: numeric(lineKv),
        level: numeric(Float32Array.from(lineKv, levelOf)),
        reactance: numeric(array('branch.reactance', Float32Array)),
        transformer: flags(array('branch.transformer', Uint8Array)),
      },
      textColumn(lineIds),
    ),
    rows(index('Machine'), g, {
      position: vector(machinePosition),
      name: names('machine.name'),
      power: numeric(machinePower),
      mva: numeric(array('machine.mva', Float32Array)),
    }),
    ...(fault
      ? [
          rows(index('Fault'), 1, {
            position: vector(position.slice(fault.bus * 2, fault.bus * 2 + 2)),
          }),
        ]
      : []),
  ]);
  let simulation: Simulation | undefined;
  if (simulated) {
    const frames = header.frames!,
      dt = header.dt!,
      // Per unit of 60 Hz, in mHz.
      scale = (header.speedScale ?? 1) * 60_000,
      speeds = Float32Array.from(array('machine.speed', Int16Array), (value) => value * scale);
    data = appendData(data, [
      {
        kind: 'samples',
        index: index('Machine'),
        rows: { kind: 'range', offset: 0, count: g },
        firstFrame: 0,
        coordinates: Float64Array.from({ length: frames }, (_, f) => f * dt),
        columns: { speed: { ...numeric(speeds), frameStride: g, rowStride: 1 } },
      },
    ]);
    simulation = {
      frames,
      dt,
      duration: (frames - 1) * dt,
      speeds,
      largest: 32767 * scale,
      ...(fault
        ? {
            fault: {
              bus: new TextDecoder().decode(
                busNames.bytes.subarray(busNames.offsets[fault.bus], busNames.offsets[fault.bus + 1]),
              ),
              on: fault.on,
              off: fault.off,
            },
          }
        : {}),
    };
  }
  return {
    data,
    name: header.case,
    buses: n,
    lines: m,
    machines: g,
    bytes: downloaded,
    positions: position,
    load,
    generation,
    machineBus,
    machinePower,
    ...(simulation ? { simulation } : {}),
  };
}

export async function loadCase(id: string, signal: AbortSignal, progress: Progress): Promise<GridCase> {
  const { buffer, received } = await download(`${import.meta.env.BASE_URL}grids/${id}.bin`, signal, progress);
  return readCase(id, buffer, received);
}

/** Natural Earth's coasts, countries, and provinces, as lines: a type each, a line per row. */
export const BORDERS = ['Coast', 'Country', 'Province'] as const;
export async function loadBorders(signal: AbortSignal, progress: Progress): Promise<Data> {
  const { buffer } = await download(`${import.meta.env.BASE_URL}grids/borders.bin`, signal, progress),
    length = new DataView(buffer).getUint32(0, true),
    { layers } = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as {
      readonly layers: readonly { readonly type: string; readonly lines: number; readonly points: number }[];
    };
  let at = 4 + length;
  const starts = layers.map(({ lines }) => {
    const view = new Int32Array(buffer, at, lines + 1);
    at += view.byteLength;
    return view;
  });
  const points = layers.map((layer) => {
    const view = new Float32Array(buffer, at, layer.points * 2);
    at += view.byteLength;
    return view;
  });
  if (at !== buffer.byteLength) throw new Error('The borders file is not whole');
  const field = { type: { kind: 'list', items: POSITION.type }, geographic: true } as const;
  return createData(
    { types: Object.fromEntries(BORDERS.map((type) => [type, { fields: { points: field } }])) },
    BORDERS.map((type) => {
      const k = layers.findIndex((layer) => layer.type === type);
      if (k < 0) throw new Error(`The borders file has no ${type} lines`);
      return rows({ source: 'natural-earth-borders', type, version: '5.1.2' }, starts[k]!.length - 1, {
        points: lists(starts[k]!, vector(points[k]!)),
      });
    }),
  );
}
