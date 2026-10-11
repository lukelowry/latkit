import { textColumn, type Column, type Data } from '@latkit/model';
import { decodeTile, type FeatureSet, type TileLayer } from './mvt.js';
import { prepareShapes, shapesBuffers, type Shapes } from '../prepare/shapes.js';

/** The types a tile's property becomes as a field. */
export type VectorFieldType = 'float64' | 'boolean' | 'text';
/**
 * What a vector tile's layers draw: their rings, as areas and outlines, and their lines; and the
 * fields their rows carry, the properties records read, each in every tile whether or not its
 * features hold it.
 */
export interface VectorLayerRequest {
  readonly name: string;
  readonly rings: boolean;
  readonly lines: boolean;
  readonly fields: Readonly<Record<string, VectorFieldType>>;
}
export interface VectorRequest {
  readonly bytes: Uint8Array;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly layers: readonly VectorLayerRequest[];
  /** The Index source the tile's rows are numbered under, by place. */
  readonly source: string;
}
/** A decoded layer: its rows, which are its features, and its shapes. */
export interface VectorLayer {
  readonly name: string;
  readonly rows: number;
  /**
   * Each row's feature id, where every feature has a distinct whole-number one: the tiles number
   * each id once, so a feature is one item in every tile and zoom that holds it.
   */
  readonly ids?: Float64Array;
  readonly rings?: Shapes;
  readonly lines?: Shapes;
}
/** A decoded tile: its layers, and their rows as model rows, in the schema its request describes. */
export interface VectorTile {
  readonly layers: readonly VectorLayer[];
  readonly batches: readonly Data.RowBatch[];
}

const DEGREE = Math.PI / 180;

/** A tile's longitude and latitude at a point in its own units. */
class TileFrame {
  readonly west: number;
  readonly east: number;
  readonly north: number;
  readonly south: number;
  private readonly n: number;
  constructor(
    readonly z: number,
    readonly x: number,
    readonly y: number,
    readonly extent: number,
  ) {
    this.n = 2 ** z;
    this.west = this.lon(0);
    this.east = this.lon(extent);
    this.north = this.lat(0);
    this.south = this.lat(extent);
  }
  lon(px: number): number {
    return ((this.x + px / this.extent) / this.n) * 360 - 180;
  }
  lat(py: number): number {
    return (
      Math.atan(Math.sinh(Math.PI * (1 - (2 * (this.y + py / this.extent)) / this.n))) / DEGREE
    );
  }
}

/** A ring clipped to the tile's square, by each side in turn. */
function clipRing(xy: Float32Array, first: number, end: number, size: number): number[] {
  let points: number[] = [];
  for (let i = first; i < end; i++) points.push(xy[2 * i], xy[2 * i + 1]);
  const sides: [number, boolean, number][] = [
    [0, false, 0],
    [0, true, size],
    [1, false, 0],
    [1, true, size],
  ];
  for (const [axis, upper, limit] of sides) {
    const out: number[] = [],
      n = points.length / 2;
    if (!n) break;
    const inside = (k: number) =>
      upper ? points[2 * k + axis] <= limit : points[2 * k + axis] >= limit;
    for (let k = 0; k < n; k++) {
      const j = (k + n - 1) % n,
        a = inside(j),
        b = inside(k);
      if (a !== b) {
        const pa = points[2 * j + axis],
          pb = points[2 * k + axis],
          t = (limit - pa) / (pb - pa),
          other = 1 - axis,
          q = points[2 * j + other] + (points[2 * k + other] - points[2 * j + other]) * t;
        if (axis === 0) out.push(limit, q);
        else out.push(q, limit);
      }
      if (b) out.push(points[2 * k], points[2 * k + 1]);
    }
    points = out;
  }
  return points;
}
/** A polyline clipped to the tile's square: the runs of it inside. */
function clipLine(xy: Float32Array, first: number, end: number, size: number): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  const close = () => {
    if (run.length >= 4) runs.push(run);
    run = [];
  };
  for (let i = first; i + 1 < end; i++) {
    let t0 = 0,
      t1 = 1;
    const ax = xy[2 * i],
      ay = xy[2 * i + 1],
      dx = xy[2 * i + 2] - ax,
      dy = xy[2 * i + 3] - ay;
    const clip = (p: number, q: number) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };
    if (!(clip(-dx, ax) && clip(dx, size - ax) && clip(-dy, ay) && clip(dy, size - ay))) {
      close();
      continue;
    }
    const sx = ax + dx * t0,
      sy = ay + dy * t0;
    if (!run.length || run[run.length - 2] !== sx || run[run.length - 1] !== sy) {
      if (run.length && t0 > 0) close();
      run.push(sx, sy);
    }
    run.push(ax + dx * t1, ay + dy * t1);
    if (t1 < 1) close();
  }
  close();
  return runs;
}

/** Shapes input in longitude and latitude, gathered feature by feature. */
class Gather {
  readonly rowParts: number[] = [0];
  readonly parts: number[] = [0];
  readonly coordinates: number[] = [];
  constructor(private readonly frame: TileFrame) {}
  part(points: readonly number[]): void {
    const f = this.frame,
      size = f.extent;
    for (let k = 0; k < points.length; k += 2) {
      const px = points[k],
        py = points[k + 1];
      // Points on the tile's edges land on its exact bounds, so strokes know a clip from a border.
      this.coordinates.push(
        px <= 0 ? f.west : px >= size ? f.east : f.lon(px),
        py <= 0 ? f.north : py >= size ? f.south : f.lat(py),
      );
    }
    this.parts.push(this.coordinates.length / 2);
  }
  row(): void {
    this.rowParts.push(this.parts.length - 1);
  }
  empty(rows: number): void {
    for (let r = 0; r < rows; r++) this.row();
  }
}

/** Decode a vector tile's requested layers: clipped to the tile, prepared, with their rows. */
export function decodeVector(request: VectorRequest): {
  tile: VectorTile;
  transfer: ArrayBuffer[];
} {
  const wanted = new Set(request.layers.map((layer) => layer.name)),
    decoded = new Map(decodeTile(request.bytes, wanted).map((layer) => [layer.name, layer])),
    layers: VectorLayer[] = [],
    batches: Data.RowBatch[] = [],
    transfer: ArrayBuffer[] = [];
  for (const want of request.layers) {
    const layer = decoded.get(want.name);
    if (!layer) continue;
    const frame = new TileFrame(request.z, request.x, request.y, layer.extent),
      sets = [layer.areas, layer.lines, layer.points],
      counts = sets.map((set) => set.features.length - 1),
      rows = counts[0] + counts[1] + counts[2];
    if (!rows) continue;
    let rings: Shapes | undefined, lines: Shapes | undefined;
    const clip = [frame.west, frame.south, frame.east, frame.north] as const;
    if (want.rings && counts[0]) {
      const gather = new Gather(frame),
        set = layer.areas;
      for (let f = 0; f < counts[0]; f++) {
        for (let p = set.features[f]; p < set.features[f + 1]; p++) {
          const ring = clipRing(set.coordinates, set.parts[p], set.parts[p + 1], layer.extent);
          if (ring.length >= 6) gather.part(ring);
        }
        gather.row();
      }
      gather.empty(counts[1] + counts[2]);
      rings = prepare(gather, true, clip);
      transfer.push(...shapesBuffers(rings));
    }
    if (want.lines && counts[1]) {
      const gather = new Gather(frame),
        set = layer.lines;
      gather.empty(counts[0]);
      for (let f = 0; f < counts[1]; f++) {
        for (let p = set.features[f]; p < set.features[f + 1]; p++)
          for (const run of clipLine(set.coordinates, set.parts[p], set.parts[p + 1], layer.extent))
            gather.part(run);
        gather.row();
      }
      gather.empty(counts[2]);
      lines = prepare(gather, false, clip);
      transfer.push(...shapesBuffers(lines));
    }
    if (!rings && !lines) continue;
    const { batch, ids } = layerRows(layer, sets, want.fields, request.source, frame);
    batches.push(batch);
    if (ids) transfer.push(ids.buffer as ArrayBuffer);
    layers.push({ name: layer.name, rows, rings, lines, ...(ids ? { ids } : {}) });
  }
  return { tile: { layers, batches }, transfer };
}
function prepare(gather: Gather, closed: boolean, clip: readonly number[]): Shapes {
  return prepareShapes({
    closed,
    rowParts: Uint32Array.from(gather.rowParts),
    parts: Uint32Array.from(gather.parts),
    coordinates: Float64Array.from(gather.coordinates),
    detail: 'full',
    clip: clip as readonly [number, number, number, number],
  });
}

/**
 * A layer's features as model rows, by place: a column per field asked for, and an id each. Where
 * every feature's id is a distinct whole number, those ids too, for the tiles to number. Only the
 * properties asked for are read, and only their values decode.
 */
function layerRows(
  layer: TileLayer,
  sets: readonly FeatureSet[],
  fields: Readonly<Record<string, VectorFieldType>>,
  source: string,
  frame: TileFrame,
): { batch: Data.RowBatch; ids?: Float64Array } {
  let count = 0;
  for (const set of sets) count += set.features.length - 1;
  const numbers = new Float64Array(count);
  let row = 0;
  for (const set of sets)
    for (let f = 0; f + 1 < set.features.length; f++) numbers[row++] = set.ids[f];
  const stable =
    numbers.every((id) => Number.isSafeInteger(id) && id >= 0) &&
    new Set(numbers).size === numbers.length;
  const ids = stable
    ? Array.from(numbers, String)
    : Array.from(numbers, (_, i) => `${layer.name}:${frame.z}/${frame.x}/${frame.y}:${i}`);
  // Each key's column, or -1 for keys no field reads.
  const names = Object.keys(fields),
    columns = names.map((name) => new FieldColumn(fields[name], count)),
    slots = new Map(names.map((name, i) => [name, i])),
    slot = Int32Array.from(layer.keys, (key) => slots.get(key) ?? -1);
  if (names.length) {
    row = 0;
    for (const set of sets)
      for (let f = 0; f + 1 < set.features.length; f++, row++)
        for (let pair = set.tagStarts[f]; pair < set.tagStarts[f + 1]; pair++) {
          const at = slot[set.tags[2 * pair]];
          if (at >= 0) columns[at].set(row, layer.value(set.tags[2 * pair + 1]));
        }
  }
  return {
    batch: {
      kind: 'rows',
      index: { source, type: layer.name, version: '1' },
      rows: { kind: 'range', offset: 0, count },
      ids: textColumn(ids),
      columns: Object.fromEntries(names.map((name, i) => [name, columns[i].column()])),
    },
    ...(stable ? { ids: numbers } : {}),
  };
}

/**
 * A field's column as features fill it, null where none holds a value it takes: a number for
 * `float64`, a boolean as 0 or 1; a boolean for `boolean`, a number as whether it is not 0; and
 * any value as its text for `text`.
 */
class FieldColumn {
  private readonly validity: Uint8Array;
  private readonly numbers?: Float64Array;
  private readonly bits?: Uint8Array;
  private readonly texts?: (string | null)[];
  private held = 0;
  constructor(
    private readonly type: VectorFieldType,
    private readonly count: number,
  ) {
    this.validity = new Uint8Array(Math.ceil(count / 8));
    if (type === 'float64') this.numbers = new Float64Array(count);
    else if (type === 'boolean') this.bits = new Uint8Array(Math.ceil(count / 8));
    else this.texts = new Array<string | null>(count).fill(null);
  }
  set(row: number, value: string | number | boolean): void {
    const bit = 1 << (row & 7);
    if (this.validity[row >>> 3] & bit) return;
    if (this.numbers) {
      const number = typeof value === 'boolean' ? +value : value;
      if (typeof number !== 'number' || Number.isNaN(number)) return;
      this.numbers[row] = number;
    } else if (this.bits) {
      if (typeof value === 'string') return;
      if (value) this.bits[row >>> 3] |= bit;
    } else this.texts![row] = String(value);
    this.validity[row >>> 3] |= bit;
    this.held++;
  }
  column(): Column {
    const { count } = this,
      validity = this.held < count ? { validity: this.validity } : {};
    if (this.numbers)
      return { kind: 'numeric', offset: 0, length: count, values: this.numbers, ...validity };
    if (this.bits)
      return { kind: 'boolean', offset: 0, length: count, values: this.bits, ...validity };
    return textColumn(this.texts!);
  }
}
