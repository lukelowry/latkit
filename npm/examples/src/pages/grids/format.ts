/**
 * The synthetic grid cases in `public/grids`, which the networks page and the docs gallery read.
 *
 * A case file is gzip-compressed. Inflated, it starts with the magic "LKG1" and a u32 header length,
 * followed by a JSON header with the case's name and counts. Typed arrays follow on eight-byte
 * boundaries. The header's `arrays` gives each as [type, offset, length], with the offset in bytes
 * from the first eight-byte boundary after the header and the length in elements. The arrays hold:
 * - per bus: number, name, kV, longitude and latitude, and load and generation in MW;
 * - per branch: its two bus rows, reactance, and whether it is a transformer;
 * - per machine: bus row, name, rating, and output.
 *
 * Simulated cases also hold each machine's speed deviation for every frame, `dt` seconds apart, as
 * int16 in steps of `speedScale` per unit, and the fault the simulation applied.
 */

export interface Header {
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

/** A case's simulation: each machine's speed deviation over the simulated time. */
export interface Simulation {
  readonly frames: number;
  readonly dt: number;
  readonly duration: number;
  /** Speed deviation in mHz, one value per machine for each frame, frame-major. */
  readonly speeds: Float32Array;
  /** The largest deviation either way, in mHz: the int16 maximum at the file's `speedScale`. */
  readonly largest: number;
}

/** A case file's header and arrays, and the columns its readers derive from them. */
export interface CaseFile {
  readonly header: Header;
  /** Returns one of the case's arrays by name, such as `branch.reactance`. Throws if it is
   * missing. */
  array<T>(name: string, of: new (b: ArrayBuffer, o: number, l: number) => T): T;
  /** Returns the strings of one of the case's text arrays, such as `bus.name`. */
  names(name: string): string[];
  /** Each bus's longitude and latitude, interleaved in `positions` and apart in `lon` and `lat`. */
  readonly positions: Float32Array;
  readonly lon: Float64Array;
  readonly lat: Float64Array;
  /** Each bus's kV and voltage level. */
  readonly kv: Float32Array;
  readonly level: Float32Array;
  /** Each branch's two bus rows, its kV (the higher of its buses'), and its voltage level. */
  readonly from: Uint32Array;
  readonly to: Uint32Array;
  readonly lineKv: Float32Array;
  readonly lineLevel: Float32Array;
  /** Each machine's bus row. */
  readonly machineBus: Uint32Array;
  readonly simulation?: Simulation;
}

/** The voltage level of a bus or line, an index into `LEVELS`: 0 below 100 kV, then 115–161, 230,
 * 345, 500, and 765 kV. */
export function levelOf(kv: number): number {
  return kv >= 700 ? 5 : kv >= 450 ? 4 : kv >= 300 ? 3 : kv >= 200 ? 2 : kv >= 100 ? 1 : 0;
}
export const LEVELS = ['< 100 kV', '115–161 kV', '230 kV', '345 kV', '500 kV', '765 kV'] as const;

/** Returns `bytes` as an `ArrayBuffer`, inflated if they are gzip-compressed, as case files are. */
export function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
    return Promise.resolve(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(inflated).arrayBuffer();
}

const MAGIC = 0x31474b4c;
const text = new TextDecoder();

/** Reads an inflated case file. Throws if the bytes are not a case, naming it `id`. */
export function parseCase(id: string, buffer: ArrayBuffer): CaseFile {
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
  const positions = array('bus.position', Float32Array);
  const kv = array('bus.kv', Float32Array);
  const ends = array('branch.ends', Uint32Array);
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    lon[b] = positions[b * 2]!;
    lat[b] = positions[b * 2 + 1]!;
  }
  const from = new Uint32Array(m);
  const to = new Uint32Array(m);
  const lineKv = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    from[e] = ends[e * 2]!;
    to[e] = ends[e * 2 + 1]!;
    lineKv[e] = Math.max(kv[from[e]!]!, kv[to[e]!]!);
  }
  let simulation: Simulation | undefined;
  if (header.frames !== undefined && header.dt !== undefined) {
    // Converts int16 steps to mHz: a step is `speedScale` per unit, and 1 per unit is 60 Hz.
    const scale = (header.speedScale ?? 1) * 60_000;
    simulation = {
      frames: header.frames,
      dt: header.dt,
      duration: (header.frames - 1) * header.dt,
      speeds: Float32Array.from(array('machine.speed', Int16Array), (value) => value * scale),
      largest: 32767 * scale,
    };
  }
  return {
    header,
    array,
    names,
    positions,
    lon,
    lat,
    kv,
    level: Float32Array.from(kv, levelOf),
    from,
    to,
    lineKv,
    lineLevel: Float32Array.from(lineKv, levelOf),
    machineBus: array('machine.bus', Uint32Array),
    ...(simulation ? { simulation } : {}),
  };
}
