import earcut from 'earcut';
import { cutLines, cutRings, labelPoint, simplificationAreas, type CutParts } from './geometry.js';

/** Where a strip ends and the next begins. */
export const BREAK = 0xffffffff;
/** Edges longer than this many degrees gain points, so they bend with the globe. */
const DENSIFY = 2;
/** Geodesics gain a point every this many degrees. */
const GEODESIC = 1;
/**
 * Inner edges longer than this many degrees split, so none sags far beneath the globe: a chord
 * this long sags under 0.4% of its radius. Outlines are densified finer, which keeps an area's
 * outline on the globe; an inner edge only moves a fill's inside, which its own triangles cover.
 */
const SPLIT = 10;
/** The coarsest level drops points whose effective area is under this many square degrees. */
const COARSEST = 2;
/** Each level keeps points down to a sixteenth of the area of the level before: two zooms. */
const STEP = 16;
const MAX_LEVELS = 10;
/** Each level holds at most a third of the points of the next finer one. */
const GROWTH = 3;
/** The deepest cell a piece is filed under. */
export const MAX_DEPTH = 12;
const DEGREE = Math.PI / 180;

/** A type's shapes as read: rows of parts, each part a run of points. */
export interface ShapesInput {
  /** Rings, which bound areas and outline them, or polylines. */
  readonly closed: boolean;
  /** Polylines follow great circles between their points. */
  readonly geodesic?: boolean;
  /** Per row its first part, then the part count. */
  readonly rowParts: Uint32Array;
  /** Per part its first point, then the point count. */
  readonly parts: Uint32Array;
  /** Longitude and latitude pairs, in degrees. */
  readonly coordinates: Float64Array;
  /** `levels` simplifies into levels of detail; `full` keeps one level of every point, as tiles do. */
  readonly detail?: 'levels' | 'full';
  /** West, south, east, and north of a tile the shapes were clipped to: its edges are cuts, not borders. */
  readonly clip?: readonly [number, number, number, number];
}

/**
 * A type's shapes prepared to draw: vertices relative to each row's origin, triangles and strips at
 * levels of detail, filed in a quadtree so a view draws any subtree as one range.
 */
export interface Shapes {
  readonly closed: boolean;
  readonly rows: number;
  /** Per row the point its vertices lie relative to, split for precision: high lon and lat, then low. */
  readonly origins: Float32Array;
  /** Per row its west, south, east, and north; NaN without a shape. */
  readonly bounds: Float32Array;
  /** Per row where a label sits: its largest area's pole of inaccessibility, or its longest line's middle. */
  readonly anchors: Float32Array;
  /** West, south, east, and north of every row. */
  readonly extent: readonly [number, number, number, number];
  /** Per vertex its x and y relative to its row's origin, and its row as a bit pattern: three words. */
  readonly vertices: Float32Array;
  /** The cut parts at full detail, which are the leading vertices: each part's first, then the count. */
  readonly parts: Uint32Array;
  /** Per piece, in the nodes' order: its row, first entry in `pieceParts`, and part count. */
  readonly pieces: Uint32Array;
  /** The parts of each piece: a polygon's outline then its holes, or a polyline. */
  readonly pieceParts: Uint32Array;
  /** Per piece its west, south, east, and north. */
  readonly pieceBounds: Float32Array;
  readonly levels: readonly ShapesLevel[];
  readonly nodes: ShapesNodes;
}
/** One level of detail: the triangles areas fill, and the strips lines draw. */
export interface ShapesLevel {
  /** The finest view this level draws faithfully, as the effective area it drops, in square degrees. */
  readonly tolerance: number;
  /** Vertex indices, three per triangle. */
  readonly triangles: Uint32Array;
  /** Vertex indices of each strip, each ending with `BREAK`. */
  readonly strips: Uint32Array;
  /** Per strip entry, how far along its strip it lies, in degrees of arc. */
  readonly along: Float32Array;
}
/** Cells of a longitude-latitude quadtree that hold pieces, and their ancestors, depth first. */
export interface ShapesNodes {
  /** Per node its depth, column, and row: three words. */
  readonly cells: Uint32Array;
  /** Per node the node after its subtree. */
  readonly next: Uint32Array;
  /** Per node its first piece, then the piece count. */
  readonly pieces: Uint32Array;
  /** Per level, per node its first triangle index, then the level's count. */
  readonly triangles: readonly Uint32Array[];
  /** Per level, per node its first strip entry, then the level's count. */
  readonly strips: readonly Uint32Array[];
}

/** Every typed array a set of shapes holds, to transfer it whole between threads. */
export function shapesBuffers(shapes: Shapes): ArrayBuffer[] {
  const arrays: ArrayBufferView[] = [
    shapes.origins,
    shapes.bounds,
    shapes.anchors,
    shapes.vertices,
    shapes.parts,
    shapes.pieces,
    shapes.pieceParts,
    shapes.pieceBounds,
    shapes.nodes.cells,
    shapes.nodes.next,
    shapes.nodes.pieces,
    ...shapes.nodes.triangles,
    ...shapes.nodes.strips,
    ...shapes.levels.flatMap((level) => [level.triangles, level.strips, level.along]),
  ];
  return [...new Set(arrays.map((array) => array.buffer as ArrayBuffer))];
}

/** A growing list of 32-bit words. */
export class Words {
  array: Uint32Array;
  length = 0;
  constructor(capacity = 256) {
    this.array = new Uint32Array(Math.max(16, Math.ceil(capacity)));
  }
  push(value: number): void {
    if (this.length === this.array.length) this.grow(this.length + 1);
    this.array[this.length++] = value;
  }
  grow(size: number): void {
    const next = new Uint32Array(Math.max(size, this.array.length * 2));
    next.set(this.array.subarray(0, this.length));
    this.array = next;
  }
  finish(): Uint32Array {
    return this.array.slice(0, this.length);
  }
}
/** A growing list of floats. */
export class Floats {
  array: Float32Array;
  length = 0;
  constructor(capacity = 256) {
    this.array = new Float32Array(Math.max(16, Math.ceil(capacity)));
  }
  push(value: number): void {
    if (this.length === this.array.length) {
      const next = new Float32Array(this.array.length * 2);
      next.set(this.array);
      this.array = next;
    }
    this.array[this.length++] = value;
  }
  finish(): Float32Array {
    return this.array.slice(0, this.length);
  }
}

/** Longitude wrapped into [-180, 180]. */
function wrap(x: number): number {
  return x >= -180 && x <= 180 ? x : ((((x + 180) % 360) + 360) % 360) - 180;
}
/** The parts with every longitude wrapped, every latitude clamped, and unfinite points dropped. */
function wrapped(input: ShapesInput): { coordinates: Float64Array; parts: Uint32Array } {
  const { coordinates, parts } = input,
    out = new Float64Array(coordinates.length),
    starts = new Uint32Array(parts.length);
  let n = 0;
  for (let p = 0; p + 1 < parts.length; p++) {
    starts[p] = n;
    for (let i = parts[p]; i < parts[p + 1]; i++) {
      const x = coordinates[2 * i],
        y = coordinates[2 * i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out[2 * n] = wrap(x);
      out[2 * n + 1] = Math.max(-90, Math.min(90, y));
      n++;
    }
  }
  starts[parts.length - 1] = n;
  return { coordinates: out.subarray(0, 2 * n), parts: starts };
}
/** The signed area of points `first` to `end` as a ring: positive counter-clockwise. */
function shoelace(xy: Float64Array, first: number, end: number): number {
  if (end - first < 3) return 0;
  const x0 = xy[2 * first],
    y0 = xy[2 * first + 1];
  let sum = 0;
  for (let i = first + 1; i < end - 1; i++)
    sum += (xy[2 * i] - x0) * (xy[2 * i + 3] - y0) - (xy[2 * i + 2] - x0) * (xy[2 * i + 1] - y0);
  return sum / 2;
}
/** Whether a point lies inside a ring, by the even-odd rule. */
function insideRing(xy: Float64Array, first: number, end: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = first, j = end - 1; i < end; j = i++) {
    const ax = xy[2 * i],
      ay = xy[2 * i + 1],
      bx = xy[2 * j],
      by = xy[2 * j + 1];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
/** Whether the edge between two points runs along the antimeridian or a pole: a cut, not a border. */
export function cutEdge(ax: number, ay: number, bx: number, by: number): boolean {
  return (Math.abs(ax) === 180 && ax === bx) || (Math.abs(ay) === 90 && ay === by);
}
/**
 * The arc between two points, in degrees: how far apart they lie on the globe. Points along a pole
 * are one point, however far apart their longitudes.
 */
function arc(ax: number, ay: number, bx: number, by: number): number {
  const s = Math.sin(((by - ay) * DEGREE) / 2),
    t = Math.sin(((bx - ax) * DEGREE) / 2),
    h = s * s + Math.cos(ay * DEGREE) * Math.cos(by * DEGREE) * t * t;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / DEGREE;
}
/** The point a fraction of the way along the great circle between two points. */
function slerp(ax: number, ay: number, bx: number, by: number, t: number): [number, number] {
  const la = ay * DEGREE,
    lb = by * DEGREE,
    oa = ax * DEGREE,
    ob = bx * DEGREE;
  const a = [Math.cos(la) * Math.cos(oa), Math.cos(la) * Math.sin(oa), Math.sin(la)],
    b = [Math.cos(lb) * Math.cos(ob), Math.cos(lb) * Math.sin(ob), Math.sin(lb)],
    dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])),
    angle = Math.acos(dot);
  if (angle < 1e-12) return [ax + (bx - ax) * t, ay + (by - ay) * t];
  const s = Math.sin(angle),
    wa = Math.sin((1 - t) * angle) / s,
    wb = Math.sin(t * angle) / s,
    p = [0, 1, 2].map((k) => a[k] * wa + b[k] * wb);
  return [Math.atan2(p[1], p[0]) / DEGREE, Math.atan2(p[2], Math.hypot(p[0], p[1])) / DEGREE];
}

/** Pieces of a type: polygons (an outline and its holes) or polylines, each of one row. */
interface Piece {
  readonly row: number;
  /** Its parts among the cut parts: a polygon's outline first. */
  readonly rings: readonly number[];
  readonly bounds: readonly [number, number, number, number];
}

/** Rows' rings grouped into polygons: an outline winds as the row's first ring does, a hole the other way. */
function polygons(cut: CutParts, cutRows: Uint32Array, firstSign: Float64Array): Piece[] {
  const { coordinates: xy, parts } = cut,
    pieces: Piece[] = [];
  let p = 0;
  while (p < cutRows.length) {
    const row = cutRows[p];
    let end = p;
    while (end < cutRows.length && cutRows[end] === row) end++;
    const outlines: number[] = [],
      holes: number[] = [];
    for (let r = p; r < end; r++) {
      const area = shoelace(xy, parts[r], parts[r + 1]);
      if (area === 0) continue;
      if (firstSign[row] === 0 || Math.sign(area) === firstSign[row]) outlines.push(r);
      else holes.push(r);
    }
    const owned = outlines.map((r) => [r]);
    for (const hole of holes) {
      const x = xy[2 * parts[hole]],
        y = xy[2 * parts[hole] + 1];
      let owner = outlines.length === 1 ? 0 : -1;
      for (let k = 0; owner < 0 && k < outlines.length; k++)
        if (insideRing(xy, parts[outlines[k]], parts[outlines[k] + 1], x, y)) owner = k;
      if (owner >= 0) owned[owner].push(hole);
    }
    for (const rings of owned) pieces.push({ row, rings, bounds: boundsOf(cut, rings) });
    p = end;
  }
  return pieces;
}
function boundsOf(cut: CutParts, rings: readonly number[]): [number, number, number, number] {
  const { coordinates: xy, parts } = cut;
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  for (const r of rings)
    for (let i = parts[r]; i < parts[r + 1]; i++) {
      const x = xy[2 * i],
        y = xy[2 * i + 1];
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  return [w, s, e, n];
}

/** A node's place in the quadtree as one number: cells above its depth, then its row and column. */
function cellKey(depth: number, x: number, y: number): number {
  return (4 ** depth - 1) / 3 + y * 2 ** depth + x;
}
/** The deepest cell whose loose bounds hold a piece: the one holding its center, at least as large. */
function cellOf(bounds: readonly number[]): [number, number, number] {
  const width = Math.max(bounds[2] - bounds[0], 1e-9),
    height = Math.max(bounds[3] - bounds[1], 1e-9),
    depth = Math.max(
      0,
      Math.min(MAX_DEPTH, Math.floor(Math.min(Math.log2(360 / width), Math.log2(180 / height)))),
    ),
    n = 2 ** depth,
    x = Math.min(n - 1, Math.max(0, Math.floor((((bounds[0] + bounds[2]) / 2 + 180) / 360) * n))),
    y = Math.min(n - 1, Math.max(0, Math.floor((((bounds[1] + bounds[3]) / 2 + 90) / 180) * n)));
  return [depth, x, y];
}
/** The nodes holding pieces and their ancestors, depth first, and the pieces in their nodes' order. */
function quadtree(pieces: readonly Piece[]): {
  readonly cells: Uint32Array;
  readonly next: Uint32Array;
  readonly order: Uint32Array;
  readonly firsts: Uint32Array;
} {
  const nodes = new Map<number, number[]>(),
    node = (depth: number, x: number, y: number) => {
      const key = cellKey(depth, x, y);
      let found = nodes.get(key);
      if (!found) nodes.set(key, (found = []));
      return found;
    };
  node(0, 0, 0);
  pieces.forEach((piece, i) => {
    let [depth, x, y] = cellOf(piece.bounds);
    node(depth, x, y).push(i);
    while (depth > 0) node(--depth, (x >>>= 1), (y >>>= 1));
  });
  const cells: number[] = [],
    next: number[] = [],
    order: number[] = [],
    firsts: number[] = [];
  const visit = (depth: number, x: number, y: number) => {
    const found = nodes.get(cellKey(depth, x, y));
    if (!found) return;
    const at = next.length;
    cells.push(depth, x, y);
    next.push(0);
    firsts.push(order.length);
    for (const piece of found) order.push(piece);
    if (depth < MAX_DEPTH) {
      visit(depth + 1, 2 * x, 2 * y);
      visit(depth + 1, 2 * x + 1, 2 * y);
      visit(depth + 1, 2 * x, 2 * y + 1);
      visit(depth + 1, 2 * x + 1, 2 * y + 1);
    }
    next[at] = next.length;
  };
  visit(0, 0, 0);
  firsts.push(order.length);
  return {
    cells: Uint32Array.from(cells),
    next: Uint32Array.from(next),
    order: Uint32Array.from(order),
    firsts: Uint32Array.from(firsts),
  };
}

/** Vertices as they grow: each a point relative to its row's origin, and its row; absolute too, while building. */
class Vertices {
  private words: Words;
  private floats: Float32Array;
  private absolute: Float64Array;
  constructor(
    capacity: number,
    private readonly origins: Float64Array,
  ) {
    this.words = new Words(capacity * 3);
    this.floats = new Float32Array(this.words.array.buffer);
    this.absolute = new Float64Array(Math.max(32, Math.ceil(capacity) * 2));
  }
  get count(): number {
    return this.words.length / 3;
  }
  add(x: number, y: number, row: number): number {
    const at = this.words.length,
      v = at / 3;
    if (at + 3 > this.words.array.length) {
      this.words.grow(at + 3);
      this.floats = new Float32Array(this.words.array.buffer);
    }
    if (2 * v + 2 > this.absolute.length) {
      const next = new Float64Array(this.absolute.length * 2);
      next.set(this.absolute);
      this.absolute = next;
    }
    this.floats[at] = x - this.origins[2 * row];
    this.floats[at + 1] = y - this.origins[2 * row + 1];
    this.words.array[at + 2] = row;
    this.words.length = at + 3;
    this.absolute[2 * v] = x;
    this.absolute[2 * v + 1] = y;
    return v;
  }
  x(v: number): number {
    return this.absolute[2 * v];
  }
  y(v: number): number {
    return this.absolute[2 * v + 1];
  }
  finish(): Float32Array {
    return new Float32Array(this.words.finish().buffer);
  }
}

/**
 * Prepare a type's shapes: cut at the antimeridian, simplified alike along shared borders, filled
 * and stroked at levels of detail, and filed in a quadtree.
 */
export function prepareShapes(input: ShapesInput): Shapes {
  const { closed, rowParts } = input,
    rows = rowParts.length - 1,
    source = wrapped(input),
    partRows = new Uint32Array(source.parts.length - 1);
  for (let r = 0; r < rows; r++) for (let p = rowParts[r]; p < rowParts[r + 1]; p++) partRows[p] = r;
  const cut = closed ? cutRings(source) : cutLines(source),
    { coordinates: xy, parts } = cut,
    points = parts[parts.length - 1],
    cutRows = Uint32Array.from(cut.from, (p) => partRows[p]);
  // Each row's outlines wind as the pieces of its first ring do: its outline, cut or not.
  const firstSign = new Float64Array(rows);
  if (closed)
    for (let p = 0; p < cutRows.length; p++) {
      const r = cutRows[p];
      if (firstSign[r] === 0 && cut.from[p] === rowParts[r])
        firstSign[r] = Math.sign(shoelace(xy, parts[p], parts[p + 1]));
    }
  // Rows' bounds and origins, over their cut points.
  const box = new Float64Array(rows * 4);
  for (let r = 0; r < rows; r++) box.set([Infinity, Infinity, -Infinity, -Infinity], r * 4);
  for (let p = 0; p < cutRows.length; p++) {
    const r = cutRows[p];
    for (let i = parts[p]; i < parts[p + 1]; i++) {
      const x = xy[2 * i],
        y = xy[2 * i + 1];
      if (x < box[r * 4]) box[r * 4] = x;
      if (y < box[r * 4 + 1]) box[r * 4 + 1] = y;
      if (x > box[r * 4 + 2]) box[r * 4 + 2] = x;
      if (y > box[r * 4 + 3]) box[r * 4 + 3] = y;
    }
  }
  const bounds = new Float32Array(rows * 4).fill(NaN),
    origin = new Float64Array(rows * 2),
    origins = new Float32Array(rows * 4),
    extent: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let r = 0; r < rows; r++) {
    if (!(box[r * 4] <= box[r * 4 + 2])) continue;
    for (let k = 0; k < 4; k++) bounds[r * 4 + k] = box[r * 4 + k];
    extent[0] = Math.min(extent[0], box[r * 4]);
    extent[1] = Math.min(extent[1], box[r * 4 + 1]);
    extent[2] = Math.max(extent[2], box[r * 4 + 2]);
    extent[3] = Math.max(extent[3], box[r * 4 + 3]);
    for (let k = 0; k < 2; k++) {
      const value = box[r * 4 + k],
        high = Math.fround(value),
        low = Math.fround(value - high);
      origins[r * 4 + k] = high;
      origins[r * 4 + 2 + k] = low;
      origin[r * 2 + k] = high + low;
    }
  }
  // Every cut point is a vertex, in order; levels add the points they densify and fill with.
  const vertices = new Vertices(points * 1.25 + 64, origin);
  for (let p = 0; p < cutRows.length; p++)
    for (let i = parts[p]; i < parts[p + 1]; i++) vertices.add(xy[2 * i], xy[2 * i + 1], cutRows[p]);
  const pieces: Piece[] = closed
    ? polygons(cut, cutRows, firstSign)
    : Array.from(cutRows, (row, p) => ({ row, rings: [p], bounds: boundsOf(cut, [p]) }));
  const tree = quadtree(pieces),
    full = input.detail === 'full',
    areas = full ? new Float64Array(points).fill(Infinity) : simplificationAreas(cut, closed);
  // Candidate levels keep points down to a sixteenth of the area of the one before. A level stays
  // only where the next it keeps holds several times its points, so levels cost little beside the
  // finest, which keeps every point.
  const kept: number[] = [];
  for (let k = 0; k < (full ? 0 : MAX_LEVELS); k++) {
    const tolerance = COARSEST / STEP ** k;
    let count = 0;
    for (let i = 0; i < points; i++) if (areas[i] > tolerance) count++;
    kept.push(count);
    if (count === points) break;
  }
  const tolerances: number[] = [];
  let last = points;
  for (let k = kept.length - 1; k >= 0; k--)
    if (kept[k] * GROWTH <= last) {
      tolerances.unshift(COARSEST / STEP ** k);
      last = kept[k];
    }
  tolerances.push(0);
  const clip = input.clip;
  const cuts = clip
    ? (ax: number, ay: number, bx: number, by: number) =>
        cutEdge(ax, ay, bx, by) ||
        (ax === bx && (ax === clip[0] || ax === clip[2])) ||
        (ay === by && (ay === clip[1] || ay === clip[3]))
    : cutEdge;
  const levels: ShapesLevel[] = [],
    nodeTriangles: Uint32Array[] = [],
    nodeStrips: Uint32Array[] = [],
    nodeCount = tree.next.length;
  let anchorLevel: Level | undefined;
  for (const tolerance of tolerances) {
    const level = new Level(
        cut,
        cutRows,
        areas,
        tolerance,
        vertices,
        input.geodesic === true,
        closed,
        cuts,
      ),
      triangles = new Words(),
      strips = new Words(),
      along = new Floats(),
      triangleStarts = new Uint32Array(nodeCount + 1),
      stripStarts = new Uint32Array(nodeCount + 1);
    for (let node = 0; node < nodeCount; node++) {
      triangleStarts[node] = triangles.length;
      stripStarts[node] = strips.length;
      for (let k = tree.firsts[node]; k < tree.firsts[node + 1]; k++) {
        const piece = pieces[tree.order[k]];
        if (level.tiny(piece)) continue;
        if (closed) level.fill(piece, triangles);
        for (const ring of piece.rings) level.stroke(ring, closed, strips, along);
      }
    }
    triangleStarts[nodeCount] = triangles.length;
    stripStarts[nodeCount] = strips.length;
    levels.push({
      tolerance,
      triangles: triangles.finish(),
      strips: strips.finish(),
      along: along.finish(),
    });
    nodeTriangles.push(triangleStarts);
    nodeStrips.push(stripStarts);
    // Labels sit by a level fine enough to follow every outline, yet quick to search.
    if (!anchorLevel || tolerance >= 1e-4) anchorLevel = level;
  }
  // Pieces in the nodes' order, for picking.
  const pieceTable = new Uint32Array(pieces.length * 3),
    pieceBounds = new Float32Array(pieces.length * 4),
    pieceParts = new Words(pieces.length + 16);
  tree.order.forEach((index, k) => {
    const piece = pieces[index];
    pieceTable.set([piece.row, pieceParts.length, piece.rings.length], k * 3);
    for (const ring of piece.rings) pieceParts.push(ring);
    pieceBounds.set(piece.bounds, k * 4);
  });
  return {
    closed,
    rows,
    origins,
    bounds,
    anchors: anchorsOf(pieces, rows, closed, anchorLevel!, cut),
    extent: extent[0] <= extent[2] ? extent : [0, 0, 0, 0],
    vertices: vertices.finish(),
    parts,
    pieces: pieceTable,
    pieceParts: pieceParts.finish(),
    pieceBounds,
    levels,
    nodes: {
      cells: tree.cells,
      next: tree.next,
      pieces: tree.firsts,
      triangles: nodeTriangles,
      strips: nodeStrips,
    },
  };
}

/** Where each row's label sits: in its largest polygon, or midway along its longest line. */
function anchorsOf(
  pieces: readonly Piece[],
  rows: number,
  closed: boolean,
  level: Level,
  cut: CutParts,
): Float32Array {
  const anchors = new Float32Array(rows * 2).fill(NaN),
    best = new Float64Array(rows).fill(-1),
    chosen = new Int32Array(rows).fill(-1);
  pieces.forEach((piece, i) => {
    const [w, s, e, n] = piece.bounds,
      size = closed
        ? Math.abs(shoelace(cut.coordinates, cut.parts[piece.rings[0]], cut.parts[piece.rings[0] + 1]))
        : Math.hypot(e - w, n - s);
    if (size > best[piece.row]) {
      best[piece.row] = size;
      chosen[piece.row] = i;
    }
  });
  for (let r = 0; r < rows; r++) {
    if (chosen[r] < 0) continue;
    const point = closed ? level.labelOf(pieces[chosen[r]]) : level.middleOf(pieces[chosen[r]]);
    if (point) anchors.set(point, r * 2);
  }
  return anchors;
}

/** One level of a type's shapes, built piece by piece. */
class Level {
  /** Each part's points at this level, densified: vertex indices, made once and shared. */
  private readonly rings = new Map<number, Uint32Array>();
  /** Pieces narrower than this many degrees fall under half a pixel at this level's views. */
  private readonly smallest: number;
  constructor(
    private readonly cut: CutParts,
    private readonly cutRows: Uint32Array,
    private readonly areas: Float64Array,
    private readonly tolerance: number,
    private readonly vertices: Vertices,
    private readonly geodesic: boolean,
    private readonly closed: boolean,
    /** Whether an edge is a cut, which strokes leave out. */
    private readonly cuts: (ax: number, ay: number, bx: number, by: number) => boolean,
  ) {
    this.smallest = Math.sqrt(tolerance / 2);
  }
  /** Whether a piece is too small to see at this level's views. */
  tiny(piece: Piece): boolean {
    const [w, s, e, n] = piece.bounds;
    return Math.max(e - w, n - s) < this.smallest;
  }
  /** A part's kept points, densified, as vertex indices. */
  ring(part: number): Uint32Array {
    let found = this.rings.get(part);
    if (found) return found;
    const { parts } = this.cut,
      first = parts[part],
      end = parts[part + 1],
      row = this.cutRows[part],
      out = new Words(end - first + 8),
      step = this.geodesic ? GEODESIC : DENSIFY;
    let last = -1,
      head = -1;
    for (let i = first; i < end; i++) {
      if (!(this.areas[i] > this.tolerance)) continue;
      if (last >= 0) this.densify(last, i, row, step, out);
      else head = i;
      out.push(i);
      last = i;
    }
    // A ring's closing edge bends too: its points come last, before the ring closes on its first.
    if (this.closed && head >= 0 && last !== head) this.densify(last, head, row, step, out);
    this.rings.set(part, (found = out.finish()));
    return found;
  }
  /** The points between two vertices on an edge too long to stay straight on the globe. */
  private densify(a: number, b: number, row: number, step: number, out: Words): void {
    const v = this.vertices,
      ax = v.x(a),
      ay = v.y(a),
      bx = v.x(b),
      by = v.y(b),
      length = arc(ax, ay, bx, by);
    // Cuts bend too, so the halves of a cut area meet on the globe; strokes leave them out.
    if (length <= step) return;
    const n = Math.ceil(length / step);
    // From the lesser end, so two rings sharing an edge place the same points.
    const forward = ax < bx || (ax === bx && ay < by),
      [px, py, qx, qy] = forward ? [ax, ay, bx, by] : [bx, by, ax, ay];
    for (let k = 1; k < n; k++) {
      const t = (forward ? k : n - k) / n,
        [x, y] = this.geodesic
          ? slerp(px, py, qx, qy, t)
          : [px + (qx - px) * t, py + (qy - py) * t];
      out.push(v.add(x, y, row));
    }
  }
  /** Fill a polygon: its rings at this level, triangulated, every long edge split. */
  fill(piece: Piece, out: Words): void {
    const flat: number[] = [],
      ids: number[] = [],
      holes: number[] = [],
      v = this.vertices;
    for (let k = 0; k < piece.rings.length; k++) {
      const ring = this.ring(piece.rings[k]);
      if (ring.length < 3) {
        if (k === 0) return;
        continue;
      }
      if (k > 0) holes.push(ids.length);
      for (const id of ring) {
        flat.push(v.x(id), v.y(id));
        ids.push(id);
      }
    }
    const triangles = earcut(flat, holes.length ? holes : undefined),
      [w, s, e, n] = piece.bounds;
    if (e - w <= SPLIT && n - s <= SPLIT) {
      for (const t of triangles) out.push(ids[t]);
      return;
    }
    for (const id of this.refine(Array.from(triangles, (t) => ids[t]), piece.row)) out.push(id);
  }
  /**
   * Triangles whose edges all span at most `SPLIT` degrees, so none cuts beneath the globe: each
   * longer edge splits at its middle, the same point for both triangles that share it, until none
   * is left. Outlines are densified finer already, so only inner edges split and no crack opens.
   */
  private refine(triangles: number[], row: number): number[] {
    const v = this.vertices,
      middles = new Map<number, number>(),
      key = (a: number, b: number) => (a < b ? a * 0x100000000 + b : b * 0x100000000 + a),
      length = (a: number, b: number) => arc(v.x(a), v.y(a), v.x(b), v.y(b)),
      middle = (a: number, b: number) => {
        const k = key(a, b);
        let m = middles.get(k);
        if (m === undefined)
          middles.set(k, (m = v.add((v.x(a) + v.x(b)) / 2, (v.y(a) + v.y(b)) / 2, row)));
        return m;
      };
    let current = triangles;
    for (let pass = 0; pass < 16; pass++) {
      // Each triangle too long marks its longest edge alone; both triangles on a marked edge split
      // it, so no crack opens, and slivers split along their length rather than across.
      const marked = new Set<number>();
      for (let t = 0; t < current.length; t += 3) {
        const a = current[t],
          b = current[t + 1],
          c = current[t + 2],
          ab = length(a, b),
          bc = length(b, c),
          ca = length(c, a),
          longest = Math.max(ab, bc, ca);
        if (longest <= SPLIT) continue;
        marked.add(longest === ab ? key(a, b) : longest === bc ? key(b, c) : key(c, a));
      }
      if (!marked.size) break;
      const next: number[] = [];
      for (let t = 0; t < current.length; t += 3) {
        const a = current[t],
          b = current[t + 1],
          c = current[t + 2],
          ab = marked.has(key(a, b)),
          bc = marked.has(key(b, c)),
          ca = marked.has(key(c, a));
        if (!ab && !bc && !ca) {
          next.push(a, b, c);
          continue;
        }
        const mab = ab ? middle(a, b) : -1,
          mbc = bc ? middle(b, c) : -1,
          mca = ca ? middle(c, a) : -1;
        if (ab && bc && ca) next.push(a, mab, mca, mab, b, mbc, mca, mbc, c, mab, mbc, mca);
        else if (ab && bc) next.push(a, mab, c, mab, b, mbc, mab, mbc, c);
        else if (bc && ca) next.push(a, b, mbc, a, mbc, mca, mca, mbc, c);
        else if (ca && ab) next.push(a, mab, mca, mab, b, c, mab, c, mca);
        else if (ab) next.push(a, mab, c, mab, b, c);
        else if (bc) next.push(a, b, mbc, a, mbc, c);
        else next.push(a, b, mca, mca, b, c);
      }
      current = next;
    }
    return current;
  }
  /** Stroke a ring or polyline: its strip, broken where it runs along a cut. */
  stroke(part: number, closed: boolean, strips: Words, along: Floats): void {
    const ring = this.ring(part),
      v = this.vertices;
    if (ring.length < 2) return;
    const count = closed ? ring.length + 1 : ring.length;
    let run = 0,
      distance = 0,
      px = 0,
      py = 0;
    for (let k = 0; k < count; k++) {
      const id = ring[k % ring.length],
        x = v.x(id),
        y = v.y(id);
      if (run > 0 && this.cuts(px, py, x, y)) {
        this.end(run, strips, along);
        run = 0;
      }
      if (run > 0) distance += Math.hypot((x - px) * Math.cos(((y + py) / 2) * DEGREE), y - py);
      else distance = 0;
      strips.push(id);
      along.push(distance);
      run++;
      px = x;
      py = y;
    }
    this.end(run, strips, along);
  }
  /** End a strip; a run of one point draws nothing, and is dropped. */
  private end(run: number, strips: Words, along: Floats): void {
    if (run === 0) return;
    if (run === 1) {
      strips.length--;
      along.length--;
      return;
    }
    strips.push(BREAK);
    along.push(0);
  }
  /** A polygon's pole of inaccessibility at this level. */
  labelOf(piece: Piece): readonly [number, number] | null {
    const v = this.vertices,
      coordinates: number[] = [],
      starts: number[] = [];
    for (const part of piece.rings) {
      const ring = this.ring(part);
      if (ring.length < 3) continue;
      starts.push(coordinates.length / 2);
      for (const id of ring) coordinates.push(v.x(id), v.y(id));
    }
    if (!starts.length) return null;
    starts.push(coordinates.length / 2);
    const [w, s, e, n] = piece.bounds;
    return labelPoint(
      { coordinates: Float64Array.from(coordinates), parts: Uint32Array.from(starts) },
      0,
      starts.length - 1,
      Math.max(Math.max(e - w, n - s) / 100, 1e-7),
    );
  }
  /** The point halfway along a polyline at this level. */
  middleOf(piece: Piece): readonly [number, number] | null {
    const ring = this.ring(piece.rings[0]),
      v = this.vertices;
    if (!ring.length) return null;
    let total = 0;
    for (let k = 1; k < ring.length; k++)
      total += Math.hypot(v.x(ring[k]) - v.x(ring[k - 1]), v.y(ring[k]) - v.y(ring[k - 1]));
    let walked = 0;
    for (let k = 1; k < ring.length; k++) {
      const step = Math.hypot(v.x(ring[k]) - v.x(ring[k - 1]), v.y(ring[k]) - v.y(ring[k - 1]));
      if (walked + step >= total / 2 && step > 0) {
        const t = (total / 2 - walked) / step;
        return [
          v.x(ring[k - 1]) + (v.x(ring[k]) - v.x(ring[k - 1])) * t,
          v.y(ring[k - 1]) + (v.y(ring[k]) - v.y(ring[k - 1])) * t,
        ];
      }
      walked += step;
    }
    return [v.x(ring[0]), v.y(ring[0])];
  }
}
