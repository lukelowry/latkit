/** Datasets: `Data` changes in place, a `Snapshot` is one version, and `Tiles` load in pieces. */

import type * as bindings from '../pkg/latkit.js';
import type { EnvelopeRequest, Id, Query } from './inputs.js';
import { bytesOf, hold, inner, release, wasm, waited, wrap, type Wait } from './internal.js';
import { load } from './load.js';
import type { Description, Value } from './outputs.js';
import { framed, type Patch } from './patch.js';

/**
 * The rows a query returns, as columns in the forms a patch takes: numbers as a `Float64Array`
 * (missing values NaN), other values as arrays (missing `null`), and a reference as the ids of the
 * rows it references.
 */
export interface QueryResult {
  table: string;
  ids: Id[];
  fields: Record<string, Float64Array | Value[] | { reference: string; ids: (Id | null)[] }>;
  /** How many rows matched the query before `offset` and `limit` applied. */
  total: number;
}

/** Each row's minimum and maximum of a sampled field over equal spans of the axis. */
export interface Envelope {
  /** The span boundaries on the axis: one more than the number of spans. */
  at: Float64Array;
  /**
   * Each row's minimum in each span: `spans` values per row, row after row. NaN where a span has
   * no frame.
   */
  least: Float32Array;
  /** Each row's maximum in each span, laid out like `least`. */
  greatest: Float32Array;
}

/**
 * What {@link Data.read} accepts: bytes, a `Blob`, a `Response`, a byte stream, a URL to fetch as
 * a string, or a parsed JSON value. The content is latkit's bytes, GeoJSON, or a dataset document.
 */
export type DataSource =
  Uint8Array | ArrayBuffer | Blob | Response | ReadableStream<Uint8Array> | string | object;

/** A bindings object that reads one version of a dataset: a `Data` or a `Snapshot`. */
type Reads = bindings.Data | bindings.Snapshot;

/**
 * A dataset that changes in place: named tables of columns, changed only by patches. A patch
 * applies completely or not at all. Views given a `Data` draw its latest version, from the frame
 * after each patch. A {@link Snapshot} keeps one version and shares its pages with the dataset, so
 * keeping earlier versions, as an undo history does, costs only the pages that differ.
 *
 * ```ts
 * const grid = new Data('grid').apply(new Patch().replace('Bus', [1, 2], { kv: [230, 115] }));
 * view.sources = [grid];
 * grid.apply(new Patch().set('Bus', [2], { kv: [69] })); // drawn next frame
 * ```
 */
export class Data {
  /** Creates an empty dataset named `name`. Throws an `unloaded` error before `load()` finishes. */
  constructor(name: string) {
    hold(this, new (wasm().Data)(name));
  }

  /**
   * Reads a dataset from `source`, calling `load()` first. Its first bytes decide the format:
   *
   * - latkit's bytes, as `toBytes()` writes them.
   * - GeoJSON, plain or gzip-compressed, read in a worker. Points, line strings, and polygons
   *   become rows of tables `points`, `lines`, and `polygons`, with the geometry in field
   *   `geometry` and each property as a field. GeoJSON requires `options.name`.
   * - A dataset document, `{"name": ..., "patch": [...]}`, whose patch is read as
   *   {@link Patch.read} reads one.
   *
   * `options.name` names the dataset, replacing the name in latkit's bytes or a document.
   * `options.base` is the URL that a document's file slices are relative to; it defaults to the URL
   * the source was fetched from. Rejects with an `invalid` error for bytes that are not a valid
   * dataset, and with an `io` error when a fetch fails or answers an error status.
   */
  static async read(
    source: DataSource,
    options: { name?: string; base?: string } & Wait = {},
  ): Promise<Data> {
    await load();
    const { bytes, base } = await bytesOf(source, options);
    const read = wasm().Data.read(bytes, options.name, options.base ?? base);
    return wrap(Data, await waited<bindings.Data>(read, options, 'reading a dataset'));
  }

  get name(): string {
    return reads(this).name;
  }

  /**
   * Applies every change in `patch` (a {@link Patch} or its bytes), or none of them when one is
   * invalid, and returns this dataset. Views draw the new version from their next frame. Throws an
   * `invalid` error whose `path` names the failing change, such as `patch[1].Bus.kv`, or when the
   * patch names another dataset.
   */
  apply(patch: Patch | Uint8Array): this {
    inner<bindings.Data>(this, 'Data').apply(patch instanceof Uint8Array ? patch : framed(patch));
    return this;
  }

  /** The current version as a {@link Snapshot}, which later patches leave unchanged. O(1). */
  snapshot(): Snapshot {
    return wrap(Snapshot, inner<bindings.Data>(this, 'Data').snapshot());
  }

  /**
   * Makes `snapshot`, a version of this dataset, the current version, as an undo does. Views draw
   * it from their next frame. Throws an `invalid` error for a snapshot of a dataset with another
   * name.
   */
  restore(snapshot: Snapshot): this {
    inner<bindings.Data>(this, 'Data').restore(inner<bindings.Snapshot>(snapshot, 'Snapshot'));
    return this;
  }

  /** Describes the current version; see {@link Snapshot.describe}. */
  describe(): Description {
    return describe(reads(this));
  }

  /** Reads one value of the current version; see {@link Snapshot.get}. */
  get(table: string, id: Id, field: string, options: { at?: number } = {}): Value {
    return get(reads(this), table, id, field, options);
  }

  /** Queries the current version; see {@link Snapshot.query}. */
  query(query: Query): QueryResult {
    return reads(this).query(JSON.stringify(query)) as QueryResult;
  }

  /** Per-row minimums and maximums of the current version; see {@link Snapshot.envelope}. */
  envelope(request: EnvelopeRequest): Envelope {
    return envelope(reads(this), request);
  }

  /** The current version as latkit's bytes: a patch that builds it from an empty dataset. */
  toBytes(): Uint8Array {
    return reads(this).toBytes();
  }

  /**
   * Frees this handle. Views drawing the dataset keep drawing it, and its snapshots stay usable.
   * Other methods throw afterwards.
   */
  destroy(): void {
    release<bindings.Data>(this)?.free();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/**
 * One immutable version of a dataset, taken in O(1) by {@link Data.snapshot}. A view given a
 * snapshot draws that version unchanged.
 */
export class Snapshot {
  private constructor() {}

  get name(): string {
    return reads(this).name;
  }

  /**
   * Describes the dataset: its tables and their row counts, each field and its kind, and the axis
   * and the span its sampled fields cover.
   */
  describe(): Description {
    return describe(reads(this));
  }

  /**
   * Reads `field` of the row with `id` in `table`. A sampled field reads its last frame at or
   * before `options.at`, or its last frame when `at` is omitted. A reference reads the referenced
   * row's id. Returns `null` when the table, row, field, or value is missing.
   */
  get(table: string, id: Id, field: string, options: { at?: number } = {}): Value {
    return get(reads(this), table, id, field, options);
  }

  /**
   * Runs `query` on the CPU: reads a table's rows, filtered, sorted, and paged, through the same
   * expressions marks use. Sampled fields are read at `query.at`. Throws an `invalid` error for an
   * invalid query.
   */
  query(query: Query): QueryResult {
    return reads(this).query(JSON.stringify(query)) as QueryResult;
  }

  /**
   * Computes each row's minimum and maximum of a sampled field over equal spans of an axis range,
   * for every row or the rows `request.ids` lists. Each span reads the coarsest stored levels of
   * detail that fit in it, so it costs a few reads regardless of how many frames it covers. Throws
   * an `invalid` error for an unknown table or row, or a field that is not sampled, and a `limit`
   * error when rows times spans exceeds 2^26.
   */
  envelope(request: EnvelopeRequest): Envelope {
    return envelope(reads(this), request);
  }

  /** This version as latkit's bytes: a patch that builds it from an empty dataset. */
  toBytes(): Uint8Array {
    return reads(this).toBytes();
  }

  /**
   * Frees this handle. Views given the snapshot keep drawing it; other methods throw afterwards.
   */
  destroy(): void {
    release<bindings.Snapshot>(this)?.free();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/**
 * A dataset fetched in pieces as views need them. A `Tiles` is plain data: a dataset name and a
 * URL. Each view draws the pieces its camera and plot window need as a dataset of its own, and all
 * views of a GPU share the fetched pieces. The first bytes at `url` decide the kind of tiles:
 *
 * - Time tiles: a `frames.json` manifest as `latkit tile` writes it, for a dataset whose sampled
 *   fields' histories are fetched in spans. A line tracing a field fetches the level of detail its
 *   plot window shows; other marks fetch the frames around the view's `at`. A span still loading
 *   shows the coarser span that contains it.
 * - Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` URL template, fetched
 *   as the camera needs them. Each layer becomes a table of features of the kind its marks draw:
 *   polygons for areas, lines for lines, points for vertices. A table named `layer:polygons`,
 *   `layer:lines`, or `layer:points` holds that kind regardless of the marks.
 */
export class Tiles {
  /** Tiles at `url`, drawn as the dataset named `name`. */
  constructor(
    readonly name: string,
    readonly url: string,
  ) {}
}

/** A dataset a view draws; views match it to the scene's marks by the dataset's name. */
export type Source = Data | Snapshot | Tiles;

/** @internal Converts `source` to a new bindings `Source` on every call. */
export function sourceOf(source: Source): bindings.Source {
  if (source instanceof Tiles) return wasm().Source.tiles(source.name, source.url);
  return source instanceof Data
    ? inner<bindings.Data>(source, 'Data').source()
    : inner<bindings.Snapshot>(source, 'Snapshot').source();
}

/** @internal Wraps a bindings snapshot in a public {@link Snapshot}. */
export function snapshotOf(snapshot: bindings.Snapshot): Snapshot {
  return wrap(Snapshot, snapshot);
}

function reads(owner: Data | Snapshot): Reads {
  return inner<Reads>(owner, owner instanceof Data ? 'Data' : 'Snapshot');
}

function describe(reads: Reads): Description {
  return JSON.parse(reads.describe()) as Description;
}

function get(reads: Reads, table: string, id: Id, field: string, { at }: { at?: number }): Value {
  return JSON.parse(reads.get(table, id, field, at)) as Value;
}

function envelope(reads: Reads, request: EnvelopeRequest): Envelope {
  return reads.envelope(JSON.stringify(request)) as Envelope;
}
