/**
 * A PMTiles v3 writer for fixtures: the archives the reader's tests open, with the directory runs,
 * leaves, and shared contents real archives use.
 */
import { failure } from '@latkit/model';
import { tileId } from '../src/sources/archive.js';
import { HEAD_BYTES } from '../src/sources/ranges.js';

type Bounds = readonly [number, number, number, number];
interface Header {
  readonly rootOffset: number;
  readonly rootLength: number;
  readonly metadataOffset: number;
  readonly metadataLength: number;
  readonly leafOffset: number;
  readonly leafLength: number;
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly addressed: number;
  readonly entries: number;
  readonly contents: number;
  readonly internalCompression: number;
  readonly tileCompression: number;
  readonly tileType: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds: Bounds;
  readonly center: readonly [lon: number, lat: number, zoom: number];
}
/** A directory's entries as columns, sorted by tile id; run length 0 marks a leaf directory. */
interface Directory {
  readonly ids: Float64Array;
  readonly runs: Uint32Array;
  readonly lengths: Uint32Array;
  readonly offsets: Float64Array;
}

const MAX_ZOOM = 26;
const HEADER_BYTES = 127;
const LEAF_ENTRIES = 4096;
const MAGIC = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]; // "PMTiles"
const NONE = 1;
/** PMTiles' tile type of Mapbox Vector Tiles. */
const MVT = 1;
/** How many tiles lie at every zoom below each zoom. */
const TILES_BELOW = new Float64Array(MAX_ZOOM + 2);
for (let z = 1; z < TILES_BELOW.length; z++) TILES_BELOW[z] = TILES_BELOW[z - 1] + 4 ** (z - 1);

/** A tile id back as its zoom, column, and row. */
export function tileOf(id: number): readonly [z: number, x: number, y: number] {
  if (!Number.isInteger(id) || id < 0 || id >= TILES_BELOW[MAX_ZOOM + 1])
    throw failure('invalid-input', `${id} is not a tile id`);
  let z = 0;
  while (TILES_BELOW[z + 1] <= id) z++;
  let rest = id - TILES_BELOW[z];
  let x = 0;
  let y = 0;
  for (let s = 1; s < 2 ** z; s *= 2) {
    const quadrant = rest % 4;
    const rx = quadrant >> 1;
    const ry = (quadrant ^ rx) & 1;
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }
    x += s * rx;
    y += s * ry;
    rest = (rest - quadrant) / 4;
  }
  return [z, x, y];
}

function writeHeader(view: DataView, header: Header): void {
  MAGIC.forEach((byte, i) => view.setUint8(i, byte));
  view.setUint8(7, 3);
  const u64 = (at: number, value: number): void => {
    view.setUint32(at, value % 2 ** 32, true);
    view.setUint32(at + 4, Math.floor(value / 2 ** 32), true);
  };
  const degrees = (at: number, value: number): void =>
    view.setInt32(at, Math.round(value * 1e7), true);
  u64(8, header.rootOffset);
  u64(16, header.rootLength);
  u64(24, header.metadataOffset);
  u64(32, header.metadataLength);
  u64(40, header.leafOffset);
  u64(48, header.leafLength);
  u64(56, header.dataOffset);
  u64(64, header.dataLength);
  u64(72, header.addressed);
  u64(80, header.entries);
  u64(88, header.contents);
  view.setUint8(96, 1);
  view.setUint8(97, header.internalCompression);
  view.setUint8(98, header.tileCompression);
  view.setUint8(99, header.tileType);
  view.setUint8(100, header.minZoom);
  view.setUint8(101, header.maxZoom);
  header.bounds.forEach((value, i) => degrees(102 + 4 * i, value));
  view.setUint8(118, header.center[2]);
  degrees(119, header.center[0]);
  degrees(123, header.center[1]);
}

/** Unsigned LEB128 varints written into a growing buffer. */
class VarintWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(capacity: number) {
    this.buffer = new Uint8Array(Math.max(16, capacity));
  }

  push(value: number): void {
    if (this.length + 10 > this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    const buffer = this.buffer;
    let position = this.length;
    let rest = value;
    while (rest >= 0x80) {
      buffer[position++] = (rest % 0x80) | 0x80;
      rest = Math.floor(rest / 0x80);
    }
    buffer[position++] = rest;
    this.length = position;
  }

  get bytes(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

/** The entries from `start` to `end`, encoded as one directory. */
function encodeDirectory(directory: Directory, start: number, end: number): Uint8Array {
  const { ids, runs, lengths, offsets } = directory;
  const out = new VarintWriter((end - start) * 6 + 8);
  out.push(end - start);
  let last = 0;
  for (let i = start; i < end; i++) {
    out.push(ids[i] - last);
    last = ids[i];
  }
  for (let i = start; i < end; i++) out.push(runs[i]);
  for (let i = start; i < end; i++) out.push(lengths[i]);
  for (let i = start; i < end; i++)
    out.push(i > start && offsets[i] === offsets[i - 1] + lengths[i - 1] ? 0 : offsets[i] + 1);
  return out.bytes;
}

function directoryOf(count: number): Directory {
  return {
    ids: new Float64Array(count),
    runs: new Uint32Array(count),
    lengths: new Uint32Array(count),
    offsets: new Float64Array(count),
  };
}

function hashOf(bytes: Uint8Array): number {
  let hash = 0x811c9dc5 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return hash >>> 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Distinct tile contents, each kept once in the order first seen, found again by hash. */
class Contents {
  readonly parts: Uint8Array[] = [];
  readonly offsets: number[] = [];
  size = 0;
  private readonly latest = new Map<number, number>();
  /** The previous content with the same hash, or -1. */
  private readonly previous: number[] = [];

  add(bytes: Uint8Array): number {
    const hash = hashOf(bytes);
    const latest = this.latest.get(hash) ?? -1;
    for (let c = latest; c >= 0; c = this.previous[c])
      if (sameBytes(this.parts[c], bytes)) return c;
    const content = this.parts.length;
    this.parts.push(bytes);
    this.offsets.push(this.size);
    this.previous.push(latest);
    this.latest.set(hash, content);
    this.size += bytes.length;
    return content;
  }
}

/** Tile indices in tile id order. */
function sortedBy(ids: Float64Array): Uint32Array {
  const order = new Uint32Array(ids.length);
  let sorted = true;
  for (let i = 0; i < ids.length; i++) {
    order[i] = i;
    if (i > 0 && ids[i] < ids[i - 1]) sorted = false;
  }
  return sorted ? order : order.sort((a, b) => ids[a] - ids[b]);
}

/** Directory entries for tiles in id order, with identical contents stored once and runs merged. */
function layoutTiles(
  tiles: readonly { readonly bytes: Uint8Array }[],
  ids: Float64Array,
  order: Uint32Array,
): { readonly entries: Directory; readonly contents: Contents } {
  const all = directoryOf(order.length);
  const contents = new Contents();
  let count = 0;
  let last = -1;
  for (let k = 0; k < order.length; k++) {
    const id = ids[order[k]];
    if (k > 0 && id === ids[order[k - 1]])
      throw failure('invalid-input', `Tile ${tileOf(id).join('/')} appears twice`);
    const bytes = tiles[order[k]].bytes;
    const content = contents.add(bytes);
    const previous = count - 1;
    if (content === last && id === all.ids[previous] + all.runs[previous]) all.runs[previous]++;
    else {
      all.ids[count] = id;
      all.runs[count] = 1;
      all.lengths[count] = bytes.length;
      all.offsets[count] = contents.offsets[content];
      count++;
    }
    last = content;
  }
  const entries = {
    ids: all.ids.subarray(0, count),
    runs: all.runs.subarray(0, count),
    lengths: all.lengths.subarray(0, count),
    offsets: all.offsets.subarray(0, count),
  };
  return { entries, contents };
}

/** A root directory that fits the first read beside the header, and leaf directories when needed. */
function layoutDirectories(entries: Directory): {
  readonly root: Uint8Array;
  readonly leaves: readonly Uint8Array[];
} {
  const count = entries.ids.length;
  const room = HEAD_BYTES - HEADER_BYTES;
  if (count * 4 <= room) {
    const root = encodeDirectory(entries, 0, count);
    if (root.length <= room) return { root, leaves: [] };
  }
  for (let size = LEAF_ENTRIES; ; size *= 2) {
    const leafCount = Math.ceil(count / size);
    const top = directoryOf(leafCount);
    const leaves: Uint8Array[] = [];
    let offset = 0;
    for (let l = 0; l < leafCount; l++) {
      const start = l * size;
      const leaf = encodeDirectory(entries, start, Math.min(count, start + size));
      top.ids[l] = entries.ids[start];
      top.lengths[l] = leaf.length;
      top.offsets[l] = offset;
      leaves.push(leaf);
      offset += leaf.length;
    }
    const root = encodeDirectory(top, 0, leafCount);
    if (root.length <= room) return { root, leaves };
  }
}

/** A PMTiles v3 archive of already-encoded tiles: vector tiles unless `tileType` says otherwise. */
export function writeArchive(
  tiles: Iterable<{
    readonly z: number;
    readonly x: number;
    readonly y: number;
    readonly bytes: Uint8Array;
  }>,
  header: {
    readonly tileType?: number;
    readonly minZoom: number;
    readonly maxZoom: number;
    readonly bounds: readonly [number, number, number, number];
    readonly center?: readonly [lon: number, lat: number, zoom: number];
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Uint8Array {
  const tileType = header.tileType ?? MVT;
  const list = Array.from(tiles);
  const ids = new Float64Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const { z, x, y, bytes } = list[i];
    if (!(bytes instanceof Uint8Array))
      throw failure('invalid-input', `Tile ${z}/${x}/${y} has no bytes`);
    if (z < header.minZoom || z > header.maxZoom)
      throw failure('invalid-input', `Tile ${z}/${x}/${y} lies outside the archive's zooms`);
    ids[i] = tileId(z, x, y);
  }
  const { entries, contents } = layoutTiles(list, ids, sortedBy(ids));
  const { root, leaves } = layoutDirectories(entries);
  const metadata = new TextEncoder().encode(JSON.stringify(header.metadata ?? {}));
  const leafLength = leaves.reduce((sum, leaf) => sum + leaf.length, 0);
  const metadataOffset = HEADER_BYTES + root.length;
  const leafOffset = metadataOffset + metadata.length;
  const dataOffset = leafOffset + leafLength;
  const [west, south, east, north] = header.bounds;
  const out = new Uint8Array(dataOffset + contents.size);
  writeHeader(new DataView(out.buffer), {
    rootOffset: HEADER_BYTES,
    rootLength: root.length,
    metadataOffset,
    metadataLength: metadata.length,
    leafOffset,
    leafLength,
    dataOffset,
    dataLength: contents.size,
    addressed: list.length,
    entries: entries.ids.length,
    contents: contents.parts.length,
    internalCompression: NONE,
    tileCompression: NONE,
    tileType,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds: header.bounds,
    center: header.center ?? [(west + east) / 2, (south + north) / 2, header.minZoom],
  });
  out.set(root, HEADER_BYTES);
  out.set(metadata, metadataOffset);
  let at = leafOffset;
  for (const leaf of leaves) {
    out.set(leaf, at);
    at += leaf.length;
  }
  at = dataOffset;
  for (const part of contents.parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
