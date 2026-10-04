import type { Bounds2D } from '../view/camera.js';

/** Children per index node. */
const NODE = 16;
/** Items an index build handles between pauses. */
const CHUNK = 4096;
const float = new Float32Array(1),
  bits = new Uint32Array(float.buffer);
/** The largest float32 at or below `x`. */
function below(x: number): number {
  const f = Math.fround(x);
  if (f <= x) return f;
  float[0] = f;
  if (f > 0) bits[0]--;
  else if (f < 0) bits[0]++;
  else bits[0] = 0x80000001;
  return float[0];
}
/** The smallest float32 at or above `x`. */
function above(x: number): number {
  const f = Math.fround(x);
  if (f >= x) return f;
  float[0] = f;
  if (f > 0) bits[0]++;
  else if (f < 0) bits[0]--;
  else bits[0] = 1;
  return float[0];
}
/** Position along a Hilbert curve on a 65536² grid (http://threadlocalmutex.com, public domain). */
function hilbert(x: number, y: number): number {
  let a = x ^ y,
    b = 0xffff ^ a,
    c = 0xffff ^ (x | y),
    d = x & (y ^ 0xffff);
  let A = a | (b >> 1),
    B = (a >> 1) ^ a,
    C = (c >> 1) ^ (b & (d >> 1)) ^ c,
    D = (a & (c >> 1)) ^ (d >> 1) ^ d;
  a = A;
  b = B;
  c = C;
  d = D;
  A = (a & (a >> 2)) ^ (b & (b >> 2));
  B = (a & (b >> 2)) ^ (b & ((a ^ b) >> 2));
  C ^= (a & (c >> 2)) ^ (b & (d >> 2));
  D ^= (b & (c >> 2)) ^ ((a ^ b) & (d >> 2));
  a = A;
  b = B;
  c = C;
  d = D;
  A = (a & (a >> 4)) ^ (b & (b >> 4));
  B = (a & (b >> 4)) ^ (b & ((a ^ b) >> 4));
  C ^= (a & (c >> 4)) ^ (b & (d >> 4));
  D ^= (b & (c >> 4)) ^ ((a ^ b) & (d >> 4));
  a = A;
  b = B;
  c = C;
  d = D;
  C ^= (a & (c >> 8)) ^ (b & (d >> 8));
  D ^= (b & (c >> 8)) ^ ((a ^ b) & (d >> 8));
  a = C ^ (C >> 1);
  b = D ^ (D >> 1);
  let i0 = x ^ y,
    i1 = b | (0xffff ^ (i0 | a));
  i0 = (i0 | (i0 << 8)) & 0x00ff00ff;
  i0 = (i0 | (i0 << 4)) & 0x0f0f0f0f;
  i0 = (i0 | (i0 << 2)) & 0x33333333;
  i0 = (i0 | (i0 << 1)) & 0x55555555;
  i1 = (i1 | (i1 << 8)) & 0x00ff00ff;
  i1 = (i1 | (i1 << 4)) & 0x0f0f0f0f;
  i1 = (i1 | (i1 << 2)) & 0x33333333;
  i1 = (i1 | (i1 << 1)) & 0x55555555;
  return ((i1 << 1) | i0) >>> 0;
}
/** Sort items by key until each node's run holds the right items, pausing between partitions. */
function* sortKeys(keys: Uint32Array, items: Uint32Array): Generator<void, void, void> {
  const stack = [0, items.length - 1];
  let done = 0;
  while (stack.length) {
    const right = stack.pop()!,
      left = stack.pop()!;
    if (Math.floor(left / NODE) >= Math.floor(right / NODE)) continue;
    const pivot = keys[(left + right) >>> 1];
    let i = left - 1,
      j = right + 1;
    for (;;) {
      do i++;
      while (keys[i] < pivot);
      do j--;
      while (keys[j] > pivot);
      if (i >= j) break;
      const key = keys[i],
        item = items[i];
      keys[i] = keys[j];
      items[i] = items[j];
      keys[j] = key;
      items[j] = item;
    }
    // The smaller side goes on top, so the stack stays logarithmic.
    if (j - left < right - j) stack.push(j + 1, right, left, j);
    else stack.push(left, j, j + 1, right);
    done += right - left;
    if (done >= CHUNK * 16) {
      done = 0;
      yield;
    }
  }
}
/** Starts of each level's nodes, leaves first and the root last, then the node count. */
function levels(count: number): number[] {
  const starts = [0];
  let size = count,
    end = count;
  do {
    size = Math.ceil(size / NODE);
    starts.push(end);
    end += size;
  } while (size > 1);
  starts.push(end);
  return starts;
}
const finite = (box: Float64Array) =>
  Number.isFinite(box[0]) &&
  Number.isFinite(box[1]) &&
  Number.isFinite(box[2]) &&
  Number.isFinite(box[3]);
const unchecked = () => {};
/** Reads an item's box as minX, minY, maxX, maxY; any non-finite side leaves it out. */
export type BoxRead = (item: number, box: Float64Array) => void;
/**
 * A packed static R-tree over item boxes: items sorted along a Hilbert curve of their centers, 16
 * children per node. Boxes are float32 about the data's center, rounded outward, so a query yields
 * every item whose exact box meets it, and a few more; callers measure exact distances. About 21
 * bytes per item, built in its own storage.
 */
export class BoxIndex {
  private constructor(
    /** Item offsets in leaf order. */
    readonly items: Uint32Array,
    /** Four per node: leaves first, then each level up to the root. */
    readonly boxes: Float32Array,
    private readonly starts: readonly number[],
    private readonly origin: readonly [number, number],
  ) {}
  static bytes(count: number): number {
    return levels(count).at(-1)! * 16 + count * 4;
  }
  get bytes(): number {
    return this.boxes.byteLength + this.items.byteLength;
  }
  /** Build at once; `extent` holds every finite box. */
  static of(count: number, extent: Bounds2D, read: BoxRead): BoxIndex {
    const steps = BoxIndex.build(count, extent, read);
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
    }
  }
  /** Build in steps; each yield is a point to pause. `extent` holds every finite box. */
  static *build(count: number, extent: Bounds2D, read: BoxRead): Generator<void, BoxIndex, void> {
    const starts = levels(count),
      boxes = new Float32Array(starts.at(-1)! * 4),
      items = new Uint32Array(count),
      // Keys sort inside the box storage before any box is written there.
      keys = new Uint32Array(boxes.buffer, 0, count),
      box = new Float64Array(4);
    const [x0, y0, x1, y1] = extent.every(Number.isFinite) ? extent : [0, 0, 0, 0],
      sx = x1 > x0 ? 0xffff / (x1 - x0) : 0,
      sy = y1 > y0 ? 0xffff / (y1 - y0) : 0,
      ox = (x0 + x1) / 2,
      oy = (y0 + y1) / 2;
    const cell = (v: number) => Math.max(0, Math.min(0xffff, Math.floor(v)));
    for (let i = 0; i < count; i++) {
      if (i % CHUNK === CHUNK - 1) yield;
      read(i, box);
      items[i] = i;
      keys[i] = finite(box)
        ? hilbert(cell(((box[0] + box[2]) / 2 - x0) * sx), cell(((box[1] + box[3]) / 2 - y0) * sy))
        : 0xffffffff;
    }
    yield* sortKeys(keys, items);
    for (let p = 0; p < count; p++) {
      if (p % CHUNK === CHUNK - 1) yield;
      read(items[p], box);
      const at = p * 4;
      if (finite(box)) {
        boxes[at] = below(box[0] - ox);
        boxes[at + 1] = below(box[1] - oy);
        boxes[at + 2] = above(box[2] - ox);
        boxes[at + 3] = above(box[3] - oy);
      } else {
        boxes[at] = boxes[at + 1] = Infinity;
        boxes[at + 2] = boxes[at + 3] = -Infinity;
      }
    }
    for (let level = 1; level < starts.length - 1; level++) {
      const children = starts[level - 1],
        start = starts[level];
      for (let node = start; node < starts[level + 1]; node++) {
        if ((node - start) % CHUNK === CHUNK - 1) yield;
        const first = children + (node - start) * NODE,
          last = Math.min(first + NODE, start);
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (let child = first * 4; child < last * 4; child += 4) {
          minX = Math.min(minX, boxes[child]);
          minY = Math.min(minY, boxes[child + 1]);
          maxX = Math.max(maxX, boxes[child + 2]);
          maxY = Math.max(maxY, boxes[child + 3]);
        }
        boxes[node * 4] = minX;
        boxes[node * 4 + 1] = minY;
        boxes[node * 4 + 2] = maxX;
        boxes[node * 4 + 3] = maxY;
      }
    }
    return new BoxIndex(items, boxes, starts, [ox, oy]);
  }
  /** Offsets of the items whose boxes may meet `bounds`; `check` runs once per node. */
  *query(bounds: Bounds2D, check: () => void = unchecked): Iterable<number> {
    const { boxes, items, starts } = this,
      top = starts.length - 2,
      root = starts[top];
    if (!items.length) return;
    // Rounding is monotonic, so shifting both sides keeps every comparison conservative.
    const minX = bounds[0] - this.origin[0],
      minY = bounds[1] - this.origin[1],
      maxX = bounds[2] - this.origin[0],
      maxY = bounds[3] - this.origin[1];
    const meets = (node: number) =>
      boxes[node * 4] <= maxX &&
      boxes[node * 4 + 1] <= maxY &&
      boxes[node * 4 + 2] >= minX &&
      boxes[node * 4 + 3] >= minY;
    if (!meets(root)) return;
    const stack = [root, top];
    while (stack.length) {
      check();
      const level = stack.pop()!,
        node = stack.pop()!,
        first = starts[level - 1] + (node - starts[level]) * NODE,
        last = Math.min(first + NODE, starts[level]);
      for (let child = first; child < last; child++)
        if (meets(child)) {
          if (level === 1) yield items[child];
          else stack.push(child, level - 1);
        }
    }
  }
}

/** Boxes placed one at a time where nothing placed overlaps them, as labels claim their room. */
export class Occupancy {
  private readonly cells = new Map<number, number[]>();
  private readonly placed: number[] = [];
  constructor(private readonly cell = 64) {}
  /** Whether the box is free. */
  free(box: Bounds2D): boolean {
    const { cell, placed } = this;
    for (let y = Math.floor(box[1] / cell), y1 = Math.floor(box[3] / cell); y <= y1; y++)
      for (let x = Math.floor(box[0] / cell), x1 = Math.floor(box[2] / cell); x <= x1; x++)
        for (const at of this.cells.get(key(x, y)) ?? [])
          if (
            placed[at] < box[2] &&
            placed[at + 2] > box[0] &&
            placed[at + 1] < box[3] &&
            placed[at + 3] > box[1]
          )
            return false;
    return true;
  }
  /** Claim the box, whether or not it was free. */
  add(box: Bounds2D): void {
    const { cell, placed } = this,
      at = placed.push(box[0], box[1], box[2], box[3]) - 4;
    for (let y = Math.floor(box[1] / cell), y1 = Math.floor(box[3] / cell); y <= y1; y++)
      for (let x = Math.floor(box[0] / cell), x1 = Math.floor(box[2] / cell); x <= x1; x++) {
        const k = key(x, y),
          bucket = this.cells.get(k);
        if (bucket) bucket.push(at);
        else this.cells.set(k, [at]);
      }
  }
  /** Claim the box only where nothing overlaps it; true when placed. */
  place(box: Bounds2D): boolean {
    if (!this.free(box)) return false;
    this.add(box);
    return true;
  }
}
/** One integer per cell for cells within ±2²⁵ of the origin, which any finite diagram uses. */
function key(x: number, y: number): number {
  return (x + 0x2000000) * 0x4000000 + (y + 0x2000000);
}
