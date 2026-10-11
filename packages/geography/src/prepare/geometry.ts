import { failure } from '@latkit/model';
import earcut from 'earcut';
import { Heap } from './heap.js';

/** Polylines or rings: x, y pairs, with the first pair of each part followed by the total pair count. */
export interface Parts {
  readonly coordinates: Float64Array;
  readonly parts: Uint32Array;
}
/** Cut parts, and for each the input part it came from. */
export interface CutParts extends Parts {
  readonly from: Uint32Array;
}

/** Polylines cut where they cross the antimeridian (consecutive longitudes more than 180° apart), each cut ending exactly at ±180 with the crossing latitude interpolated. */
export function cutLines(lines: Parts): CutParts {
  const count = checkParts(lines),
    { coordinates: xy, parts } = lines,
    out = new Builder(count + 16, parts.length + 16);
  for (let p = 0; p + 1 < parts.length; p++) {
    const first = parts[p],
      end = parts[p + 1];
    out.source = p;
    if (!crosses(xy, first, end, false)) {
      out.copy(xy, first, end);
      continue;
    }
    out.point(xy[2 * first], xy[2 * first + 1]);
    for (let i = first + 1; i < end; i++) {
      const direction = crossing(xy, i - 1, i);
      if (direction !== 0) {
        const y = crossingLatitude(xy, i - 1, i, direction);
        out.point(180 * direction, y);
        out.end(2, false);
        out.point(-180 * direction, y);
      }
      out.point(xy[2 * i], xy[2 * i + 1]);
    }
    out.end(2, false);
  }
  return out.finish();
}

/** Rings cut at the antimeridian into closed pieces on each side, the cut edges running along ±180; rings that do not cross are returned as they are. Polygons covering a pole (e.g. Antarctica, where the ring wraps the whole longitude range) close along the pole latitude (±90) instead. */
export function cutRings(rings: Parts): CutParts {
  const count = checkParts(rings),
    { coordinates: xy, parts } = rings,
    out = new Builder(count + 64, parts.length + 16),
    chains = new Chains();
  for (let p = 0; p + 1 < parts.length; p++) {
    const first = parts[p],
      end = parts[p + 1];
    out.source = p;
    if (end - first < 2 || !crosses(xy, first, end, true)) out.copy(xy, first, end);
    else cutRing(xy, first, end, chains, out);
  }
  return out.finish();
}

/**
 * Topology-preserving simplification levels. Points shared by several parts (by exact coordinates)
 * split parts into arcs; each distinct arc (an arc and its reverse are the same arc) is ranked once
 * with Visvalingam–Whyatt effective area, so neighboring rings simplify identically along shared
 * borders and never crack. Endpoints of arcs (junctions) and the endpoints of open polylines are
 * always kept; a ring keeps at least 3 points (its largest-area points) at every level.
 * Returns, per point of the input, the area at which it disappears (Infinity for kept-forever
 * points), in squared degrees. A level with tolerance t keeps the points whose area exceeds t.
 */
export function simplificationAreas(parts: Parts, closed: boolean): Float64Array {
  const count = checkParts(parts),
    { coordinates: xy, parts: starts } = parts,
    ids = coordinateIds(xy, count),
    junction = junctions(ids, starts, closed),
    byId = new Float64Array(count).fill(-1);
  for (let i = 0; i < count; i++) if (junction[ids[i]]) byId[ids[i]] = Infinity;
  const ranker = new Ranker(xy, ids, byId);
  for (let p = 0; p + 1 < starts.length; p++)
    rankPart(starts[p], starts[p + 1], ids, junction, closed, ranker);
  if (closed)
    for (let p = 0; p + 1 < starts.length; p++) keepThree(starts[p], starts[p + 1], ids, byId);
  const areas = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const area = byId[ids[i]];
    areas[i] = area < 0 ? Infinity : area;
  }
  return areas;
}

/** The parts with only the points whose area exceeds `tolerance`, dropping parts left with fewer than 2 points (lines) or 3 (rings). Also returns, per output point, its index in the input. */
export function simplified(
  parts: Parts,
  areas: Float64Array,
  tolerance: number,
  closed: boolean,
): Parts & { readonly source: Uint32Array } {
  const count = checkParts(parts),
    { coordinates: xy, parts: starts } = parts,
    minimum = closed ? 3 : 2;
  if (areas.length !== count)
    throw failure('invalid-input', `Expected ${count} areas, one per point, not ${areas.length}.`);
  let points = 0,
    kept = 0;
  for (let p = 0; p + 1 < starts.length; p++) {
    const k = keptIn(areas, starts[p], starts[p + 1], tolerance);
    if (k < minimum) continue;
    points += k;
    kept++;
  }
  const coordinates = new Float64Array(2 * points),
    outStarts = new Uint32Array(kept + 1),
    source = new Uint32Array(points);
  let n = 0,
    part = 0;
  for (let p = 0; p + 1 < starts.length; p++) {
    const first = starts[p],
      end = starts[p + 1];
    if (keptIn(areas, first, end, tolerance) < minimum) continue;
    outStarts[part++] = n;
    for (let i = first; i < end; i++) {
      if (!(areas[i] > tolerance)) continue;
      coordinates[2 * n] = xy[2 * i];
      coordinates[2 * n + 1] = xy[2 * i + 1];
      source[n++] = i;
    }
  }
  outStarts[part] = n;
  return { coordinates, parts: outStarts, source };
}

/** Triangles of one polygon (outer ring then holes) as indices into its own points, via earcut; empty for degenerate input. */
export function triangulate(polygon: Parts, first: number, count: number): Uint32Array {
  checkRange(polygon, first, count);
  if (count === 0) return new Uint32Array(0);
  const { coordinates, parts } = polygon,
    start = parts[first],
    holes: number[] = [];
  for (let r = first + 1; r < first + count; r++) holes.push(parts[r] - start);
  const points = coordinates.subarray(2 * start, 2 * parts[first + count]);
  return Uint32Array.from(earcut(points, holes.length > 0 ? holes : null));
}

/** Rings grouped into polygons: each counter-clockwise (positive area) ring starts a polygon, and clockwise rings that follow are its holes. Returns per polygon the index of its first ring and, after the last, the ring count. */
export function polygonsOf(rings: Parts): Uint32Array {
  checkParts(rings);
  const { coordinates: xy, parts } = rings,
    ringCount = parts.length - 1,
    firsts: number[] = [];
  for (let r = 0; r < ringCount; r++)
    if (r === 0 || shoelace(xy, parts[r], parts[r + 1]) > 0) firsts.push(r);
  firsts.push(ringCount);
  return Uint32Array.from(firsts);
}

/** The signed shoelace area of a part (positive counter-clockwise, y up). */
export function ringArea(parts: Parts, part: number): number {
  checkRange(parts, part, 1);
  return shoelace(parts.coordinates, parts.parts[part], parts.parts[part + 1]);
}

/** The pole of inaccessibility of a polygon (Mapbox polylabel's algorithm), for placing its label: within `precision` degrees. */
export function labelPoint(
  polygon: Parts,
  first: number,
  count: number,
  precision: number,
): readonly [number, number] {
  checkRange(polygon, first, count);
  if (!(precision > 0) || !Number.isFinite(precision))
    throw failure('invalid-input', `Label precision must be a positive number, not ${precision}.`);
  const { coordinates: xy, parts } = polygon;
  if (count === 0 || parts[first + 1] === parts[first])
    throw failure('invalid-input', 'A polygon needs an outer ring with points.');
  const shape: Shape = { xy, parts, first, count };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = parts[first]; i < parts[first + 1]; i++) {
    minX = Math.min(minX, xy[2 * i]);
    maxX = Math.max(maxX, xy[2 * i]);
    minY = Math.min(minY, xy[2 * i + 1]);
    maxY = Math.max(maxY, xy[2 * i + 1]);
  }
  const width = maxX - minX,
    height = maxY - minY,
    size = Math.min(width, height),
    centroid = centroidCell(shape),
    middle = cellAt(shape, minX + width / 2, minY + height / 2, 0);
  let best = middle.d > centroid.d ? middle : centroid;
  if (size <= precision) return [best.x, best.y];
  const cells: Cell[] = [],
    queue = new Heap(16, () => false),
    probe = (x: number, y: number, h: number) => {
      const cell = cellAt(shape, x, y, h);
      if (cell.max > best.d + precision) queue.push(cells.push(cell) - 1, -cell.max);
      if (cell.d > best.d) best = cell;
    };
  const half = size / 2;
  for (let x = minX; x < maxX; x += size)
    for (let y = minY; y < maxY; y += size) probe(x + half, y + half, half);
  while (queue.size > 0) {
    const cell = cells[queue.pop()];
    if (cell.max - best.d <= precision) break;
    const h = cell.h / 2;
    probe(cell.x - h, cell.y - h, h);
    probe(cell.x + h, cell.y - h, h);
    probe(cell.x - h, cell.y + h, h);
    probe(cell.x + h, cell.y + h, h);
  }
  return [best.x, best.y];
}

/** The pair count of well-formed parts; throws invalid-input otherwise. */
function checkParts({ coordinates, parts }: Parts): number {
  if (coordinates.length % 2 !== 0)
    throw failure('invalid-input', 'Coordinates must be x, y pairs.');
  const count = coordinates.length / 2;
  if (parts.length === 0 || parts[0] !== 0 || parts[parts.length - 1] !== count)
    throw failure('invalid-input', `Parts must start at 0 and end at the pair count, ${count}.`);
  for (let i = 1; i < parts.length; i++)
    if (parts[i] < parts[i - 1])
      throw failure('invalid-input', `Parts must ascend; part ${i} does not.`);
  return count;
}

/** Throws invalid-input unless parts `first` to `first + count` exist, ascend, and lie within the coordinates. */
function checkRange({ coordinates, parts }: Parts, first: number, count: number): void {
  const last = first + count;
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(count) ||
    first < 0 ||
    count < 0 ||
    last >= parts.length
  )
    throw failure('invalid-input', `Parts ${first} to ${last} are out of range.`);
  for (let r = first; r < last; r++)
    if (parts[r + 1] < parts[r])
      throw failure('invalid-input', `Parts must ascend; part ${r + 1} does not.`);
  if (2 * parts[last] > coordinates.length)
    throw failure('invalid-input', `Part ${last} ends past the coordinates.`);
}

/** Parts written point by point into buffers that grow, skipping a point that repeats the last. */
class Builder {
  /** The input part the parts ended next come from. */
  source = 0;
  private xy: Float64Array;
  private starts: Uint32Array;
  private sources: Uint32Array;
  private points = 0;
  private ended = 0;

  constructor(points: number, parts: number) {
    this.xy = new Float64Array(2 * Math.max(points, 4));
    this.starts = new Uint32Array(Math.max(parts, 1) + 1);
    this.sources = new Uint32Array(Math.max(parts, 1));
  }

  /** Appends a point to the open part unless it repeats the last one. */
  point(x: number, y: number): void {
    const n = this.points;
    if (n > this.starts[this.ended] && this.xy[2 * n - 2] === x && this.xy[2 * n - 1] === y) return;
    if (2 * n + 2 > this.xy.length) this.grow(n + 1);
    this.xy[2 * n] = x;
    this.xy[2 * n + 1] = y;
    this.points = n + 1;
  }

  /** Appends points `first` to `end` of `source` as one part, as they are. */
  copy(source: Float64Array, first: number, end: number): void {
    const n = this.points + end - first;
    if (2 * n > this.xy.length) this.grow(n);
    this.xy.set(source.subarray(2 * first, 2 * end), 2 * this.points);
    this.points = n;
    this.close();
  }

  /** Ends the open part, dropping it with fewer than `minimum` points; a ring also drops a repeat of its first point, and drops itself with no area. */
  end(minimum: number, ring: boolean): void {
    const xy = this.xy,
      first = this.starts[this.ended];
    let n = this.points;
    if (
      ring &&
      n - first > 1 &&
      xy[2 * first] === xy[2 * n - 2] &&
      xy[2 * first + 1] === xy[2 * n - 1]
    )
      n--;
    this.points = n;
    if (n - first < minimum || (ring && shoelace(xy, first, n) === 0)) this.points = first;
    else this.close();
  }

  finish(): CutParts {
    const points = this.starts[this.ended];
    return {
      coordinates: this.xy.slice(0, 2 * points),
      parts: this.starts.slice(0, this.ended + 1),
      from: this.sources.slice(0, this.ended),
    };
  }

  private close(): void {
    if (this.ended + 1 >= this.starts.length) {
      const starts = new Uint32Array(2 * this.starts.length),
        sources = new Uint32Array(2 * this.starts.length);
      starts.set(this.starts);
      sources.set(this.sources);
      this.starts = starts;
      this.sources = sources;
    }
    this.sources[this.ended] = this.source;
    this.starts[++this.ended] = this.points;
  }

  private grow(points: number): void {
    const xy = new Float64Array(2 * Math.max(points, 2 * this.points));
    xy.set(this.xy.subarray(0, 2 * this.points));
    this.xy = xy;
  }
}

/** The signed area of points `first` to `end`, as a closed ring. */
function shoelace(xy: Float64Array, first: number, end: number): number {
  if (end - first < 3) return 0;
  const x0 = xy[2 * first],
    y0 = xy[2 * first + 1];
  let sum = 0;
  for (let i = first + 1; i < end - 1; i++)
    sum += (xy[2 * i] - x0) * (xy[2 * i + 3] - y0) - (xy[2 * i + 2] - x0) * (xy[2 * i + 1] - y0);
  return sum / 2;
}

/** Whether the step from point `a` to point `b` crosses the antimeridian: 1 eastward (from +180 to −180), −1 westward, 0 not. */
function crossing(xy: Float64Array, a: number, b: number): number {
  const step = xy[2 * b] - xy[2 * a];
  return step < -180 ? 1 : step > 180 ? -1 : 0;
}

/** The latitude where the step from point `a` to point `b` meets the antimeridian, crossing in `direction`. */
function crossingLatitude(xy: Float64Array, a: number, b: number, direction: number): number {
  const x0 = xy[2 * a],
    y0 = xy[2 * a + 1],
    y1 = xy[2 * b + 1],
    span = xy[2 * b] + 360 * direction - x0,
    t = span === 0 ? 0 : (180 * direction - x0) / span;
  return t <= 0 ? y0 : t >= 1 ? y1 : y0 + t * (y1 - y0);
}

/** Whether points `first` to `end` cross the antimeridian, counting the closing step of a ring. */
function crosses(xy: Float64Array, first: number, end: number, ring: boolean): boolean {
  for (let i = first + 1; i < end; i++) if (crossing(xy, i - 1, i) !== 0) return true;
  return ring && end - first > 1 && crossing(xy, end - 1, first) !== 0;
}

/**
 * Whether a crossing ring encloses the region on its left. A ring that comes back to its start
 * longitude encloses its left when counter-clockwise; one that wraps the globe encloses the nearer
 * pole, which lies on its left when it wraps eastward around the north or westward around the south.
 */
function regionOnLeft(xy: Float64Array, first: number, end: number): boolean {
  const n = end - first,
    x0 = xy[2 * first],
    y0 = xy[2 * first + 1];
  let shift = 0,
    twiceArea = 0,
    u = 0,
    v = 0,
    latitudes = 0;
  for (let i = 0; i < n; i++) {
    const a = first + i,
      b = first + ((i + 1) % n);
    shift += 360 * crossing(xy, a, b);
    const nextU = xy[2 * b] + shift - x0,
      nextV = xy[2 * b + 1] - y0;
    twiceArea += u * nextV - nextU * v;
    u = nextU;
    v = nextV;
    latitudes += xy[2 * a + 1];
  }
  if (shift === 0) return twiceArea >= 0;
  const eastward = shift > 0,
    north = latitudes >= 0;
  return eastward === north;
}

/** The pieces of one ring between antimeridian crossings, each from its entry point to its exit point. */
class Chains {
  xy = new Float64Array(256);
  points = 0;
  /** The first point of each chain. */
  readonly starts: number[] = [];
  /** Where each chain enters along the map boundary. */
  readonly entries: number[] = [];
  /** Where each chain exits along the map boundary. */
  readonly exits: number[] = [];

  clear(): void {
    this.points = 0;
    this.starts.length = this.entries.length = this.exits.length = 0;
  }

  begin(x: number, y: number, clockwise: boolean): void {
    this.starts.push(this.points);
    this.entries.push(perimeter(x, y, clockwise));
    this.point(x, y);
  }

  point(x: number, y: number): void {
    if (2 * this.points + 2 > this.xy.length) {
      const xy = new Float64Array(2 * this.xy.length);
      xy.set(this.xy);
      this.xy = xy;
    }
    this.xy[2 * this.points] = x;
    this.xy[2 * this.points + 1] = y;
    this.points++;
  }

  finish(x: number, y: number, clockwise: boolean): void {
    this.point(x, y);
    this.exits.push(perimeter(x, y, clockwise));
  }

  /** The point after the last of chain `c`. */
  end(c: number): number {
    return c + 1 < this.starts.length ? this.starts[c + 1] : this.points;
  }
}

/** Where a point on the antimeridian lies along the boundary of the map rectangle: counter-clockwise from (−180, −90) over a perimeter of 1080, or clockwise when `clockwise`. */
function perimeter(x: number, y: number, clockwise: boolean): number {
  const position = (x > 0 ? 450 + y : 990 - y) % 1080;
  return clockwise ? (1080 - position) % 1080 : position;
}

/** The corners of the map rectangle as (perimeter position, x, y), in counter-clockwise order. */
const COUNTER_CLOCKWISE_CORNERS = [0, -180, -90, 360, 180, -90, 540, 180, 90, 900, -180, 90];
/** The corners of the map rectangle as (perimeter position, x, y), in clockwise order. */
const CLOCKWISE_CORNERS = [0, -180, -90, 180, -180, 90, 540, 180, 90, 720, 180, -90];

/** Cuts one ring that crosses the antimeridian into chains, then joins them into closed pieces. */
function cutRing(xy: Float64Array, first: number, end: number, chains: Chains, out: Builder): void {
  const n = end - first,
    clockwise = !regionOnLeft(xy, first, end),
    at = (i: number) => first + (i % n);
  let c = 0;
  while (crossing(xy, at(c), at(c + 1)) === 0) c++;
  chains.clear();
  const direction = crossing(xy, at(c), at(c + 1));
  chains.begin(-180 * direction, crossingLatitude(xy, at(c), at(c + 1), direction), clockwise);
  for (let step = 1; step <= n; step++) {
    const a = at(c + step),
      b = at(c + step + 1),
      direction = crossing(xy, a, b);
    chains.point(xy[2 * a], xy[2 * a + 1]);
    if (direction === 0) continue;
    const y = crossingLatitude(xy, a, b, direction);
    chains.finish(180 * direction, y, clockwise);
    if (step < n) chains.begin(-180 * direction, y, clockwise);
  }
  rejoin(chains, clockwise, out);
}

/**
 * Joins chains into closed pieces: from each chain's exit, the boundary of the map rectangle is
 * walked in the ring's direction to the next chain's entry, passing any corners on the way.
 */
function rejoin(chains: Chains, clockwise: boolean, out: Builder): void {
  const { entries, exits } = chains,
    count = entries.length,
    order = Array.from({ length: count }, (_, i) => i).sort((a, b) => entries[a] - entries[b]),
    used = new Uint8Array(count),
    corners = clockwise ? CLOCKWISE_CORNERS : COUNTER_CLOCKWISE_CORNERS;
  for (let start = 0; start < count; start++) {
    if (used[start]) continue;
    let c = start;
    for (;;) {
      used[c] = 1;
      for (let i = chains.starts[c]; i < chains.end(c); i++)
        out.point(chains.xy[2 * i], chains.xy[2 * i + 1]);
      const next = nextEntry(order, entries, exits[c]);
      walk(exits[c], entries[next], corners, out);
      if (next === start || used[next]) break;
      c = next;
    }
    out.end(3, true);
  }
}

/** The chain whose entry comes first at or after boundary position `position`, wrapping around. */
function nextEntry(order: readonly number[], entries: readonly number[], position: number): number {
  let low = 0,
    high = order.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (entries[order[middle]] < position) low = middle + 1;
    else high = middle;
  }
  return order[low === order.length ? 0 : low];
}

/** Appends the corners passed walking the map boundary from position `from` to position `to`. */
function walk(from: number, to: number, corners: readonly number[], out: Builder): void {
  const span = (to - from + 1080) % 1080;
  let next = 0;
  while (next < 4 && corners[3 * next] <= from) next++;
  for (let k = 0; k < 4; k++) {
    const corner = 3 * ((next + k) % 4),
      offset = (corners[corner] - from + 1080) % 1080 || 1080;
    if (offset >= span) return;
    out.point(corners[corner + 1], corners[corner + 2]);
  }
}

/** Per point, the index of the first point with the same coordinates, found by hashing. */
function coordinateIds(xy: Float64Array, count: number): Int32Array {
  const ids = new Int32Array(count),
    bits = new Uint32Array(xy.buffer, xy.byteOffset, 2 * xy.length);
  let size = 2;
  while (size < 2 * count) size *= 2;
  const table = new Int32Array(size).fill(-1),
    mask = size - 1;
  for (let i = 0; i < count; i++) {
    const x = xy[2 * i],
      y = xy[2 * i + 1];
    // −0 and 0 are the same coordinate, so both hash as 0.
    let slot =
      hashWords(
        x === 0 ? 0 : bits[4 * i],
        x === 0 ? 0 : bits[4 * i + 1],
        y === 0 ? 0 : bits[4 * i + 2],
        y === 0 ? 0 : bits[4 * i + 3],
      ) & mask;
    for (;;) {
      const j = table[slot];
      if (j < 0) {
        table[slot] = ids[i] = i;
        break;
      }
      if (xy[2 * j] === x && xy[2 * j + 1] === y) {
        ids[i] = j;
        break;
      }
      slot = (slot + 1) & mask;
    }
  }
  return ids;
}

/** A 32-bit hash of four words (MurmurHash3's mixing). */
function hashWords(a: number, b: number, c: number, d: number): number {
  let h = mix(mix(mix(mix(0x9747b28c, a), b), c), d) ^ 16;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function mix(h: number, word: number): number {
  let k = Math.imul(word, 0xcc9e2d51);
  k = Math.imul((k << 15) | (k >>> 17), 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/**
 * Per coordinate id, whether it is a junction: an endpoint of an open polyline, or a point whose
 * neighbors differ between its occurrences, so a shared border starts, ends, or branches there.
 */
function junctions(ids: Int32Array, starts: Uint32Array, closed: boolean): Uint8Array {
  const count = ids.length,
    junction = new Uint8Array(count),
    before = new Int32Array(count).fill(-1),
    after = new Int32Array(count);
  for (let p = 0; p + 1 < starts.length; p++) {
    const first = starts[p],
      end = starts[p + 1];
    for (let i = first; i < end; i++) {
      const id = ids[i];
      if (junction[id]) continue;
      if (!closed && (i === first || i === end - 1)) {
        junction[id] = 1;
        continue;
      }
      const previous = ids[i === first ? end - 1 : i - 1],
        next = ids[i === end - 1 ? first : i + 1];
      if (before[id] < 0) {
        before[id] = previous;
        after[id] = next;
      } else if (
        !(before[id] === previous && after[id] === next) &&
        !(before[id] === next && after[id] === previous)
      )
        junction[id] = 1;
    }
  }
  return junction;
}

/** Ranks the arcs of one part that no earlier occurrence ranked: between junctions, or the whole ring when it has none. */
function rankPart(
  first: number,
  end: number,
  ids: Int32Array,
  junction: Uint8Array,
  closed: boolean,
  ranker: Ranker,
): void {
  const n = end - first;
  let j = first;
  while (j < end && !junction[ids[j]]) j++;
  if (j === end) {
    if (closed && n > 0) ranker.ring(first, end);
    return;
  }
  const steps = closed ? n : end - 1 - j;
  ranker.begin(j);
  for (let t = 1; t <= steps; t++) {
    const i = first + ((j - first + t) % n);
    ranker.add(i);
    if (junction[ids[i]]) {
      ranker.arc();
      ranker.begin(i);
    }
  }
}

/**
 * Visvalingam–Whyatt over one arc at a time, writing each point's effective area by coordinate id.
 * A removed point raises its neighbors' areas to at least its own, so areas only grow as points go.
 * Ties break by coordinates, so an arc and its reverse rank the same.
 */
class Ranker {
  private points = new Int32Array(64);
  private previous = new Int32Array(64);
  private next = new Int32Array(64);
  private area = new Float64Array(64);
  private length = 0;
  private readonly heap = new Heap(64, (a, b) => this.westOrSouth(a, b));

  constructor(
    private readonly xy: Float64Array,
    private readonly ids: Int32Array,
    private readonly byId: Float64Array,
  ) {}

  /** Starts an arc at junction `point`. */
  begin(point: number): void {
    this.length = 0;
    this.add(point);
  }

  add(point: number): void {
    if (this.length === this.points.length) this.grow();
    this.points[this.length++] = point;
  }

  /** Ranks the interior of the arc between its fixed ends, unless an earlier occurrence did. */
  arc(): void {
    const { points, previous, next, area, ids, byId, heap } = this,
      last = this.length - 1;
    if (last < 2 || byId[ids[points[1]]] >= 0) return;
    for (let k = 0; k <= last; k++) {
      previous[k] = k - 1;
      next[k] = k + 1;
    }
    heap.clear();
    for (let k = 1; k < last; k++) {
      area[k] = this.triangle(k - 1, k, k + 1);
      heap.push(k, area[k]);
    }
    while (heap.size > 0) this.remove(heap.pop(), 1, last);
    for (let k = 1; k < last; k++) byId[ids[points[k]]] = area[k];
  }

  /** Ranks a ring with no junctions as a closed sequence, keeping its last three points. */
  ring(first: number, end: number): void {
    const n = end - first;
    if (this.byId[this.ids[first]] >= 0) return;
    while (this.points.length < n) this.grow();
    const { points, previous, next, area, ids, byId, heap } = this;
    for (let k = 0; k < n; k++) points[k] = first + k;
    this.length = n;
    if (n <= 3) {
      for (let k = 0; k < n; k++) byId[ids[points[k]]] = Infinity;
      return;
    }
    for (let k = 0; k < n; k++) {
      previous[k] = (k + n - 1) % n;
      next[k] = (k + 1) % n;
    }
    heap.clear();
    for (let k = 0; k < n; k++) {
      area[k] = this.triangle(previous[k], k, next[k]);
      heap.push(k, area[k]);
    }
    while (heap.size > 3) this.remove(heap.pop(), 0, n);
    while (heap.size > 0) area[heap.pop()] = Infinity;
    for (let k = 0; k < n; k++) byId[ids[points[k]]] = area[k];
  }

  /** Unlinks point `k`, whose area is now final, and re-ranks its neighbors from `low` up to before `high`, raised to at least its area. */
  private remove(k: number, low: number, high: number): void {
    const { previous, next, area, heap } = this,
      p = previous[k],
      q = next[k];
    next[p] = q;
    previous[q] = p;
    if (p >= low && p < high) {
      area[p] = Math.max(area[k], this.triangle(previous[p], p, q));
      heap.update(p, area[p]);
    }
    if (q >= low && q < high) {
      area[q] = Math.max(area[k], this.triangle(p, q, next[q]));
      heap.update(q, area[q]);
    }
  }

  /** The area of the triangle of arc points a, b, c; exactly the same for c, b, a. */
  private triangle(a: number, b: number, c: number): number {
    const { xy, points } = this,
      pa = 2 * points[a],
      pb = 2 * points[b],
      pc = 2 * points[c],
      ax = xy[pa] - xy[pb],
      ay = xy[pa + 1] - xy[pb + 1],
      cx = xy[pc] - xy[pb],
      cy = xy[pc + 1] - xy[pb + 1];
    return Math.abs(ax * cy - ay * cx) / 2;
  }

  /** Whether arc point a lies west of b, or south at the same longitude: how equal areas are ordered. */
  private westOrSouth(a: number, b: number): boolean {
    const { xy, points } = this,
      pa = 2 * points[a],
      pb = 2 * points[b];
    return xy[pa] !== xy[pb] ? xy[pa] < xy[pb] : xy[pa + 1] < xy[pb + 1];
  }

  private grow(): void {
    const size = 2 * this.points.length,
      points = new Int32Array(size);
    points.set(this.points);
    this.points = points;
    this.previous = new Int32Array(size);
    this.next = new Int32Array(size);
    this.area = new Float64Array(size);
  }
}

/** Keeps at least three points of a ring forever, raising its largest-area points as needed. */
function keepThree(first: number, end: number, ids: Int32Array, byId: Float64Array): void {
  let kept = 0;
  for (let i = first; i < end; i++) if (byId[ids[i]] === Infinity) kept++;
  for (; kept < 3 && kept < end - first; kept++) {
    let largest = -1;
    for (let i = first; i < end; i++)
      if (byId[ids[i]] !== Infinity && (largest < 0 || byId[ids[i]] > byId[ids[largest]]))
        largest = i;
    if (largest < 0) return;
    byId[ids[largest]] = Infinity;
  }
}

/** The points of `first` to `end` whose area exceeds `tolerance`. */
function keptIn(areas: Float64Array, first: number, end: number, tolerance: number): number {
  let kept = 0;
  for (let i = first; i < end; i++) if (areas[i] > tolerance) kept++;
  return kept;
}

/** One polygon of a Parts: rings `first` to `first + count`. */
interface Shape {
  readonly xy: Float64Array;
  readonly parts: Uint32Array;
  readonly first: number;
  readonly count: number;
}

/** A square probe for the label: its center, half its side, its distance to the outline, and the most any point in it could reach. */
interface Cell {
  readonly x: number;
  readonly y: number;
  readonly h: number;
  readonly d: number;
  readonly max: number;
}

function cellAt(shape: Shape, x: number, y: number, h: number): Cell {
  const d = signedDistance(shape, x, y);
  return { x, y, h, d, max: d + h * Math.SQRT2 };
}

/** The cell at the outer ring's centroid, or at its first point when that is degenerate or worse. */
function centroidCell(shape: Shape): Cell {
  const { xy, parts, first } = shape,
    start = parts[first],
    end = parts[first + 1],
    x0 = xy[2 * start],
    y0 = xy[2 * start + 1];
  let area = 0,
    x = 0,
    y = 0;
  for (let i = start, j = end - 1; i < end; j = i++) {
    const ax = xy[2 * i] - x0,
      ay = xy[2 * i + 1] - y0,
      bx = xy[2 * j] - x0,
      by = xy[2 * j + 1] - y0,
      f = ax * by - bx * ay;
    x += (ax + bx) * f;
    y += (ay + by) * f;
    area += 3 * f;
  }
  const fallback = cellAt(shape, x0, y0, 0);
  if (area === 0) return fallback;
  const centroid = cellAt(shape, x0 + x / area, y0 + y / area, 0);
  return centroid.d < fallback.d ? fallback : centroid;
}

/** The distance from a point to the polygon's outline: positive inside, negative outside. */
function signedDistance({ xy, parts, first, count }: Shape, px: number, py: number): number {
  let inside = false,
    nearest = Infinity;
  for (let r = first; r < first + count; r++) {
    const start = parts[r],
      end = parts[r + 1];
    for (let i = start, j = end - 1; i < end; j = i++) {
      const ax = xy[2 * i],
        ay = xy[2 * i + 1],
        bx = xy[2 * j],
        by = xy[2 * j + 1];
      if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
      nearest = Math.min(nearest, segmentDistanceSquared(px, py, ax, ay, bx, by));
    }
  }
  return nearest === 0 ? 0 : (inside ? 1 : -1) * Math.sqrt(nearest);
}

function segmentDistanceSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  let x = ax,
    y = ay,
    dx = bx - ax,
    dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = bx;
      y = by;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = px - x;
  dy = py - y;
  return dx * dx + dy * dy;
}
