import {
  bitAt,
  failure,
  fieldDefinition,
  positionField,
  assertIndex,
  type Column,
  type Index,
  type ReferenceColumn,
  type RowAxis,
  type Schema,
  type Data,
  type FieldValues,
  type Space,
} from '@latkit/model';
import { kit, type Position2D } from '@latkit/gpu';
import type { NetworkData, VertexData, EdgeData, PathData } from '../data.js';
import { Adjacency } from './adjacency.js';
import { RowLookup, indexKey } from './rows.js';

/** Rows per bank. A power of two, so a type's dense address splits into bank and offset by shifts. */
export const BANK_ROWS = 16384;
const BANK_SHIFT = 14;
export interface VertexBank {
  readonly id: number;
  readonly type: string;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly count: number;
  readonly base: number;
  position?: Position2D;
  /** Private control points share field upload/projection, but are never model vertices. */
  readonly synthetic?: VertexData;
}
export interface SegmentBatch {
  readonly a: VertexBank;
  readonly b: VertexBank;
  readonly records: Uint32Array;
  readonly data: kit.BufferData;
  readonly order?: Uint32Array;
}
export interface EdgeBank {
  readonly base: number;
  readonly type: string;
  readonly index: Index;
  readonly rows: RowAxis;
  readonly count: number;
  readonly batches: readonly SegmentBatch[];
  /** Each row's vertices as dense addresses, compressed by row. */
  readonly incidence: { readonly offsets: Uint32Array; readonly vertices: Uint32Array };
  /** Some row joins more than two vertices: a net drawn as stars. */
  readonly stars?: boolean;
  readonly order?: Uint32Array;
  readonly kind?: 'path';
  readonly source?: Data;
}
export interface Geometry {
  readonly vertices: readonly VertexBank[];
  readonly edges: readonly EdgeBank[];
  readonly lookup: ReadonlyMap<string, RowLookup<VertexBank>>;
  readonly vertexCount: number;
  readonly edgeCount: number;
  /** Path rows, densely addressed after the edges. */
  readonly pathCount: number;
  readonly segmentCount: number;
  readonly schema: Schema;
  /** Positions are longitude/latitude in degrees. */
  readonly geographic: boolean;
  readonly bytes: number;
  readonly adjacency: Adjacency;
  readonly native?: Geometry;
}
export interface Limits {
  /** Drawn vertices, including path points. */
  readonly vertices?: number;
  /** Logical stroke segments before adaptive GPU tessellation. */
  readonly segments?: number;
  /** CPU memory for topology and paths. */
  readonly geometryBytes?: number;
  /** CPU memory for hit-test indexes; hover and pick fall back to scans past it. */
  readonly pickingBytes?: number;
}
export const DEFAULT_LIMITS = Object.freeze({
  vertices: 2_000_000,
  segments: 8_000_000,
  geometryBytes: 256 * 1024 ** 2,
  pickingBytes: 64 * 1024 ** 2,
});
export function vertexOptions(data: NetworkData, bank: VertexBank): VertexData {
  return bank.synthetic ?? data.vertices[bank.type];
}
export function edgeOptions(data: NetworkData, bank: EdgeBank): EdgeData | PathData {
  return bank.kind === 'path' ? data.paths![bank.type] : data.edges![bank.type];
}
export function segmentBatch(a: VertexBank, b: VertexBank, records: Uint32Array): SegmentBatch {
  const data = new kit.BufferData({ size: records.byteLength, label: 'network path segments' });
  data.write({ data: records });
  return { a, b, records, data };
}

/** A growable Uint32Array: amortized constant pushes with no per-item allocation. */
class Uints {
  private values = new Uint32Array(64);
  length = 0;
  push(value: number): void {
    if (this.length === this.values.length) {
      const grown = new Uint32Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    this.values[this.length++] = value;
  }
  append(rows: RowAxis): void {
    if (rows.kind === 'indices')
      for (let i = 0; i < rows.values.length; i++) this.push(rows.values[i]);
    else for (let i = 0; i < rows.count; i++) this.push(rows.offset + i);
  }
  /** An exact-length copy; the builder stays reusable. */
  take(): Uint32Array {
    return this.values.slice(0, this.length);
  }
}

/** A contiguous run as a range, so ranged reads and lookups never allocate index arrays. */
/** The space a position binding's coordinates lie in: its vector field's, or its axes' when they agree. */
function spaceOf(source: Data, from: string, position: Position2D): Space | undefined {
  if (typeof position !== 'object' || !('x' in position))
    return fieldDefinition(source, from, position)?.space;
  const x = fieldDefinition(source, from, position.x)?.space,
    y = fieldDefinition(source, from, position.y)?.space;
  if (x !== y) throw failure('invalid-input', 'Position axes lie in different spaces');
  return x;
}
function axis(rows: Uint32Array): RowAxis {
  const n = rows.length;
  if (!n) return { kind: 'range', offset: 0, count: 0 };
  for (let i = 1; i < n; i++) if (rows[i] !== rows[0] + i) return { kind: 'indices', values: rows };
  return { kind: 'range', offset: rows[0], count: n };
}

/** Physical rows of one Index at dense positions from `base`: a direct table, or a map when sparse.
 * Build scratch, like the readers' builders, so it is not charged to the geometry. */
class Addresses {
  private readonly table?: Int32Array;
  private readonly map?: Map<number, number>;
  constructor(
    rows: Uint32Array,
    readonly base = 0,
    readonly firstBank = 0,
  ) {
    let max = -1;
    for (let i = 0; i < rows.length; i++) if (rows[i] > max) max = rows[i];
    if (max < rows.length * 4 + 65536) {
      const table = (this.table = new Int32Array(max + 1).fill(-1));
      for (let i = 0; i < rows.length; i++) {
        if (table[rows[i]] !== -1) throw failure('invalid-input', 'Duplicate physical row');
        table[rows[i]] = base + i;
      }
    } else {
      const map = (this.map = new Map());
      for (let i = 0; i < rows.length; i++) {
        if (map.has(rows[i])) throw failure('invalid-input', 'Duplicate physical row');
        map.set(rows[i], base + i);
      }
    }
  }
  /** The row's dense address; -1 when it is not drawn. */
  get(row: number): number {
    if (this.table) return row < this.table.length ? this.table[row] : -1;
    return this.map!.get(row) ?? -1;
  }
}

/** The drawn rows of one vertex type. */
interface Drawn {
  readonly index?: Index;
  readonly addresses: Addresses;
}

function reference(column: Column | undefined, name: string): ReferenceColumn {
  if (column?.kind !== 'reference')
    throw failure('invalid-input', 'Expected a reference column: ' + name);
  return column;
}

/** Segment records grouped by the vertex banks they join: [offset a, offset b, local row, 0]. */
class Segments {
  private groups = new Map<number, { a: number; b: number; records: Uints }>();
  private lastKey = -1;
  private last?: Uints;
  count = 0;
  constructor(
    private readonly vertices: readonly VertexBank[],
    private readonly limit: number,
    private readonly total: { count: number },
  ) {}
  add(a: number, b: number, offsetA: number, offsetB: number, local: number): void {
    if (++this.total.count > this.limit)
      throw failure('resource-limit', 'Network segment limit exceeded');
    this.count++;
    const key = a * this.vertices.length + b;
    if (key !== this.lastKey) {
      let group = this.groups.get(key);
      if (!group) {
        group = { a, b, records: new Uints() };
        this.groups.set(key, group);
      }
      this.lastKey = key;
      this.last = group.records;
    }
    const records = this.last!;
    records.push(offsetA);
    records.push(offsetB);
    records.push(local);
    records.push(0);
  }
  take(): SegmentBatch[] {
    const batches = [...this.groups.values()].map((g) =>
      segmentBatch(this.vertices[g.a], this.vertices[g.b], g.records.take()),
    );
    this.groups = new Map();
    this.lastKey = -1;
    this.last = undefined;
    this.count = 0;
    return batches;
  }
}

export async function readGeometry(
  data: NetworkData,
  frame: kit.Preparation,
  limits: Required<Limits>,
): Promise<Geometry> {
  const vertices: VertexBank[] = [],
    edges: EdgeBank[] = [],
    lookup = new Map<string, RowLookup<VertexBank>>(),
    drawn = new Map<string, Drawn>(),
    systems = new Set<string>(),
    segments = { count: 0 };
  let vertexCount = 0,
    edgeCount = 0,
    pathCount = 0,
    bytes = 0;
  const schema = data.source.schema;
  const charge = (n: number) => {
    bytes += n;
    if (bytes > limits.geometryBytes)
      throw failure('resource-limit', 'Network geometry exceeds its CPU budget');
  };
  const rowsOf = async (
    source: Data,
    type: string,
    selection: VertexData['rows'],
  ): Promise<{ index?: Index; rows: Uint32Array }> => {
    const rows = new Uints();
    let index: Index | undefined;
    for await (const block of frame.reader.read(source, {
      kind: 'rows',
      from: type,
      select: [],
      ...(selection ? { rows: selection } : {}),
    })) {
      if (index) assertIndex(index, block.index);
      else index = block.index;
      rows.append(block.rows);
    }
    return { index, rows: rows.take() };
  };

  for (const [type, options] of Object.entries(data.vertices)) {
    const read = await rowsOf(data.source, type, options.rows);
    const definition = schema.types[type];
    if (!definition) throw failure('invalid-input', 'Unknown vertex type: ' + type);
    const position = options.position ?? positionField(definition, ['geographic', 'cartesian']),
      space = position === undefined ? undefined : spaceOf(data.source, type, position);
    if (space) systems.add(space);
    if (vertexCount + read.rows.length > limits.vertices)
      throw failure('resource-limit', 'Network vertex limit exceeded');
    const addresses = new Addresses(read.rows, vertexCount, vertices.length);
    drawn.set(type, { index: read.index, addresses });
    const table = new RowLookup<VertexBank>();
    for (let first = 0; first < read.rows.length; first += BANK_ROWS) {
      const rows = axis(read.rows.subarray(first, first + BANK_ROWS));
      const count = Math.min(BANK_ROWS, read.rows.length - first);
      const bank: VertexBank = {
        id: vertices.length,
        type,
        index: read.index!,
        rows,
        count,
        base: vertexCount,
        position,
      };
      vertices.push(bank);
      table.add(rows, bank);
      vertexCount += count;
      charge(256 + (rows.kind === 'indices' ? count * 36 : 0));
    }
    table.seal();
    if (read.index) lookup.set(indexKey(read.index), table);
  }

  /** The drawn rows a reference column names, checked against its declared vertex type. */
  const target = (column: ReferenceColumn): Drawn | undefined => {
    const found = drawn.get(column.index.type);
    if (!found) throw failure('invalid-input', 'References must name a vertex type');
    if (found.index) assertIndex(found.index, column.index);
    return found.index ? found : undefined;
  };
  /** Bank and offset of a dense address within its type, without searching. */
  const bankOf = (addresses: Addresses, dense: number) =>
    addresses.firstBank + ((dense - addresses.base) >>> BANK_SHIFT);
  const offsetOf = (addresses: Addresses, dense: number) =>
    (dense - addresses.base) & (BANK_ROWS - 1);
  /** The addresses of the type holding a dense vertex address. */
  const addressesOf = (dense: number): Addresses => {
    let lo = 0,
      hi = vertices.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (vertices[m].base <= dense) lo = m + 1;
      else hi = m;
    }
    return drawn.get(vertices[lo - 1].type)!.addresses;
  };

  const wiring = kit.wiring(schema, Object.keys(data.vertices), data.edges ?? {});
  for (const [type, options] of Object.entries(data.edges ?? {})) {
    const wire = wiring.get(type)!;
    const pairs = new Segments(vertices, limits.segments, segments);
    if (wire.kind === 'ends') {
      const [{ field: a }, { field: b }] = wire.ends;
      let index: Index | undefined;
      const rows = new Uints(),
        offsets = new Uints(),
        incidence = new Uints();
      offsets.push(0);
      const flush = () => {
        if (!rows.length) return;
        const count = rows.length;
        edges.push({
          base: edgeCount,
          type,
          index: index!,
          rows: axis(rows.take()),
          count,
          incidence: { offsets: offsets.take(), vertices: incidence.take() },
          batches: pairs.take(),
        });
        edgeCount += count;
        charge(256 + count * 16 + incidence.length * 8);
        rows.length = 0;
        offsets.length = 0;
        offsets.push(0);
        incidence.length = 0;
      };
      for await (const block of frame.reader.read(data.source, {
        kind: 'rows',
        from: type,
        select: [a, b],
        ...(options.rows ? { rows: options.rows } : {}),
      })) {
        if (index) assertIndex(index, block.index);
        else index = block.index;
        const from = reference(block.columns[a], a),
          to = reference(block.columns[b], b);
        const ta = target(from)?.addresses,
          tb = target(to)?.addresses;
        const range = block.rows.kind === 'range',
          offset = range ? block.rows.offset : 0,
          values = range ? undefined : block.rows.values,
          n = range ? block.rows.count : values!.length;
        for (let i = 0; i < n; i++) {
          const local = rows.length;
          rows.push(range ? offset + i : values![i]);
          const at = from.offset + i,
            bt = to.offset + i;
          const va = ta && bitAt(from.validity, at) ? ta.get(from.values[at]) : -1,
            vb = tb && bitAt(to.validity, bt) ? tb.get(to.values[bt]) : -1;
          if (va >= 0) incidence.push(va);
          if (vb >= 0) incidence.push(vb);
          offsets.push(incidence.length);
          if (va >= 0 && vb >= 0) {
            charge(48);
            pairs.add(
              bankOf(ta!, va),
              bankOf(tb!, vb),
              offsetOf(ta!, va),
              offsetOf(tb!, vb),
              local,
            );
          }
          if (rows.length === BANK_ROWS) flush();
        }
      }
      flush();
      continue;
    }
    if (options.bends) throw failure('invalid-input', 'Bends require ends');
    // A net: its ends are the drawn vertices whose references name its rows.
    const nets = await rowsOf(data.source, type, options.rows);
    const local = new Addresses(nets.rows);
    const net = new Uints(),
      member = new Uints();
    const ports = new Map<string, string[]>();
    for (const port of wire.ports)
      ports.set(port.type, [...(ports.get(port.type) ?? []), port.field]);
    for (const [vertexType, fields] of ports) {
      const own = drawn.get(vertexType)!,
        selection = data.vertices[vertexType].rows;
      for await (const block of frame.reader.read(data.source, {
        kind: 'rows',
        from: vertexType,
        select: fields,
        ...(selection ? { rows: selection } : {}),
      })) {
        if (own.index) assertIndex(own.index, block.index);
        const range = block.rows.kind === 'range',
          offset = range ? block.rows.offset : 0,
          values = range ? undefined : block.rows.values,
          n = range ? block.rows.count : values!.length;
        for (const name of fields) {
          const column = reference(block.columns[name], name);
          if (nets.index) assertIndex(nets.index, column.index);
          for (let i = 0; i < n; i++) {
            const at = column.offset + i;
            if (!bitAt(column.validity, at)) continue;
            const v = own.addresses.get(range ? offset + i : values![i]),
              e = local.get(column.values[at]);
            if (v < 0 || e < 0) continue;
            net.push(e);
            member.push(v);
          }
        }
      }
    }
    // Group members by net with a counting sort, then drop a vertex wired twice to one net.
    const count = nets.rows.length,
      starts = new Uint32Array(count + 1),
      byNet = net.take(),
      byMember = member.take(),
      members = new Uint32Array(byNet.length);
    for (let p = 0; p < byNet.length; p++) starts[byNet[p] + 1]++;
    for (let i = 0; i < count; i++) starts[i + 1] += starts[i];
    const cursor = starts.slice(0, count);
    for (let p = 0; p < byNet.length; p++) members[cursor[byNet[p]]++] = byMember[p];
    let write = 0;
    for (let i = 0; i < count; i++) {
      const begin = starts[i],
        end = starts[i + 1];
      starts[i] = write;
      if (end - begin > 2) members.subarray(begin, end).sort();
      for (let p = begin; p < end; p++)
        if (p === begin || members[p] !== members[p - 1]) members[write++] = members[p];
    }
    starts[count] = write;
    for (let first = 0; first < count; first += BANK_ROWS) {
      const last = Math.min(count, first + BANK_ROWS),
        base = starts[first];
      const offsets = Uint32Array.from(starts.subarray(first, last + 1), (s) => s - base);
      let stars = false;
      for (let i = first; i < last; i++) {
        const size = starts[i + 1] - starts[i];
        // A junction centers every net's star; otherwise only nets of more than two vertices.
        if (options.junction ? size > 0 : size > 2) stars = true;
        else if (size === 2) {
          const va = members[starts[i]],
            vb = members[starts[i] + 1];
          const ta = addressesOf(va),
            tb = addressesOf(vb);
          charge(48);
          pairs.add(bankOf(ta, va), bankOf(tb, vb), offsetOf(ta, va), offsetOf(tb, vb), i - first);
        }
      }
      edges.push({
        base: edgeCount,
        type,
        index: nets.index!,
        rows: axis(nets.rows.subarray(first, last)),
        count: last - first,
        incidence: { offsets, vertices: members.slice(base, starts[last]) },
        batches: pairs.take(),
        ...(stars ? { stars } : {}),
      });
      edgeCount += last - first;
      charge(256 + (last - first) * 16 + (starts[last] - base) * 4);
    }
  }

  for (const [type, options] of Object.entries(data.paths ?? {})) {
    const source = options.source ?? data.source;
    const read = await rowsOf(source, type, options.rows);
    const space = fieldDefinition(source, type, options.points)?.space;
    if (space) systems.add(space);
    for (let first = 0; first < read.rows.length; first += BANK_ROWS) {
      const count = Math.min(BANK_ROWS, read.rows.length - first);
      edges.push({
        base: edgeCount + pathCount,
        type,
        index: read.index!,
        rows: axis(read.rows.subarray(first, first + BANK_ROWS)),
        count,
        kind: 'path',
        source,
        batches: [],
        incidence: { offsets: new Uint32Array(count + 1), vertices: new Uint32Array() },
      });
      pathCount += count;
      charge(256 + count * 12);
    }
  }
  frame.signal.throwIfAborted();
  if (systems.size > 1)
    throw failure('invalid-input', 'Drawn types disagree on their coordinate system');
  const geographic = systems.has('geographic');
  for (const bank of vertices)
    if (!bank.position) {
      if (geographic) throw failure('invalid-input', 'Geographic vertices require positions');
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
  const connected = edges.filter((bank) => !bank.kind);
  const adjacencyBytes =
    (vertexCount + edgeCount + 2) * 4 +
    connected.reduce((sum, bank) => sum + bank.incidence.vertices.length * 8, 0);
  charge(adjacencyBytes);
  const adjacency = new Adjacency(
    vertices,
    connected,
    edges.filter((bank) => bank.kind === 'path'),
    vertexCount,
    edgeCount,
  );
  bytes -= adjacencyBytes - adjacency.bytes;
  return {
    vertices,
    edges,
    lookup,
    vertexCount,
    edgeCount,
    pathCount,
    segmentCount: segments.count,
    schema,
    geographic,
    bytes,
    adjacency,
  };
}
