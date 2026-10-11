import { failure } from '@latkit/model';
import { openTiles, type TileSource } from './sources/archive.js';

/** Vector tiles a geography reads, by URL ranges or held locally. */
export interface Tiles {
  /** What the tiles hold, once their source is open; rejects when it cannot be read. */
  readonly info: Promise<TilesInfo>;
}
export interface TilesInfo {
  readonly minZoom: number;
  readonly maxZoom: number;
  /** West, south, east, and north, in degrees. */
  readonly bounds: readonly [number, number, number, number];
  readonly attribution?: string;
  /** The layers, which a geography's records name as types. */
  readonly layers: readonly string[];
}
export interface TilesOptions {
  /** Keep fetched bytes in Cache Storage, so the tiles a view has seen draw offline. */
  readonly persist?: boolean;
  readonly attribution?: string;
}

let sources = 0;
/** Tiles, opened lazily and shared by every view that reads them. */
export class TileSet implements Tiles {
  readonly info: Promise<TilesInfo>;
  /** The Index source the tiles' features are numbered under, unique to these tiles. */
  readonly name = `latkit-tiles-${++sources}`;
  private opened?: Promise<TileSource>;
  /** Each feature id the tiles have held, and its row. */
  private readonly rows = new Map<number, number>();
  constructor(
    private readonly from: string | URL | Blob | ArrayBuffer | ArrayBufferView,
    private readonly options: TilesOptions,
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
function infoOf(source: TileSource): TilesInfo {
  const { vector_layers: layers } = source.metadata as {
    readonly vector_layers?: readonly { readonly id?: unknown }[];
  };
  return {
    minZoom: source.minZoom,
    maxZoom: source.maxZoom,
    bounds: source.bounds,
    ...(source.attribution !== undefined ? { attribution: source.attribution } : {}),
    layers: (layers ?? [])
      .map((layer) => layer.id)
      .filter((id): id is string => typeof id === 'string'),
  };
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
  options: TilesOptions = {},
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
