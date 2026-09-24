/**
 * Routing fixtures: netlists placed in columns the way a layered layout places them, brute-force
 * obstacle queries, a writer that records what a router writes, and checks every route must pass.
 */

import type { Netlist } from '@latkit/model';

import { laneShifts } from '../../src/layout/shapes.js';
import { prepare, type Prepared } from '../../src/prepare.js';
import type { RouteContext } from '../../src/route/index.js';
import type { RouteWriter } from '../../src/route/straight.js';

/** A prepared netlist and where its blocks sit. */
export interface Placed {
  readonly prepared: Prepared;
  readonly positions: Float32Array;
}

/** How `columns` spaces blocks, in grid steps, and where it starts. */
export interface ColumnOptions {
  readonly grid?: number;
  /** Between columns. @defaultValue `10` */
  readonly gap?: number;
  /** Between blocks in a column. @defaultValue `4` */
  readonly stack?: number;
  readonly x?: number;
  readonly y?: number;
}

/**
 * Place blocks in columns left to right, each column's blocks stacked top to bottom with `stack`
 * grid steps between extents and columns `gap` grid steps apart; every top-left on the grid.
 * Blocks in no column stay at NaN.
 */
export function columns(
  netlist: Netlist,
  cols: readonly (readonly number[])[],
  options: ColumnOptions = {},
): Placed {
  const prepared = prepare(netlist, options.grid ?? 8);
  const positions = new Float32Array(2 * prepared.blockCount).fill(Number.NaN);
  placeColumns(prepared, positions, cols, options);
  return { prepared, positions };
}

/** `columns` into existing positions; returns the right and bottom its extents reach. */
function placeColumns(
  prepared: Prepared,
  positions: Float32Array,
  cols: readonly (readonly number[])[],
  options: ColumnOptions,
): readonly [right: number, bottom: number] {
  const g = prepared.metrics.grid;
  const { size, extent } = prepared;
  const up = (v: number): number => Math.ceil(v / g - 1e-9) * g;
  let x = options.x ?? 0;
  let right = x;
  let bottom = options.y ?? 0;
  for (const col of cols) {
    const left = Math.max(0, ...col.map((b) => extent[4 * b]!));
    let width = 0;
    let y = options.y ?? 0;
    for (const b of col) {
      const top = up(y + extent[4 * b + 1]!);
      positions[2 * b] = up(x + left);
      positions[2 * b + 1] = top;
      width = Math.max(width, left + size[2 * b]! + extent[4 * b + 2]!);
      y = top + size[2 * b + 1]! + extent[4 * b + 3]!;
      bottom = Math.max(bottom, y);
      y += (options.stack ?? 4) * g;
    }
    right = Math.max(right, x + width);
    x = up(x + width + (options.gap ?? 10) * g);
  }
  return [right, bottom];
}

/**
 * The columns of each plant of `system(plants)` (default shapes), in block indices: a steam plant's
 * TGOV1 and IEEET1 left of its GENROU, a PSS plant's IEEEST further left, a renewable plant's
 * REPCA, REECB, REGCA left to right, a classical plant's GENCLS alone.
 */
export function plantColumns(plants: number): number[][][] {
  const shapes = [[[1, 2], [0]], [[3], [1, 2], [0]], [[2], [1], [0]], [[0]]] as const;
  const sizes = [3, 4, 3, 1];
  const units: number[][][] = [];
  let at = 0;
  for (let i = 0; i < plants; i++) {
    const shape = i % 4;
    units.push(shapes[shape]!.map((col) => col.map((b) => at + b)));
    at += sizes[shape]!;
  }
  return units;
}

/**
 * Place units (each a list of columns) on shelves the way the layout packs them: `perRow` units
 * to a row, each unit laid out by `columns` at its own origin, with room under each unit for its
 * feedback lanes.
 */
export function shelf(
  netlist: Netlist,
  units: readonly (readonly (readonly number[])[])[],
  perRow: number,
  grid = 8,
): Placed {
  const placed = columns(netlist, [], { grid });
  const up = (v: number): number => Math.ceil(v / grid - 1e-9) * grid;
  let x = 0;
  let y = 0;
  let rowBottom = 0;
  units.forEach((unit, i) => {
    if (i > 0 && i % perRow === 0) {
      x = 0;
      y = up(rowBottom + 16 * grid);
    }
    const [right, bottom] = placeColumns(placed.prepared, placed.positions, unit, { x, y });
    rowBottom = Math.max(rowBottom, bottom);
    x = up(right + 16 * grid);
  });
  return placed;
}

/** Place blocks on a coarse grid of cells, `across` per row, each cell `cell` units square. */
export function scatter(netlist: Netlist, across: number, cell: number, grid = 8): Placed {
  const prepared = prepare(netlist, grid);
  const positions = new Float32Array(2 * prepared.blockCount);
  for (let b = 0; b < prepared.blockCount; b++) {
    positions[2 * b] = (b % across) * cell;
    positions[2 * b + 1] = Math.floor(b / across) * cell;
  }
  return { prepared, positions };
}

/** A block's extent rectangle: its rectangle grown by its extents. */
export function extentRect(
  placed: Placed,
  block: number,
): readonly [x0: number, y0: number, x1: number, y1: number] {
  const { prepared, positions } = placed;
  const x = positions[2 * block]!;
  const y = positions[2 * block + 1]!;
  const e = prepared.extent;
  return [
    x - e[4 * block]!,
    y - e[4 * block + 1]!,
    x + prepared.size[2 * block]! + e[4 * block + 2]!,
    y + prepared.size[2 * block + 1]! + e[4 * block + 3]!,
  ];
}

/**
 * Brute-force obstacles: every placed block whose extent rectangle's interior meets a box, so a
 * box of zero width still finds the blocks its line runs through.
 */
export function obstaclesOf(placed: Placed): RouteContext['obstacles'] {
  return (x0, y0, x1, y1, visit) => {
    for (let b = 0; b < placed.prepared.blockCount; b++) {
      if (Number.isNaN(placed.positions[2 * b]!)) continue;
      const [bx0, by0, bx1, by1] = extentRect(placed, b);
      if (bx0 < x1 && x0 < bx1 && by0 < y1 && y0 < by1) visit(b);
    }
  };
}

/** A route context over a placement, with the lane shifts the scene would give it. */
export function contextOf(
  placed: Placed,
  options: {
    readonly mode?: RouteContext['mode'];
    readonly blockVisible?: Float32Array | null;
    readonly netVisible?: Float32Array | null;
  } = {},
): RouteContext {
  return {
    prepared: placed.prepared,
    positions: placed.positions,
    blockVisible: options.blockVisible ?? null,
    netVisible: options.netVisible ?? null,
    mode: options.mode ?? 'orthogonal',
    obstacles: obstaclesOf(placed),
    laneShift: laneShifts(placed.prepared),
  };
}

/** One recorded segment. */
export interface Segment {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly along: number;
}

/** A writer that keeps everything a router writes. */
export class Recorder implements RouteWriter {
  readonly segments: Segment[] = [];
  readonly junctions: (readonly [number, number])[] = [];
  readonly arrows: (readonly [number, number, number, number])[] = [];
  anchorAt: readonly [number, number] | null = null;

  segment(ax: number, ay: number, bx: number, by: number, along: number): void {
    this.segments.push({ ax, ay, bx, by, along });
  }

  junction(x: number, y: number): void {
    this.junctions.push([x, y]);
  }

  arrow(x: number, y: number, dx: number, dy: number): void {
    this.arrows.push([x, y, dx, dy]);
  }

  anchor(x: number, y: number): void {
    this.anchorAt = [x, y];
  }
}

/** A port's position. */
export function portAt(placed: Placed, port: number): readonly [number, number] {
  const { prepared, positions } = placed;
  const b = prepared.portBlock[port]!;
  return [
    positions[2 * b]! + prepared.portOffset[2 * port]!,
    positions[2 * b + 1]! + prepared.portOffset[2 * port + 1]!,
  ];
}

/** The ports of a net. */
export function netPorts(prepared: Prepared, net: number): number[] {
  const { netStart, netPorts: ports } = prepared.netlist;
  return Array.from(ports.subarray(netStart[net]!, netStart[net + 1]!));
}

/** Whether a segment runs through the open interior of a rectangle. */
export function pierces(
  s: Segment,
  rect: readonly [number, number, number, number],
  inset = 0,
): boolean {
  const [x0, y0, x1, y1] = rect;
  const lx = Math.min(s.ax, s.bx);
  const hx = Math.max(s.ax, s.bx);
  const ly = Math.min(s.ay, s.by);
  const hy = Math.max(s.ay, s.by);
  return lx < x1 - inset && hx > x0 + inset && ly < y1 - inset && hy > y0 + inset;
}

/** Length of the stretch two collinear segments share; 0 when they are not collinear. */
export function overlap(a: Segment, b: Segment): number {
  if (a.ax === a.bx && b.ax === b.bx && a.ax === b.ax) {
    const lo = Math.max(Math.min(a.ay, a.by), Math.min(b.ay, b.by));
    const hi = Math.min(Math.max(a.ay, a.by), Math.max(b.ay, b.by));
    return Math.max(0, hi - lo);
  }
  if (a.ay === a.by && b.ay === b.by && a.ay === b.ay) {
    const lo = Math.max(Math.min(a.ax, a.bx), Math.min(b.ax, b.bx));
    const hi = Math.min(Math.max(a.ax, a.bx), Math.max(b.ax, b.bx));
    return Math.max(0, hi - lo);
  }
  return 0;
}
