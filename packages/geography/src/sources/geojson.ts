import { failure, textColumn } from '@latkit/model';
import type {
  BooleanColumn,
  Column,
  DataType,
  FieldDefinition,
  ListColumn,
  NumericColumn,
  RowBatch,
  Schema,
  TextColumn,
  TypeDefinition,
  VectorColumn,
} from '@latkit/model';

export interface GeoJsonOptions {
  /** The type features become: one name for all, or a name per feature from its properties. 'Feature' by default. */
  readonly type?: string | ((properties: Readonly<Record<string, unknown>>) => string);
  /** A property holding each feature's id; the feature's own `id`, else its type and place, by default. */
  readonly id?: string;
  /** The Index source name rows are numbered under; a fresh one by default. */
  readonly source?: string;
  /** Stops reading and parsing; the promise rejects. */
  readonly signal?: AbortSignal;
}

type Properties = Readonly<Record<string, unknown>>;
/** Longitude, latitude, and any altitude, which is ignored. */
type Position = readonly number[];

/** A feature as GeoJSON gives it; its geometry is read in the passes. */
interface Feature {
  readonly geometry: unknown;
  readonly properties: Properties;
  readonly id: unknown;
}

/** A field of a type: its definition and its column. */
interface Field {
  readonly name: string;
  readonly definition: FieldDefinition;
  readonly column: Column;
}

const POSITION: DataType = { kind: 'vector', items: 'float64', size: 2 };
/** Each row's rings or polylines: lists of positions. */
const PATHS: DataType = { kind: 'list', items: { kind: 'list', items: POSITION } };
/** Names shape fields take; a property of the same name is skipped. */
const SHAPE_NAMES = new Set(['rings', 'points', 'position']);
const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);
const NO_PROPERTIES: Properties = Object.freeze({});
const MAX_OFFSET = 0x7fffffff;

/** The schema and row batches GeoJSON describes, as plain columns any thread can build and transfer. */
export function geojsonBatches(
  value: unknown,
  options: GeoJsonOptions = {},
): { readonly schema: Schema; readonly batches: readonly RowBatch[] } {
  const source = options.source ?? crypto.randomUUID();
  const types: [string, TypeDefinition][] = [];
  const batches: RowBatch[] = [];
  for (const [type, features] of byType(featuresOf(value), options.type)) {
    const fields = [...shapeFields(features), ...propertyFields(features)];
    types.push([type, { fields: Object.fromEntries(fields.map((f) => [f.name, f.definition])) }]);
    batches.push({
      kind: 'rows',
      index: { source, type, version: '1' },
      rows: { kind: 'range', offset: 0, count: features.length },
      ids: idsOf(type, features, options.id),
      columns: Object.fromEntries(fields.map((f) => [f.name, f.column])),
    });
  }
  return { schema: { types: Object.fromEntries(types) }, batches };
}

function notGeoJson(detail: string): Error {
  return failure('invalid-input', `Not GeoJSON: ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function featuresOf(value: unknown): readonly Feature[] {
  if (!isRecord(value)) throw notGeoJson('not an object');
  if (value.type === 'FeatureCollection') {
    if (!Array.isArray(value.features)) throw notGeoJson('a FeatureCollection without features');
    return (value.features as readonly unknown[]).map(featureOf);
  }
  if (value.type === 'Feature') return [featureOf(value, 0)];
  if (typeof value.type === 'string' && GEOMETRY_TYPES.has(value.type))
    return [{ geometry: value, properties: NO_PROPERTIES, id: undefined }];
  throw notGeoJson('no recognizable type');
}

function featureOf(value: unknown, at: number): Feature {
  if (!isRecord(value) || value.type !== 'Feature')
    throw notGeoJson(`feature ${at} is not a Feature`);
  const { geometry, properties, id } = value;
  if (properties === null || properties === undefined)
    return { geometry, properties: NO_PROPERTIES, id };
  if (!isRecord(properties))
    throw notGeoJson(`feature ${at} has properties that are not an object`);
  return { geometry, properties, id };
}

/** Features grouped by the type each becomes, in order of first appearance. */
function byType(
  features: readonly Feature[],
  type: GeoJsonOptions['type'] = 'Feature',
): Map<string, Feature[]> {
  const types = new Map<string, Feature[]>();
  for (const feature of features) {
    const name: unknown = typeof type === 'function' ? type(feature.properties) : type;
    if (typeof name !== 'string' || !name)
      throw failure('invalid-input', 'A feature type must be a nonempty string.');
    let members = types.get(name);
    if (!members) types.set(name, (members = []));
    members.push(feature);
  }
  return types;
}

// Shapes

/** Where a geometry's kept shapes go: rings with the positions each keeps, polylines, positions. */
interface Shapes {
  ring(ring: readonly Position[], length: number, hole: boolean): void;
  line(line: readonly Position[]): void;
  point(position: Position): void;
}

/** Shape fields in two passes: count every row's shapes, then write them into exact buffers. */
function shapeFields(features: readonly Feature[]): Field[] {
  const rows = features.length;
  const count = new ShapeCount();
  for (const feature of features) {
    walk(feature.geometry, count);
    count.end();
  }
  const writer = new ShapeWriter(
    count.ringRows
      ? new PathsColumn(rows, count.rings, count.ringPoints, count.ringRows < rows)
      : undefined,
    count.lineRows
      ? new PathsColumn(rows, count.lines, count.linePoints, count.lineRows < rows)
      : undefined,
    count.positionRows ? new PositionColumn(rows, count.positionRows < rows) : undefined,
  );
  for (const feature of features) {
    walk(feature.geometry, writer);
    writer.end();
  }
  return writer.fields();
}

function walk(geometry: unknown, shapes: Shapes): void {
  if (geometry === null || geometry === undefined) return;
  if (!isRecord(geometry)) throw notGeoJson('a geometry is not an object');
  const coordinates = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
      point(coordinates, shapes);
      break;
    case 'MultiPoint':
      for (const position of arrayOf(coordinates)) point(position, shapes);
      break;
    case 'LineString':
      line(coordinates, shapes);
      break;
    case 'MultiLineString':
      for (const path of arrayOf(coordinates)) line(path, shapes);
      break;
    case 'Polygon':
      polygon(coordinates, shapes);
      break;
    case 'MultiPolygon':
      for (const rings of arrayOf(coordinates)) polygon(rings, shapes);
      break;
    case 'GeometryCollection':
      for (const member of arrayOf(geometry.geometries)) walk(member, shapes);
      break;
    default:
      throw notGeoJson('a geometry has no recognizable type');
  }
}

/** A position; an empty one, an empty Point, gives nothing. */
function point(value: unknown, shapes: Shapes): void {
  if (Array.isArray(value) && value.length === 0) return;
  shapes.point(positionOf(value));
}

/** A polyline, kept with 2 points or more. */
function line(value: unknown, shapes: Shapes): void {
  const positions = positionsOf(value);
  if (positions.length >= 2) shapes.line(positions);
}

/** A polygon's kept rings: its outline, then its holes. A degenerate outline drops the polygon. */
function polygon(value: unknown, shapes: Shapes): void {
  const rings = arrayOf(value).map(positionsOf);
  const outline = rings.length ? ringLength(rings[0]) : 0;
  if (!outline) return;
  shapes.ring(rings[0], outline, false);
  for (let i = 1; i < rings.length; i++) {
    const length = ringLength(rings[i]);
    if (length) shapes.ring(rings[i], length, true);
  }
}

/** The positions a ring keeps: all but a closing repeat of the first, or none if fewer than 3 distinct. */
function ringLength(ring: readonly Position[]): number {
  let length = ring.length;
  if (length > 1 && same(ring[0], ring[length - 1])) length--;
  return threeDistinct(ring, length) ? length : 0;
}

/** Whether a ring's first `length` positions hold at least 3 distinct ones. */
function threeDistinct(ring: readonly Position[], length: number): boolean {
  let second = -1;
  for (let i = 1; i < length; i++) {
    if (same(ring[i], ring[0])) continue;
    if (second < 0) second = i;
    else if (!same(ring[i], ring[second])) return true;
  }
  return false;
}

function same(a: Position, b: Position): boolean {
  return longitude(a) === longitude(b) && latitude(a) === latitude(b);
}

/** The shoelace area of a ring's first `length` positions; positive when counter-clockwise, latitude up. */
function signedArea(ring: readonly Position[], length: number): number {
  const x0 = longitude(ring[0]),
    y0 = latitude(ring[0]);
  let sum = 0,
    px = 0,
    py = 0;
  for (let i = 1; i < length; i++) {
    const x = longitude(ring[i]) - x0,
      y = latitude(ring[i]) - y0;
    sum += px * y - x * py;
    px = x;
    py = y;
  }
  return sum / 2;
}

/** Longitude wrapped into [-180, 180]. */
function longitude(position: Position): number {
  const x = position[0];
  return x >= -180 && x <= 180 ? x : ((((x + 180) % 360) + 360) % 360) - 180;
}

/** Latitude clamped to [-90, 90]. */
function latitude(position: Position): number {
  const y = position[1];
  return y < -90 ? -90 : y > 90 ? 90 : y;
}

function arrayOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw notGeoJson('coordinates are not arrays');
  return value as readonly unknown[];
}

function positionOf(value: unknown): Position {
  if (!Array.isArray(value) || !Number.isFinite(value[0]) || !Number.isFinite(value[1]))
    throw notGeoJson('a position is not a finite longitude and latitude');
  return value as Position;
}

/** A list of positions, each checked. */
function positionsOf(value: unknown): readonly Position[] {
  const positions = arrayOf(value);
  for (const position of positions) positionOf(position);
  return positions as readonly Position[];
}

/** The first pass: how many rings, polylines, and positions a type's rows keep. */
class ShapeCount implements Shapes {
  rings = 0;
  ringPoints = 0;
  ringRows = 0;
  lines = 0;
  linePoints = 0;
  lineRows = 0;
  positionRows = 0;
  #rowRings = 0;
  #rowLines = 0;
  #placed = false;

  ring(_ring: readonly Position[], length: number): void {
    this.rings++;
    this.ringPoints += length;
  }

  line(line: readonly Position[]): void {
    this.lines++;
    this.linePoints += line.length;
  }

  point(): void {
    this.#placed = true;
  }

  /** End a row, noting which shape fields it gave a value. */
  end(): void {
    if (this.rings > this.#rowRings) this.ringRows++;
    if (this.lines > this.#rowLines) this.lineRows++;
    if (this.#placed) this.positionRows++;
    this.#rowRings = this.rings;
    this.#rowLines = this.lines;
    this.#placed = false;
  }
}

/** The second pass: writes each row's shapes into the columns the first pass sized. */
class ShapeWriter implements Shapes {
  #row = 0;

  constructor(
    readonly rings: PathsColumn | undefined,
    readonly points: PathsColumn | undefined,
    readonly position: PositionColumn | undefined,
  ) {}

  /** Outlines wind counter-clockwise and holes clockwise, reversed when they do not. */
  ring(ring: readonly Position[], length: number, hole: boolean): void {
    const area = signedArea(ring, length);
    this.rings?.add(ring, length, hole ? area > 0 : area < 0);
  }

  line(line: readonly Position[]): void {
    this.points?.add(line, line.length, false);
  }

  point(position: Position): void {
    this.position?.add(this.#row, position);
  }

  end(): void {
    this.rings?.end(this.#row);
    this.points?.end(this.#row);
    this.position?.end(this.#row);
    this.#row++;
  }

  fields(): Field[] {
    const fields: Field[] = [];
    if (this.rings) fields.push(shapeField('rings', PATHS, this.rings.column()));
    if (this.points) fields.push(shapeField('points', PATHS, this.points.column()));
    if (this.position) fields.push(shapeField('position', POSITION, this.position.column()));
    return fields;
  }
}

function shapeField(name: string, type: DataType, column: Column): Field {
  return {
    name,
    definition: { type, geographic: true, ...(column.validity ? { nullable: true } : {}) },
    column,
  };
}

/** Rows of rings or polylines, written into buffers sized by the count. */
class PathsColumn {
  readonly #rows: Int32Array;
  readonly #offsets: Int32Array;
  readonly #values: Float64Array;
  readonly #validity: Uint8Array | undefined;
  #paths = 0;
  #points = 0;

  constructor(rows: number, paths: number, points: number, nullable: boolean) {
    if (paths > MAX_OFFSET || points > MAX_OFFSET)
      throw failure('resource-limit', 'GeoJSON holds more shapes than int32 offsets address.');
    this.#rows = new Int32Array(rows + 1);
    this.#offsets = new Int32Array(paths + 1);
    this.#values = new Float64Array(points * 2);
    this.#validity = nullable ? new Uint8Array(Math.ceil(rows / 8)) : undefined;
  }

  /** Append a path's first `length` positions, reversed when asked. */
  add(path: readonly Position[], length: number, reverse: boolean): void {
    const values = this.#values;
    let at = this.#points * 2;
    for (let i = 0; i < length; i++) {
      const position = path[reverse ? length - 1 - i : i];
      values[at++] = longitude(position);
      values[at++] = latitude(position);
    }
    this.#points += length;
    this.#offsets[++this.#paths] = this.#points;
  }

  /** End a row; it is present when it gained a path. */
  end(row: number): void {
    this.#rows[row + 1] = this.#paths;
    if (this.#validity && this.#paths > this.#rows[row]) setBit(this.#validity, row);
  }

  column(): ListColumn {
    const points = this.#values.length / 2;
    const paths: ListColumn = {
      kind: 'list',
      offset: 0,
      length: this.#offsets.length - 1,
      offsets: this.#offsets,
      values: {
        kind: 'vector',
        offset: 0,
        length: points,
        size: 2,
        values: { kind: 'numeric', offset: 0, length: points * 2, values: this.#values },
      },
    };
    return {
      kind: 'list',
      offset: 0,
      length: this.#rows.length - 1,
      offsets: this.#rows,
      values: paths,
      ...(this.#validity ? { validity: this.#validity } : {}),
    };
  }
}

/** One position per row: the first its geometry gives. */
class PositionColumn {
  readonly #values: Float64Array;
  readonly #validity: Uint8Array | undefined;
  #placed = false;

  constructor(rows: number, nullable: boolean) {
    this.#values = new Float64Array(rows * 2);
    this.#validity = nullable ? new Uint8Array(Math.ceil(rows / 8)) : undefined;
  }

  add(row: number, position: Position): void {
    if (this.#placed) return;
    this.#placed = true;
    this.#values[row * 2] = longitude(position);
    this.#values[row * 2 + 1] = latitude(position);
  }

  end(row: number): void {
    if (this.#placed && this.#validity) setBit(this.#validity, row);
    this.#placed = false;
  }

  column(): VectorColumn {
    const values = this.#values;
    return {
      kind: 'vector',
      offset: 0,
      length: values.length / 2,
      size: 2,
      values: { kind: 'numeric', offset: 0, length: values.length, values },
      ...(this.#validity ? { validity: this.#validity } : {}),
    };
  }
}

// Properties

type PropertyType = 'float64' | 'boolean' | 'text';

/** A property across a type's features: the type its values share and how many are present. */
interface PropertyTally {
  type: PropertyType;
  present: number;
}

/** A field per property some feature gives a value, in order of first value. */
function propertyFields(features: readonly Feature[]): Field[] {
  return [...tallyProperties(features)].map(([name, tally]) => {
    const column = propertyColumn(features, name, tally);
    return {
      name,
      definition: { type: tally.type, ...(column.validity ? { nullable: true } : {}) },
      column,
    };
  });
}

function tallyProperties(features: readonly Feature[]): Map<string, PropertyTally> {
  const tallies = new Map<string, PropertyTally>();
  for (const { properties } of features)
    for (const name of Object.keys(properties)) {
      const value = properties[name];
      if (value === null || value === undefined || !name || SHAPE_NAMES.has(name)) continue;
      const type = propertyType(value);
      const tally = tallies.get(name);
      if (!tally) tallies.set(name, { type, present: 1 });
      else {
        tally.present++;
        if (tally.type !== type) tally.type = 'text';
      }
    }
  return tallies;
}

function propertyType(value: unknown): PropertyType {
  if (typeof value === 'number' && Number.isFinite(value)) return 'float64';
  return typeof value === 'boolean' ? 'boolean' : 'text';
}

function propertyColumn(features: readonly Feature[], name: string, tally: PropertyTally): Column {
  if (tally.type === 'text')
    return textColumn(features.map((feature) => text(valueOf(feature.properties, name))));
  const rows = features.length;
  const validity = tally.present < rows ? new Uint8Array(Math.ceil(rows / 8)) : undefined;
  return tally.type === 'float64'
    ? numberColumn(features, name, validity)
    : booleanColumn(features, name, validity);
}

function numberColumn(
  features: readonly Feature[],
  name: string,
  validity: Uint8Array | undefined,
): NumericColumn {
  const values = new Float64Array(features.length);
  for (let i = 0; i < features.length; i++) {
    const value = valueOf(features[i].properties, name);
    if (typeof value !== 'number') continue;
    values[i] = value;
    if (validity) setBit(validity, i);
  }
  return {
    kind: 'numeric',
    offset: 0,
    length: values.length,
    values,
    ...(validity ? { validity } : {}),
  };
}

function booleanColumn(
  features: readonly Feature[],
  name: string,
  validity: Uint8Array | undefined,
): BooleanColumn {
  const values = new Uint8Array(Math.ceil(features.length / 8));
  for (let i = 0; i < features.length; i++) {
    const value = valueOf(features[i].properties, name);
    if (typeof value !== 'boolean') continue;
    if (value) setBit(values, i);
    if (validity) setBit(validity, i);
  }
  return {
    kind: 'boolean',
    offset: 0,
    length: features.length,
    values,
    ...(validity ? { validity } : {}),
  };
}

/** A property value as text: numbers and booleans stringified, objects and arrays as JSON. */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** A feature's own property; never one inherited from Object. */
function valueOf(properties: Properties, name: string): unknown {
  return Object.hasOwn(properties, name) ? properties[name] : undefined;
}

function setBit(bitmap: Uint8Array, at: number): void {
  bitmap[at >>> 3] |= 1 << (at & 7);
}

// Ids

/** Each row's id, unique within its type: the `property`, the feature's id, or the type and place. */
function idsOf(
  type: string,
  features: readonly Feature[],
  property: string | undefined,
): TextColumn {
  const taken = new Set<string>();
  const next = new Map<string, number>();
  return textColumn(
    features.map((feature, place) =>
      unique(
        (property === undefined ? undefined : idText(valueOf(feature.properties, property))) ??
          idText(feature.id) ??
          `${type}/${place}`,
        taken,
        next,
      ),
    ),
  );
}

/** An id as text: a nonempty string or a finite number. */
function idText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** `id`, or `id#2`, `id#3`, and so on when taken. */
function unique(id: string, taken: Set<string>, next: Map<string, number>): string {
  let result = id;
  if (taken.has(id)) {
    let n = next.get(id) ?? 2;
    while (taken.has(`${id}#${n}`)) n++;
    next.set(id, n + 1);
    result = `${id}#${n}`;
  }
  taken.add(result);
  return result;
}
