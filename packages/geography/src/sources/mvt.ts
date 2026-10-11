import { failure } from '@latkit/model';

/** A decoded tile's layer: its features by geometry, in tile units (0..extent, y down). */
export interface TileLayer {
  readonly name: string;
  readonly extent: number;
  /** Property names and values, shared by its features (MVT keys and values tables). */
  readonly keys: readonly string[];
  readonly values: readonly (string | number | boolean)[];
  readonly areas: FeatureSet;
  readonly lines: FeatureSet;
  readonly points: FeatureSet;
}

/**
 * Features of one geometry, packed: every coordinate in one Float32Array of x, y pairs.
 * `parts` holds, per part (a ring, a polyline, or a feature's points), the index of its first pair
 * and, after the last part, the total pair count. `features` holds, per feature, the index of its
 * first part and, after the last, the total part count. For areas, `polygons` holds, for every
 * polygon in feature order, the index of its first part (outer ring, then its holes), and after the
 * last, the part count; a feature's polygons are those beginning within its parts. Outer rings are
 * counter-clockwise and holes clockwise in a y-up frame (negative and positive shoelace area in the
 * y-down tile frame), whatever the tile encodes. Degenerate rings and polylines, repeated
 * consecutive points, and features left without parts are dropped.
 */
export interface FeatureSet {
  readonly coordinates: Float32Array;
  readonly parts: Uint32Array;
  readonly features: Uint32Array;
  /** Areas only: per polygon, its first part, and after the last, the part count. */
  readonly polygons?: Uint32Array;
  /** Per feature, its id (NaN without one). */
  readonly ids: Float64Array;
  /** Per feature, its tags as pairs of key and value indices into the layer's tables. */
  readonly tags: Uint32Array;
  /** Per feature, where its tags begin in `tags` (pairs), and after the last, the total. */
  readonly tagStarts: Uint32Array;
}

type Value = string | number | boolean;

const VARINT = 0;
const FIXED64 = 1;
const BYTES = 2;
const FIXED32 = 5;

const MOVE_TO = 1;
const LINE_TO = 2;
const CLOSE_PATH = 7;

const POINT = 1;
const LINESTRING = 2;
const POLYGON = 3;

const decoder = new TextDecoder();

/** Decodes a Mapbox Vector Tile (MVT 2.1) into its layers. */
export function decodeTile(bytes: Uint8Array): readonly TileLayer[] {
  const r = new Reader(bytes);
  const layers: TileLayer[] = [];
  while (r.pos < r.end) {
    const key = varint(r);
    if (key !== ((3 << 3) | BYTES)) {
      skip(r, key & 7);
      continue;
    }
    const end = span(r);
    const tileEnd = r.end;
    r.end = end;
    layers.push(readLayer(r));
    r.pos = end;
    r.end = tileEnd;
  }
  return layers;
}

/** A feature's properties as an object, for inspection; drawing reads tags directly. */
export function properties(
  layer: TileLayer,
  set: FeatureSet,
  feature: number,
): Record<string, Value> {
  const entries: [string, Value][] = [];
  for (let pair = set.tagStarts[feature]; pair < set.tagStarts[feature + 1]; pair++)
    entries.push([layer.keys[set.tags[2 * pair]], layer.values[set.tags[2 * pair + 1]]]);
  return Object.fromEntries(entries);
}

/** The failure for any input that is not a well-formed vector tile. */
function malformed(): Error {
  return failure('invalid-input', 'Malformed vector tile');
}

/** A position in protobuf bytes and the end of the message being read. */
class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos = 0;
  end: number;
  /** The low and high 32 bits of the last 64-bit varint read. */
  low = 0;
  high = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.end = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

/** Reads a varint as a number, exact below 2^53. */
function varint(r: Reader): number {
  const { bytes, end } = r;
  let pos = r.pos;
  let value = 0;
  for (let shift = 0; shift < 28; shift += 7) {
    if (pos >= end) throw malformed();
    const byte = bytes[pos++];
    value |= (byte & 0x7f) << shift;
    if (byte < 0x80) {
      r.pos = pos;
      return value;
    }
  }
  varint64(r);
  return r.high * 2 ** 32 + r.low;
}

/** Reads a varint of up to 64 bits into the reader's low and high words. */
function varint64(r: Reader): void {
  const { bytes, end } = r;
  let pos = r.pos;
  let low = 0;
  let high = 0;
  for (let shift = 0; shift < 70; shift += 7) {
    if (pos >= end) throw malformed();
    const byte = bytes[pos++];
    const bits = byte & 0x7f;
    if (shift < 28) low |= bits << shift;
    else if (shift === 28) {
      low |= bits << 28;
      high = bits >>> 4;
    } else high |= bits << (shift - 32);
    if (byte < 0x80) {
      r.pos = pos;
      r.low = low >>> 0;
      r.high = high >>> 0;
      return;
    }
  }
  throw malformed();
}

/** Reads a two's complement int64 varint. */
function int64(r: Reader): number {
  varint64(r);
  if (r.high < 0x80000000) return r.high * 2 ** 32 + r.low;
  const low = (~r.low + 1) >>> 0;
  const high = (~r.high + (low === 0 ? 1 : 0)) >>> 0;
  return -(high * 2 ** 32 + low);
}

/** Reads a zigzag-encoded sint64 varint. */
function sint64(r: Reader): number {
  varint64(r);
  const half = (r.high >>> 1) * 2 ** 32 + (((r.low >>> 1) | (r.high << 31)) >>> 0);
  return r.low & 1 ? -half - 1 : half;
}

/** Decodes a zigzag-encoded 32-bit value. */
function zigzag(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

/** Reads a length prefix and returns where the delimited bytes end. */
function span(r: Reader): number {
  const length = varint(r);
  const end = r.pos + length;
  if (end > r.end) throw malformed();
  return end;
}

/** Returns where `size` fixed bytes begin, and moves past them. */
function fixed(r: Reader, size: number): number {
  const pos = r.pos;
  if (pos + size > r.end) throw malformed();
  r.pos = pos + size;
  return pos;
}

/** Skips a field's value by its wire type. */
function skip(r: Reader, wire: number): void {
  if (wire === VARINT) varint64(r);
  else if (wire === FIXED64) fixed(r, 8);
  else if (wire === BYTES) r.pos = span(r);
  else if (wire === FIXED32) fixed(r, 4);
  else throw malformed();
}

/** Reads a length-delimited UTF-8 string. */
function string(r: Reader): string {
  const end = span(r);
  const text = utf8(r.bytes, r.pos, end);
  r.pos = end;
  return text;
}

/** Decodes UTF-8 bytes, building short ASCII strings directly. */
function utf8(bytes: Uint8Array, start: number, end: number): string {
  if (end - start > 16) return decoder.decode(bytes.subarray(start, end));
  let text = '';
  for (let i = start; i < end; i++) {
    const byte = bytes[i];
    if (byte >= 0x80) return decoder.decode(bytes.subarray(start, end));
    text += String.fromCharCode(byte);
  }
  return text;
}

/** Reads a layer: its tables first, then its features. */
function readLayer(r: Reader): TileLayer {
  const keys: string[] = [];
  const values: Value[] = [];
  let name = '';
  let extent = 4096;
  ranges.length = 0;
  while (r.pos < r.end) {
    const key = varint(r);
    if (key === ((1 << 3) | BYTES)) name = string(r);
    else if (key === ((2 << 3) | BYTES)) {
      const end = span(r);
      ranges.push(r.pos);
      ranges.push(end);
      r.pos = end;
    } else if (key === ((3 << 3) | BYTES)) keys.push(string(r));
    else if (key === ((4 << 3) | BYTES)) values.push(readValue(r));
    else if (key === ((5 << 3) | VARINT)) extent = varint(r);
    else skip(r, key & 7);
  }
  const layerEnd = r.end;
  builders.reset();
  for (let i = 0; i < ranges.length; i += 2) {
    r.pos = ranges.array[i];
    r.end = ranges.array[i + 1];
    readFeature(r, builders, keys.length, values.length);
  }
  r.pos = r.end = layerEnd;
  const { areas, lines, points } = builders;
  return {
    name,
    extent,
    keys,
    values,
    areas: areas.finish(),
    lines: lines.finish(),
    points: points.finish(),
  };
}

/** Reads a Value message: whichever of its typed fields is present. */
function readValue(r: Reader): Value {
  const end = span(r);
  const outer = r.end;
  r.end = end;
  let value: Value | undefined;
  while (r.pos < end) {
    const key = varint(r);
    if (key === ((1 << 3) | BYTES)) value = string(r);
    else if (key === ((2 << 3) | FIXED32)) value = r.view.getFloat32(fixed(r, 4), true);
    else if (key === ((3 << 3) | FIXED64)) value = r.view.getFloat64(fixed(r, 8), true);
    else if (key === ((4 << 3) | VARINT)) value = int64(r);
    else if (key === ((5 << 3) | VARINT)) value = varint(r);
    else if (key === ((6 << 3) | VARINT)) value = sint64(r);
    else if (key === ((7 << 3) | VARINT)) value = varint(r) !== 0;
    else skip(r, key & 7);
  }
  r.end = outer;
  if (value === undefined) throw malformed();
  return value;
}

/** Reads a feature and files it under its geometry, skipping unknown geometry types. */
function readFeature(r: Reader, builders: Builders, keyCount: number, valueCount: number): void {
  let type = 0;
  let id = NaN;
  let tagsStart = 0;
  let tagsEnd = 0;
  let geometryStart = 0;
  let geometryEnd = 0;
  while (r.pos < r.end) {
    const key = varint(r);
    if (key === ((1 << 3) | VARINT)) id = varint(r);
    else if (key === ((2 << 3) | BYTES)) {
      tagsEnd = span(r);
      tagsStart = r.pos;
      r.pos = tagsEnd;
    } else if (key === ((3 << 3) | VARINT)) type = varint(r);
    else if (key === ((4 << 3) | BYTES)) {
      geometryEnd = span(r);
      geometryStart = r.pos;
      r.pos = geometryEnd;
    } else skip(r, key & 7);
  }
  const builder = builders.of(type);
  if (builder === undefined) return;
  builder.begin(geometryEnd - geometryStart);
  r.pos = geometryStart;
  r.end = geometryEnd;
  if (type === POLYGON) readRings(r, builder);
  else if (type === LINESTRING) readLines(r, builder);
  else readPoints(r, builder);
  if (builder.parts.length === builder.firstPart) return;
  r.pos = tagsStart;
  r.end = tagsEnd;
  builder.end(id);
  readTags(r, builder.tags, keyCount, valueCount);
}

/** Reads packed tag pairs, checking each against the layer's tables. */
function readTags(r: Reader, tags: Uints, keyCount: number, valueCount: number): void {
  while (r.pos < r.end) {
    const key = varint(r);
    const value = varint(r);
    if (key >= keyCount || value >= valueCount) throw malformed();
    tags.push(key);
    tags.push(value);
  }
}

/** Reads point geometry: every point of the feature in one part. */
function readPoints(r: Reader, b: FeatureBuilder): void {
  const c = b.coordinates;
  const start = b.size;
  let n = start;
  let x = 0;
  let y = 0;
  while (r.pos < r.end) {
    const command = varint(r);
    const id = command & 7;
    if (id === MOVE_TO || id === LINE_TO) {
      for (let count = command >>> 3; count > 0; count--) {
        x += zigzag(varint(r));
        y += zigzag(varint(r));
        c[n++] = x;
        c[n++] = y;
      }
    } else if (id !== CLOSE_PATH) throw malformed();
  }
  if (n > start) b.parts.push(start / 2);
  b.size = n;
}

/** Reads linestring geometry: each MoveTo begins a polyline. */
function readLines(r: Reader, b: FeatureBuilder): void {
  const c = b.coordinates;
  let n = b.size;
  let line = -1;
  let x = 0;
  let y = 0;
  let firstX = 0;
  let firstY = 0;
  while (r.pos < r.end) {
    const command = varint(r);
    const id = command & 7;
    let count = command >>> 3;
    if (id === MOVE_TO) {
      for (; count > 0; count--) {
        if (line >= 0) n = b.endLine(line, n);
        x += zigzag(varint(r));
        y += zigzag(varint(r));
        line = n;
        firstX = x;
        firstY = y;
        c[n++] = x;
        c[n++] = y;
      }
    } else if (id === LINE_TO) {
      if (line < 0) throw malformed();
      for (; count > 0; count--) {
        const dx = zigzag(varint(r));
        const dy = zigzag(varint(r));
        if (dx === 0 && dy === 0) continue;
        x += dx;
        y += dy;
        c[n++] = x;
        c[n++] = y;
      }
    } else if (id === CLOSE_PATH) {
      if (line < 0) continue;
      if (x !== firstX || y !== firstY) {
        c[n++] = firstX;
        c[n++] = firstY;
      }
      n = b.endLine(line, n);
      line = -1;
    } else throw malformed();
  }
  if (line >= 0) n = b.endLine(line, n);
  b.size = n;
}

/** Reads polygon geometry: rings, each closed by ClosePath or the next MoveTo. */
function readRings(r: Reader, b: FeatureBuilder): void {
  const c = b.coordinates;
  let n = b.size;
  let ring = -1;
  let x = 0;
  let y = 0;
  let firstX = 0;
  let firstY = 0;
  let area = 0;
  while (r.pos < r.end) {
    const command = varint(r);
    const id = command & 7;
    let count = command >>> 3;
    if (id === MOVE_TO) {
      for (; count > 0; count--) {
        if (ring >= 0) n = closeRing(b, ring, n, x, y, firstX, firstY, area);
        x += zigzag(varint(r));
        y += zigzag(varint(r));
        ring = n;
        firstX = x;
        firstY = y;
        area = 0;
        c[n++] = x;
        c[n++] = y;
      }
    } else if (id === LINE_TO) {
      if (ring < 0) throw malformed();
      for (; count > 0; count--) {
        const dx = zigzag(varint(r));
        const dy = zigzag(varint(r));
        if (dx === 0 && dy === 0) continue;
        area += x * dy - dx * y;
        x += dx;
        y += dy;
        c[n++] = x;
        c[n++] = y;
      }
    } else if (id === CLOSE_PATH) {
      if (ring >= 0) n = closeRing(b, ring, n, x, y, firstX, firstY, area);
      ring = -1;
    } else throw malformed();
  }
  if (ring >= 0) n = closeRing(b, ring, n, x, y, firstX, firstY, area);
  b.size = n;
}

/** Closes the ring from float `start` to `end` ending at (x, y); returns the new float count. */
function closeRing(
  b: FeatureBuilder,
  start: number,
  end: number,
  x: number,
  y: number,
  firstX: number,
  firstY: number,
  area: number,
): number {
  if (x === firstX && y === firstY && end - start > 2) end -= 2;
  return b.ring(start, end, area + x * firstY - firstX * y);
}

/** Reverses the x, y pairs from float `start` to `end` in place. */
function reversePairs(c: Float32Array, start: number, end: number): void {
  for (let i = start, j = end - 2; i < j; i += 2, j -= 2) {
    const x = c[i];
    const y = c[i + 1];
    c[i] = c[j];
    c[i + 1] = c[j + 1];
    c[j] = x;
    c[j + 1] = y;
  }
}

/** A growable list of uint32 values. */
class Uints {
  array = new Uint32Array(256);
  length = 0;

  push(value: number): void {
    if (this.length === this.array.length) {
      const next = new Uint32Array(this.array.length * 2);
      next.set(this.array);
      this.array = next;
    }
    this.array[this.length++] = value;
  }

  /** Its values followed by `last`, in an array of their own. */
  close(last: number): Uint32Array {
    this.push(last);
    return this.array.slice(0, this.length);
  }
}

/** The features of one geometry as they decode, reused across a tile's layers. */
class FeatureBuilder {
  coordinates = new Float32Array(4096);
  /** Floats written to `coordinates`. */
  size = 0;
  readonly parts = new Uints();
  readonly features = new Uints();
  readonly polygons = new Uints();
  readonly tags = new Uints();
  readonly tagStarts = new Uints();
  readonly ids: number[] = [];
  /** The first part of the feature being decoded. */
  firstPart = 0;
  /** The sign of the area of that feature's first ring, or 0 before it. */
  winding = 0;
  /** Whether these features are areas, which carry polygons. */
  readonly areas: boolean;

  constructor(areas: boolean) {
    this.areas = areas;
  }

  reset(): void {
    this.size = 0;
    this.parts.length = 0;
    this.features.length = 0;
    this.polygons.length = 0;
    this.tags.length = 0;
    this.tagStarts.length = 0;
    this.ids.length = 0;
  }

  /** Starts a feature whose geometry is `byteLength` bytes, which bounds its floats at twice that. */
  begin(byteLength: number): void {
    const needed = this.size + 2 * byteLength;
    if (needed > this.coordinates.length) {
      const next = new Float32Array(Math.max(needed, this.coordinates.length * 2));
      next.set(this.coordinates.subarray(0, this.size));
      this.coordinates = next;
    }
    this.firstPart = this.parts.length;
    this.winding = 0;
  }

  /** Files the decoded feature; its tags follow. */
  end(id: number): void {
    this.features.push(this.firstPart);
    this.ids.push(id);
    this.tagStarts.push(this.tags.length / 2);
  }

  /** Ends a polyline, dropping it under two points; returns the new float count. */
  endLine(start: number, end: number): number {
    if (end - start < 4) return start;
    this.parts.push(start / 2);
    return end;
  }

  /**
   * Files a closed ring as an outer ring or a hole, normalizing its winding, or drops it when
   * degenerate; returns the new float count. The feature's first ring is outer, and later rings
   * of its winding begin new polygons.
   */
  ring(start: number, end: number, area: number): number {
    if (end - start < 6 || area === 0) return start;
    const sign = area > 0 ? 1 : -1;
    if (this.winding === 0) this.winding = sign;
    const outer = sign === this.winding;
    if (outer) this.polygons.push(this.parts.length);
    if (area < 0 !== outer) reversePairs(this.coordinates, start, end);
    this.parts.push(start / 2);
    return end;
  }

  finish(): FeatureSet {
    const partCount = this.parts.length;
    const set = {
      coordinates: this.coordinates.slice(0, this.size),
      parts: this.parts.close(this.size / 2),
      features: this.features.close(partCount),
      ids: new Float64Array(this.ids),
      tags: this.tags.array.slice(0, this.tags.length),
      tagStarts: this.tagStarts.close(this.tags.length / 2),
    };
    return this.areas ? { ...set, polygons: this.polygons.close(partCount) } : set;
  }
}

/** One feature builder per geometry. */
class Builders {
  readonly areas = new FeatureBuilder(true);
  readonly lines = new FeatureBuilder(false);
  readonly points = new FeatureBuilder(false);

  /** The builder for an MVT geometry type, or undefined for an unknown one. */
  of(type: number): FeatureBuilder | undefined {
    if (type === POLYGON) return this.areas;
    if (type === LINESTRING) return this.lines;
    if (type === POINT) return this.points;
    return undefined;
  }

  reset(): void {
    this.areas.reset();
    this.lines.reset();
    this.points.reset();
  }
}

/** Scratch shared by every decode, which runs to completion, so buffers grow once per worker. */
const builders = new Builders();
/** A layer's feature byte ranges, as start and end pairs. */
const ranges = new Uints();
