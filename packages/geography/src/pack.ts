import {
  createData,
  createReader,
  failure,
  fieldDefinition,
  rowCount,
  type Column,
  type Data,
  type FieldDefinition,
  type FieldInput,
  type RowBatch,
  type TypeDefinition,
} from '@latkit/model';
import { kit } from '@latkit/gpu';
import { AREA, LINE, type AreaOptions, type LineOptions } from './options.js';
import { readShapes } from './read.js';
import { run } from './prepare/client.js';
import { shapesBuffers, type Shapes, type ShapesLevel } from './prepare/shapes.js';
import { writeArchive } from './sources/archive.js';

/** "LKP1": the payload a pack's one tile holds. */
const MAGIC = 0x31504b4c;
type ArrayName =
  | 'Float64Array'
  | 'Float32Array'
  | 'Uint32Array'
  | 'Int32Array'
  | 'Uint16Array'
  | 'Int16Array'
  | 'Uint8Array'
  | 'Int8Array';
const ARRAYS = {
  Float64Array,
  Float32Array,
  Uint32Array,
  Int32Array,
  Uint16Array,
  Int16Array,
  Uint8Array,
  Int8Array,
} as const;
/** Where a typed array lies in a pack's binary: its kind, byte offset, and element count. */
interface ArrayRef {
  readonly type: ArrayName;
  readonly offset: number;
  readonly length: number;
}
interface ColumnRef {
  readonly kind: 'numeric' | 'boolean' | 'text' | 'vector';
  readonly length: number;
  readonly size?: number;
  readonly values?: ArrayRef;
  readonly bytes?: ArrayRef;
  readonly offsets?: ArrayRef;
  readonly validity?: ArrayRef;
}
interface ShapesRef {
  readonly type: string;
  readonly field: string;
  readonly closed: boolean;
  readonly rows: number;
  readonly extent: readonly [number, number, number, number];
  readonly arrays: Readonly<Record<string, ArrayRef>>;
  readonly levels: readonly {
    readonly tolerance: number;
    readonly triangles: ArrayRef;
    readonly strips: ArrayRef;
    readonly along: ArrayRef;
  }[];
  readonly nodeTriangles: readonly ArrayRef[];
  readonly nodeStrips: readonly ArrayRef[];
}
interface Manifest {
  readonly latkit: 'pack';
  readonly version: 1;
  readonly types: Readonly<
    Record<
      string,
      {
        readonly fields: Readonly<Record<string, FieldDefinition>>;
        readonly blocks: readonly {
          readonly offset: number;
          readonly count: number;
          readonly ids: ColumnRef;
          readonly columns: Readonly<Record<string, ColumnRef>>;
        }[];
      }
    >
  >;
  readonly shapes: readonly ShapesRef[];
}

/** Typed arrays laid end to end, each on an eight-byte boundary. */
class Binary {
  private readonly arrays: ArrayBufferView[] = [];
  size = 0;
  add(array: ArrayBufferView): ArrayRef {
    const name = array.constructor.name as ArrayName;
    if (!(name in ARRAYS)) throw failure('invalid-input', `A pack cannot hold ${name}`);
    this.size = Math.ceil(this.size / 8) * 8;
    const offset = this.size;
    this.arrays.push(array);
    this.size += array.byteLength;
    return { type: name, offset, length: (array as Float64Array).length };
  }
  write(into: Uint8Array, at: number): void {
    let offset = 0;
    for (const array of this.arrays) {
      offset = Math.ceil(offset / 8) * 8;
      into.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at + offset);
      offset += array.byteLength;
    }
  }
}
function columnRef(binary: Binary, column: Column, name: string): ColumnRef {
  const validity = column.validity && binary.add(column.validity),
    base = { length: column.length, ...(validity ? { validity } : {}) };
  if (column.offset !== 0)
    throw failure('internal', `A packed column starts at its slice: ${name}`);
  if (column.kind === 'numeric')
    return { kind: 'numeric', ...base, values: binary.add(column.values) };
  if (column.kind === 'boolean')
    return { kind: 'boolean', ...base, values: binary.add(column.values) };
  if (column.kind === 'text')
    return {
      kind: 'text',
      ...base,
      bytes: binary.add(column.bytes),
      offsets: binary.add(column.offsets),
    };
  if (column.kind === 'vector' && column.values.offset === 0)
    return {
      kind: 'vector',
      ...base,
      size: column.size,
      values: binary.add(column.values.values),
    };
  throw failure('invalid-input', `A pack holds numbers, booleans, text, and vectors: ${name}`);
}
/** A copy of a column that starts at its slice, so its arrays write whole. */
function compact(column: Column): Column {
  if (column.offset === 0 && (column.kind !== 'vector' || column.values.offset === 0))
    return column;
  const { offset, length } = column,
    bits = (bitmap: Uint8Array | undefined) => {
      if (!bitmap) return undefined;
      const out = new Uint8Array(Math.ceil(length / 8));
      for (let i = 0; i < length; i++)
        if (bitmap[(offset + i) >>> 3] & (1 << ((offset + i) & 7))) out[i >>> 3] |= 1 << (i & 7);
      return out;
    };
  const validity = bits(column.validity),
    base = { offset: 0, length, ...(validity ? { validity } : {}) };
  if (column.kind === 'numeric')
    return { kind: 'numeric', ...base, values: column.values.slice(offset, offset + length) };
  if (column.kind === 'boolean') return { kind: 'boolean', ...base, values: bits(column.values)! };
  if (column.kind === 'text') {
    const start = column.offsets[offset],
      offsets = Int32Array.from(
        column.offsets.subarray(offset, offset + length + 1),
        (v) => v - start,
      );
    return {
      kind: 'text',
      ...base,
      offsets,
      bytes: column.bytes.slice(start, column.offsets[offset + length]),
    };
  }
  if (column.kind === 'vector') {
    const from = column.values.offset + offset * column.size,
      values = column.values.values.slice(from, from + length * column.size);
    return {
      kind: 'vector',
      ...base,
      size: column.size,
      values: { kind: 'numeric', offset: 0, length: values.length, values },
    };
  }
  return column;
}
function shapesRef(binary: Binary, type: string, field: string, shapes: Shapes): ShapesRef {
  const arrays: Record<string, ArrayRef> = {};
  for (const name of [
    'origins',
    'bounds',
    'anchors',
    'vertices',
    'parts',
    'pieces',
    'pieceParts',
    'pieceBounds',
  ] as const)
    arrays[name] = binary.add(shapes[name]);
  arrays.cells = binary.add(shapes.nodes.cells);
  arrays.next = binary.add(shapes.nodes.next);
  arrays.nodePieces = binary.add(shapes.nodes.pieces);
  return {
    type,
    field,
    closed: shapes.closed,
    rows: shapes.rows,
    extent: shapes.extent,
    arrays,
    levels: shapes.levels.map((level) => ({
      tolerance: level.tolerance,
      triangles: binary.add(level.triangles),
      strips: binary.add(level.strips),
      along: binary.add(level.along),
    })),
    nodeTriangles: shapes.nodes.triangles.map((array) => binary.add(array)),
    nodeStrips: shapes.nodes.strips.map((array) => binary.add(array)),
  };
}

/** The field a record draws from: its own, or the kind's default. */
export function shapeField(kind: 'area' | 'line', options: AreaOptions | LineOptions): FieldInput {
  return kind === 'area'
    ? ((options as AreaOptions).rings ?? 'rings')
    : ((options as LineOptions).points ?? 'points');
}
/** Whether a line record strokes rings, which close: an area type's own `rings`. */
export function strokesRings(options: LineOptions, area: AreaOptions | undefined): boolean {
  const field = options.points ?? 'points';
  return field === 'rings' || (area !== undefined && field === (area.rings ?? 'rings'));
}
/** A field input as a key: a field name, or its JSON. */
export function fieldKey(field: FieldInput): string {
  return typeof field === 'string' ? field : JSON.stringify(field);
}

/**
 * A pack: the shapes and fields the records name, prepared ahead, as a PMTiles archive. A view
 * reads it with `tiles()` and draws it without preparing anything, offline or from a CDN.
 */
export async function pack(
  data: Data,
  records: {
    readonly areas?: Readonly<Record<string, AreaOptions>>;
    readonly lines?: Readonly<Record<string, LineOptions>>;
  },
): Promise<Uint8Array> {
  const reader = createReader().open();
  try {
    const binary = new Binary(),
      shapes: ShapesRef[] = [],
      prepared = new Map<string, Promise<Shapes>>(),
      fields = new Map<string, Set<string>>();
    const want = (
      type: string,
      field: FieldInput,
      closed: boolean,
      geodesic: boolean,
      options: AreaOptions | LineOptions,
      kinds: Readonly<Record<string, kit.ChannelKind>>,
    ) => {
      if (typeof field !== 'string')
        throw failure('invalid-input', `A pack names its shape fields: ${type}`);
      const key = `${type}\u0000${field}\u0000${closed}`;
      if (!prepared.has(key))
        prepared.set(
          key,
          readShapes(reader, data, type, field, { closed, geodesic }).then((input) =>
            run({ kind: 'shapes', input }, [
              input.rowParts.buffer as ArrayBuffer,
              input.parts.buffer as ArrayBuffer,
              input.coordinates.buffer as ArrayBuffer,
            ]),
          ),
        );
      const named = fields.get(type) ?? new Set<string>();
      for (const input of Object.values(kit.bindChannels(options, kinds).fields))
        if (typeof input === 'string') named.add(input);
      const labels = kit.resolveLabels(options.labels);
      if (labels && typeof labels.field === 'string') named.add(labels.field);
      fields.set(type, named);
    };
    for (const [type, options] of Object.entries(records.areas ?? {}))
      want(type, shapeField('area', options), true, false, options, AREA);
    for (const [type, options] of Object.entries(records.lines ?? {}))
      want(
        type,
        shapeField('line', options),
        strokesRings(options, records.areas?.[type]),
        options.route === 'geodesic',
        options,
        LINE,
      );
    let extent: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [key, done] of prepared) {
      const [type, field] = key.split('\u0000'),
        result = await done;
      shapes.push(shapesRef(binary, type, field, result));
      if (result.extent[0] <= result.extent[2])
        extent = [
          Math.min(extent[0], result.extent[0]),
          Math.min(extent[1], result.extent[1]),
          Math.max(extent[2], result.extent[2]),
          Math.max(extent[3], result.extent[3]),
        ];
    }
    const types: Record<string, Manifest['types'][string]> = {};
    for (const [type, named] of fields) {
      const definitions: Record<string, FieldDefinition> = {},
        inputs: Record<string, string> = {};
      for (const name of named) {
        const definition = fieldDefinition(data, type, name);
        if (!definition) throw failure('invalid-input', `No ${name} field on ${type}`);
        // Sampled values belong to a run's Data, which `values` reads; a pack holds what stays.
        if ('sampled' in definition && definition.sampled) continue;
        definitions[name] = definition;
        inputs[name] = name;
      }
      const blocks: Manifest['types'][string]['blocks'][number][] = [];
      for await (const block of reader.fields({
        source: data,
        from: type,
        fields: inputs,
        ids: true,
      })) {
        if (!block.ids) throw failure('invalid-input', `Rows of ${type} need ids to pack`);
        const columns: Record<string, ColumnRef> = {};
        for (const name of Object.keys(inputs)) {
          const column = block.columns[name];
          if (column) columns[name] = columnRef(binary, compact(column), name);
        }
        blocks.push({
          offset: block.rowOffset,
          count: rowCount(block.rows),
          ids: columnRef(binary, compact(block.ids), 'ids'),
          columns,
        });
      }
      types[type] = { fields: definitions, blocks };
    }
    const manifest: Manifest = { latkit: 'pack', version: 1, types, shapes },
      json = new TextEncoder().encode(JSON.stringify(manifest)),
      head = Math.ceil((8 + json.length) / 8) * 8,
      payload = new Uint8Array(head + binary.size),
      view = new DataView(payload.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, json.length, true);
    payload.set(json, 8);
    binary.write(payload, head);
    if (!(extent[0] <= extent[2])) extent = [-180, -85.0511287798, 180, 85.0511287798];
    return writeArchive([{ z: 0, x: 0, y: 0, bytes: payload }], {
      kind: 'pack',
      minZoom: 0,
      maxZoom: 0,
      bounds: extent,
      metadata: {
        types: Object.keys(types),
        shapes: shapes.map(({ type, field, closed }) => ({ type, field, closed })),
      },
    });
  } finally {
    reader.close();
  }
}

/** What a pack holds: its rows as Data, and each type's prepared shapes by field. */
export interface Pack {
  readonly data: Data;
  readonly shapes: ReadonlyMap<string, Shapes>;
}
/** The key a pack files a type's shapes under. */
export function packKey(type: string, field: string, closed: boolean): string {
  return `${type}\u0000${field}\u0000${closed}`;
}
/** Read a pack's payload: views onto its binary, with nothing copied but a misaligned whole. */
export function readPack(bytes: Uint8Array, source: string): Pack {
  if (bytes.byteOffset % 8) bytes = bytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint32(0, true) !== MAGIC)
    throw failure('invalid-input', 'These bytes are not a latkit pack');
  const length = view.getUint32(4, true),
    manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as Manifest,
    head = Math.ceil((8 + length) / 8) * 8;
  if (manifest.latkit !== 'pack' || manifest.version !== 1)
    throw failure('unsupported', 'This pack was written by another version of latkit');
  const buffer = bytes.buffer as ArrayBuffer,
    array = <T extends ArrayBufferView>(ref: ArrayRef): T =>
      new ARRAYS[ref.type](
        buffer,
        bytes.byteOffset + head + ref.offset,
        ref.length,
      ) as unknown as T;
  const column = (ref: ColumnRef): Column => {
    const base = {
      offset: 0,
      length: ref.length,
      ...(ref.validity ? { validity: array<Uint8Array>(ref.validity) } : {}),
    };
    if (ref.kind === 'text')
      return { kind: 'text', ...base, bytes: array(ref.bytes!), offsets: array(ref.offsets!) };
    if (ref.kind === 'vector') {
      const values = array<Float64Array>(ref.values!);
      return {
        kind: 'vector',
        ...base,
        size: ref.size!,
        values: { kind: 'numeric', offset: 0, length: values.length, values },
      };
    }
    if (ref.kind === 'boolean') return { kind: 'boolean', ...base, values: array(ref.values!) };
    return { kind: 'numeric', ...base, values: array(ref.values!) };
  };
  const definitions: Record<string, TypeDefinition> = {},
    batches: RowBatch[] = [];
  for (const [type, entry] of Object.entries(manifest.types)) {
    definitions[type] = { fields: entry.fields };
    for (const block of entry.blocks)
      batches.push({
        kind: 'rows',
        index: { source, type, version: '1' },
        rows: { kind: 'range', offset: block.offset, count: block.count },
        ids: column(block.ids) as RowBatch['ids'],
        columns: Object.fromEntries(
          Object.entries(block.columns).map(([name, ref]) => [name, column(ref)]),
        ),
      });
  }
  const shapes = new Map<string, Shapes>();
  for (const ref of manifest.shapes) {
    const a = ref.arrays,
      levels: ShapesLevel[] = ref.levels.map((level) => ({
        tolerance: level.tolerance,
        triangles: array(level.triangles),
        strips: array(level.strips),
        along: array(level.along),
      }));
    shapes.set(packKey(ref.type, ref.field, ref.closed), {
      closed: ref.closed,
      rows: ref.rows,
      extent: ref.extent,
      origins: array(a.origins),
      bounds: array(a.bounds),
      anchors: array(a.anchors),
      vertices: array(a.vertices),
      parts: array(a.parts),
      pieces: array(a.pieces),
      pieceParts: array(a.pieceParts),
      pieceBounds: array(a.pieceBounds),
      levels,
      nodes: {
        cells: array(a.cells),
        next: array(a.next),
        pieces: array(a.nodePieces),
        triangles: ref.nodeTriangles.map((r) => array(r)),
        strips: ref.nodeStrips.map((r) => array(r)),
      },
    });
  }
  return { data: createData({ types: definitions }, batches), shapes };
}
/** Every buffer a pack's shapes hold, as a check that nothing copied: one, its payload's. */
export function packBuffers(pack: Pack): ArrayBuffer[] {
  return [...new Set([...pack.shapes.values()].flatMap(shapesBuffers))];
}
