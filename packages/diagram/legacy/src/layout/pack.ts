/**
 * Placing units and blocks among others: shelf packing for a whole arrangement, and placing new
 * blocks beside what they connect to when a reload adds them, so editing never makes a diagram
 * jump.
 */

import { ceilTo, snapTo } from '../geometry.js';
import { NONE, STYLE_WIRE, type Prepared } from '../prepare.js';
import type { UnitLayout } from './layered.js';
import { Occupancy } from './occupancy.js';
import { Layouts } from './shapes.js';
import { units, type Units } from './units.js';

/**
 * Grid steps between packed unit rectangles, each holding everything drawn for its unit (a group's
 * frame included), so no two group frames come closer.
 */
export const UNIT_GAP = 6;
/** Width over height a packing aims for. */
const ASPECT = 16 / 10;
/** Row widths a packing tries while it converges on the aspect. */
const PACK_ROUNDS = 8;
/** Grid steps between a new block and the block it reads or feeds. */
const BESIDE_GAP = 8;
/** Grid steps between a new block and the block it lands under. */
const BELOW_GAP = 4;
/** Clearance a new block keeps from everything, in grid steps. */
const CLEARANCE = 2;
/** Pitches a candidate slides down looking for room. */
const SLIDE_STEPS = 64;
/** Grid steps a shelf row spans at least. */
const SHELF_MIN = 128;
/** Shelf spots a piece skips past blocks placed in the shelf's way before it takes one anyway. */
export const SHELF_TRIES = 4096;

/**
 * Shelf-pack unit rectangles in order into rows targeting a 16:10 aspect; returns top-lefts.
 *
 * @remarks
 * Every two rectangles keep `gap` between them, across a row and between rows. The row width
 * starts at the one a square-ish packing of the total area would take, then moves by the square
 * root of the aspect error a few times; the closest packing wins. Positions are sums of widths,
 * heights and gaps, so grid-multiple inputs keep every top-left on the grid.
 */
export function packUnits(widths: Float32Array, heights: Float32Array, gap: number): Float32Array {
  const count = widths.length;
  const positions = new Float32Array(2 * count);
  if (count === 0) return positions;
  let area = 0;
  let widest = 0;
  for (let unit = 0; unit < count; unit++) {
    area += (widths[unit]! + gap) * (heights[unit]! + gap);
    widest = Math.max(widest, widths[unit]!);
  }
  const bounds = new Float64Array(2);
  let row = Math.max(widest, Math.sqrt(area * ASPECT));
  let bestRow = row;
  let bestError = Infinity;
  for (let round = 0; round < PACK_ROUNDS; round++) {
    shelve(widths, heights, gap, row, null, bounds);
    const ratio = bounds[1]! > 0 ? bounds[0]! / bounds[1]! : ASPECT;
    const error = Math.abs(Math.log(ratio / ASPECT));
    if (error < bestError) {
      bestError = error;
      bestRow = row;
    }
    const next = Math.max(widest, row * Math.sqrt(ASPECT / ratio));
    if (Math.abs(next - row) < 1e-6 * row) break;
    row = next;
  }
  shelve(widths, heights, gap, bestRow, positions, bounds);
  return positions;
}

/** Shelve rectangles into rows no wider than `row`; writes top-lefts when asked and the bounds. */
function shelve(
  widths: Float32Array,
  heights: Float32Array,
  gap: number,
  row: number,
  positions: Float32Array | null,
  bounds: Float64Array,
): void {
  let x = 0;
  let y = 0;
  let tallest = 0;
  let right = 0;
  for (let unit = 0; unit < widths.length; unit++) {
    const w = widths[unit]!;
    if (x > 0 && x + w > row) {
      y += tallest + gap;
      x = 0;
      tallest = 0;
    }
    if (positions) {
      positions[2 * unit] = x;
      positions[2 * unit + 1] = y;
    }
    right = Math.max(right, x + w);
    tallest = Math.max(tallest, heights[unit]!);
    x += w + gap;
  }
  bounds[0] = right;
  bounds[1] = y + tallest;
}

/**
 * Place blocks whose position is NaN beside what they connect to, avoiding `occupied`
 * rectangles (top-lefts of the rest, NaN = none); writes into `positions`.
 *
 * @remarks
 * New blocks move in pieces: a unit none of whose blocks has a position is one piece, laid out
 * whole by `layerUnit`; any other new block is a piece of its own. A piece tries, in order, the
 * spot right of each positioned block driving one of its blocks (the connecting ports level), left
 * of each positioned block one of its blocks drives, then under its first positioned neighbor;
 * each spot slides down a pitch at a time, up to 64, until the piece is clear. A whole unit is
 * clear when its rectangle (its wires, labels, and group frame included) keeps `UNIT_GAP` grid
 * steps from the rectangle every other unit is drawn in (`Frames`), as a packing keeps them; a
 * single block, padded by two grid steps, when it clears every occupied rectangle and every block
 * placed before it. Whole units go first, in unit order; single blocks follow in index order,
 * outward from the positioned ones, and a block wired to nothing positioned lands under its
 * unit's lowest block. A piece without a free spot goes on a shelf below everything. A neighbor
 * counts where it shows: its `occupied` pair when finite, else its position.
 *
 * @param positions - Automatic top-lefts, 2 per block, NaN for the blocks to place; written.
 * @param occupied - Where blocks sit, 2 per block, NaN for a block that takes no room.
 */
export function placeNew(
  prepared: Prepared,
  positions: Float32Array,
  occupied: Float32Array,
): void {
  const { blockCount, size, extent, portOffset, portBlock, portNet, netStyle, netDriver } =
    prepared;
  const { portStart, netStart, netPorts } = prepared.netlist;
  const g = prepared.metrics.grid;
  const fresh = new Uint8Array(blockCount);
  let pending = 0;
  for (let block = 0; block < blockCount; block++) {
    if (Number.isNaN(positions[2 * block]!) || Number.isNaN(positions[2 * block + 1]!)) {
      fresh[block] = 1;
      pending++;
    }
  }
  if (pending === 0) return;

  const shown = (block: number): boolean =>
    Number.isFinite(occupied[2 * block]!) && Number.isFinite(occupied[2 * block + 1]!);
  const refX = (block: number): number =>
    shown(block) ? occupied[2 * block]! : positions[2 * block]!;
  const refY = (block: number): number =>
    shown(block) ? occupied[2 * block + 1]! : positions[2 * block + 1]!;
  const known = (block: number): boolean => shown(block) || !fresh[block];

  const room = new Occupancy(cellSize(prepared));
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const cover = (block: number, x: number, y: number): void => {
    const x0 = x - extent[4 * block]!;
    const y0 = y - extent[4 * block + 1]!;
    const x1 = x + size[2 * block]! + extent[4 * block + 2]!;
    const y1 = y + size[2 * block + 1]! + extent[4 * block + 3]!;
    room.add(block, x0, y0, x1, y1);
    bounds[0] = Math.min(bounds[0]!, x0);
    bounds[1] = Math.min(bounds[1]!, y0);
    bounds[2] = Math.max(bounds[2]!, x1);
    bounds[3] = Math.max(bounds[3]!, y1);
  };
  for (let block = 0; block < blockCount; block++) {
    if (shown(block)) cover(block, occupied[2 * block]!, occupied[2 * block + 1]!);
  }

  // The piece in hand: its blocks, their offsets from its origin, the box their extents span
  // (on the grid), the frame that must find room, and its unit when it is a whole one.
  const one = new Uint32Array(1);
  const none = new Float32Array(2);
  let members: Uint32Array = one;
  let offsets: Float32Array = none;
  const reach = new Float64Array(4);
  const frame = new Float64Array(4);
  let whole = NONE;
  // Where every unit is drawn, once a whole unit needs room among them.
  let frames: Frames | null = null;
  const hold = (blocks: Uint32Array, at: Float32Array, layout: UnitLayout | null): void => {
    members = blocks;
    offsets = at;
    reach[0] = Infinity;
    reach[1] = Infinity;
    reach[2] = -Infinity;
    reach[3] = -Infinity;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const x = at[2 * i]!;
      const y = at[2 * i + 1]!;
      reach[0] = Math.min(reach[0]!, x - ceilTo(extent[4 * block]!, g));
      reach[1] = Math.min(reach[1]!, y - ceilTo(extent[4 * block + 1]!, g));
      reach[2] = Math.max(reach[2]!, x + size[2 * block]! + ceilTo(extent[4 * block + 2]!, g));
      reach[3] = Math.max(reach[3]!, y + size[2 * block + 1]! + ceilTo(extent[4 * block + 3]!, g));
    }
    if (layout) {
      frame[0] = 0;
      frame[1] = 0;
      frame[2] = layout.width;
      frame[3] = layout.height;
    } else frame.set(reach);
  };
  const holdBlock = (block: number): void => {
    one[0] = block;
    whole = NONE;
    hold(one, none, null);
  };
  const commit = (x: number, y: number): void => {
    for (let i = 0; i < members.length; i++) {
      const block = members[i]!;
      positions[2 * block] = x + offsets[2 * i]!;
      positions[2 * block + 1] = y + offsets[2 * i + 1]!;
      fresh[block] = 0;
      cover(block, positions[2 * block]!, positions[2 * block + 1]!);
    }
    if (whole !== NONE) {
      frames!.add(whole, x + frame[0]!, y + frame[1]!, x + frame[2]!, y + frame[3]!);
    }
  };
  const pad = CLEARANCE * g;
  const pitch = prepared.metrics.pitch;
  const free = (x: number, y: number): boolean =>
    whole !== NONE
      ? frames!.clear(whole, x + frame[0]!, y + frame[1]!, x + frame[2]!, y + frame[3]!)
      : !room.hits(
          members[0]!,
          x + frame[0]! - pad,
          y + frame[1]! - pad,
          x + frame[2]! + pad,
          y + frame[3]! + pad,
        );
  /** Slide the piece down from (x, y) until it is free; true once it is placed. */
  const settle = (x: number, y: number): boolean => {
    for (let step = 0; step < SLIDE_STEPS; step++) {
      const at = y + step * pitch;
      if (!free(x, at)) continue;
      commit(x, at);
      return true;
    }
    return false;
  };
  // A whole unit's spot beside a neighbor starts a unit gap clear of the rectangle the neighbor's
  // unit is drawn in, rather than sliding down along it.
  const gap = UNIT_GAP * g;
  /** Edge `side` of the rectangle `other`'s unit is drawn in, for a whole piece; else NaN. */
  const edge = (other: number, side: number): number =>
    whole === NONE ? Number.NaN : frames!.edge(all.unitOf[other]!, side);
  /** A spot's left `x` right of `other`, past its unit's rectangle for a whole piece. */
  const rightOf = (other: number, x: number): number => {
    const right = edge(other, 2);
    return Number.isFinite(right) ? Math.max(x, ceilTo(right + gap - frame[0]!, g)) : x;
  };
  /** A spot's left `x` left of `other`, short of its unit's rectangle for a whole piece. */
  const leftOf = (other: number, x: number): number => {
    const left = edge(other, 0);
    return Number.isFinite(left) ? Math.min(x, -ceilTo(frame[2]! + gap - left, g)) : x;
  };
  /** A spot's top `y` under `other`, below its unit's rectangle for a whole piece. */
  const below = (other: number, y: number): number => {
    const bottom = edge(other, 3);
    return Number.isFinite(bottom) ? Math.max(y, ceilTo(bottom + gap - frame[1]!, g)) : y;
  };
  /** Try the spot under `other`, member `i`'s left edge level with its left edge. */
  const under = (i: number, other: number): boolean => {
    const bottom = refY(other) + size[2 * other + 1]! + extent[4 * other + 3]!;
    return settle(
      snapTo(refX(other) - offsets[2 * i]!, g),
      below(other, ceilTo(bottom + BELOW_GAP * g - reach[1]!, g)),
    );
  };
  /** Try every spot beside the positioned blocks the piece is wired to. */
  const beside = (): boolean => {
    let first = NONE;
    let firstMember = 0;
    for (let i = 0; i < members.length; i++) {
      const block = members[i]!;
      for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
        const net = portNet[port]!;
        if (net === NONE || netStyle[net] !== STYLE_WIRE) continue;
        const driver = netDriver[net]!;
        for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
          const other = portBlock[netPorts[at]!]!;
          if (first === NONE && other !== block && known(other)) {
            first = other;
            firstMember = i;
          }
        }
        if (driver === NONE || driver === port) continue;
        const other = portBlock[driver]!;
        if (other === block || !known(other)) continue;
        const right = refX(other) + size[2 * other]! + extent[4 * other + 2]!;
        const level = refY(other) + portOffset[2 * driver + 1]! - portOffset[2 * port + 1]!;
        if (
          settle(
            rightOf(other, ceilTo(right + BESIDE_GAP * g - reach[0]!, g)),
            snapTo(level - offsets[2 * i + 1]!, g),
          )
        ) {
          return true;
        }
      }
    }
    for (let i = 0; i < members.length; i++) {
      const block = members[i]!;
      for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
        const net = portNet[port]!;
        if (net === NONE || netStyle[net] !== STYLE_WIRE || netDriver[net] !== port) continue;
        for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
          const reader = netPorts[at]!;
          const other = portBlock[reader]!;
          if (other === block || !known(other)) continue;
          const left = refX(other) - extent[4 * other]!;
          const level = refY(other) + portOffset[2 * reader + 1]! - portOffset[2 * port + 1]!;
          if (
            settle(
              leftOf(other, -ceilTo(reach[2]! + BESIDE_GAP * g - left, g)),
              snapTo(level - offsets[2 * i + 1]!, g),
            )
          ) {
            return true;
          }
        }
      }
    }
    return first !== NONE && under(firstMember, first);
  };

  // Wholly new units, each laid out whole, beside what it is wired to or else deferred.
  const all = units(prepared);
  const layouts = new Layouts(prepared);
  const deferred: {
    readonly unit: number;
    readonly order: Uint32Array;
    readonly layout: UnitLayout;
  }[] = [];
  let deferredArea = 0;
  for (let unit = 0; unit < all.count; unit++) {
    const from = all.start[unit]!;
    const to = all.start[unit + 1]!;
    let anchored = false;
    for (let at = from; at < to && !anchored; at++) anchored = known(all.blocks[at]!);
    if (anchored) continue;
    // Framing the drawn units shapes them all, so it comes before this unit's order is taken.
    if (!frames) {
      frames = new Frames(prepared, all);
      frames.addDrawn(layouts, occupied, null);
    }
    const layout = layouts.of(all.blocks, from, to);
    const order = layouts.order.slice(0, to - from);
    hold(order, layout.positions, layout);
    whole = unit;
    if (beside()) continue;
    deferred.push({ unit, order, layout });
    deferredArea += (layout.width + UNIT_GAP * g) * (layout.height + UNIT_GAP * g);
  }

  // Whole units shelve below every unit's rectangle, single blocks below every block.
  const shelf = new Shelf(
    frames?.bounds ?? bounds,
    UNIT_GAP * g,
    Math.sqrt(deferredArea * ASPECT),
    g,
  );
  /** Put the piece on the next free spot of the shelf. */
  const shelve = (): void => {
    const w = frame[2]! - frame[0]!;
    const h = frame[3]! - frame[1]!;
    for (let tries = 0; ; tries++) {
      shelf.place(w, h);
      if (free(shelf.x - frame[0]!, shelf.y - frame[1]!) || tries === SHELF_TRIES) break;
    }
    commit(shelf.x - frame[0]!, shelf.y - frame[1]!);
  };
  for (const { unit, order, layout } of deferred) {
    hold(order, layout.positions, layout);
    whole = unit;
    shelve();
  }

  // Single blocks, outward from the positioned ones: each round places every block wired to one.
  for (let progress = true; progress;) {
    progress = false;
    for (let block = 0; block < blockCount; block++) {
      if (!fresh[block]) continue;
      holdBlock(block);
      if (beside()) progress = true;
    }
  }
  // The rest are wired to nothing positioned: under their unit's lowest block, else shelved.
  for (let block = 0; block < blockCount; block++) {
    if (!fresh[block]) continue;
    holdBlock(block);
    const unit = all.unitOf[block]!;
    let lowest = NONE;
    let bottom = -Infinity;
    for (let at = all.start[unit]!; at < all.start[unit + 1]!; at++) {
      const other = all.blocks[at]!;
      if (other === block || !known(other)) continue;
      const y = refY(other) + size[2 * other + 1]! + extent[4 * other + 3]!;
      if (y > bottom) {
        bottom = y;
        lowest = other;
      }
    }
    if (lowest === NONE || !under(0, lowest)) shelve();
  }
}

/** A cell size for occupancy queries: twice the mean block reach, at least eight grid steps. */
function cellSize(prepared: Prepared): number {
  const { blockCount, size, extent } = prepared;
  const g = prepared.metrics.grid;
  let sum = 0;
  for (let block = 0; block < blockCount; block++) {
    sum += Math.max(
      size[2 * block]! + extent[4 * block]! + extent[4 * block + 2]!,
      size[2 * block + 1]! + extent[4 * block + 1]! + extent[4 * block + 3]!,
    );
  }
  return Math.max(8 * g, blockCount > 0 ? (2 * sum) / blockCount : 0);
}

/**
 * Rows of rectangles a gap below some bounds (`[x0, y0, x1, y1]`, empty when `x0 > x1`), left
 * edges at the bounds' left, rows as wide as the bounds or `width`, whichever is wider; everything
 * on the grid.
 */
export class Shelf {
  /** The last placed rectangle's top-left. */
  x = 0;
  y = 0;
  private readonly left: number;
  private readonly limit: number;
  private cursor: number;
  private row: number;
  private tallest = 0;

  constructor(
    bounds: readonly number[],
    private readonly gap: number,
    width: number,
    grid: number,
  ) {
    const empty = !(bounds[0]! <= bounds[2]!);
    this.left = empty ? 0 : -ceilTo(-bounds[0]!, grid);
    this.row = empty ? 0 : ceilTo(bounds[3]! + gap, grid);
    this.limit = Math.max(empty ? 0 : bounds[2]! - this.left, width, SHELF_MIN * grid);
    this.cursor = this.left;
  }

  /** Put a `w` by `h` rectangle next on the shelf; its top-left lands in `x`, `y`. */
  place(w: number, h: number): void {
    if (this.cursor > this.left && this.cursor + w > this.left + this.limit) {
      this.row += this.tallest + this.gap;
      this.cursor = this.left;
      this.tallest = 0;
    }
    this.x = this.cursor;
    this.y = this.row;
    this.cursor += w + this.gap;
    this.tallest = Math.max(this.tallest, h);
  }
}

/**
 * The rectangles units are drawn in, each owned by its unit, so a unit being placed keeps
 * `UNIT_GAP` grid steps from every other unit's, as a packing keeps them.
 *
 * @remarks
 * A unit's rectangle holds everything drawn for it: its blocks with extents, its wires and their
 * labels, and its group's frame (`UnitLayout`). Where a unit already stands, its rectangle is the
 * box of its placed blocks with their extents (each rounded up to the grid) grown by its layout's
 * `margin`: exactly its layout's rectangle when it stands as laid out.
 */
export class Frames {
  /** The union of every rectangle added, `[x0, y0, x1, y1]`; empty while `x0 > x1`. */
  readonly bounds = [Infinity, Infinity, -Infinity, -Infinity];
  private readonly room: Occupancy;
  private readonly gap: number;
  /** Per unit: the union of its rectangles, `[x0, y0, x1, y1]`, NaN while it has none. */
  private readonly rects: Float64Array;

  constructor(
    private readonly prepared: Prepared,
    private readonly all: Units,
  ) {
    this.room = new Occupancy(cellSize(prepared));
    this.gap = UNIT_GAP * prepared.metrics.grid;
    this.rects = new Float64Array(4 * all.count).fill(Number.NaN);
  }

  /** Edge `side` (`0` left, `1` top, `2` right, `3` bottom) of unit `unit`'s rectangle, or NaN. */
  edge(unit: number, side: number): number {
    return this.rects[4 * unit + side]!;
  }

  /** Add a rectangle to unit `unit`'s. */
  add(unit: number, x0: number, y0: number, x1: number, y1: number): void {
    this.room.add(unit, x0, y0, x1, y1);
    grow(this.bounds, 0, x0, y0, x1, y1);
    grow(this.rects, 4 * unit, x0, y0, x1, y1);
  }

  /**
   * Add the rectangle of every unit with a block at a finite pair of `at`, but those `skip` marks:
   * where those blocks stand, grown by the unit's layout margin.
   */
  addDrawn(layouts: Layouts, at: Float32Array, skip: Uint8Array | null): void {
    const { size, extent } = this.prepared;
    const g = this.prepared.metrics.grid;
    const all = this.all;
    for (let unit = 0; unit < all.count; unit++) {
      if (skip?.[unit]) continue;
      const from = all.start[unit]!;
      const to = all.start[unit + 1]!;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = from; k < to; k++) {
        const block = all.blocks[k]!;
        const x = at[2 * block]!;
        const y = at[2 * block + 1]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        x0 = Math.min(x0, x - ceilTo(extent[4 * block]!, g));
        y0 = Math.min(y0, y - ceilTo(extent[4 * block + 1]!, g));
        x1 = Math.max(x1, x + size[2 * block]! + ceilTo(extent[4 * block + 2]!, g));
        y1 = Math.max(y1, y + size[2 * block + 1]! + ceilTo(extent[4 * block + 3]!, g));
      }
      if (!(x0 <= x1)) continue;
      const margin = layouts.of(all.blocks, from, to).margin;
      this.add(unit, x0 - margin[0], y0 - margin[1], x1 + margin[2], y1 + margin[3]);
    }
  }

  /** Whether unit `unit` drawn in the rectangle keeps the gap from every other unit's. */
  clear(unit: number, x0: number, y0: number, x1: number, y1: number): boolean {
    const gap = this.gap;
    return !this.room.hits(unit, x0 - gap, y0 - gap, x1 + gap, y1 + gap);
  }

  /**
   * The first top from `y` down, a pitch at a time for up to `SLIDE_STEPS` pitches, where unit
   * `unit`'s `w` by `h` rectangle at left `x` is `clear`; NaN when none is.
   */
  slide(unit: number, x: number, y: number, w: number, h: number): number {
    const pitch = this.prepared.metrics.pitch;
    for (let step = 0; step < SLIDE_STEPS; step++) {
      const top = y + step * pitch;
      if (this.clear(unit, x, top, x + w, top + h)) return top;
    }
    return Number.NaN;
  }
}

/** Grow the box `[x0, y0, x1, y1]` at `at` of `box` (NaN or infinite when empty) by a rectangle. */
function grow(
  box: Float64Array | number[],
  at: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  // `!(a <= b)` takes the rectangle's edge over a NaN one as well.
  if (!(box[at]! <= x0)) box[at] = x0;
  if (!(box[at + 1]! <= y0)) box[at + 1] = y0;
  if (!(box[at + 2]! >= x1)) box[at + 2] = x1;
  if (!(box[at + 3]! >= y1)) box[at + 3] = y1;
}
