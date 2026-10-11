import { failure, type Schema } from '@latkit/model';
import { openTiles, type TileSource } from './sources/archive.js';
import type { VectorFieldType } from './sources/vector.js';

/** Vector tiles a geography reads, by URL ranges or held locally. */
export interface Tiles {
  /** What the tiles hold, once their source is open; rejects when it cannot be read. */
  readonly info: Promise<Tiles.Info>;
}
export declare namespace Tiles {
  interface Info {
    readonly minZoom: number;
    readonly maxZoom: number;
    /** West, south, east, and north, in degrees. */
    readonly bounds: readonly [number, number, number, number];
    readonly attribution?: string;
    /**
     * A type per layer, which a geography's records name, with the fields the tiles' metadata
     * declares for it: `float64`, `boolean`, or `text`, each nullable. A record's channels and
     * labels read them; tiles decode only what records read.
     */
    readonly schema: Schema;
  }
  interface Options {
    /** Keep fetched bytes in Cache Storage, so the tiles a view has seen draw offline. */
    readonly persist?: boolean;
    readonly attribution?: string;
  }
}

let sources = 0;
/** Tiles, opened lazily and shared by every view that reads them. */
export class TileSet implements Tiles {
  readonly info: Promise<Tiles.Info>;
  /** The Index source the tiles' features are numbered under, unique to these tiles. */
  readonly name = `latkit-tiles-${++sources}`;
  private opened?: Promise<TileSource>;
  /** Each feature id the tiles have held, and its row. */
  private readonly rows = new Map<number, number>();
  constructor(
    private readonly from: string | URL | Blob | ArrayBuffer | ArrayBufferView,
    private readonly options: Tiles.Options,
  ) {
    this.info = this.source().then(infoOf);
    this.info.catch(() => undefined);
  }
  /** The open source. */
  source(): Promise<TileSource> {
    return (this.opened ??= openTiles(this.from, this.options));
  }
  /**
   * Feature ids as rows of these tiles: each id numbered once, the first time any tile holds it, so
   * a feature is one row in every tile and zoom, however large its id.
   */
  rowsOf(ids: Float64Array): Uint32Array {
    const rows = new Uint32Array(ids.length);
    ids.forEach((id, i) => {
      let row = this.rows.get(id);
      if (row === undefined) this.rows.set(id, (row = this.rows.size));
      rows[i] = row;
    });
    return rows;
  }
}
function infoOf(source: TileSource): Tiles.Info {
  return {
    minZoom: source.minZoom,
    maxZoom: source.maxZoom,
    bounds: source.bounds,
    ...(source.attribution !== undefined ? { attribution: source.attribution } : {}),
    schema: declaredSchema(source),
  };
}
/** How TileJSON's `vector_layers` names a field's type; any other reads as text. */
const DECLARED: Readonly<Record<string, VectorFieldType>> = {
  Number: 'float64',
  Boolean: 'boolean',
  String: 'text',
};
/** A layer as TileJSON's `vector_layers` lists it. */
interface ListedLayer {
  readonly id?: unknown;
  readonly fields?: unknown;
}
const declared = new WeakMap<TileSource, Schema>();
/** The layers and fields a source's metadata declares, as a schema; read once per source. */
export function declaredSchema(source: TileSource): Schema {
  let schema = declared.get(source);
  if (schema) return schema;
  const { vector_layers: listed } = source.metadata as { readonly vector_layers?: unknown },
    types = new Map<string, Schema.Type>();
  for (const layer of (Array.isArray(listed) ? listed : []) as readonly (ListedLayer | null)[]) {
    const { id, fields } = layer ?? {};
    if (typeof id !== 'string' || types.has(id)) continue;
    const kinds = fields && typeof fields === 'object' ? Object.entries(fields) : [];
    types.set(id, {
      fields: Object.fromEntries(
        kinds.map(([name, kind]) => [
          name,
          {
            type:
              typeof kind === 'string' && Object.hasOwn(DECLARED, kind) ? DECLARED[kind] : 'text',
            nullable: true,
          },
        ]),
      ),
    });
  }
  declared.set(source, (schema = { types: Object.fromEntries(types) }));
  return schema;
}
/** Whether a value is tiles `tiles()` made. */
export function isTiles(value: unknown): value is TileSet {
  return value instanceof TileSet;
}

/**
 * Vector tiles: a PMTiles archive by URL, as a Blob such as a local file, or as bytes; a
 * `{z}/{x}/{y}` URL template; or a TileJSON URL.
 */
export function tiles(
  from: string | URL | Blob | ArrayBuffer | ArrayBufferView,
  options: Tiles.Options = {},
): Tiles {
  if (
    typeof from !== 'string' &&
    !(from instanceof URL) &&
    !(typeof Blob !== 'undefined' && from instanceof Blob) &&
    !(from instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(from)
  )
    throw failure('invalid-input', 'Tiles come from a URL, a Blob, or bytes');
  return new TileSet(from, options);
}
