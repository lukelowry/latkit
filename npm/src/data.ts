/** Datasets: a `Data` changing in place, a `Snapshot` of one version, and `Tiles` fetched in pieces. */

import type * as bindings from '../pkg/latkit.js';
import type { EnvelopeRequest, Id, Query } from './inputs.js';
import { hold, inner, release, wasm, waited, wrap, type Wait } from './internal.js';
import { load } from './load.js';
import type { Description, Value } from './outputs.js';
import { framed, type Patch } from './patch.js';

/**
 * The rows a query keeps, in the forms a patch writes: numbers as a `Float64Array` (missing NaN),
 * other values as arrays (missing `null`), a reference as its target's ids.
 */
export interface QueryResult {
  table: string;
  ids: Id[];
  fields: Record<string, Float64Array | Value[] | { reference: string; ids: (Id | null)[] }>;
  /** The rows the query kept before paging. */
  total: number;
}

/** Rows' least and greatest values over spans of the axis: `at` holds one more edge than spans. */
export interface Envelope {
  at: Float64Array;
  least: Float32Array;
  greatest: Float32Array;
}

/** What `Data.read` reads: latkit's bytes, GeoJSON, or a dataset's JSON document. */
export type DataSource =
  Uint8Array | ArrayBuffer | Blob | Response | ReadableStream<Uint8Array> | string | object;

/** What reads a version of a dataset, as the bindings' `Data` and `Snapshot` both do. */
type Reads = bindings.Data | bindings.Snapshot;

/**
 * A dataset that changes in place: named tables of columns, changed only by patches, every change
 * of one or none. A view given it draws its latest version, from the frame after a patch applies. A
 * snapshot keeps one version, sharing every page with it, so earlier versions kept, as an undo
 * history does, cost only the pages they hold apart.
 *
 * ```ts
 * const grid = new Data('grid').apply(new Patch().replace('Bus', [1, 2], { kv: [230, 115] }));
 * view.sources = [grid];
 * grid.apply(new Patch().set('Bus', [2], { kv: [69] })); // drawn next frame
 * ```
 */
export class Data {
  /** An empty dataset named `name`. */
  constructor(name: string) {
    hold(this, new (wasm().Data)(name));
  }

  /**
   * The dataset `source` holds, as its first bytes say: latkit's bytes; GeoJSON, gzip-compressed or
   * not, read in a worker, its points, line strings, and polygons rows of tables `points`, `lines`,
   * and `polygons`, each with its geometry as field `geometry` and its properties as fields; or its
   * JSON document, `{"name": ..., "patch": [...]}`, its patch read as `Patch.read` reads one. `source`
   * is bytes, a `Blob`, a `Response`, a stream, a URL to fetch, or a document as a JSON value. `name`
   * names it, as GeoJSON needs; `base` is what a document's slices of files are relative to, by
   * default the URL it was fetched from.
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

  /** Applies every change of `patch`, or none when one is invalid. */
  apply(patch: Patch | Uint8Array): this {
    inner<bindings.Data>(this, 'Data').apply(patch instanceof Uint8Array ? patch : framed(patch));
    return this;
  }

  /** The version it holds now, kept as it is while patches change it: O(1). */
  snapshot(): Snapshot {
    return wrap(Snapshot, inner<bindings.Data>(this, 'Data').snapshot());
  }

  /** Makes `snapshot`, a version of this dataset, the one it holds: what an undo does. */
  restore(snapshot: Snapshot): this {
    inner<bindings.Data>(this, 'Data').restore(inner<bindings.Snapshot>(snapshot, 'Snapshot'));
    return this;
  }

  /** What it holds now: see {@link Snapshot.describe}. */
  describe(): Description {
    return describe(reads(this));
  }

  /** A value it holds now: see {@link Snapshot.get}. */
  get(table: string, id: Id, field: string, options: { at?: number } = {}): Value {
    return get(reads(this), table, id, field, options);
  }

  /** The rows a query keeps of what it holds now: see {@link Snapshot.query}. */
  query(query: Query): QueryResult {
    return reads(this).query(JSON.stringify(query)) as QueryResult;
  }

  /** Rows' extremes over spans of what it holds now: see {@link Snapshot.envelope}. */
  envelope(request: EnvelopeRequest): Envelope {
    return envelope(reads(this), request);
  }

  /** What it holds now as latkit's bytes: the patch that builds it. */
  toBytes(): Uint8Array {
    return reads(this).toBytes();
  }

  /** Frees this handle; views drawing the dataset and its snapshots keep it. */
  destroy(): void {
    release<bindings.Data>(this)?.free();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/** One version of a dataset, as it was when taken: O(1) to keep. A view given one draws it as it is. */
export class Snapshot {
  private constructor() {}

  get name(): string {
    return reads(this).name;
  }

  /** What the dataset holds: tables, rows, fields and their kinds, the axis and its span. */
  describe(): Description {
    return describe(reads(this));
  }

  /** The value of `field` for the row with `id` in `table`, at axis coordinate `at` when given. */
  get(table: string, id: Id, field: string, options: { at?: number } = {}): Value {
    return get(reads(this), table, id, field, options);
  }

  /**
   * The rows of a table `query` keeps, filtered, sorted, and paged, sampled fields read at its
   * coordinate, on the CPU through the expressions marks draw with.
   */
  query(query: Query): QueryResult {
    return reads(this).query(JSON.stringify(query)) as QueryResult;
  }

  /**
   * Each row's least and greatest value of a sampled field over equal spans of a range, of every row
   * or of the rows named: row after row, NaN where a span holds no frame. It reads the coarsest
   * levels of detail that fit, so a span costs a few reads however many frames it covers.
   */
  envelope(request: EnvelopeRequest): Envelope {
    return envelope(reads(this), request);
  }

  /** The version as latkit's bytes: the patch that builds it. */
  toBytes(): Uint8Array {
    return reads(this).toBytes();
  }

  destroy(): void {
    release<bindings.Snapshot>(this)?.free();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}

/**
 * A dataset fetched in pieces as views ask for them: plain data naming where they lie. Each view
 * draws the pieces its camera and plot window ask for as a dataset of its own, and every view of a
 * GPU shares what is fetched. The source's first bytes say what it holds.
 *
 * - Time tiles, a `frames.json` manifest as `latkit tile` writes it: a dataset whose sampled
 *   fields' histories are fetched in spans. A line tracing a field fetches the detail its plot
 *   window draws, a mark showing one the frames about the view's coordinate, and a span still
 *   loading draws the coarser span above it.
 * - Vector tiles: a PMTiles archive, a TileJSON document, or a `{z}/{x}/{y}` template, fetched as
 *   the camera asks. Each layer is a table of its features of the kind marks draw it as (areas
 *   polygons, lines lines, vertices points), or named `layer:polygons`, `layer:lines`, or
 *   `layer:points`.
 */
export class Tiles {
  /** The tiles at `url`, drawn as dataset `name`. */
  constructor(
    readonly name: string,
    readonly url: string,
  ) {}
}

/** What a view draws a dataset from, by its name. */
export type Source = Data | Snapshot | Tiles;

/** @internal `source` as the bindings take it, each time anew. */
export function sourceOf(source: Source): bindings.Source {
  if (source instanceof Tiles) return wasm().Source.tiles(source.name, source.url);
  return source instanceof Data
    ? inner<bindings.Data>(source, 'Data').source()
    : inner<bindings.Snapshot>(source, 'Snapshot').source();
}

/** @internal A snapshot around the bindings' `snapshot`. */
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

/** The bytes `source` holds, and the URL they came from. */
async function bytesOf(
  source: DataSource,
  wait: Wait,
): Promise<{ bytes: Uint8Array; base: string }> {
  if (typeof source === 'string') {
    const response = await waited(
      fetch(source, { signal: wait.signal }),
      wait,
      `fetching ${source}`,
    );
    return bytesOf(response, wait);
  }
  if (source instanceof Uint8Array) return { bytes: source, base: '' };
  if (source instanceof ArrayBuffer) return { bytes: new Uint8Array(source), base: '' };
  if (source instanceof Response) {
    if (!source.ok) throw new Error(`${source.url}: ${source.status} ${source.statusText}`);
    return { bytes: new Uint8Array(await source.arrayBuffer()), base: source.url };
  }
  if (source instanceof Blob)
    return { bytes: new Uint8Array(await source.arrayBuffer()), base: '' };
  if (source instanceof ReadableStream)
    return { bytes: new Uint8Array(await new Response(source).arrayBuffer()), base: '' };
  return { bytes: new TextEncoder().encode(JSON.stringify(source)), base: '' };
}
