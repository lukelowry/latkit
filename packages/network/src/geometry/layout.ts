import {
  rowAt,
  type FieldInput,
  type FieldValues,
  type FieldsBlock,
  type ReadScope,
  type RowAxis,
  type Work,
} from '@latkit/model';
import { kit, type LayoutOptions, type Positions } from '@latkit/gpu';
import type { NetworkData, NetworkItem } from '../data.js';
import {
  channels,
  readIdentity,
  sameIdentity,
  VERTEX,
  type FieldRead,
} from '../rendering/fields.js';
import { placement, type Geometry, type VertexBank } from './topology.js';
import { indexKey } from './rows.js';

/** What layout placed: each bank holding a placed vertex reads every row's position from here. */
interface Placed {
  readonly banks: ReadonlyMap<VertexBank, FieldValues>;
  readonly topology: Geometry;
  readonly layout: LayoutOptions;
  /** The placed vertices by dense address, and where, two numbers each, for the next to keep. */
  readonly vertices: Uint32Array;
  readonly at: Float64Array;
}
/** Edge lengths the default gap reads: enough for a steady median, few enough to sort at once. */
const SAMPLES = 4096;

/**
 * Where a view places each drawn vertex without a position: every row of a type that binds neither
 * x nor y, and each row whose x or y reads no number. It reads the positions a frame read anyway,
 * and places again only when they, the topology, or the layout change; what it placed before stays.
 */
export class Placement {
  #last?: { readonly key: readonly unknown[]; readonly placed: Placed };
  /** Each bank holding a placed vertex, and every row's position, read in place of its x and y. */
  async prepare(
    topology: Geometry,
    data: NetworkData,
    reads: ReadonlyMap<VertexBank, FieldRead>,
    layout: LayoutOptions,
    work: Work,
  ): Promise<ReadonlyMap<VertexBank, FieldValues>> {
    const key: unknown[] = [topology, layout];
    for (const bank of topology.vertices) {
      const read = reads.get(bank);
      key.push(bank, ...(read ? readIdentity(read) : []));
    }
    if (this.#last && sameIdentity(this.#last.key, key)) return this.#last.placed.banks;
    const positions = topology.vertices.map((bank): PositionRead => {
        const read = reads.get(bank);
        return read
          ? { bank, tiles: read.native, x: read.channels.x, y: read.channels.y }
          : { bank, tiles: null };
      }),
      placed = await place(topology, data, positions, layout, work, this.#last?.placed);
    this.#last = { key, placed };
    return placed.banks;
  }
}
/** Place what `reads` leave without a position; what `previous` placed stays with the same layout. */
async function place(
  topology: Geometry,
  data: NetworkData,
  reads: readonly PositionRead[],
  layout: LayoutOptions,
  work: Work,
  previous?: Placed,
): Promise<Placed> {
  const { at, free } = positionsOf(reads, topology.vertexCount, false);
  if (!at) return { banks: new Map(), topology, layout, vertices: free, at: new Float64Array() };
  if (previous && sameLayout(previous.layout, layout)) keep(at, topology, previous);
  await arrangeFree(topology, data, at, layout, work);
  const banks = new Map<VertexBank, FieldValues>();
  let next = 0;
  for (const bank of topology.vertices) {
    while (next < free.length && free[next] < bank.base) next++;
    if (next === free.length || free[next] >= bank.base + bank.count) continue;
    const values = at.slice(bank.base * 2, (bank.base + bank.count) * 2);
    banks.set(bank, {
      index: bank.index,
      rows: bank.rows,
      values: {
        kind: 'vector',
        offset: 0,
        length: bank.count,
        size: 2,
        values: { kind: 'numeric', offset: 0, length: values.length, values },
      },
    });
  }
  const placed = new Float64Array(free.length * 2);
  free.forEach((v, i) => placed.set(at.subarray(v * 2, v * 2 + 2), i * 2));
  return { banks, topology, layout, vertices: free, at: placed };
}
/** Each drawn vertex's position, those without one placed: two numbers a vertex. */
export async function arrangeVertices(
  reader: ReadScope,
  topology: Geometry,
  data: NetworkData,
  layout: LayoutOptions,
  work: Work,
): Promise<Float64Array> {
  const { at, free } = positionsOf(
    await readPositions(reader, topology, data),
    topology.vertexCount,
    true,
  );
  if (free.length) await arrangeFree(topology, data, at!, layout, work);
  return at!;
}
/** Each type's rows where `at` places them, an axis a field. */
export function positions(topology: Geometry, at: Float64Array): Record<string, Positions> {
  const out: Record<string, Positions> = {};
  for (const [type, banks] of byType(topology)) {
    const first = banks[0].base,
      count = banks.reduce((n, bank) => n + bank.count, 0),
      rows = joined(banks),
      axis = (lane: number): FieldValues => {
        const values = new Float64Array(count);
        for (let i = 0; i < count; i++) values[i] = at[(first + i) * 2 + lane];
        return {
          index: banks[0].index,
          rows,
          values: { kind: 'numeric', offset: 0, length: count, values },
        };
      };
    out[type] = { x: axis(0), y: axis(1) };
  }
  return out;
}

function byType(topology: Geometry): Map<string, VertexBank[]> {
  const types = new Map<string, VertexBank[]>();
  for (const bank of topology.vertices) {
    const banks = types.get(bank.type);
    if (banks) banks.push(bank);
    else types.set(bank.type, [bank]);
  }
  return types;
}
/** A type's rows across its banks: one range when they run on, else their indices. */
function joined(banks: readonly VertexBank[]): RowAxis {
  const count = banks.reduce((n, bank) => n + bank.count, 0),
    first = banks[0].rows;
  let next = first.kind === 'range' ? first.offset : -1;
  for (const { rows } of banks) {
    if (rows.kind !== 'range' || rows.offset !== next) {
      next = -1;
      break;
    }
    next += rows.count;
  }
  if (first.kind === 'range' && next >= 0) return { kind: 'range', offset: first.offset, count };
  const values = new Uint32Array(count);
  let at = 0;
  for (const bank of banks) for (let i = 0; i < bank.count; i++) values[at++] = rowAt(bank.rows, i);
  return { kind: 'indices', values };
}
/** Where a bank reads its positions: tiles and the channels placing them; none without x or y. */
interface PositionRead {
  readonly bank: VertexBank;
  readonly tiles: readonly FieldsBlock[] | null;
  readonly x?: kit.ResolvedChannel;
  readonly y?: kit.ResolvedChannel;
}
const rowsIn = (tile: FieldsBlock) =>
  tile.rows.kind === 'range' ? tile.rows.count : tile.rows.values.length;
/**
 * Write a tile's positions into `out` from vertex `first`, both NaN where either reads no number;
 * whether any did.
 */
function write(read: PositionRead, tile: FieldsBlock, out: Float64Array, first: number): boolean {
  kit.channelValues(read.x!, tile, out, first * 2, 2);
  kit.channelValues(read.y!, tile, out, first * 2 + 1, 2);
  let missing = false;
  for (let i = first * 2, end = (first + rowsIn(tile)) * 2; i < end; i += 2)
    if (!Number.isFinite(out[i]) || !Number.isFinite(out[i + 1])) {
      out[i] = out[i + 1] = NaN;
      missing = true;
    }
  return missing;
}
/** Each bank's positions through the reader, as a frame's field reads would have them. */
async function readPositions(
  reader: ReadScope,
  topology: Geometry,
  data: NetworkData,
): Promise<PositionRead[]> {
  const reads: PositionRead[] = [];
  for (const [type, banks] of byType(topology)) {
    const options = data.vertices[type];
    if (placement(data.source, type, options) === 'free') {
      for (const bank of banks) reads.push({ bank, tiles: null });
      continue;
    }
    const bound = channels(options, VERTEX),
      { x, y } = bound.channels,
      fields: Record<string, FieldInput> = {};
    for (const channel of [x, y])
      if (channel.column !== undefined) fields[channel.column] = bound.fields[channel.column];
    // An unset axis reads 0, so one bound axis lays rows along it.
    const resolved = await kit.resolveChannels(
      reader,
      { source: data.source, from: type, rows: options.rows },
      { fields, channels: { x, y } },
      { x: x.field === undefined ? 0 : NaN, y: y.field === undefined ? 0 : NaN },
    );
    for (const bank of banks) {
      const tiles: FieldsBlock[] = [];
      if (x.column !== undefined || y.column !== undefined)
        for await (const tile of reader.fields({
          source: data.source,
          from: type,
          rows: { ...bank.rows, index: bank.index },
          fields,
        }))
          tiles.push(tile);
      reads.push({ bank, tiles, ...resolved });
    }
  }
  return reads;
}
/**
 * Every drawn vertex's position as its shader reads it, two numbers each, both NaN where either
 * reads no number; and those vertices, by dense address. Without `all`, no positions when every
 * vertex has one. One linear pass, as reading fields for a frame is, so it runs without yielding.
 */
function positionsOf(
  reads: readonly PositionRead[],
  n: number,
  all: boolean,
): { at: Float64Array | null; free: Uint32Array } {
  // Most networks position every vertex: find one without before holding them all.
  let any = all,
    scratch = new Float64Array(0);
  for (const read of reads) {
    if (any) break;
    if (!read.tiles) any = true;
    else if (!read.tiles.length)
      any = !Number.isFinite(read.x!.fallback) || !Number.isFinite(read.y!.fallback);
    else
      for (const tile of read.tiles) {
        if (scratch.length < rowsIn(tile) * 2) scratch = new Float64Array(rowsIn(tile) * 2);
        if ((any = write(read, tile, scratch, 0))) break;
      }
  }
  if (!any) return { at: null, free: new Uint32Array() };
  const at = new Float64Array(n * 2).fill(NaN);
  for (const read of reads) {
    const { bank, tiles } = read;
    if (!tiles) continue;
    if (!tiles.length) {
      if (Number.isFinite(read.x!.fallback) && Number.isFinite(read.y!.fallback))
        for (let i = 0; i < bank.count; i++) {
          at[(bank.base + i) * 2] = read.x!.fallback;
          at[(bank.base + i) * 2 + 1] = read.y!.fallback;
        }
      continue;
    }
    for (const tile of tiles) write(read, tile, at, bank.base + tile.rowOffset);
  }
  let count = 0;
  for (let v = 0; v < n; v++) if (at[v * 2] !== at[v * 2]) count++;
  const free = new Uint32Array(count);
  for (let v = 0, k = 0; v < n; v++) if (at[v * 2] !== at[v * 2]) free[k++] = v;
  return { at, free };
}
/** Pin each vertex `previous` placed, and still without a position, where it was placed. */
function keep(at: Float64Array, topology: Geometry, previous: Placed): void {
  const before = previous.topology;
  previous.vertices.forEach((v, i) => {
    let d = v;
    if (before !== topology) {
      const bank = bankAt(before.vertices, v),
        found = topology.lookup.get(indexKey(bank.index))?.get(rowAt(bank.rows, v - bank.base));
      if (!found) return;
      d = found.value.base + found.offset;
    }
    if (at[d * 2] === at[d * 2]) return;
    at[d * 2] = previous.at[i * 2];
    at[d * 2 + 1] = previous.at[i * 2 + 1];
  });
}
/**
 * Arrange the vertices `at` holds no position for, in place. Layout runs down the page, so the
 * network's y, which runs up, turns over on the way in and back on the way out.
 */
async function arrangeFree(
  topology: Geometry,
  data: NetworkData,
  at: Float64Array,
  layout: LayoutOptions,
  work: Work,
): Promise<void> {
  const graph = topology.adjacency.graph,
    n = graph.vertexCount;
  for (let v = 0; v < n; v++) at[v * 2 + 1] = -at[v * 2 + 1];
  const gap = typicalLength(graph, at),
    placed = await kit.place(
      graph,
      {
        pinned: at,
        item: (v): NetworkItem => {
          const bank = bankAt(topology.vertices, v);
          return {
            kind: 'vertex',
            source: data.source,
            index: bank.index,
            row: rowAt(bank.rows, v - bank.base),
          };
        },
      },
      kit.layoutOptions(layout, { algorithm: 'stress', vertexGap: gap, rankGap: gap * 3 }),
      work,
    );
  for (let v = 0; v < n; v++) {
    at[v * 2] = placed[v * 2];
    at[v * 2 + 1] = -placed[v * 2 + 1];
  }
}
/**
 * How long an edge between positioned vertices runs, at the median of an even sample, so placed
 * ones match them; 1 without any.
 */
function typicalLength(graph: kit.Graph, at: Float64Array): number {
  const { offsets, items } = graph.ends,
    joins = (e: number) =>
      offsets[e + 1] - offsets[e] >= 2 &&
      at[items[offsets[e]] * 2] === at[items[offsets[e]] * 2] &&
      at[items[offsets[e] + 1] * 2] === at[items[offsets[e] + 1] * 2];
  let count = 0;
  for (let e = 0; e < graph.edgeCount; e++) if (joins(e)) count++;
  const step = Math.max(1, Math.floor(count / SAMPLES)),
    lengths: number[] = [];
  for (let e = 0, k = 0; e < graph.edgeCount; e++)
    if (joins(e) && k++ % step === 0) {
      const a = items[offsets[e]],
        b = items[offsets[e] + 1],
        d = Math.hypot(at[a * 2] - at[b * 2], at[a * 2 + 1] - at[b * 2 + 1]);
      if (d > 0) lengths.push(d);
    }
  if (!lengths.length) return 1;
  lengths.sort((p, q) => p - q);
  return lengths[lengths.length >> 1];
}
function bankAt(banks: readonly VertexBank[], dense: number): VertexBank {
  let lo = 0,
    hi = banks.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (banks[m].base <= dense) lo = m + 1;
    else hi = m;
  }
  return banks[lo - 1];
}
function sameLayout(a: LayoutOptions, b: LayoutOptions): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof LayoutOptions>;
  return [...keys].every((key) => a[key] === b[key]);
}
