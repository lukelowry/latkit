/**
 * Synthetic grid cases, which the page fetches gzip-compressed from `public/grids`. `format.ts`
 * describes the files and reads them.
 */
import { Data, Patch, reference } from 'latkit';
import { inflate, parseCase, type Simulation } from './format.js';

export interface Case {
  readonly data: Data;
  readonly name: string;
  readonly buses: number;
  readonly lines: number;
  readonly machines: number;
  /** Bytes downloaded, compressed. */
  readonly bytes: number;
  /** Whether its buses have names, which labels and search use. */
  readonly named: boolean;
  /** Each bus's longitude and latitude, interleaved. `load` and `generation` are per bus, in MW. */
  readonly positions: Float32Array;
  readonly load: Float32Array;
  readonly generation: Float32Array;
  /** Each machine's bus row. `machinePower` is each machine's output in MW. */
  readonly machineBus: Uint32Array;
  readonly machinePower: Float32Array;
  /** The simulation, with the fault it applied at the bus named `bus`. */
  readonly simulation?: Simulation & {
    readonly fault?: { readonly bus: string; readonly on: number; readonly off: number };
  };
}

/** The bounding box of interleaved longitudes and latitudes: west, south, east, and north. */
export function extent(positions: Float32Array): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 2) {
    box[0] = Math.min(box[0], positions[i]!);
    box[1] = Math.min(box[1], positions[i + 1]!);
    box[2] = Math.max(box[2], positions[i]!);
    box[3] = Math.max(box[3], positions[i + 1]!);
  }
  return box;
}

/** Reads an inflated case file into a dataset named `grid` with tables `Bus`, `Line`, `Machine`,
 * and, for a simulated fault, `Fault`. Throws if the bytes are not a case. */
export function readCase(id: string, buffer: ArrayBuffer, downloaded = buffer.byteLength): Case {
  const c = parseCase(id, buffer);
  const { buses, branches: lines, machines } = c.header;
  const number = c.array('bus.number', Uint32Array);
  const load = c.array('bus.load', Float32Array);
  const generation = c.array('bus.generation', Float32Array);
  const machinePower = c.array('machine.power', Float32Array);
  const busNames = c.names('bus.name');
  const fault = c.simulation && c.header.fault;
  // Buses are keyed by number, so lines reference them by number.
  const numbered = (rows: Uint32Array) => Uint32Array.from(rows, (b) => number[b]!);
  const patch = new Patch()
    .set('Bus', number, {
      lon: c.lon,
      lat: c.lat,
      name: busNames,
      number: Float64Array.from(number),
      kv: c.kv,
      level: c.level,
      load,
      generation,
    })
    .set(
      'Line',
      { count: lines },
      {
        from: reference('Bus', numbered(c.from)),
        to: reference('Bus', numbered(c.to)),
        kv: c.lineKv,
        level: c.lineLevel,
        reactance: c.array('branch.reactance', Float32Array),
        transformer: Array.from(c.array('branch.transformer', Uint8Array), (v) => v !== 0),
      },
    )
    .set(
      'Machine',
      { count: machines },
      {
        lon: Float64Array.from(c.machineBus, (b) => c.lon[b]!),
        lat: Float64Array.from(c.machineBus, (b) => c.lat[b]!),
        kv: Float64Array.from(c.machineBus, (b) => c.kv[b]!),
        name: c.names('machine.name'),
        power: machinePower,
        mva: c.array('machine.mva', Float32Array),
      },
    );
  if (fault)
    patch.set('Fault', { count: 1 }, { lon: [c.lon[fault.bus]!], lat: [c.lat[fault.bus]!] });
  let simulation: Case['simulation'];
  if (c.simulation) {
    const { frames, dt, speeds } = c.simulation;
    patch.axis('time', 's');
    for (let f = 0; f < frames; f++)
      patch.append('Machine', f * dt, { speed: speeds.subarray(f * machines, (f + 1) * machines) });
    simulation = {
      ...c.simulation,
      ...(fault
        ? {
            fault: { bus: busNames[fault.bus] ?? `bus ${fault.bus}`, on: fault.on, off: fault.off },
          }
        : {}),
    };
  }
  return {
    data: new Data('grid').apply(patch),
    name: c.header.case,
    buses,
    lines,
    machines,
    bytes: downloaded,
    named: true,
    positions: c.positions,
    load,
    generation,
    machineBus: c.machineBus,
    machinePower,
    ...(simulation ? { simulation } : {}),
  };
}

/** Reports download progress: the bytes received so far, and the total if the response gives it. */
export type Progress = (received: number, total: number | undefined) => void;

/** Formats download progress in megabytes for a status line, with the total when known. */
export const megabytes = (received: number, total: number | undefined) =>
  `${(received / 1e6).toFixed(1)}${total ? ` of ${(total / 1e6).toFixed(1)}` : ''} MB`;

/**
 * Downloads a file and returns its bytes. `progress` is called for each chunk. It gets no total
 * once the bytes received exceed the response's length, as they do when the transfer is
 * compressed.
 */
export async function download(
  url: string,
  signal: AbortSignal,
  progress?: Progress,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
  });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
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
  return bytes;
}

export async function loadCase(
  id: string,
  signal: AbortSignal,
  progress?: Progress,
): Promise<Case> {
  const bytes = await download(`${import.meta.env.BASE_URL}grids/${id}.bin`, signal, progress);
  return readCase(id, await inflate(bytes), bytes.length);
}
