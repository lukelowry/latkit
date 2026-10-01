import { assertIndex, rowAt, rowCount } from '@latkit/model';
import { BufferData, GpuError, type Preparation, type FieldValues } from '@latkit/gpu';
import type { Index, RowAxis, Schema, Queryable } from '@latkit/model';
import type { Position2D as Position } from '@latkit/gpu';
import type { NetworkData, VertexOptions, EdgeOptions, PathOptions } from '../data.js';
import { Adjacency } from './adjacency.js';
import { RowLookup, bit, indexKey } from './rows.js';

export const BANK_ROWS = 16384;
export interface VertexBank {
  readonly id: number;
  readonly type: string;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly count: number;
  readonly base: number;
  position?: Position;
  /** Private control points share field upload/projection, but are never model vertices. */
  readonly synthetic?: VertexOptions;
}
export interface SegmentBatch {
  readonly a: VertexBank;
  readonly b: VertexBank;
  readonly records: Uint32Array;
  readonly data: BufferData;
  readonly order?: Uint32Array;
}
export interface EdgeBank {
  readonly base: number;
  readonly type: string;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly count: number;
  readonly batches: readonly SegmentBatch[];
  readonly incidence: { readonly offsets: Uint32Array; readonly vertices: Uint32Array };
  readonly order?: Uint32Array;
  readonly kind?: 'path';
  readonly source?: Queryable;
}
export interface Geometry {
  readonly vertices: readonly VertexBank[];
  readonly edges: readonly EdgeBank[];
  readonly lookup: ReadonlyMap<string, RowLookup<VertexBank>>;
  readonly vertexCount: number;
  readonly edgeCount: number;
  readonly segmentCount: number;
  readonly schema: Schema;
  readonly bytes: number;
  readonly adjacency: Adjacency;
  readonly native?: Geometry;
}
export interface Limits {
  readonly maxVertices?: number;
  readonly maxSegments?: number;
  readonly cpuBytes?: number;
}
export const DEFAULT_LIMITS = Object.freeze({
  maxVertices: 2_000_000,
  maxSegments: 8_000_000,
  cpuBytes: 256 * 1024 ** 2,
});
export function vertexOptions(data: NetworkData, bank: VertexBank): VertexOptions {
  return bank.synthetic ?? data.vertices[bank.type];
}
export function edgeOptions(data: NetworkData, bank: EdgeBank): EdgeOptions | PathOptions {
  return bank.kind === 'path' ? data.paths![bank.type] : data.edges![bank.type];
}
export function rowAxis(values: readonly number[]): RowAxis {
  if (!values.length) return { kind: 'range', offset: 0, count: 0 };
  if (values.every((v, i) => v === values[0] + i))
    return { kind: 'range', offset: values[0], count: values.length };
  return { kind: 'indices', values: Uint32Array.from(values) };
}
export function segmentBatch(a: VertexBank, b: VertexBank, records: Uint32Array): SegmentBatch {
  const data = new BufferData({ size: records.byteLength, label: 'network path segments' });
  data.write({ data: records });
  return { a, b, records, data };
}
export async function readGeometry(
  data: NetworkData,
  frame: Preparation,
  limits: Required<Limits>,
): Promise<Geometry> {
  const vertices: VertexBank[] = [],
    edges: EdgeBank[] = [],
    lookup = new Map<string, RowLookup<VertexBank>>();
  let vertexCount = 0,
    edgeCount = 0,
    segmentCount = 0,
    bytes = 0;
  let schema: Schema | undefined;
  const charge = (n: number) => {
    bytes += n;
    if (bytes > limits.cpuBytes)
      throw new GpuError('resource-limit', 'Network geometry exceeds its CPU budget');
  };
  for (const [type, options] of Object.entries(data.vertices)) {
    let declared: Index | undefined;
    let pending: number[] = [];
    const table = new RowLookup<VertexBank>();
    const flush = () => {
      if (!pending.length) return;
      const definition = schema!.components[type] ?? schema!.tables?.[type];
      if (!definition) throw new GpuError('invalid-input', 'Unknown vertex type: ' + type);
      const rows = rowAxis(pending),
        count = pending.length;
      if (vertexCount + count > limits.maxVertices)
        throw new GpuError('resource-limit', 'Network vertex limit exceeded');
      const bank: VertexBank = {
        id: vertices.length,
        type,
        index: declared!,
        rows,
        count,
        base: vertexCount,
        position: options.position ?? definition.spatial?.field,
      };
      if (data.coordinates === 'geographic' && !bank.position)
        throw new GpuError('invalid-input', 'Geographic vertices require positions');
      vertices.push(bank);
      table.add(rows, bank);
      vertexCount += count;
      charge(256 + (rows.kind === 'indices' ? count * 36 : 0));
      pending = [];
    };
    for await (const block of frame.query(data.source, {
      kind: 'rows',
      from: type,
      select: [],
      ...(options.rows ? { rows: options.rows } : {}),
    })) {
      if (block.kind === 'schema') {
        schema = block.schema;
        continue;
      }
      if (declared) assertIndex(declared, block.index);
      else declared = block.index;
      for (let i = 0; i < rowCount(block.rows); i++) {
        pending.push(rowAt(block.rows, i));
        if (pending.length === BANK_ROWS) flush();
      }
    }
    flush();
    table.seal();
    if (declared) lookup.set(indexKey(declared), table);
  }
  if (!schema) schema = await data.source.describe({ signal: frame.signal });
  for (const bank of vertices)
    if (!bank.position) {
      const values = new Float32Array(bank.count * 2);
      for (let i = 0; i < bank.count; i++) {
        const a = (2 * Math.PI * (bank.base + i)) / Math.max(1, vertexCount);
        values[i * 2] = Math.cos(a);
        values[i * 2 + 1] = Math.sin(a);
      }
      bank.position = {
        index: bank.index,
        rows: bank.rows,
        values: {
          kind: 'vector',
          offset: 0,
          length: bank.count,
          size: 2,
          values: { kind: 'numeric', offset: 0, length: values.length, values },
        },
      } satisfies FieldValues;
      charge(values.byteLength);
    }
  const expected = new Map(vertices.map((bank) => [bank.type, bank.index]));
  const addressTables = new WeakMap<Index, RowLookup<VertexBank> | null>();
  const address = (index: Index, row: number) => {
    let table = addressTables.get(index);
    if (table === undefined) {
      const declared = expected.get(index.type);
      if (declared) assertIndex(declared, index);
      table = lookup.get(indexKey(index)) ?? null;
      addressTables.set(index, table);
    }
    return table?.get(row);
  };
  for (const [type, options] of Object.entries(data.edges ?? {})) {
    if (
      options.bends &&
      options.connectivity.kind === 'endpoints' &&
      options.connectivity.layout === 'star'
    )
      throw new GpuError('invalid-input', 'Bends require pair connectivity');
    let index: Index | undefined,
      rows: number[] = [],
      incidence: number[] = [],
      offsets: number[] = [0];
    let groups = new Map<string, { a: VertexBank; b: VertexBank; values: number[] }>();
    const flush = () => {
      if (!rows.length) return;
      const batches = [...groups.values()].map((g) =>
        segmentBatch(g.a, g.b, Uint32Array.from(g.values)),
      );
      edges.push({
        base: edgeCount,
        type,
        index: index!,
        rows: rowAxis(rows),
        count: rows.length,
        batches,
        incidence: { offsets: Uint32Array.from(offsets), vertices: Uint32Array.from(incidence) },
      });
      edgeCount += rows.length;
      charge(256 + rows.length * 40 + incidence.length * 8);
      rows = [];
      offsets = [0];
      incidence = [];
      groups = new Map();
    };
    type Address = NonNullable<ReturnType<typeof address>>;
    const pair = (a: Address, b: Address, local: number) => {
      if (++segmentCount > limits.maxSegments)
        throw new GpuError('resource-limit', 'Network segment limit exceeded');
      charge(48);
      const key = a.value.id + ':' + b.value.id;
      let group = groups.get(key);
      if (!group) {
        group = { a: a.value, b: b.value, values: [] };
        groups.set(key, group);
      }
      group.values.push(a.offset, b.offset, local, 0);
    };
    const add = (row: number, ends: readonly [Index, number][]) => {
      const local = rows.length;
      rows.push(row);
      let a: Address | undefined, b: Address | undefined;
      for (const [index, row] of ends) {
        const endpoint = address(index, row);
        if (!endpoint) continue;
        incidence.push(endpoint.value.base + endpoint.offset);
        if (!a) a = endpoint;
        else if (!b) b = endpoint;
      }
      offsets.push(incidence.length);
      if (
        a &&
        b &&
        ends.length === 2 &&
        !(options.connectivity.kind === 'endpoints' && options.connectivity.layout === 'star')
      )
        pair(a, b, local);
      if (rows.length === BANK_ROWS) flush();
    };
    const query =
      options.connectivity.kind === 'links'
        ? { ...options.connectivity, from: type, ...(options.rows ? { rows: options.rows } : {}) }
        : {
            kind: 'endpoints' as const,
            from: type,
            ...(options.rows ? { rows: options.rows } : {}),
          };
    let pending: { row: number; total: number; next: number; ends: [Index, number][] } | undefined;
    for await (const block of frame.query(data.source, query)) {
      if (block.kind === 'schema') continue;
      if (index) assertIndex(index, block.index);
      else index = block.index;
      if (block.kind === 'links') {
        for (let i = 0; i < rowCount(block.rows); i++) {
          const local = rows.length;
          rows.push(rowAt(block.rows, i));
          if (bit(block.validity, i)) {
            const a = address(block.targetIndex, block.source[i]),
              b = address(block.targetIndex, block.target[i]);
            if (a) incidence.push(a.value.base + a.offset);
            if (b) incidence.push(b.value.base + b.offset);
            if (a && b) pair(a, b, local);
          }
          offsets.push(incidence.length);
          if (rows.length === BANK_ROWS) flush();
        }
      } else if (block.kind === 'endpoints')
        for (let c = 0; c < block.connections.length; c++) {
          const row = block.connections[c],
            total = block.totalEndpoints[c],
            first = block.firstEndpoint[c];
          if (!pending) pending = { row, total, next: 0, ends: [] };
          if (pending.row !== row || pending.total !== total || pending.next !== first)
            throw new GpuError('invalid-input', 'Discontinuous connection endpoints');
          if (
            options.connectivity.kind === 'endpoints' &&
            options.connectivity.layout === 'pair' &&
            total !== 2
          )
            throw new GpuError('invalid-input', 'Pair layout requires exactly two endpoints');
          if (total > limits.maxSegments)
            throw new GpuError('resource-limit', 'Connection exceeds the segment budget');
          for (let i = block.offsets[c]; i < block.offsets[c + 1]; i++) {
            const component = block.componentIndexes[block.componentType[i]];
            if (!component) throw new GpuError('invalid-input', 'Invalid endpoint type');
            charge(24);
            pending.ends.push([component, block.componentRow[i]]);
          }
          pending.next += block.offsets[c + 1] - block.offsets[c];
          if (pending.next > total)
            throw new GpuError('invalid-input', 'Too many connection endpoints');
          if (pending.next === total) {
            add(row, pending.ends);
            pending = undefined;
          }
        }
    }
    if (pending) throw new GpuError('invalid-input', 'Incomplete connection endpoints');
    flush();
  }
  for (const [type, options] of Object.entries(data.paths ?? {})) {
    let index: Index | undefined,
      pending: number[] = [];
    const flush = () => {
      if (!pending.length) return;
      edges.push({
        base: edgeCount,
        type,
        index: index!,
        rows: rowAxis(pending),
        count: pending.length,
        kind: 'path',
        source: options.source ?? data.source,
        batches: [],
        incidence: { offsets: new Uint32Array(pending.length + 1), vertices: new Uint32Array() },
      });
      charge(256 + pending.length * 12);
      pending = [];
    };
    for await (const block of frame.query(options.source ?? data.source, {
      kind: 'rows',
      from: type,
      select: [],
      ...(options.rows ? { rows: options.rows } : {}),
    })) {
      if (block.kind === 'schema') continue;
      if (index) assertIndex(index, block.index);
      else index = block.index;
      for (let i = 0; i < rowCount(block.rows); i++) {
        pending.push(rowAt(block.rows, i));
        if (pending.length === BANK_ROWS) flush();
      }
    }
    flush();
  }
  frame.signal.throwIfAborted();
  const connected = edges.filter((bank) => !bank.kind);
  const adjacencyBytes =
    (vertexCount + edgeCount + 2) * 4 +
    connected.reduce((sum, bank) => sum + bank.incidence.vertices.length * 8, 0);
  charge(adjacencyBytes);
  const adjacency = new Adjacency(vertices, connected, vertexCount, edgeCount);
  bytes -= adjacencyBytes - adjacency.bytes;
  return {
    vertices,
    edges,
    lookup,
    vertexCount,
    edgeCount,
    segmentCount,
    schema,
    bytes,
    adjacency,
  };
}
