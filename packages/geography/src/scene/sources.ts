import { createData, type Data, type FieldInput, type Schema } from '@latkit/model';
import type { Gpu, kit } from '@latkit/gpu';
import { fieldKey } from '../options.js';
import { run } from '../prepare/client.js';
import type { Shapes } from '../prepare/shapes.js';
import { matchRows, readShapes } from '../read.js';
import type { TileSource } from '../sources/archive.js';
import type { VectorLayerRequest } from '../sources/vector.js';
import type { TileSet } from '../tiles.js';
import { Pyramid, type TileKey } from './pyramid.js';
import { ShapesBuffers } from './upload.js';

/** Shapes prepared from Data: by Data, then by type, field, and how they draw. */
const prepared = new WeakMap<Data, Map<string, Promise<Shapes>>>();

/** A vector tile, decoded: its rows, and each layer's shapes on the GPU. */
export interface VectorTileData {
  readonly key: TileKey;
  readonly data: Data;
  readonly layers: ReadonlyMap<string, { readonly rings?: Prepared; readonly lines?: Prepared }>;
  readonly bytes: number;
}

/** Shapes ready to draw: as prepared, and on the GPU. */
export interface Prepared {
  readonly shapes: Shapes;
  readonly buffers: ShapesBuffers;
}
interface Join {
  map?: Uint32Array;
  buffer?: kit.BufferResource;
  done: Promise<void>;
}
/**
 * Everything a geography's records draw from: shapes prepared from Data in a worker and shared by
 * every view, vector tiles by pyramid, and the joins `values` reads through. Loads start when a
 * frame first asks and invalidate the view as they land.
 */
export class Sources {
  private readonly buffers = new Map<Shapes, ShapesBuffers>();
  private readonly vectors = new Map<TileSet, { key: string; pyramid: Pyramid<VectorTileData> }>();
  private readonly joins = new WeakMap<Data, WeakMap<Data, Map<string, Join>>>();
  private readonly loading = new Set<Promise<unknown>>();
  /** What each preparation this view asked for became. */
  private readonly states = new WeakMap<Promise<Shapes>, { shapes?: Shapes }>();
  /** Joins' buffers, which destroy lets go of. */
  private readonly joined = new Set<kit.BufferResource>();
  private readonly sources = new WeakMap<TileSet, { source?: TileSource }>();
  constructor(
    private readonly gpu: Gpu,
    private readonly hooks: {
      readonly invalidate: () => void;
      readonly fail: (error: unknown) => void;
      readonly signal: AbortSignal;
      readonly limits: () => { readonly tileBytes: number; readonly tileRequests: number };
    },
  ) {}
  /** Settles once what is loading now lands. */
  get pending(): Promise<void> | undefined {
    const waits: Promise<unknown>[] = [...this.loading];
    for (const { pyramid } of this.vectors.values())
      if (pyramid.pending) waits.push(pyramid.pending);
    return waits.length ? Promise.all(waits).then(() => undefined) : undefined;
  }
  /** GPU bytes held: shapes, and loaded tiles. */
  get bytes(): number {
    let bytes = 0;
    for (const buffers of this.buffers.values()) bytes += buffers.bytes;
    for (const { pyramid } of this.vectors.values()) bytes += pyramid.stats.bytes;
    return bytes;
  }
  /** Tiles held and loading. */
  get tiles(): { readonly held: number; readonly loading: number } {
    let held = 0,
      loading = 0;
    for (const { pyramid } of this.vectors.values()) {
      held += pyramid.stats.held;
      loading += pyramid.stats.loading;
    }
    return { held, loading };
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.loading.add(promise);
    promise.then(
      () => {
        this.loading.delete(promise);
        this.hooks.invalidate();
      },
      (error: unknown) => {
        this.loading.delete(promise);
        if (!this.hooks.signal.aborted) this.hooks.fail(error);
      },
    );
    return promise;
  }
  /** A type's shapes from Data, prepared once in a worker; undefined until they are. */
  shapes(
    data: Data,
    type: string,
    field: FieldInput,
    closed: boolean,
    geodesic: boolean,
  ): Prepared | undefined {
    let byKey = prepared.get(data);
    if (!byKey) prepared.set(data, (byKey = new Map<string, Promise<Shapes>>()));
    const key = `${type}\u0000${fieldKey(field)}\u0000${closed}\u0000${geodesic}`;
    let promise = byKey.get(key);
    if (!promise) {
      const reader = this.gpu.reader.open();
      promise = readShapes(reader, data, type, field, { closed, geodesic })
        .finally(() => reader.close())
        .then((input) =>
          run({ kind: 'shapes', input }, [
            input.rowParts.buffer as ArrayBuffer,
            input.parts.buffer as ArrayBuffer,
            input.coordinates.buffer as ArrayBuffer,
          ]),
        );
      byKey.set(key, promise);
      const settled = promise;
      // A failed preparation is forgotten, so the next view or config tries again.
      promise.catch(() => {
        if (byKey.get(key) === settled) byKey.delete(key);
      });
    }
    let state = this.states.get(promise);
    if (!state) {
      const made: { shapes?: Shapes } = {};
      this.states.set(promise, (state = made));
      this.track(promise).then(
        (shapes) => (made.shapes = shapes),
        () => undefined,
      );
    }
    return state.shapes && this.upload(state.shapes);
  }
  /** Tiles' source once open: their zooms and bounds. */
  opened(tiles: TileSet): TileSource | undefined {
    let entry = this.sources.get(tiles);
    if (!entry) {
      const made: { source?: TileSource } = {};
      this.sources.set(tiles, (entry = made));
      this.track(tiles.source()).then(
        (source) => (made.source = source),
        () => undefined,
      );
    }
    return entry.source;
  }
  private upload(shapes: Shapes): Prepared {
    let buffers = this.buffers.get(shapes);
    if (!buffers) this.buffers.set(shapes, (buffers = new ShapesBuffers(this.gpu, shapes)));
    return { shapes, buffers };
  }
  /**
   * Vector tiles of a source, decoding the layers and fields asked for; asking for others starts
   * over. Every tile's rows share one schema, the request's, so what reads them plans once.
   */
  vector(tiles: TileSet, layers: readonly VectorLayerRequest[]): Pyramid<VectorTileData> {
    const key = JSON.stringify(layers),
      found = this.vectors.get(tiles);
    if (found?.key === key) return found.pyramid;
    found?.pyramid.destroy();
    const schema: Schema = {
        types: Object.fromEntries(
          layers.map((layer) => [
            layer.name,
            {
              fields: Object.fromEntries(
                Object.entries(layer.fields).map(([name, type]) => [
                  name,
                  { type, nullable: true },
                ]),
              ),
            },
          ]),
        ),
      },
      limits = this.hooks.limits(),
      pyramid = new Pyramid<VectorTileData>({
        tiles,
        bytes: limits.tileBytes,
        requests: limits.tileRequests,
        load: (source, tile, signal) =>
          this.loadVector(tiles, source, tile, layers, schema, signal),
        size: (data) => data.bytes,
        release: (data) => {
          for (const layer of data.layers.values()) {
            layer.rings?.buffers.destroy();
            layer.lines?.buffers.destroy();
          }
        },
        loaded: this.hooks.invalidate,
        fail: this.hooks.fail,
      });
    this.vectors.set(tiles, { key, pyramid });
    return pyramid;
  }
  private async loadVector(
    tiles: TileSet,
    source: TileSource,
    key: TileKey,
    layers: readonly VectorLayerRequest[],
    schema: Schema,
    signal: AbortSignal,
  ): Promise<VectorTileData | null> {
    const fetched = await source.tile(key.z, key.x, key.y, signal);
    if (!fetched) return null;
    // A copy goes to the worker, so a source held whole keeps its bytes.
    const bytes = fetched.slice(),
      { layers: decoded, batches } = await run(
        {
          kind: 'vector',
          request: { bytes, ...key, layers, source: `${tiles.name}/${key.z}/${key.x}/${key.y}` },
        },
        [bytes.buffer as ArrayBuffer],
        signal,
      );
    // A layer whose features all carry distinct ids numbers them as the tiles do, under their source.
    const numbered = new Map(decoded.filter((layer) => layer.ids).map((l) => [l.name, l.ids!])),
      data = createData(
        schema,
        batches.map((batch) => {
          const ids = numbered.get(batch.index.type);
          return ids
            ? {
                ...batch,
                index: { ...batch.index, source: tiles.name },
                rows: { kind: 'indices' as const, values: tiles.rowsOf(ids) },
              }
            : batch;
        }),
      ),
      out = new Map<string, { rings?: Prepared; lines?: Prepared }>();
    let total = 0;
    const up = (shapes: Shapes | undefined): Prepared | undefined => {
      if (!shapes) return undefined;
      const buffers = new ShapesBuffers(this.gpu, shapes);
      buffers.level(0);
      total += buffers.bytes;
      return { shapes, buffers };
    };
    for (const layer of decoded)
      out.set(layer.name, { rings: up(layer.rings), lines: up(layer.lines) });
    return { key, data, layers: out, bytes: total };
  }
  /** Where each shape row's values lie among `values`' rows of the type; undefined until matched. */
  join(shapes: Data, values: Data, type: string): kit.BufferResource | undefined {
    let byValues = this.joins.get(shapes);
    if (!byValues) this.joins.set(shapes, (byValues = new WeakMap()));
    let byType = byValues.get(values);
    if (!byType) byValues.set(values, (byType = new Map<string, Join>()));
    let join = byType.get(type);
    if (!join) {
      const reader = this.gpu.reader.open(),
        made: Join = {
          done: this.track(
            matchRows(reader, shapes, values, type).finally(() => reader.close()),
          ).then(
            (map) => {
              made.map = map;
            },
            () => undefined,
          ),
        };
      byType.set(type, (join = made));
    }
    if (join.map && !join.buffer) {
      const resource = this.gpu.buffer({
        size: Math.max(16, join.map.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: 'geography values rows',
      });
      this.gpu.device.queue.writeBuffer(resource.buffer, 0, join.map as Uint32Array<ArrayBuffer>);
      join.buffer = resource;
      this.joined.add(resource);
    }
    return join.buffer;
  }
  /** Let go of what no record names any more: pyramids, and shapes' buffers. */
  keep(live: {
    readonly shapes: ReadonlySet<Shapes>;
    readonly vectors: ReadonlySet<TileSet>;
  }): void {
    for (const [shapes, buffers] of this.buffers)
      if (!live.shapes.has(shapes)) {
        buffers.destroy();
        this.buffers.delete(shapes);
      }
    for (const [tiles, { pyramid }] of this.vectors)
      if (!live.vectors.has(tiles)) {
        pyramid.destroy();
        this.vectors.delete(tiles);
      }
  }
  destroy(): void {
    for (const buffers of this.buffers.values()) buffers.destroy();
    this.buffers.clear();
    for (const buffer of this.joined) buffer.destroy();
    this.joined.clear();
    for (const { pyramid } of this.vectors.values()) pyramid.destroy();
    this.vectors.clear();
  }
}
