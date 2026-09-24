/**
 * A sparse uniform grid over boxes keyed by integer id: blocks with their extents and port reach,
 * wire entries, and group frames. Unlike network's CSR grid, which a topology builds once, a
 * diagram's boxes move one at a time under drags and re-routes, so each id is inserted, replaced,
 * and removed in place.
 *
 * @remarks
 * Cells live in an open-addressed table keyed by integer cell coordinates, so only occupied cells
 * cost memory and a diagram may extend in any direction. Each cell holds a linked list of pooled
 * nodes; every array is typed and grows by doubling, so steady-state inserts, removes, and queries
 * allocate nothing. A box spanning more than `MAX_SPAN_CELLS` cells (a lane across the whole
 * diagram at a fine cell size) goes on a short list every query tests instead of flooding the
 * table.
 */
export class SpatialHash {
  /** Diagram units per cell side, and its inverse. */
  private side = 1;
  private inverse = 1;

  // Per id: its box, its cell span, where it lives, and the last query that visited it.
  private boxes = new Float64Array(0);
  private spans = new Int32Array(0);
  private where = new Uint8Array(0);
  private stamps = new Uint32Array(0);
  private stamp = 0;
  private present = 0;

  // Node pool: one node per (cell, id) membership, chained per cell and through the free list.
  private nodeId = new Int32Array(64);
  private nodeNext = new Int32Array(64);
  private nodeTop = 0;
  private free = -1;

  // Open-addressed cell table: coordinates and the head node of each occupied cell.
  private cellX = new Int32Array(0);
  private cellY = new Int32Array(0);
  private cellHead = new Int32Array(0);
  private cellUsed = new Uint8Array(0);
  private cellCount = 0;

  // Oversized ids, tested linearly; `bigAt[id]` is the id's index in `big`.
  private big = new Int32Array(8);
  private bigAt = new Int32Array(0);
  private bigCount = 0;

  /** Whether a query is running; a nested one dedupes with its own set instead of the stamps. */
  private querying = false;

  constructor() {
    this.allocateTable(64);
  }

  /** Number of ids with a box. */
  get size(): number {
    return this.present;
  }

  /** Diagram units per cell side. */
  get cellSize(): number {
    return this.side;
  }

  /**
   * Choose the cell size (the median block extent width) and drop every box, making room at once
   * for the `ids` a caller is about to insert so a bulk build grows nothing as it goes.
   *
   * @param ids - Ids below this bound are about to be inserted. @defaultValue `0`
   * @throws RangeError when `cellSize` is not a finite positive number.
   */
  reset(cellSize: number, ids = 0): void {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError(`SpatialHash cell size must be finite and positive, got ${cellSize}`);
    }
    this.side = cellSize;
    this.inverse = 1 / cellSize;
    this.clear();
    if (ids <= 0) return;
    this.reserveIds(ids);
    // A box about the size of a cell covers one to four of them.
    const nodes = 2 * ids;
    if (this.nodeId.length < nodes) {
      this.nodeId = grow(this.nodeId, nodes);
      this.nodeNext = grow(this.nodeNext, nodes);
    }
    // The table is empty after `clear`; keep it at most half full for about a cell per id.
    let slots = this.cellUsed.length;
    while (slots < 2 * ids) slots *= 2;
    if (slots > this.cellUsed.length) this.allocateTable(slots);
  }

  /**
   * Add or replace the box of `id`, a non-negative integer. A box with a non-finite coordinate
   * removes the id instead, so a block without a position is simply not indexed.
   */
  insert(id: number, x0: number, y0: number, x1: number, y1: number): void {
    this.remove(id);
    if (!Number.isFinite(x0 + y0 + x1 + y1)) return;
    const lx = Math.min(x0, x1);
    const hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1);
    const hy = Math.max(y0, y1);
    this.reserveIds(id + 1);
    const b = 4 * id;
    this.boxes[b] = lx;
    this.boxes[b + 1] = ly;
    this.boxes[b + 2] = hx;
    this.boxes[b + 3] = hy;
    const cx0 = this.cellOf(lx);
    const cy0 = this.cellOf(ly);
    const cx1 = this.cellOf(hx);
    const cy1 = this.cellOf(hy);
    this.present++;
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_SPAN_CELLS) {
      this.where[id] = IN_BIG;
      if (this.bigCount === this.big.length) this.big = grow(this.big, this.bigCount * 2);
      this.bigAt[id] = this.bigCount;
      this.big[this.bigCount++] = id;
      return;
    }
    this.where[id] = IN_CELLS;
    this.spans[b] = cx0;
    this.spans[b + 1] = cy0;
    this.spans[b + 2] = cx1;
    this.spans[b + 3] = cy1;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.cellSlot(cx, cy, true);
        const node = this.takeNode();
        this.nodeId[node] = id;
        this.nodeNext[node] = this.cellHead[cell]!;
        this.cellHead[cell] = node;
      }
    }
  }

  /** Remove the box of `id`, if any. */
  remove(id: number): void {
    if (id >= this.where.length || this.where[id] === ABSENT) return;
    this.present--;
    if (this.where[id] === IN_BIG) {
      // Swap-remove from the oversized list.
      const at = this.bigAt[id]!;
      const last = this.big[--this.bigCount]!;
      this.big[at] = last;
      this.bigAt[last] = at;
      this.where[id] = ABSENT;
      return;
    }
    this.where[id] = ABSENT;
    const b = 4 * id;
    const cx0 = this.spans[b]!;
    const cy0 = this.spans[b + 1]!;
    const cx1 = this.spans[b + 2]!;
    const cy1 = this.spans[b + 3]!;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.cellSlot(cx, cy, false);
        if (cell < 0) continue;
        let previous = -1;
        let node = this.cellHead[cell]!;
        while (node >= 0 && this.nodeId[node] !== id) {
          previous = node;
          node = this.nodeNext[node]!;
        }
        if (node < 0) continue;
        if (previous < 0) this.cellHead[cell] = this.nodeNext[node]!;
        else this.nodeNext[previous] = this.nodeNext[node]!;
        this.nodeNext[node] = this.free;
        this.free = node;
      }
    }
  }

  /**
   * Visit each id whose box intersects `[x0, y0, x1, y1]` (edges touching count), once. `visit`
   * may run another query but must not insert or remove.
   */
  query(x0: number, y0: number, x1: number, y1: number, visit: (id: number) => void): void {
    const lx = Math.min(x0, x1);
    const hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1);
    const hy = Math.max(y0, y1);
    if (!(lx <= hx && ly <= hy) || this.present === 0) return;
    if (this.querying) {
      // A nested query would overwrite the outer query's stamps; dedupe with a set instead.
      this.scan(lx, ly, hx, hy, visit, new Set<number>());
      return;
    }
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.stamps.fill(0);
      this.stamp = 1;
    }
    this.querying = true;
    try {
      this.scan(lx, ly, hx, hy, visit, null);
    } finally {
      this.querying = false;
    }
  }

  /** Drop every box, keeping the cell size. */
  clear(): void {
    this.where.fill(ABSENT);
    this.present = 0;
    this.nodeTop = 0;
    this.free = -1;
    this.cellUsed.fill(0);
    this.cellCount = 0;
    this.bigCount = 0;
  }

  /** Visit every id whose box intersects the ordered query box, deduplicated by stamp or `seen`. */
  private scan(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    visit: (id: number) => void,
    seen: Set<number> | null,
  ): void {
    const cx0 = this.cellOf(x0);
    const cy0 = this.cellOf(y0);
    const cx1 = this.cellOf(x1);
    const cy1 = this.cellOf(y1);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > this.cellCount) {
      // A query wider than the occupied cells walks the table instead of empty coordinates.
      for (let cell = 0; cell < this.cellUsed.length; cell++) {
        if (this.cellUsed[cell] === 0) continue;
        const cx = this.cellX[cell]!;
        const cy = this.cellY[cell]!;
        if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue;
        for (let node = this.cellHead[cell]!; node >= 0; node = this.nodeNext[node]!) {
          this.test(this.nodeId[node]!, x0, y0, x1, y1, visit, seen);
        }
      }
    } else {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const cell = this.cellSlot(cx, cy, false);
          if (cell < 0) continue;
          for (let node = this.cellHead[cell]!; node >= 0; node = this.nodeNext[node]!) {
            this.test(this.nodeId[node]!, x0, y0, x1, y1, visit, seen);
          }
        }
      }
    }
    for (let i = 0; i < this.bigCount; i++) this.test(this.big[i]!, x0, y0, x1, y1, visit, seen);
  }

  /** Visit `id` when it is new to this query and its box intersects the query box. */
  private test(
    id: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    visit: (id: number) => void,
    seen: Set<number> | null,
  ): void {
    if (seen) {
      if (seen.has(id)) return;
      seen.add(id);
    } else {
      if (this.stamps[id] === this.stamp) return;
      this.stamps[id] = this.stamp;
    }
    const b = 4 * id;
    const boxes = this.boxes;
    if (boxes[b]! <= x1 && boxes[b + 2]! >= x0 && boxes[b + 1]! <= y1 && boxes[b + 3]! >= y0) {
      visit(id);
    }
  }

  /** The cell coordinate of a diagram coordinate, clamped to a safe integer range. */
  private cellOf(value: number): number {
    const cell = Math.floor(value * this.inverse);
    return cell < -CELL_LIMIT ? -CELL_LIMIT : cell > CELL_LIMIT ? CELL_LIMIT : cell;
  }

  /** The table slot of cell `(cx, cy)`; created when `create`, else `-1` when absent. */
  private cellSlot(cx: number, cy: number, create: boolean): number {
    const mask = this.cellUsed.length - 1;
    let slot = hashCell(cx, cy) & mask;
    while (this.cellUsed[slot] === 1) {
      if (this.cellX[slot] === cx && this.cellY[slot] === cy) return slot;
      slot = (slot + 1) & mask;
    }
    if (!create) return -1;
    // Keep the table at most half full so probes stay short.
    if (2 * (this.cellCount + 1) > this.cellUsed.length) {
      this.rehash(this.cellUsed.length * 2);
      return this.cellSlot(cx, cy, true);
    }
    this.cellUsed[slot] = 1;
    this.cellX[slot] = cx;
    this.cellY[slot] = cy;
    this.cellHead[slot] = -1;
    this.cellCount++;
    return slot;
  }

  /** Allocate an empty cell table of `slots`, a power of two. */
  private allocateTable(slots: number): void {
    this.cellX = new Int32Array(slots);
    this.cellY = new Int32Array(slots);
    this.cellHead = new Int32Array(slots);
    this.cellUsed = new Uint8Array(slots);
    this.cellCount = 0;
  }

  /** Move every occupied cell into a table of `slots`. */
  private rehash(slots: number): void {
    const { cellX, cellY, cellHead, cellUsed } = this;
    this.allocateTable(slots);
    const mask = slots - 1;
    for (let old = 0; old < cellUsed.length; old++) {
      if (cellUsed[old] === 0) continue;
      let slot = hashCell(cellX[old]!, cellY[old]!) & mask;
      while (this.cellUsed[slot] === 1) slot = (slot + 1) & mask;
      this.cellUsed[slot] = 1;
      this.cellX[slot] = cellX[old]!;
      this.cellY[slot] = cellY[old]!;
      this.cellHead[slot] = cellHead[old]!;
      this.cellCount++;
    }
  }

  /** A free node, growing the pool when none is left. */
  private takeNode(): number {
    if (this.free >= 0) {
      const node = this.free;
      this.free = this.nodeNext[node]!;
      return node;
    }
    if (this.nodeTop === this.nodeId.length) {
      this.nodeId = grow(this.nodeId, this.nodeTop * 2);
      this.nodeNext = grow(this.nodeNext, this.nodeTop * 2);
    }
    return this.nodeTop++;
  }

  /** Grow the per-id arrays to hold ids below `count`. */
  private reserveIds(count: number): void {
    if (count <= this.where.length) return;
    const capacity = Math.max(count, 2 * this.where.length, 16);
    const boxes = new Float64Array(4 * capacity);
    boxes.set(this.boxes);
    this.boxes = boxes;
    this.spans = grow(this.spans, 4 * capacity);
    const where = new Uint8Array(capacity);
    where.set(this.where);
    this.where = where;
    const stamps = new Uint32Array(capacity);
    stamps.set(this.stamps);
    this.stamps = stamps;
    this.bigAt = grow(this.bigAt, capacity);
  }
}

/** Where an id's box lives. */
const ABSENT = 0;
const IN_CELLS = 1;
const IN_BIG = 2;

/** Cells one box may span before it is tested linearly instead. */
const MAX_SPAN_CELLS = 1024;

/** Cell coordinates stay within this magnitude, so they fit an i32 with room to spare. */
const CELL_LIMIT = 2 ** 29;

/** A 32-bit hash of integer cell coordinates. */
function hashCell(cx: number, cy: number): number {
  let h = Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}

/** A copy of `array` with room for `length` entries. */
function grow(array: Int32Array, length: number): Int32Array<ArrayBuffer> {
  const next = new Int32Array(length);
  next.set(array);
  return next;
}
