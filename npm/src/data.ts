/** Datasets: `Data` changes in place, a `Snapshot` is one version, and `Tiles` load in pieces. */

import type * as bindings from '../pkg/latkit.js';
import type { EnvelopeRequest, Id, Query } from './inputs.js';
import {
  bytesOf,
  due,
  Handle,
  inner,
  wasm,
  waited,
  type ByteSource,
  type Wait,
} from './internal.js';
import { load } from './load.js';
import type { Description, TilesDescription, Value } from './outputs.js';
import { framed, Patch, rows, type Fields, type RowIds, type Run, type Values } from './patch.js';

/**
 * A table in a dataset, such as `grid.table('Bus')`. Use it in a mark or a cross-table
 * expression. It serializes as `[data, table]`.
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
 * A mutable dataset. Views show changes on the next frame. Write individual edits with methods
 * such as `set`, or batch them with `apply`. Views and snapshots remain usable after `destroy()`.
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
    // Loading, reading the bytes, and decoding them share one deadline.
    const until = due(options);
    await waited(load(), until, 'loading latkit');
    const { bytes, base } = await bytesOf(source, until);
    const read = wasm().Data.read(bytes, options.name, options.base ?? base);
    return new Data(await waited<bindings.Data>(read, until, 'reading a dataset'));
  }

  /**
   * Applies the patch and returns this dataset. If any change is invalid, the dataset keeps its
   * previous version. The error path identifies the change, for example `patch[1].Bus.kv`.
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
    return this.#write(true, table, ...rows(ids, fields));
  }

  /**
   * Applies {@link Patch.set}: writes `fields` for rows `ids` (or `0` to `n - 1`) of `table`,
   * adding new rows. Typed arrays of numbers, for rows given as a `Uint32Array`, as `{ count }`, or
   * not at all, are copied once and become the fields' values as they are. That is the way to
   * write a field every frame.
   */
  set(table: string, fields: Fields): this;
  set(table: string, ids: RowIds, fields?: Fields): this;
  set(table: string, ids: RowIds | Fields, fields?: Fields): this {
    return this.#write(false, table, ...rows(ids, fields));
  }

  /**
   * Applies one `set`, or with `replace` one `replace`. Number arrays for numbered rows go to
   * WebAssembly as they are. Any other ids or values are written as a patch.
   */
  #write(replace: boolean, table: string, ids: RowIds, fields: Fields): this {
    const numbers = numbered(ids, fields);
    if (!numbers) {
      const patch = new Patch();
      return this.apply(
        replace ? patch.replace(table, ids, fields) : patch.set(table, ids, fields),
      );
    }
    const names = Object.keys(fields);
    inner<bindings.Data>(this).write(
      replace,
      table,
      numbers.ids,
      numbers.count,
      names,
      numbers.values,
    );
    return this;
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

  /** Returns an immutable {@link Snapshot} in O(1). Unchanged pages are shared across versions. */
  snapshot(): Snapshot {
    return Snapshot.made(inner<bindings.Data>(this).snapshot());
  }

  /** Restores this dataset to a previous snapshot. */
  restore(snapshot: Snapshot): this {
    inner<bindings.Data>(this).restore(inner<bindings.Snapshot>(snapshot));
    return this;
  }
}

/** A typed array of numbers. A `Uint8Array` holds booleans, so it is not one. */
type Numbers = Float32Array | Float64Array | Int32Array | Uint32Array;

/**
 * Returns `ids` and `fields` as the bindings take typed writes: the ids, or the count of rows from
 * 0, and each field's array. Returns `undefined` unless the ids are a `Uint32Array` or a whole
 * `{ count }` and every field is a typed array of numbers.
 */
function numbered(
  ids: RowIds,
  fields: Fields,
): { ids: Uint32Array | undefined; count: number; values: Numbers[] } | undefined {
  const values = Object.values(fields);
  const typed = (v: unknown): v is Numbers =>
    v instanceof Float32Array ||
    v instanceof Float64Array ||
    v instanceof Int32Array ||
    v instanceof Uint32Array;
  if (!values.every(typed)) return undefined;
  if (ids instanceof Uint32Array) return { ids, count: ids.length, values };
  if (ArrayBuffer.isView(ids) || Array.isArray(ids) || !('count' in ids)) return undefined;
  const { count } = ids;
  if (!Number.isInteger(count) || count < 0 || count > 0xffffffff) return undefined;
  return { ids: undefined, count, values };
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

/**
 * Writes a history as time tiles while it is recorded: the files `latkit tile` writes for the same
 * frames, which {@link Tiles} draw. It holds only what is still to be written, each level's span and
 * bucket in progress, so its memory stays the same however long the history grows. Levels of detail
 * are built as appends to a {@link Data} build them.
 *
 * ```ts
 * const writer = new TileWriter(new Data('grid').axis('time', 's').replace('Bus', ids));
 * const files = new Map<string, Uint8Array>();
 * const write = (path: string, bytes: Uint8Array) => void files.set(path, bytes);
 * writer.apply(new Patch().append('Bus', at, { vm }), write);
 * writer.flush(write); // then tiles.refresh()
 * ```
 */
export class TileWriter extends Handle {
  /**
   * A writer of the frames appended to the tables of `base`, the dataset without its frames: at
   * least its axis and the tables' rows, as it is now.
   */
  constructor(
    base: Data | Snapshot,
    options: {
      /**
       * The entries a span holds: frames, or buckets of frames at coarser levels. A multiple of 8
       * from 8 to 2^20. Defaults to 256, as `latkit tile` writes them.
       */
      chunk?: number;
    } = {},
  ) {
    const version = base instanceof Data ? base.snapshot() : base;
    try {
      super(
        new (wasm().TileWriter)(inner<bindings.Snapshot>(version), options.chunk ?? 256),
        'TileWriter',
      );
    } finally {
      if (version !== base) version.destroy();
    }
  }

  /**
   * Appends the frames of `patch`, calling `write` with the path and bytes of each span they fill.
   * Every change must append frames to every row of a table of the base, at coordinates that do not
   * decrease, or it throws an `invalid` error and changes nothing.
   */
  apply(patch: Patch | Uint8Array, write: (path: string, bytes: Uint8Array) => void): this {
    const bytes = patch instanceof Uint8Array ? patch : framed(patch);
    inner<bindings.TileWriter>(this).apply(bytes, write);
    return this;
  }

  /**
   * Calls `write` with the spans in progress as they stand, then the base and the `frames.json`
   * manifest, so `Tiles` drawing the manifest find every frame appended so far. A span written
   * again as it grows replaces the one before. Flushed before the first frames, after appends of
   * none, it lists their fields, so views find the manifest from the start.
   */
  flush(write: (path: string, bytes: Uint8Array) => void): void {
    inner<bindings.TileWriter>(this).flush(write);
  }
}

/** How {@link Tiles} fetch their files. */
export interface TilesOptions {
  /**
   * Fetches a file in place of the browser, such as with credentials or from the app's own store:
   * the index at `url`, the pieces at URLs resolved against it, and bytes `[start, end)` of an
   * archive. A 404 or 204 `Response` is a missing piece. A rejection with an `AbortError`, as from
   * an aborted `fetch`, is no failure: the file is fetched again when next needed. latkit calls it
   * after the frame that needs the file, so it may change views and datasets. Tiles at one URL with
   * different `fetch` functions share nothing.
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
 *   `{ data, chunk, url, frames: [{ table, field, levels, frames: [first, end] }] }`. `data` is the
 *   dataset without the listed fields' entries: at least the axis and the tables' rows, such as
 *   `new Patch().axis('time', 's').replace('Bus', ids)`. Each span at `url` is a
 *   {@link Patch.frames} patch of `chunk` entries of one level. `url` names `{level}` and
 *   `{index}`, and `{field}`, the field's index in `frames`, when several fields are listed. A span
 *   holds every row of its table, so choose `chunk` to keep a span near 1 MiB, and give a plot of a
 *   few rows of a large table its own manifest of those rows. While frames are recorded, a
 *   {@link TileWriter} writes the files as they arrive, then the app calls `refresh()`.
 * - Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` URL template. Each
 *   layer becomes a table of the features its marks draw: polygons for areas, lines for lines,
 *   points for vertices. A table named `layer:polygons`, `layer:lines`, or `layer:points` holds
 *   that kind regardless of the marks. Each tile that arrives appends its rows to the view's
 *   dataset. Rows of tiles no longer drawn are kept until they outnumber the rows drawn.
 *
 * A GPU keeps what it fetched and decoded while the `Tiles` object lives, so a view that stops
 * drawing the tiles and starts again fetches nothing twice. Every `Tiles` on a GPU shares its
 * `budget.tiles` bytes. Past them, the pieces no view draws are dropped, least recently drawn
 * first. A file that fails to fetch draws nothing and is fetched again on its own: a second later,
 * then twice as long after each further failure, at most a minute. Each view drawing the tiles
 * lists the failure in its `failures` until the file arrives, so a `failures` event tells both
 * when it fails and when it recovers.
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
   * changed in every view drawing the tiles. Time tiles keep the base dataset and the spans the
   * earlier frames filled. They fetch the last span of each level again, which shows what it held
   * until the new one arrives. Every file that failed is fetched again at once. A manifest that
   * names another base, `chunk`, or `url` starts over, as vector tiles always do. Refresh as often
   * as the data changes: a file being fetched lands first, then is fetched once more however often
   * the tiles were refreshed meanwhile.
   */
  refresh(): void {
    tiled.get(this)!.bound?.refresh();
  }

  /**
   * Resolves to what the source holds, read from its index: the credit it asks to be shown, the
   * zooms and area it covers, and its layers with their fields. A PMTiles archive and a TileJSON
   * document say these. A URL template says only the default zooms, and time tiles say none.
   * Rejects when the index can't be fetched or read.
   *
   * ```ts
   * const { attribution, layers } = await tiles.describe();
   * ```
   */
  async describe(wait: Wait = {}): Promise<TilesDescription> {
    const until = due(wait);
    await waited(load(), until, 'loading latkit');
    const described = waited<string>(bound(this).describe(), until, 'describing tiles');
    return JSON.parse(await described) as TilesDescription;
  }
}

/** A dataset a view draws: the one a {@link Table} belongs to, or one of the view's `sources`. */
export type Source = Data | Snapshot | Tiles;

/** The bindings source `tiles`' views share, made the first time it is needed. */
function bound(tiles: Tiles): bindings.Source {
  const entry = tiled.get(tiles)!;
  entry.bound ??= wasm().Source.tiles(tiles.name, tiles.url, entry.fetch && bytesFrom(entry.fetch));
  return entry.bound;
}

/** @internal Converts `source` to a new bindings `Source` on every call. */
export function sourceOf(source: Source): bindings.Source {
  return source instanceof Tiles ? bound(source).copy() : inner<Reads>(source).source();
}

/** `fetch`, resolving to the bytes the bindings take: none for a missing piece. */
function bytesFrom(fetch: NonNullable<TilesOptions['fetch']>) {
  return async (url: string, range?: [number, number]): Promise<Uint8Array> => {
    const got = await fetch(url, range);
    if (got instanceof Response && (got.status === 404 || got.status === 204))
      return new Uint8Array();
    return (await bytesOf(got, due())).bytes;
  };
}
