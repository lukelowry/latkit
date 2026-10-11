import { isFailure } from '@latkit/model';
import type { kit } from '@latkit/gpu';
import type { TileSource } from '../sources/archive.js';
import type { TileSet } from '../tiles.js';
import { meets, type Region } from './visible.js';

const DEGREE = Math.PI / 180;
/** CSS pixels a vector tile spans drawn at its own zoom. */
const TILE_PX = 512;
/** At most this many tiles draw at once: past it, tiles stop splitting. */
const MAX_TILES = 256;

export interface TileKey {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}
/** A tile the frame draws, and the loaded tile it draws from: itself, or an ancestor until it loads. */
export interface Placed<T> {
  readonly key: TileKey;
  readonly from: TileKey;
  readonly data: T;
}
export interface PyramidOptions<T> {
  readonly tiles: TileSet;
  /** Bytes the loaded tiles may hold before the least recently drawn go. */
  readonly bytes: number;
  /** Requests in flight at once. */
  readonly requests: number;
  load(source: TileSource, key: TileKey, signal: AbortSignal): Promise<T | null>;
  size(data: T): number;
  release(data: T): void;
  /** A tile landed: draw again. */
  loaded(): void;
  fail(error: unknown): void;
}
const keyOf = (z: number, x: number, y: number) => `${z}/${x}/${y}`;
/** A tile's latitude at a fraction of the way down the mercator square. */
function latitudeAt(t: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) / DEGREE;
}
/** A tile's west, south, east, and north. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  return [
    (x / n) * 360 - 180,
    latitudeAt((y + 1) / n),
    ((x + 1) / n) * 360 - 180,
    latitudeAt(y / n),
  ];
}

/** A tile's four children, as their offsets in the next zoom. */
const CHILDREN = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;
/** Where tiles draw largest: where the camera looks, and tilted, the nearest ground it shows. */
function focusOf(projector: kit.Projector): (readonly [number, number])[] {
  const { camera, viewport } = projector,
    near = projector.unproject([viewport.width / 2, viewport.height]);
  return near ? [camera.center, near] : [camera.center];
}
/**
 * How large a tile draws where it lies nearest each focus, and how far from the canvas's center
 * that lands: a point that shows whenever the tile meets the view, however near the camera is.
 */
function measure(
  projector: kit.Projector,
  focus: readonly (readonly [number, number])[],
  w: number,
  s: number,
  e: number,
  n: number,
): { size: number; distance: number } {
  const dx = (e - w) / 64,
    dy = (n - s) / 64,
    { width, height } = projector.viewport;
  let size = 0,
    distance = Infinity;
  for (const [fx, fy] of focus) {
    // The focus on the tile's side of the antimeridian.
    const near = fx + 360 * Math.round(((w + e) / 2 - fx) / 360),
      x = Math.min(e - dx, Math.max(w, near)),
      y = Math.min(n - dy, Math.max(s, fy)),
      p = projector.project(x, y);
    if (!p.visible) continue;
    const east = projector.project(x + dx, y),
      north = projector.project(x, y + dy);
    size = Math.max(
      size,
      64 * Math.hypot(east.x - p.x, east.y - p.y),
      64 * Math.hypot(north.x - p.x, north.y - p.y),
    );
    distance = Math.min(distance, Math.hypot(p.x - width / 2, p.y - height / 2));
  }
  return { size, distance };
}
interface Held<T> {
  readonly data: T | null;
  readonly bytes: number;
}
/**
 * Tiles that replace their parents as the camera nears: chosen by how large they draw in any
 * projection, loaded nearest the center first, drawn from an ancestor until they land, and let go
 * of, least recently drawn first, past a byte budget.
 */
export class Pyramid<T> {
  private source?: TileSource;
  private readonly held = new Map<string, Held<T>>();
  private readonly loading = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private bytes = 0;
  private closed = false;
  private failed = false;
  /** Settles once the source opens or fails to; undefined after. */
  private opening?: Promise<void>;
  constructor(private readonly options: PyramidOptions<T>) {
    this.opening = options.tiles.source().then(
      (source) => {
        this.opening = undefined;
        if (this.closed) return;
        this.source = source;
        options.loaded();
      },
      (error: unknown) => {
        this.opening = undefined;
        if (!this.closed) options.fail(error);
      },
    );
  }
  /** Settles once the tiles loading now land. */
  get pending(): Promise<void> | undefined {
    if (this.opening) return this.opening;
    if (!this.loading.size) return undefined;
    return Promise.all([...this.loading.values()].map((l) => l.done)).then(() => undefined);
  }
  /** Tiles loaded, in flight, and the bytes held. */
  get stats(): { readonly held: number; readonly loading: number; readonly bytes: number } {
    return { held: this.held.size, loading: this.loading.size, bytes: this.bytes };
  }
  /** What the source declares, once open. */
  get opened(): TileSource | undefined {
    return this.source;
  }
  /**
   * The tiles a camera draws over `region`, the ground it shows, loading those it lacks: each loaded,
   * or drawn from an ancestor.
   */
  frame(projector: kit.Projector, region: Region): readonly Placed<T>[] {
    const source = this.source;
    if (!source || this.closed) return [];
    const wanted = this.wanted(projector, source, region),
      placed: Placed<T>[] = [],
      missing: TileKey[] = [],
      used = new Set<string>();
    for (const key of wanted) {
      const own = this.held.get(keyOf(key.z, key.x, key.y));
      if (own) {
        used.add(keyOf(key.z, key.x, key.y));
        if (own.data) placed.push({ key, from: key, data: own.data });
        continue;
      }
      missing.push(key);
      for (let z = key.z - 1; z >= 0; z--) {
        const shift = key.z - z,
          k = keyOf(z, key.x >> shift, key.y >> shift),
          found = this.held.get(k);
        if (!found) continue;
        used.add(k);
        if (found.data)
          placed.push({ key, from: { z, x: key.x >> shift, y: key.y >> shift }, data: found.data });
        break;
      }
    }
    // Drawn tiles are the most recently used.
    for (const k of used) {
      const entry = this.held.get(k)!;
      this.held.delete(k);
      this.held.set(k, entry);
    }
    this.request(missing, source, new Set(wanted.map((key) => keyOf(key.z, key.x, key.y))));
    this.evict(used);
    return placed;
  }
  destroy(): void {
    this.closed = true;
    for (const { controller } of this.loading.values()) controller.abort();
    this.loading.clear();
    for (const entry of this.held.values()) if (entry.data) this.options.release(entry.data);
    this.held.clear();
    this.bytes = 0;
  }
  /**
   * The tiles to draw: those meeting the region, each split while it draws larger than its size
   * where it lies nearest the camera's focus, nearest the center first.
   */
  private wanted(projector: kit.Projector, source: TileSource, region: Region): TileKey[] {
    const limit = TILE_PX * 1.25,
      [bw, bs, be, bn] = source.bounds,
      focus = focusOf(projector),
      out: { key: TileKey; distance: number }[] = [];
    let queue: TileKey[] = [{ z: 0, x: 0, y: 0 }];
    while (queue.length) {
      const next: TileKey[] = [];
      for (const key of queue) {
        const [w, s, e, n] = tileBounds(key.z, key.x, key.y);
        if (w > be || e < bw || s > bn || n < bs || !meets(region, w, s, e, n)) continue;
        const shown = measure(projector, focus, w, s, e, n),
          splits =
            key.z < source.maxZoom &&
            (key.z < source.minZoom || shown.size > limit) &&
            out.length + next.length + queue.length < MAX_TILES;
        if (splits)
          for (const [dx, dy] of CHILDREN)
            next.push({ z: key.z + 1, x: key.x * 2 + dx, y: key.y * 2 + dy });
        else if (key.z >= source.minZoom) out.push({ key, distance: shown.distance });
      }
      queue = next;
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.map((o) => o.key);
  }
  /** Start loading missing tiles, nearest first, and stop loading tiles no longer wanted. */
  private request(
    missing: readonly TileKey[],
    source: TileSource,
    wanted: ReadonlySet<string>,
  ): void {
    for (const [k, { controller }] of this.loading)
      if (!wanted.has(k)) {
        controller.abort();
        this.loading.delete(k);
      }
    for (const key of missing) {
      if (this.loading.size >= this.options.requests) break;
      const k = keyOf(key.z, key.x, key.y);
      if (this.loading.has(k)) continue;
      const controller = new AbortController(),
        done = this.options.load(source, key, controller.signal).then(
          (data) => {
            if (this.loading.get(k)?.controller !== controller || this.closed) {
              if (data) this.options.release(data);
              return;
            }
            this.loading.delete(k);
            const bytes = data ? this.options.size(data) : 0;
            this.held.set(k, { data, bytes });
            this.bytes += bytes;
            this.options.loaded();
          },
          (error: unknown) => {
            if (this.loading.get(k)?.controller === controller) this.loading.delete(k);
            if (controller.signal.aborted || isFailure(error, 'aborted') || this.closed) return;
            // A tile that cannot load draws its ancestor, and is not asked for again; the first
            // such failure reports, not every tile of a source that went away.
            this.held.set(k, { data: null, bytes: 0 });
            if (!this.failed) this.options.fail(error);
            this.failed = true;
            this.options.loaded();
          },
        );
      this.loading.set(k, { controller, done });
    }
  }
  /** Let go of the least recently drawn tiles past the byte budget, never one this frame draws. */
  private evict(used: ReadonlySet<string>): void {
    for (const [k, entry] of this.held) {
      if (this.bytes <= this.options.bytes) break;
      if (used.has(k)) continue;
      this.held.delete(k);
      this.bytes -= entry.bytes;
      if (entry.data) this.options.release(entry.data);
    }
  }
}
