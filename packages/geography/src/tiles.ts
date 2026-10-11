import { failure } from '@latkit/model';
import { openTiles, type TileSource } from './sources/archive.js';
import { readPack, type Pack } from './pack.js';

/** Tiles a geography reads: a pack, or vector tiles, by URL ranges or held locally. */
export interface Tiles {
  /** What the tiles hold, once their source is open; rejects when it cannot be read. */
  readonly info: Promise<TilesInfo>;
}
export interface TilesInfo {
  readonly kind: 'pack' | 'vector';
  readonly minZoom: number;
  readonly maxZoom: number;
  /** West, south, east, and north, in degrees. */
  readonly bounds: readonly [number, number, number, number];
  readonly attribution?: string;
  /** A vector source's layers, or a pack's types. */
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
  /** The Index source a tile's rows are numbered under, unique to these tiles. */
  readonly name = `latkit-tiles-${++sources}`;
  private opened?: Promise<TileSource>;
  private packed?: Promise<Pack>;
  constructor(
    private readonly from: string | URL | Blob | ArrayBuffer | Uint8Array,
    private readonly options: TilesOptions,
  ) {
    this.info = this.source().then(infoOf);
    this.info.catch(() => undefined);
  }
  /** The open source. */
  source(): Promise<TileSource> {
    return (this.opened ??= openTiles(this.from, this.options));
  }
  /** A pack's contents, read whole once. */
  pack(): Promise<Pack> {
    return (this.packed ??= this.source().then(async (source) => {
      if (source.kind !== 'pack') throw failure('invalid-input', 'These tiles are not a pack');
      const bytes = await source.tile(0, 0, 0);
      if (!bytes) throw failure('protocol', 'The pack holds no shapes');
      return readPack(bytes, this.name);
    }));
  }
}
function infoOf(source: TileSource): TilesInfo {
  const metadata = source.metadata as {
    readonly vector_layers?: readonly { readonly id?: unknown }[];
    readonly types?: readonly unknown[];
  };
  const layers =
    source.kind === 'pack'
      ? (metadata.types ?? []).filter((t): t is string => typeof t === 'string')
      : (metadata.vector_layers ?? [])
          .map((layer) => layer.id)
          .filter((id): id is string => typeof id === 'string');
  return {
    kind: source.kind,
    minZoom: source.minZoom,
    maxZoom: source.maxZoom,
    bounds: source.bounds,
    ...(source.attribution !== undefined ? { attribution: source.attribution } : {}),
    layers,
  };
}
/** Whether a value is tiles `tiles()` made. */
export function isTiles(value: unknown): value is TileSet {
  return value instanceof TileSet;
}

/**
 * Tiles from a pack, a vector PMTiles archive, a `{z}/{x}/{y}` URL template of vector tiles, or a
 * TileJSON URL; by HTTP range requests, or held locally as a Blob or bytes.
 */
export function tiles(
  from: string | URL | Blob | ArrayBuffer | Uint8Array,
  options: TilesOptions = {},
): Tiles {
  if (
    typeof from !== 'string' &&
    !(from instanceof URL) &&
    !(typeof Blob !== 'undefined' && from instanceof Blob) &&
    !(from instanceof ArrayBuffer) &&
    !(from instanceof Uint8Array)
  )
    throw failure('invalid-input', 'Tiles come from a URL, a Blob, or bytes');
  return new TileSet(from, options);
}
