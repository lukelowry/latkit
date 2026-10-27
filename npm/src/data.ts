/** Datasets: `Data` changes in place, a `Snapshot` is one version, and `Tiles` load in pieces. */

import type * as bindings from '../pkg/latkit.js';
import type { EnvelopeRequest, Id, Query } from './inputs.js';
import { bytesOf, Handle, inner, wasm, waited, type ByteSource, type Wait } from './internal.js';
import { load } from './load.js';
import type { Description, Value } from './outputs.js';
import { framed, Patch, type Fields, type RowIds, type Run, type Values } from './patch.js';

/**
 * A table of a dataset, which a mark draws or a field reads from: `grid.table('Bus')`. A view draws
 * the datasets its scene's tables belong to. Its JSON form is `[data, table]`.
 */
export class Table {
  /** The dataset the table belongs to. */
  readonly source: Source;
  /** The table's name. */
  readonly name: string;

  /** Table `name` of `source`. */
  constructor(source: Source, name: string) {
    this.source = source;
    this.name = name;
  }

  /** The JSON form, `[data, table]`, which `JSON.stringify` writes for the table. */
  toJSON(): [data: string, table: string] {
    return [this.source.name, this.name];
  }
}

/**
 * A table that a mark draws or a field reads from: a dataset's {@link Table}, or its JSON form
 * `[data, table]`, which names a dataset the view's `sources` give.
 */
export type TableInput = Table | readonly [data: string, table: string];

/** The rows a query returns, as columns in the forms a patch takes. */
export interface QueryResult {
  /** The table read. */
  table: string;
  /** The ids of the rows returned, in order. */
  ids: Id[];
  /**
   * Each selected field's column, by output name: numbers as a `Float64Array` with NaN for missing
   * values, other values as an array with `null` for missing ones, and a reference as the table it
   * references and the id of the row each row references.
   */
  fields: Record<string, Float64Array | Value[] | { reference: string; ids: (Id | null)[] }>;
  /** How many rows matched the query before `offset` and `limit` applied. */
  total: number;
}

/** Each row's minimum and maximum of a sampled field over equal spans of the axis. */
export interface Envelope {
  /** The span boundaries on the axis: one more than the number of spans. */
  at: Float64Array;
  /** Each row's minimum in each span, `spans` values per row, row after row; NaN without frames. */
  least: Float32Array;
  /** Each row's maximum in each span, laid out like `least`. */
  greatest: Float32Array;
}

/** A bindings object that reads one version of a dataset: a `Data` or a `Snapshot`. */
type Reads = bindings.Data | bindings.Snapshot;

/**
 * Named tables of columns, read the same way from a {@link Data}, which reads its current version,
 * and a {@link Snapshot}, which reads its own.
 */
export abstract class Dataset extends Handle {
  /** The dataset's name: the first part of its tables' JSON form. */
  get name(): string {
    return inner<Reads>(this).name;
  }

  /** The dataset's table `name`, for a mark to draw or a field to read from. */
  table(name: string): Table {
    return new Table(this as Dataset as Data | Snapshot, name);
  }

  /** The tables and their row counts, each field and its kind, and the axis and its span. */
  describe(): Description {
    return JSON.parse(inner<Reads>(this).describe()) as Description;
  }

  /**
   * Reads `field` of the row with `id` in `table`: for a sampled field, its last frame at or before
   * `options.at`, or its last frame; for a reference, the referenced row's id. `null` when the
   * table, row, field, or value is missing.
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
   * Reads a table's rows, filtered, sorted, and paged, through the same expressions marks use.
   * Sampled fields are read at `query.at`.
   */
  query(query: Query): QueryResult {
    return inner<Reads>(this).query(JSON.stringify(query)) as QueryResult;
  }

  /**
   * Each row's minimum and maximum of a sampled field over equal spans of an axis range, for every
   * row or the rows `request.ids` lists. Each span reads the coarsest stored levels of detail that
   * fit in it, so it costs a few reads however many frames it covers. Throws a `limit` error when
   * rows times spans exceeds 2^26.
   */
  envelope(request: EnvelopeRequest): Envelope {
    return inner<Reads>(this).envelope(JSON.stringify(request)) as Envelope;
  }

  /** The dataset as latkit's bytes: a patch that builds it from an empty dataset. */
  toBytes(): Uint8Array {
    return inner<Reads>(this).toBytes();
  }
}

/**
 * A dataset that changes in place, each change applied whole or not at all. Each method of
 * {@link Patch} is also a method here that applies that one change at once; `apply` applies a patch
 * of several. Views draw its latest version from the frame after each change. A {@link Snapshot}
 * keeps one version and shares its pages with the dataset, so an undo history costs only the pages
 * that differ. Destroying it leaves views drawing it and its snapshots usable.
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
   * - A dataset document, `{"name": ..., "patch": [...]}`, whose patch is read as
   *   {@link Patch.read} reads one.
   */
  static async read(
    source: ByteSource | object,
    options: {
      /** Names the dataset, replacing the name its bytes or document give; GeoJSON requires it. */
      name?: string;
      /** The URL a document's file slices are relative to; by default, the one it came from. */
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
   * Applies {@link Patch.replace}: replaces table `table` with rows `ids`, or `0` to `n - 1`, and
   * `fields`.
   */
  replace(table: string, fields: Fields): this;
  replace(table: string, ids: RowIds, fields?: Fields): this;
  replace(table: string, ids: RowIds | Fields, fields?: Fields): this {
    // `Patch.replace` tells ids from fields itself.
    return this.apply(new Patch().replace(table, ids as RowIds, fields));
  }

  /**
   * Applies {@link Patch.set}: writes `fields` for rows `ids` of `table`, or `0` to `n - 1`, adding
   * new rows.
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
      /** The rows the frames cover, every row by default; other rows keep their last values. */
      ids?: RowIds;
    },
  ): this {
    return this.apply(new Patch().append(table, at, fields, options));
  }

  /** Applies {@link Patch.forget}: drops every sampled field's frames before `before`. */
  forget(before: number): this {
    return this.apply(new Patch().forget(before));
  }

  /** Applies {@link Patch.frames}: stores a run of a sampled field's entries, as a time tile holds. */
  frames(table: string, field: string, run: Run): this {
    return this.apply(new Patch().frames(table, field, run));
  }

  /** The current version as a {@link Snapshot}, which later patches leave unchanged. O(1). */
  snapshot(): Snapshot {
    return Snapshot.made(inner<bindings.Data>(this).snapshot());
  }

  /** Makes `snapshot`, a version of this dataset, the current version, as an undo does. */
  restore(snapshot: Snapshot): this {
    inner<bindings.Data>(this).restore(inner<bindings.Snapshot>(snapshot));
    return this;
  }
}

/**
 * One immutable version of a dataset, taken in O(1) by {@link Data.snapshot}. A view given a
 * snapshot draws that version, and keeps drawing it once the snapshot is destroyed.
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

/**
 * A dataset fetched in pieces as views need them: plain data, a dataset name and a URL. Each view
 * draws the pieces its camera and plot window need, and the views of a GPU share them. The first
 * bytes at `url` decide the kind:
 *
 * - Time tiles: a `frames.json` manifest as `latkit tile` writes it. A line tracing a sampled field
 *   fetches the detail its plot window shows; other marks fetch the frames around the view's `at`.
 *   A span still loading shows the coarser span that contains it.
 * - Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` URL template. Each
 *   layer becomes a table of the features its marks draw: polygons for areas, lines for lines,
 *   points for vertices. A table named `layer:polygons`, `layer:lines`, or `layer:points` holds
 *   that kind whatever the marks. A tile arriving appends its rows to the view's dataset, which
 *   keeps the rows of tiles it no longer draws until they outnumber the rows it draws.
 */
export class Tiles {
  /** The name of the dataset the tiles are drawn as. */
  readonly name: string;
  /** Where the tiles are. */
  readonly url: string;

  /** Tiles at `url`, drawn as the dataset named `name`. */
  constructor(name: string, url: string) {
    this.name = name;
    this.url = url;
  }

  /** The tiles' table `name`, such as a vector tile layer, for a mark to draw. */
  table(name: string): Table {
    return new Table(this, name);
  }
}

/** A dataset a view draws: the one a {@link Table} belongs to, or one of the view's `sources`. */
export type Source = Data | Snapshot | Tiles;

/** @internal Converts `source` to a new bindings `Source` on every call. */
export function sourceOf(source: Source): bindings.Source {
  if (source instanceof Tiles) return wasm().Source.tiles(source.name, source.url);
  return inner<Reads>(source).source();
}
