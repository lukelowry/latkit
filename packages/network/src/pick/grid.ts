import type { Bounds } from '../topology/index.js';

/** Target mean occupancy; cells ~ count keeps queries near O(candidates). */
const CELLS_PER_ITEM = 1;
/** Maximum grid resolution along either axis to cap memory for large scenes. */
const MAX_AXIS_CELLS = 2048;

/** Receives one conservative cell membership for an item id. */
type EmitCell = (cell: number, id: number) => void;
/** Describes one indexable item by emitting every cell it may touch. */
type DescribeItem = (id: number, emit: EmitCell, geo: CellWalker) => void;

/**
 * Uniform CSR grid over topology coord space (plane xy / lon-lat).
 *
 * Built once per topology and never touched by camera motion; queries
 * enumerate item ids whose geometry may lie within a coord-space circle.
 * Coverage is what matters; exact screen-space tests downstream reject
 * false positives, so insertion is conservative, never tight.
 *
 * Layout: `starts[cell]..starts[cell+1]` indexes `items`, built with the
 * classic count / prefix-sum / fill passes. Segments insert into every cell
 * their line crosses via a per-row slab clip (exact for any slope, no DDA
 * corner cases). A geo segment spanning more than half the wrap period is a
 * seam crosser: it inserts both its direct span (what flat/tilt render) and
 * its wrapped interpretation (what the globe renders), so one grid serves
 * every projection.
 */
export class Grid {
  /** Query dedupe: `stamps[id] === stamp` means already visited this query.
   *  Points land in one cell each, but segments span many. */
  private readonly stamps: Uint32Array;
  private stamp = 0;

  private constructor(
    private readonly cols: number,
    private readonly rows: number,
    private readonly x0: number,
    private readonly y0: number,
    private readonly invCellW: number,
    private readonly invCellH: number,
    private readonly starts: Uint32Array,
    private readonly items: Uint32Array,
    itemCount: number,
  ) {
    this.stamps = new Uint32Array(itemCount);
  }

  /** Index points from an interleaved xy array (`coords[i*2]`, `coords[i*2+1]`). */
  static points(coords: Float32Array, count: number, bounds: Bounds): Grid {
    return Grid.build(count, bounds, (id, emit, geo) => {
      geo.point(coords[id * 2]!, coords[id * 2 + 1]!, id, emit);
    });
  }

  /**
   * Index segments read from a word-strided f32 view: endpoint a at
   * `f32[base + aOffset]`, b at `f32[base + bOffset]` (xy pairs), with
   * `base = recordsOffset + id * stride`. Positive `wrapX` enables seam handling
   * for lon-periodic coord spaces.
   */
  static segments(
    f32: Float32Array,
    recordsOffset: number,
    stride: number,
    aOffset: number,
    bOffset: number,
    count: number,
    bounds: Bounds,
    wrapX: number,
  ): Grid {
    return Grid.build(count, bounds, (id, emit, geo) => {
      const base = recordsOffset + id * stride;
      geo.segment(
        f32[base + aOffset]!,
        f32[base + aOffset + 1]!,
        f32[base + bOffset]!,
        f32[base + bOffset + 1]!,
        id,
        emit,
        wrapX,
      );
    });
  }

  /** Visit each item whose indexed geometry may intersect the circle, once. */
  each(cx: number, cy: number, r: number, visit: (id: number) => void): void {
    const c0 = this.clampCol((cx - r - this.x0) * this.invCellW);
    const c1 = this.clampCol((cx + r - this.x0) * this.invCellW);
    const r0 = this.clampRow((cy - r - this.y0) * this.invCellH);
    const r1 = this.clampRow((cy + r - this.y0) * this.invCellH);

    const stamp = ++this.stamp;
    const { starts, items, stamps } = this;
    for (let row = r0; row <= r1; row++) {
      const rowBase = row * this.cols;
      for (let col = c0; col <= c1; col++) {
        const cell = rowBase + col;
        const end = starts[cell + 1]!;
        for (let i = starts[cell]!; i < end; i++) {
          const id = items[i]!;
          if (stamps[id] === stamp) continue;
          stamps[id] = stamp;
          visit(id);
        }
      }
    }
  }

  private clampCol(v: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor(v)));
  }

  private clampRow(v: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(v)));
  }

  private static build(count: number, bounds: Bounds, describe: DescribeItem): Grid {
    const width = Math.max(bounds.xMax - bounds.xMin, 0);
    const height = Math.max(bounds.yMax - bounds.yMin, 0);

    // Cell counts follow the bounds aspect so cells stay near-square; either
    // axis may degenerate to a single row/column of slabs.
    const targetCells = Math.max(
      1,
      Math.min(count * CELLS_PER_ITEM, MAX_AXIS_CELLS * MAX_AXIS_CELLS),
    );
    const aspect = width > 0 && height > 0 ? width / height : 1;
    const cols = clampAxis(Math.sqrt(targetCells * aspect));
    const rows = clampAxis(targetCells / cols);

    const geo = new CellWalker(
      cols,
      rows,
      bounds.xMin,
      bounds.yMin,
      width > 0 ? cols / width : 0,
      height > 0 ? rows / height : 0,
    );

    // The same geometry walk runs twice: once counting, once filling, with
    // only the cell sink swapped.
    const starts = new Uint32Array(cols * rows + 1);
    const countSink: EmitCell = (cell) => {
      starts[cell + 1]!++;
    };
    for (let id = 0; id < count; id++) describe(id, countSink, geo);

    for (let cell = 1; cell < starts.length; cell++) starts[cell]! += starts[cell - 1]!;

    const items = new Uint32Array(starts[starts.length - 1]!);
    const cursor = new Uint32Array(cols * rows);
    const fillSink: EmitCell = (cell, id) => {
      items[starts[cell]! + cursor[cell]!++] = id;
    };
    for (let id = 0; id < count; id++) describe(id, fillSink, geo);

    return new Grid(cols, rows, geo.x0, geo.y0, geo.invCellW, geo.invCellH, starts, items, count);
  }
}

/** Maps item geometry onto conservative cell memberships for both build passes. */
class CellWalker {
  constructor(
    private readonly cols: number,
    private readonly rows: number,
    readonly x0: number,
    readonly y0: number,
    readonly invCellW: number,
    readonly invCellH: number,
  ) {}

  /** Emit the single clamped cell containing a point in topology coord space. */
  point(x: number, y: number, id: number, emit: EmitCell): void {
    emit(this.row(y) * this.cols + this.col(x), id);
  }

  /**
   * Emit every cell a segment may touch.
   *
   * When `wrapX` is positive, segments that cross more than half the period
   * also emit their wrapped globe interpretation.
   */
  segment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    id: number,
    emit: EmitCell,
    wrapX: number,
  ): void {
    if (wrapX > 0 && Math.abs(bx - ax) > wrapX / 2) {
      // Seam crosser: cover the direct chord (flat/tilt) and both halves of
      // the wrapped arc (globe), shifted into the grid's x range.
      const shift = bx > ax ? wrapX : -wrapX;
      this.span(ax, ay, bx, by, id, emit);
      this.span(ax, ay, bx - shift, by, id, emit);
      this.span(ax + shift, ay, bx, by, id, emit);
      return;
    }
    this.span(ax, ay, bx, by, id, emit);
  }

  /** Emit cells touched by one unwrapped segment via per-row slab clipping. */
  private span(ax: number, ay: number, bx: number, by: number, id: number, emit: EmitCell): void {
    const r0 = this.row(Math.min(ay, by));
    const r1 = this.row(Math.max(ay, by));
    const dy = by - ay;
    for (let row = r0; row <= r1; row++) {
      // Clip the segment's param range to this row's y-slab, then convert
      // the surviving x extent to a column range. Exact for any slope. The
      // edge rows absorb everything clamped into them, so their slabs are
      // open-ended; geometry outside the bounds (polyline midpoints can
      // exceed the vertex bounds) still lands in the border cells.
      let t0 = 0;
      let t1 = 1;
      if (this.invCellH > 0 && dy !== 0) {
        const slabLo = row === 0 ? -Infinity : this.y0 + row / this.invCellH;
        const slabHi = row === this.rows - 1 ? Infinity : this.y0 + (row + 1) / this.invCellH;
        const ta = (slabLo - ay) / dy;
        const tb = (slabHi - ay) / dy;
        t0 = Math.max(0, Math.min(ta, tb));
        t1 = Math.min(1, Math.max(ta, tb));
        if (t1 < t0) continue;
      }
      const xa = ax + (bx - ax) * t0;
      const xb = ax + (bx - ax) * t1;
      const c0 = this.col(Math.min(xa, xb));
      const c1 = this.col(Math.max(xa, xb));
      const rowBase = row * this.cols;
      for (let col = c0; col <= c1; col++) emit(rowBase + col, id);
    }
  }

  /** Clamp an x coordinate into a grid column. */
  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.x0) * this.invCellW)));
  }

  /** Clamp a y coordinate into a grid row. */
  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.y0) * this.invCellH)));
  }
}

/** Round and clamp a requested axis cell count to the supported range. */
function clampAxis(v: number): number {
  return Math.min(MAX_AXIS_CELLS, Math.max(1, Math.round(v)));
}
