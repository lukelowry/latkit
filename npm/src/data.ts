/** Datasets: `Data` changes in place, a `Snapshot` is one version, and `Tiles` load in pieces. */

import type * as bindings from '../pkg/latkit.js';
import type { EnvelopeRequest, Id, Query } from './inputs.js';
import { bytesOf, Handle, inner, wasm, waited, type ByteSource, type Wait } from './internal.js';
import { load } from './load.js';
import type { Description, Value } from './outputs.js';
import { framed, Patch, type Fields, type RowIds, type Run, type Values } from './patch.js';

/**
 * A table in a dataset, such as `grid.table('Bus')`. Marks draw its rows and `field().from()` reads
 * its fields. A view loads every dataset its scene uses. In JSON it is `[data, table]`.
 */
export class Table {
  /** The dataset the table belongs to. */
  readonly source: Source;
  /** The table's name. */
  readonly name: string;

  /** The table `name` in `source`. */
  constructor(source: Source, name: string) {
    this.source = source;
    this.name = name;
  }

  /** Returns the JSON form, `[data, table]`. `JSON.stringify` calls it. */
  toJSON(): [data: string, table: string] {
    return [this.source.name, this.name];
  }
}

/**
 * A table for a mark to draw or a field to read: a {@link Table}, or its JSON form `[data, table]`,
 * where `data` names a dataset in the view's `sources`.
 */
export type TableInput = Table | readonly [data: string, table: string];

/** The rows a query returns, as columns in the forms a patch takes. */
export interface QueryResult {
  /** The table read. */
  table: string;
  /** The ids of the rows returned, in order. */
  ids: Id[];
  /**
   * Each selected field's column, keyed by output name. Numbers come as a `Float64Array` with NaN
   * for missing values. Other values come as an array with `null` for missing ones. A reference
   * comes as the referenced table and, for each row, the id of the row it references.
   */
  fields: Record<string, Float64Array | Value[] | { reference: string; ids: (Id | null)[] }>;
  /** The number of rows that matched, before `offset` and `limit`. */
  total: number;
}

/** The minimum and maximum of a sampled field for each row, over equal spans of the axis. */
export interface Envelope {
  /** The span boundaries on the axis: one more than the number of spans. */
  at: Float64Array;
  /** Each row's minimum in each span, `spans` values per row, row after row. NaN for no value. */
  least: Float32Array;
  /** Each row's maximum in each span, laid out like `least`. */
  greatest: Float32Array;
}

/** A bindings object that reads one version of a dataset: a `Data` or a `Snapshot`. */
type Reads = bindings.Data | bindings.Snapshot;

/**
 * Named tables of columns. A {@link Data} reads its current version and a {@link Snapshot} reads
 * the version it holds, through the same methods.
 */
export abstract class Dataset extends Handle {
  /** The dataset's name: the `data` in its tables' JSON form `[data, table]`. */
  get name(): string {
    return inner<Reads>(this).name;
  }

  /** Returns table `name`, for a mark to draw or a field to read. */
  table(name: string): Table {
    return new Table(this as Dataset as Data | Snapshot, name);
  }

  /** Describes the tables and row counts, each field and its kind, and the axis and its span. */
  describe(): Description {
    return JSON.parse(inner<Reads>(this).describe()) as Description;
  }

  /**
   * Reads `field` of row `id` in `table`. A sampled field gives its last frame at or before
   * `options.at`, or its last frame without `at`. A reference gives the referenced row's id.
   * Returns `null` when the table, row, field, or value is missing.
   */
  get(
    table: string,
    id: Id,
    field: string,
    options: {
      /** The axis coordinate to read a sampled field at. */
      at?: number;
    } = {},
  ): Value {
    return JSON.parse(inner<Reads>(this).get(table, id, field, options.at)) as Value;
  }

  /**
   * Reads a table's rows, filtered, sorted, and paged with the same expressions marks use. Sampled
   * fields are read at `query.at`.
   */
  query(query: Query): QueryResult {
    return inner<Reads>(this).query(JSON.stringify(query)) as QueryResult;
  }

  /**
   * Returns the minimum and maximum of a sampled field over equal spans of an axis range, for every
   * row or for the rows in `request.ids`. Each span reads the coarsest stored levels of detail that
   * fit inside it, so it costs a few reads however many frames it covers. Throws a `limit` error
   * when rows times spans exceeds 2^26.
   */
  envelope(request: EnvelopeRequest): Envelope {
    return inner<Reads>(this).envelope(JSON.stringify(request)) as Envelope;
  }

  /** Returns the dataset as latkit's bytes: a patch that builds it from an empty dataset. */
  toBytes(): Uint8Array {
    return inner<Reads>(this).toBytes();
  }
}

/**
 * A dataset that changes in place. Each change applies all at once or not at all. Every
 * {@link Patch} method is also a method here that applies that one change right away, and `apply`
 * applies a patch of several. Views draw the latest version from the frame after each change. A
 * {@link Snapshot} keeps one version and shares its pages with the dataset, so an undo history
 * costs only the pages that differ. Destroying a `Data` leaves the views that draw it, and its
 * snapshots, usable.
 *
 * ```ts
 * const grid = new Data('grid').set('Bus', [1, 2], { kv: [230, 115] });
 * grid.set('Bus', [2], { kv: [69] }); // drawn the next frame
 * ```
 */
export class Data extends Dataset {
  /** Creates an empty dataset named `name`. */
  constructor(name: string);
  /** @internal Wraps the bindings dataset `bound`. */
  constructor(bound: bindings.Data);
  constructor(from: string | bindings.Data) {
    super(typeof from === 'string' ? new (wasm().Data)(from) : from, 'Data');
  }

  /**
   * Reads a dataset from `source`. Its first bytes decide the format:
   *
   * - latkit's bytes, as `toBytes()` writes them.
   * - GeoJSON, plain or gzip-compressed, read in a worker. Points, line strings, and polygons
   *   become rows of tables `points`, `lines`, and `polygons`, with the geometry in field
   *   `geometry` and each property as a field.
   * - A dataset document, `{"name": ..., "patch": [...]}`. Its patch is read like
   *   {@link Patch.read}.
   */
  static async read(
    source: ByteSource | object,
    options: {
      /** The dataset's name, overriding the name in its bytes or document. Required for GeoJSON. */
      name?: string;
      /** The URL that a document's file slices are relative to. Defaults to the document's URL. */
      base?: string;
    } & Wait = {},
  ): Promise<Data> {
    await load();
    const { bytes, base } = await bytesOf(source, options);
    const read = wasm().Data.read(bytes, options.name, options.base ?? base);
    return new Data(await waited<bindings.Data>(read, options, 'reading a dataset'));
  }

  /**
   * Applies every change in `patch`, or none when one is invalid, and returns this dataset. An
   * `invalid` error's `path` names the failing change, such as `patch[1].Bus.kv`.
   */
  apply(patch: Patch | Uint8Array): this {
    inner<bindings.Data>(this).apply(patch instanceof Uint8Array ? patch : framed(patch));
    return this;
  }

  /** Applies {@link Patch.axis}: names the axis that sampled fields are recorded over. */
  axis(name: string, unit: string): this {
    return this.apply(new Patch().axis(name, unit));
  }

  /**
   * Applies {@link Patch.replace}: replaces table `table` with `fields` for rows `ids` (or `0` to
   * `n - 1`).
   */
  replace(table: string, fields: Fields): this;
  replace(table: string, ids: RowIds, fields?: Fields): this;
  replace(table: string, ids: RowIds | Fields, fields?: Fields): this {
    // `Patch.replace` tells ids from fields itself.
    return this.apply(new Patch().replace(table, ids as RowIds, fields));
  }

  /**
   * Applies {@link Patch.set}: writes `fields` for rows `ids` (or `0` to `n - 1`) of `table`,
   * adding new rows.
   */
  set(table: string, fields: Fields): this;
  set(table: string, ids: RowIds, fields?: Fields): this;
  set(table: string, ids: RowIds | Fields, fields?: Fields): this {
    return this.apply(new Patch().set(table, ids as RowIds, fields));
  }

  /** Applies {@link Patch.remove}: removes the rows of `table` with `ids`. */
  remove(table: string, ids: RowIds): this {
    return this.apply(new Patch().remove(table, ids));
  }

  /** Applies {@link Patch.append}: records frames of `table` at the axis coordinates `at`. */
  append(
    table: string,
    at: number | readonly number[],
    fields: Readonly<Record<string, Values>>,
    options?: {
      /** The rows the frames cover. Defaults to every row. Other rows keep their last values. */
      ids?: RowIds;
    },
  ): this {
    return this.apply(new Patch().append(table, at, fields, options));
  }

  /** Applies {@link Patch.forget}: drops every sampled field's frames before `before`. */
  forget(before: number): this {
    return this.apply(new Patch().forget(before));
  }

  /** Applies {@link Patch.frames}: stores a run of a sampled field's entries, as in a time tile. */
  frames(table: string, field: string, run: Run): this {
    return this.apply(new Patch().frames(table, field, run));
  }

  /** Returns the current version as a {@link Snapshot}. Later patches don't change it. O(1). */
  snapshot(): Snapshot {
    return Snapshot.made(inner<bindings.Data>(this).snapshot());
  }

  /** Makes `snapshot`, a version of this dataset, the current version. This is how to undo. */
  restore(snapshot: Snapshot): this {
    inner<bindings.Data>(this).restore(inner<bindings.Snapshot>(snapshot));
    return this;
  }
}

/**
 * One immutable version of a dataset, taken in O(1) by {@link Data.snapshot}. A view given a
 * snapshot draws that version, and keeps drawing it after the snapshot is destroyed.
 */
export class Snapshot extends Dataset {
  private constructor(bound: bindings.Snapshot) {
    super(bound, 'Snapshot');
  }

  /** @internal Wraps the bindings snapshot `bound`. */
  static made(bound: bindings.Snapshot): Snapshot {
    return new Snapshot(bound);
  }
}

/** How {@link Tiles} fetch their files. */
export interface TilesOptions {
  /**
   * Fetches a file in place of the browser, such as with credentials or from the app's own store:
   * the index at `url`, the pieces at URLs resolved against it, and bytes `[start, end)` of an
   * archive. A 404 or 204 `Response` is a missing piece.
   */
  fetch?: (url: string, range?: [start: number, end: number]) => Promise<ByteSource>;
}

/** Each `Tiles`' fetch, and the bindings source its views share once one draws it. */
const tiled = new WeakMap<Tiles, { fetch?: TilesOptions['fetch']; bound?: bindings.Source }>();

/**
 * A dataset fetched in pieces as views need them. Each view fetches the pieces its camera and plot
 * window need, and views on one GPU share them. The first bytes at `url` decide the kind:
 *
 * - Time tiles: a `frames.json` manifest written by `latkit tile`. A line that traces a sampled
 *   field fetches the detail its plot window shows. Other marks fetch the frames around the view's
 *   `at`. While a span loads, the coarser span that contains it shows. The manifest is
 *   `{ data, chunk, url, frames: [{ table, field, levels, frames: [first, end] }] }`: `data` is the
 *   dataset without the listed fields' entries, and each span at `url` (such as
 *   `{field}/{level}/{index}.latk`) is a patch of `chunk` entries of one level. A server that
 *   records more frames rewrites the manifest and the spans past the old end, then the app calls
 *   `refresh()`.
 * - Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` URL template. Each
 *   layer becomes a table of the features its marks draw: polygons for areas, lines for lines,
 *   points for vertices. A table named `layer:polygons`, `layer:lines`, or `layer:points` holds
 *   that kind regardless of the marks. Each tile that arrives appends its rows to the view's
 *   dataset. Rows of tiles no longer drawn are kept until they outnumber the rows drawn.
 */
export class Tiles {
  /** The name of the dataset the tiles are drawn as. */
  readonly name: string;
  /** The tiles' URL. */
  readonly url: string;

  /** Tiles at `url`, drawn as the dataset named `name`. */
  constructor(name: string, url: string, { fetch }: TilesOptions = {}) {
    this.name = name;
    this.url = url;
    tiled.set(this, { fetch });
  }

  /** Returns table `name`, such as a vector tile layer, for a mark to draw. */
  table(name: string): Table {
    return new Table(this, name);
  }

  /**
   * Fetches the index again, as when a running simulation records more frames, and redraws what
   * changed in every view drawing the tiles. Time tiles keep the spans the earlier frames cover.
   * Vector tiles start over.
   */
  refresh(): void {
    tiled.get(this)!.bound?.refresh();
  }
}

/** A dataset a view draws: the one a {@link Table} belongs to, or one of the view's `sources`. */
export type Source = Data | Snapshot | Tiles;

/** @internal Converts `source` to a new bindings `Source` on every call. */
export function sourceOf(source: Source): bindings.Source {
  if (!(source instanceof Tiles)) return inner<Reads>(source).source();
  const entry = tiled.get(source)!;
  entry.bound ??= wasm().Source.tiles(
    source.name,
    source.url,
    entry.fetch && bytesFrom(entry.fetch),
  );
  return entry.bound.copy();
}

/** `fetch`, resolving to the bytes the bindings take: none for a missing piece. */
function bytesFrom(fetch: NonNullable<TilesOptions['fetch']>) {
  return async (url: string, range?: [number, number]): Promise<Uint8Array> => {
    const got = await fetch(url, range);
    if (got instanceof Response && (got.status === 404 || got.status === 204))
      return new Uint8Array();
    return (await bytesOf(got, {})).bytes;
  };
}
