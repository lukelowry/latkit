import { failure } from '@latkit/model';
import {
  SharedRequests,
  UrlRanges,
  abortedBy,
  blobRanges,
  fetchKept,
  memoryRanges,
  openCache,
  raced,
} from './ranges.js';
import type { ByteRanges } from './ranges.js';
import { gunzip, isGzip, ungzipped } from './bytes.js';

/** Where vector tiles come from: their zoom range and bounds, and each tile's bytes. */
export interface TileSource {
  readonly minZoom: number;
  readonly maxZoom: number;
  /** West, south, east, north in degrees. */
  readonly bounds: readonly [number, number, number, number];
  readonly attribution?: string;
  /** The archive's or TileJSON's metadata, parsed. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** A tile's bytes, decompressed, or null where the source has none. */
  tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null>;
}

export interface TileSourceOptions {
  /** Keep fetched bytes on the device, in Cache Storage, for offline use. */
  readonly persist?: boolean;
  readonly attribution?: string;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly signal?: AbortSignal;
}

type Bounds = TileSource['bounds'];

const MAX_ZOOM = 26;
const HEADER_BYTES = 127;
const LEAF_CACHE = 64;
const MAX_DEPTH = 4;
const MAGIC = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]; // "PMTiles"
const UNKNOWN = 0;
const GZIP = 2;
const WORLD: Bounds = [-180, -85.0511287798, 180, 85.0511287798];

/** PMTiles' tile types: unknown, which vector tiles may declare in their metadata, and theirs. */
const UNKNOWN_TILES = 0;
const VECTOR_TILES = 1;
/** URL extensions of vector tiles, and of images, which a geography never draws. */
const VECTOR_EXTENSIONS = new Set(['pbf', 'mvt']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif']);
const DEFAULT_MAX_ZOOM = 14;

/** How many tiles lie at every zoom below each zoom. */
const TILES_BELOW = new Float64Array(MAX_ZOOM + 2);
for (let z = 1; z < TILES_BELOW.length; z++) TILES_BELOW[z] = TILES_BELOW[z - 1] + 4 ** (z - 1);

// Tile ids

function checkTile(z: number, x: number, y: number): void {
  if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM)
    throw failure('invalid-input', `Zoom ${z} is not a whole number from 0 to ${MAX_ZOOM}`);
  const n = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n)
    throw failure('invalid-input', `Tile ${z}/${x}/${y} lies outside zoom ${z}`);
}

/** A tile's PMTiles id along the Hilbert curve, and back. */
export function tileId(z: number, x: number, y: number): number {
  checkTile(z, x, y);
  const last = 2 ** z - 1;
  let px = x;
  let py = y;
  let index = 0;
  for (let s = 2 ** z / 2; s >= 1; s /= 2) {
    const rx = px & s ? 1 : 0;
    const ry = py & s ? 1 : 0;
    index += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        px = last - px;
        py = last - py;
      }
      const swap = px;
      px = py;
      py = swap;
    }
  }
  return TILES_BELOW[z] + index;
}

// Header

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

function startsWithMagic(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && MAGIC.every((byte, i) => bytes[i] === byte);
}

function readHeader(head: Uint8Array): Header {
  if (!startsWithMagic(head))
    throw failure('invalid-input', 'These bytes are not a PMTiles archive');
  if (head.length < HEADER_BYTES) throw failure('protocol', 'The PMTiles header is cut short');
  if (head[7] !== 3)
    throw failure('unsupported', `PMTiles version ${head[7]} is not supported; only 3 is`);
  const view = new DataView(head.buffer, head.byteOffset, HEADER_BYTES);
  const u64 = (at: number): number =>
    view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
  const degrees = (at: number): number => view.getInt32(at, true) / 1e7;
  const header: Header = {
    rootOffset: u64(8),
    rootLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafOffset: u64(40),
    leafLength: u64(48),
    dataOffset: u64(56),
    dataLength: u64(64),
    addressed: u64(72),
    entries: u64(80),
    contents: u64(88),
    internalCompression: view.getUint8(97),
    tileCompression: view.getUint8(98),
    tileType: view.getUint8(99),
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101),
    bounds: [degrees(102), degrees(106), degrees(110), degrees(114)],
    center: [degrees(119), degrees(123), view.getUint8(118)],
  };
  checkCompression(header.internalCompression, 'directories');
  checkCompression(header.tileCompression, 'tiles');
  return header;
}

function checkCompression(code: number, what: string): void {
  if (code > GZIP)
    throw failure(
      'unsupported',
      `The archive's ${what} use compression ${code}; only gzip is read`,
    );
}

// Directories

/** A directory's entries as columns, sorted by tile id; run length 0 marks a leaf directory. */
interface Directory {
  readonly ids: Float64Array;
  readonly runs: Uint32Array;
  readonly lengths: Uint32Array;
  readonly offsets: Float64Array;
}

function corrupt(): Error {
  return failure('protocol', 'A PMTiles directory is corrupt');
}

/** Unsigned LEB128 varints read in order. */
class VarintReader {
  private position = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  next(): number {
    const bytes = this.bytes;
    let value = 0;
    let scale = 1;
    for (;;) {
      if (this.position >= bytes.length || scale > 2 ** 63) throw corrupt();
      const byte = bytes[this.position++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 0x80;
    }
  }

  u32(): number {
    const value = this.next();
    if (value > 0xffffffff) throw corrupt();
    return value;
  }
}

function decodeDirectory(bytes: Uint8Array): Directory {
  const reader = new VarintReader(bytes);
  const count = reader.next();
  if (count * 4 > bytes.length) throw corrupt();
  const ids = new Float64Array(count);
  const runs = new Uint32Array(count);
  const lengths = new Uint32Array(count);
  const offsets = new Float64Array(count);
  let id = 0;
  for (let i = 0; i < count; i++) ids[i] = id += reader.next();
  for (let i = 0; i < count; i++) runs[i] = reader.u32();
  for (let i = 0; i < count; i++) lengths[i] = reader.u32();
  for (let i = 0; i < count; i++) {
    const value = reader.next();
    if (value > 0) offsets[i] = value - 1;
    else if (i > 0) offsets[i] = offsets[i - 1] + lengths[i - 1];
    else throw corrupt();
  }
  return { ids, runs, lengths, offsets };
}

/** The entry holding a tile id, or -1. */
function findEntry(directory: Directory, id: number): number {
  const { ids, runs } = directory;
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const at = ids[middle];
    if (at < id) low = middle + 1;
    else if (at > id) high = middle - 1;
    else return middle;
  }
  if (high < 0) return -1;
  return runs[high] === 0 || id - ids[high] < runs[high] ? high : -1;
}

// Compression

function decompress(bytes: Uint8Array, compression: number): Promise<Uint8Array> | Uint8Array {
  return compression === GZIP || (compression === UNKNOWN && isGzip(bytes)) ? gunzip(bytes) : bytes;
}

// Reading archives

function readBytes(
  ranges: ByteRanges,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const head = ranges.head;
  if (length === 0) return Promise.resolve(head.subarray(0, 0));
  if (offset + length <= head.length)
    return Promise.resolve(head.subarray(offset, offset + length));
  return ranges.read(offset, length, signal);
}

function parseMetadata(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw failure('protocol', 'The archive metadata is not JSON', { cause: error });
  }
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The failure for tiles of images, which a geography never draws. */
function images(where: string): Error {
  return failure('unsupported', `${where} holds images; a geography draws vector tiles`);
}
/** Throw unless an archive holds vector tiles: by its tile type, or by its metadata's layers. */
function checkTileType(tileType: number, metadata: Record<string, unknown>): void {
  if (tileType === VECTOR_TILES) return;
  if (tileType === UNKNOWN_TILES && Array.isArray(metadata.vector_layers)) return;
  if (tileType >= 2 && tileType <= 5) throw images('This archive');
  throw failure('unsupported', `This archive holds tiles of an unknown type, ${tileType}`);
}

/** The zoom range a source serves: options over what it declares. */
function zoomsOf(
  options: TileSourceOptions,
  minZoom: number,
  maxZoom: number,
): readonly [number, number] {
  const min = options.minZoom ?? minZoom;
  const max = options.maxZoom ?? maxZoom;
  if (min > max) throw failure('invalid-input', `Zooms ${min} to ${max} are an empty range`);
  return [min, max];
}

/** A PMTiles archive's tiles, found through its directories. */
class Archive implements TileSource {
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds: Bounds;
  readonly attribution?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  private readonly ranges: ByteRanges;
  private readonly header: Header;
  private readonly root: Directory;
  private readonly leaves = new Map<number, Promise<Directory>>();

  constructor(
    ranges: ByteRanges,
    header: Header,
    root: Directory,
    metadata: Record<string, unknown>,
    options: TileSourceOptions,
  ) {
    this.ranges = ranges;
    this.header = header;
    this.root = root;
    this.metadata = metadata;
    checkTileType(header.tileType, metadata);
    [this.minZoom, this.maxZoom] = zoomsOf(options, header.minZoom, header.maxZoom);
    this.bounds = header.bounds;
    const attribution = options.attribution ?? metadata.attribution;
    if (typeof attribution === 'string') this.attribution = attribution;
  }

  async tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    const id = tileId(z, x, y);
    if (signal?.aborted) throw abortedBy(signal);
    let directory = this.root;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const entry = findEntry(directory, id);
      if (entry < 0) return null;
      const offset = directory.offsets[entry];
      const length = directory.lengths[entry];
      if (directory.runs[entry] > 0) {
        const at = this.header.dataOffset + offset;
        return decompress(
          await readBytes(this.ranges, at, length, signal),
          this.header.tileCompression,
        );
      }
      directory = await raced(this.leaf(this.header.leafOffset + offset, length), signal);
    }
    throw failure('protocol', 'The archive nests its directories too deeply');
  }

  /** A leaf directory, decoded once and kept among the most recently used. */
  private leaf(offset: number, length: number): Promise<Directory> {
    const kept = this.leaves.get(offset);
    if (kept) {
      this.leaves.delete(offset);
      this.leaves.set(offset, kept);
      return kept;
    }
    const internal = this.header.internalCompression;
    const leaf = readBytes(this.ranges, offset, length)
      .then((bytes) => decompress(bytes, internal))
      .then(decodeDirectory);
    this.leaves.set(offset, leaf);
    leaf.catch(() => {
      if (this.leaves.get(offset) === leaf) this.leaves.delete(offset);
    });
    if (this.leaves.size > LEAF_CACHE) this.leaves.delete(this.leaves.keys().next().value!);
    return leaf;
  }
}

async function openArchive(ranges: ByteRanges, options: TileSourceOptions): Promise<TileSource> {
  const header = readHeader(ranges.head);
  const { signal } = options;
  const internal = header.internalCompression;
  const [root, metadata] = await Promise.all([
    readBytes(ranges, header.rootOffset, header.rootLength, signal)
      .then((bytes) => decompress(bytes, internal))
      .then(decodeDirectory),
    readBytes(ranges, header.metadataOffset, header.metadataLength, signal)
      .then((bytes) => decompress(bytes, internal))
      .then(parseMetadata),
  ]);
  return new Archive(ranges, header, root, metadata, options);
}

// Templates and TileJSON

/** What a template's TileJSON declares. */
interface Declared {
  /** The format it names, such as `pbf`. */
  readonly format?: string;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly bounds?: Bounds;
  readonly attribution?: string;
  readonly metadata?: Record<string, unknown>;
  /** Whether rows count from the south, as TMS does. */
  readonly tms?: boolean;
}

/** The extension of a URL's path, before any query, in lower case; empty without one. */
function extensionOf(url: string): string {
  const path = url.split(/[?#]/, 1)[0];
  const dot = path.lastIndexOf('.');
  return dot < path.lastIndexOf('/') ? '' : path.slice(dot + 1).toLowerCase();
}

/** Vector tiles fetched from a `{z}/{x}/{y}` URL template. */
class Template implements TileSource {
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds: Bounds;
  readonly attribution?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  private readonly template: string;
  private readonly tms: boolean;
  private readonly cache: Promise<Cache | null>;
  private readonly requests = new SharedRequests<Uint8Array | null>();

  constructor(template: string, declared: Declared, options: TileSourceOptions) {
    this.template = template;
    for (const format of [extensionOf(template), declared.format ?? ''])
      if (IMAGE_EXTENSIONS.has(format)) throw images(template);
    [this.minZoom, this.maxZoom] = zoomsOf(
      options,
      declared.minZoom ?? 0,
      declared.maxZoom ?? DEFAULT_MAX_ZOOM,
    );
    this.bounds = declared.bounds ?? WORLD;
    const attribution = options.attribution ?? declared.attribution;
    if (attribution !== undefined) this.attribution = attribution;
    this.metadata = declared.metadata ?? {};
    this.tms = declared.tms ?? false;
    this.cache = openCache(options.persist ?? false);
  }

  async tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    checkTile(z, x, y);
    if (signal?.aborted) throw abortedBy(signal);
    if (z < this.minZoom || z > this.maxZoom) return null;
    const row = this.tms ? 2 ** z - 1 - y : y;
    const url = this.template
      .replaceAll('{z}', String(z))
      .replaceAll('{x}', String(x))
      .replaceAll('{y}', String(row));
    const bytes = await this.requests.request(url, (shared) => this.fetchTile(url, shared), signal);
    return bytes && ungzipped(bytes);
  }

  private async fetchTile(url: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const fetched = await fetchKept(url, url, null, await this.cache, signal);
    if (fetched.status === 404 || fetched.status === 204) return null;
    if (fetched.status !== 200 && fetched.status !== 206)
      throw failure('io', `Tiles could not be read from ${url} (${fetched.status})`);
    return fetched.bytes;
  }
}

function isJson(bytes: Uint8Array, type: string): boolean {
  if (type.includes('json')) return true;
  for (const byte of bytes) {
    if (byte === 0x7b) return true;
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false;
  }
  return false;
}

/** A template URL resolved against the TileJSON's, keeping its placeholders unescaped. */
function resolveTemplate(template: string, base: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(template)) return template;
  try {
    const href = new URL(template, new URL(base, globalThis.location?.href)).href;
    return href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  } catch {
    return template;
  }
}

function zoomOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function boundsOf(value: unknown): Bounds | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (!value.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
  return value as unknown as Bounds;
}

async function openTileJson(
  url: string,
  ranges: UrlRanges,
  options: TileSourceOptions,
): Promise<TileSource> {
  const body = await ranges.body(options.signal);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw failure('invalid-input', `${url} is not valid TileJSON`, { cause: error });
  }
  const tiles = isRecord(json) && Array.isArray(json.tiles) ? (json.tiles as unknown[]) : [];
  if (!isRecord(json) || typeof tiles[0] !== 'string')
    throw failure('invalid-input', `The TileJSON at ${url} names no tiles`);
  const format = typeof json.format === 'string' ? json.format.toLowerCase() : '';
  if (format && !VECTOR_EXTENSIONS.has(format) && !IMAGE_EXTENSIONS.has(format))
    throw failure('unsupported', `The TileJSON at ${url} names tiles of format ${format}`);
  return new Template(
    resolveTemplate(tiles[0], url),
    {
      format,
      minZoom: zoomOf(json.minzoom),
      maxZoom: zoomOf(json.maxzoom),
      bounds: boundsOf(json.bounds),
      attribution: typeof json.attribution === 'string' ? json.attribution : undefined,
      metadata: json,
      tms: json.scheme === 'tms',
    },
    options,
  );
}

async function openUrl(url: string, options: TileSourceOptions): Promise<TileSource> {
  const ranges = await new UrlRanges(url, options.persist ?? false).open(options.signal);
  if (startsWithMagic(ranges.head)) return openArchive(ranges, options);
  if (isJson(ranges.head, ranges.type)) return openTileJson(url, ranges, options);
  throw failure('invalid-input', `${url} is neither a PMTiles archive nor TileJSON`);
}

function checkOptions(options: TileSourceOptions): void {
  for (const zoom of [options.minZoom, options.maxZoom])
    if (zoom !== undefined && (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_ZOOM))
      throw failure('invalid-input', `Zoom ${zoom} is not a whole number from 0 to ${MAX_ZOOM}`);
  if (options.signal?.aborted) throw abortedBy(options.signal);
}

/** Open a source: a PMTiles archive (a URL read by HTTP range requests, a Blob, or bytes), a `{z}/{x}/{y}` URL template, or a TileJSON URL. */
export async function openTiles(
  from: string | URL | Blob | ArrayBuffer | ArrayBufferView,
  options: TileSourceOptions = {},
): Promise<TileSource> {
  checkOptions(options);
  if (typeof from === 'string' || from instanceof URL) {
    const url = typeof from === 'string' ? from : from.href.replace(/%7B([zxy])%7D/gi, '{$1}');
    return url.includes('{z}') ? new Template(url, {}, options) : openUrl(url, options);
  }
  if (from instanceof Blob) return openArchive(await blobRanges(from, options.signal), options);
  const bytes = ArrayBuffer.isView(from)
    ? new Uint8Array(from.buffer, from.byteOffset, from.byteLength)
    : new Uint8Array(from);
  return openArchive(memoryRanges(bytes), options);
}
