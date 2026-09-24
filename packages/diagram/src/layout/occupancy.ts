/**
 * Rectangles in a sparse uniform grid of cells: what a placement must keep clear of, and the blocks
 * a unit's wires route around while the layout measures them.
 */

/** Cell coordinates stay within this magnitude, so a loop over cells always advances. */
const CELL_LIMIT = 2 ** 29;
/** Cells one rectangle or query may span before it is tested linearly instead. */
const MAX_SPAN_CELLS = 1024;

/**
 * Rectangles in a sparse uniform grid of cells, each rectangle listed in every cell it touches, so
 * "does this box hit anything" and "what does this box meet" need no scan.
 *
 * @remarks
 * Every test is strict: a box meets a rectangle when their interiors overlap, so a box of zero
 * width finds the rectangles its line runs through. Cell coordinates clamp to `CELL_LIMIT`, so a
 * rectangle far out (a placement at `1e20`, where `c + 1 === c`) lands in an edge cell instead of
 * looping forever; the exact rectangle test keeps answers right when far rectangles share a cell.
 * A rectangle spanning more than `MAX_SPAN_CELLS` cells is kept apart and tested on every query,
 * and a query that wide tests every rectangle.
 */
export class Occupancy {
  private readonly heads = new Map<number, number>();
  private next = new Int32Array(64);
  private owner = new Int32Array(64);
  private owners = new Int32Array(16);
  private rects = new Float64Array(64);
  /** Rectangles too wide for cells, tested on every query. */
  private wide = new Int32Array(4);
  private wideCount = 0;
  /** Per rectangle: the stamp of the last `visit` that reported it. */
  private seen = new Uint32Array(16);
  private stamp = 0;
  private nodes = 0;
  private count = 0;

  /** @param cell - The cell size, in diagram units; greater than 0. */
  constructor(private readonly cell: number) {}

  /** List a rectangle owned by `owner`. */
  add(owner: number, x0: number, y0: number, x1: number, y1: number): void {
    const id = this.count++;
    if (4 * this.count > this.rects.length) this.rects = grow(this.rects, 4 * this.count);
    if (this.count > this.owners.length) {
      this.owners = grow(this.owners, this.count);
      this.seen = grow(this.seen, this.count);
    }
    this.rects[4 * id] = x0;
    this.rects[4 * id + 1] = y0;
    this.rects[4 * id + 2] = x1;
    this.rects[4 * id + 3] = y1;
    this.owners[id] = owner;
    const c0 = this.cellOf(x0);
    const c1 = this.cellOf(x1);
    const r0 = this.cellOf(y0);
    const r1 = this.cellOf(y1);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_SPAN_CELLS) {
      if (this.wideCount === this.wide.length) this.wide = grow(this.wide, this.wideCount + 1);
      this.wide[this.wideCount++] = id;
      return;
    }
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const node = this.nodes++;
        if (this.nodes > this.next.length) {
          this.next = grow(this.next, this.nodes);
          this.owner = grow(this.owner, this.nodes);
        }
        const key = cellKey(c, r);
        this.next[node] = this.heads.get(key) ?? -1;
        this.owner[node] = id;
        this.heads.set(key, node);
      }
    }
  }

  /** Whether a box overlaps a rectangle not owned by `owner`. */
  hits(owner: number, x0: number, y0: number, x1: number, y1: number): boolean {
    const c0 = this.cellOf(x0);
    const c1 = this.cellOf(x1);
    const r0 = this.cellOf(y0);
    const r1 = this.cellOf(y1);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_SPAN_CELLS) {
      for (let id = 0; id < this.count; id++) {
        if (this.owners[id] !== owner && this.meets(id, x0, y0, x1, y1)) return true;
      }
      return false;
    }
    for (let at = 0; at < this.wideCount; at++) {
      const id = this.wide[at]!;
      if (this.owners[id] !== owner && this.meets(id, x0, y0, x1, y1)) return true;
    }
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        for (let node = this.heads.get(cellKey(c, r)) ?? -1; node >= 0; node = this.next[node]!) {
          const id = this.owner[node]!;
          if (this.owners[id] !== owner && this.meets(id, x0, y0, x1, y1)) return true;
        }
      }
    }
    return false;
  }

  /** Call `visit` with the owner of every rectangle a box overlaps, once per rectangle. */
  visit(x0: number, y0: number, x1: number, y1: number, visit: (owner: number) => void): void {
    const c0 = this.cellOf(x0);
    const c1 = this.cellOf(x1);
    const r0 = this.cellOf(y0);
    const r1 = this.cellOf(y1);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_SPAN_CELLS) {
      for (let id = 0; id < this.count; id++) {
        if (this.meets(id, x0, y0, x1, y1)) visit(this.owners[id]!);
      }
      return;
    }
    if (++this.stamp === 0x100000000) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    for (let at = 0; at < this.wideCount; at++) {
      const id = this.wide[at]!;
      if (this.meets(id, x0, y0, x1, y1)) visit(this.owners[id]!);
    }
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        for (let node = this.heads.get(cellKey(c, r)) ?? -1; node >= 0; node = this.next[node]!) {
          const id = this.owner[node]!;
          if (this.seen[id] === stamp || !this.meets(id, x0, y0, x1, y1)) continue;
          this.seen[id] = stamp;
          visit(this.owners[id]!);
        }
      }
    }
  }

  /** Whether rectangle `id`'s interior meets the box's. */
  private meets(id: number, x0: number, y0: number, x1: number, y1: number): boolean {
    const rects = this.rects;
    return (
      x0 < rects[4 * id + 2]! &&
      rects[4 * id]! < x1 &&
      y0 < rects[4 * id + 3]! &&
      rects[4 * id + 1]! < y1
    );
  }

  /** The cell coordinate of a diagram coordinate, clamped to `CELL_LIMIT`. */
  private cellOf(value: number): number {
    const cell = Math.floor(value / this.cell);
    return cell < -CELL_LIMIT ? -CELL_LIMIT : cell > CELL_LIMIT ? CELL_LIMIT : cell;
  }
}

/**
 * A small-integer key per cell. Cells 2^15 apart share a key; that costs a few exact tests, never
 * a wrong answer, and keeps keys cheap to hash.
 */
function cellKey(c: number, r: number): number {
  return ((c & 0x7fff) << 15) | (r & 0x7fff);
}

/** A typed array at least `need` long, doubling, contents kept. */
function grow<T extends Int32Array | Uint32Array | Float64Array>(array: T, need: number): T {
  let length = Math.max(array.length, 1);
  while (length < need) length *= 2;
  const next = new (array.constructor as new (length: number) => T)(length);
  next.set(array);
  return next;
}
