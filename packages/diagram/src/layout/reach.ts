/**
 * How far a unit's drawing reaches past its blocks: its wires routed the way the diagram routes
 * them and the labels of the wires it roots, measured, so a unit's rectangle, and the group frame
 * drawn around it, holds everything drawn for the unit.
 */

import { ceilTo, netLabelBox } from '../geometry.js';
import { NONE, SIDE_BOTTOM, SIDE_LEFT, SIDE_RIGHT, STYLE_WIRE, type Prepared } from '../prepare.js';
import type { RouteContext } from '../route/index.js';
import { rootLabels, routeOrthogonal } from '../route/orthogonal.js';
import type { RouteWriter } from '../route/straight.js';
import { Occupancy } from './occupancy.js';

/** Room a label keeps clear right of its text, in grid steps. */
const LABEL_CLEARANCE = 0.5;
/** Units up to this many blocks answer obstacle queries by a scan; larger ones index their blocks. */
const SCAN_BLOCKS = 32;

/**
 * Per port: how far right of its anchor the label of the wire it roots reaches, a clearance
 * included, on the grid; `0` for a port that roots no labeled wire.
 *
 * @remarks
 * A wire's root is its driver, else its first port; its label is drawn in its `netLabelBox` over
 * the root's stub end once the wire joins two ports (`rootLabels`).
 */
export function labelSpans(prepared: Prepared): Float32Array {
  const widths = rootLabels(prepared);
  const m = prepared.metrics;
  const spans = new Float32Array(prepared.portCount);
  const box = new Float64Array(4);
  for (let port = 0; port < widths.length; port++) {
    if (widths[port] === 0) continue;
    netLabelBox(m, 0, 0, widths[port]!, box);
    spans[port] = ceilTo(box[2]! + LABEL_CLEARANCE * m.grid, m.grid);
  }
  return spans;
}

/**
 * Measures a unit's reach: routes its wires in isolation, over its own blocks, and bounds them
 * with the labels of the wires it roots.
 *
 * @remarks
 * A wire is routed when it joins two of the unit's ports and its driver, if any, is in the unit:
 * the wires the layout lays out. Routed alone, a unit's wires take the paths they take among the
 * rest, since every other unit keeps a gap clear of the rectangle this measures. The router's
 * lane shifts follow the order measured, as `laneShifts` has them for a canonical order, so every
 * unit of one shape routes as the one measured. A label is bounded at both anchors a router may
 * give it: the root's stub end (orthogonal routing) and the root itself (straight routing).
 * A measure keeps the vertical runs it routed and the unit's label boxes at the orthogonal
 * anchors, so `clearance` can tell how far each column gap must open for the runs to miss them.
 */
export class Reach {
  /** Per port: `labelSpans` of the prepared netlist. */
  readonly labelSpan: Float32Array;

  private readonly prepared: Prepared;
  /** Per port: `rootLabels` of the prepared netlist. */
  private readonly labelWidth: Float64Array;
  /** The label boxes of the last unit measured, 4 each (`x0, y0, x1, y1`), by least `x0`. */
  private boxes = new Float64Array(64);
  private boxCount = 0;
  private boxOrder = new Uint32Array(16);
  /** Per block and per net: the stamp of the measure that reads it as the unit's. */
  private readonly member: Uint32Array;
  private readonly visited: Uint32Array;
  private stamp = 0;
  /** The unit being measured, and an index of it when it is too large to scan: its obstacles. */
  private order: Uint32Array = new Uint32Array(0);
  private index: Occupancy | null = null;
  private readonly writer = new Bounds();
  private readonly obstacles: RouteContext['obstacles'];
  private context: RouteContext | null = null;
  /** Per block: its lane shift in the unit being measured; see `laneShifts`. */
  private readonly shift: Uint8Array;
  /** A label's line box, from an anchor at the origin. */
  private readonly label = new Float64Array(4);

  constructor(prepared: Prepared, labelSpan: Float32Array = labelSpans(prepared)) {
    this.prepared = prepared;
    this.labelSpan = labelSpan;
    this.labelWidth = rootLabels(prepared);
    this.member = new Uint32Array(prepared.blockCount);
    this.visited = new Uint32Array(prepared.netCount);
    this.shift = new Uint8Array(prepared.blockCount);
    this.obstacles = (x0, y0, x1, y1, visit) => {
      if (this.index) this.index.visit(x0, y0, x1, y1, visit);
      else this.scan(x0, y0, x1, y1, visit);
    };
  }

  /**
   * Grow `box` (`[x0, y0, x1, y1]`) by the wires and labels of the unit `order`, its blocks at
   * `at` (2 per block of the order).
   */
  measure(order: Uint32Array, at: Float32Array, box: Float64Array): void {
    const p = this.prepared;
    const { portNet, portBlock, portOffset, portSide, netStyle, netDriver } = p;
    const { portStart, netStart, netPorts } = p.netlist;
    const stub = p.metrics.stub;
    const n = order.length;
    if (++this.stamp === 0x100000000) {
      this.member.fill(0);
      this.visited.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const context = this.bind();
    const positions = context.positions;
    for (let i = 0; i < n; i++) {
      const block = order[i]!;
      this.member[block] = stamp;
      this.shift[block] = i & 1;
      positions[2 * block] = at[2 * i]!;
      positions[2 * block + 1] = at[2 * i + 1]!;
    }
    this.order = order;
    this.index = n > SCAN_BLOCKS ? this.indexOf(order, positions) : null;

    const writer = this.writer;
    writer.reset();
    for (let i = 0; i < n; i++) {
      const block = order[i]!;
      for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
        const net = portNet[port]!;
        if (net === NONE || netStyle[net] !== STYLE_WIRE || this.visited[net] === stamp) continue;
        this.visited[net] = stamp;
        const driver = netDriver[net]!;
        if (driver !== NONE && this.member[portBlock[driver]!] !== stamp) continue;
        let inside = 0;
        for (let k = netStart[net]!; k < netStart[net + 1]! && inside < 2; k++) {
          if (this.member[portBlock[netPorts[k]!]!] === stamp) inside++;
        }
        if (inside >= 2) routeOrthogonal(context, net, writer);
      }
    }

    // Labels, from both anchors: the root (straight) and its stub end (orthogonal), where the
    // label's box is kept for `clearance`.
    const top = netLabelBox(p.metrics, 0, 0, 0, this.label)[1]!;
    this.boxCount = 0;
    for (let i = 0; i < n; i++) {
      const block = order[i]!;
      const x = at[2 * i]!;
      const y = at[2 * i + 1]!;
      for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
        const span = this.labelSpan[port]!;
        if (span === 0) continue;
        const side = portSide[port]!;
        const px = x + portOffset[2 * port]!;
        const py = y + portOffset[2 * port + 1]!;
        const dx = side === SIDE_LEFT ? -stub : side === SIDE_RIGHT ? stub : 0;
        const dy =
          side === SIDE_LEFT || side === SIDE_RIGHT ? 0 : side === SIDE_BOTTOM ? stub : -stub;
        writer.add(px + Math.min(0, dx), py + Math.min(0, dy) + top);
        writer.add(px + Math.max(0, dx) + span, py + Math.max(0, dy));
        this.keepBox(px + dx, py + dy, this.labelWidth[port]!);
      }
    }
    this.sortBoxes();

    for (let i = 0; i < n; i++) {
      const block = order[i]!;
      positions[2 * block] = Number.NaN;
      positions[2 * block + 1] = Number.NaN;
    }
    this.index = null;
    if (writer.x0 > writer.x1) return;
    box[0] = Math.min(box[0]!, writer.x0);
    box[1] = Math.min(box[1]!, writer.y0);
    box[2] = Math.max(box[2]!, writer.x1);
    box[3] = Math.max(box[3]!, writer.y1);
  }

  /**
   * How far each column gap of the unit measured last must open so that no vertical run routed
   * through it crosses a label the unit draws, into `need` (one per gap, grid multiples): the most
   * any run in the gap must move right to clear every label box it meets.
   *
   * @remarks
   * A run between two columns nests beside the column it rises, climbs, or jogs into, a track per
   * port (see the router's `below`), so opening the gap carries it right by as much, while the
   * labels stay over the stub ends of the column before. A run that leaves a column downward
   * already takes a track past the labels of the wires below it; one crossing a label anyway is
   * reported too, and opening its gap moves it nowhere.
   *
   * @param columns - Per column, left to right: the least and greatest x of its blocks with their
   *   extents, at the positions measured.
   * @param need - Per gap between columns `k` and `k + 1`: written.
   * @returns Whether any gap must open.
   */
  clearance(columns: Float64Array, need: Float64Array): boolean {
    need.fill(0);
    const { runs, runCount } = this.writer;
    const { boxes, boxCount, boxOrder } = this;
    const g = this.prepared.metrics.grid;
    const layers = columns.length / 2;
    let widest = 0;
    for (let b = 0; b < boxCount; b++) widest = Math.max(widest, boxes[4 * b + 2]! - boxes[4 * b]!);
    let any = false;
    for (let r = 0; r < runCount; r++) {
      const x = runs[3 * r]!;
      const y0 = runs[3 * r + 1]!;
      const y1 = runs[3 * r + 2]!;
      // The gap right of the last column whose right edge is left of the run.
      let lo = 0;
      let hi = layers;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (columns[2 * mid + 1]! < x) lo = mid + 1;
        else hi = mid;
      }
      const gap = lo - 1;
      if (gap < 0 || gap >= layers - 1 || !(x < columns[2 * gap + 2]!)) continue;
      // Boxes starting left of the run, back to the widest a box can reach it from.
      lo = 0;
      hi = boxCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (boxes[4 * boxOrder[mid]!]! < x) lo = mid + 1;
        else hi = mid;
      }
      for (let k = lo - 1; k >= 0; k--) {
        const at = 4 * boxOrder[k]!;
        if (boxes[at]! <= x - widest) break;
        if (!(x < boxes[at + 2]! && boxes[at + 1]! < y1 && y0 < boxes[at + 3]!)) continue;
        const move = ceilTo(boxes[at + 2]! - x, g);
        if (move > need[gap]!) need[gap] = move;
        any = true;
      }
    }
    return any;
  }

  /** Keep the label box over an orthogonal anchor at `(x, y)` of a label `width` wide. */
  private keepBox(x: number, y: number, width: number): void {
    if (4 * this.boxCount === this.boxes.length) {
      const boxes = new Float64Array(2 * this.boxes.length);
      boxes.set(this.boxes);
      this.boxes = boxes;
    }
    netLabelBox(this.prepared.metrics, x, y, width, this.label);
    this.boxes.set(this.label, 4 * this.boxCount++);
  }

  /** Order the kept boxes by their left edges, ties by index. */
  private sortBoxes(): void {
    const count = this.boxCount;
    if (this.boxOrder.length < count) this.boxOrder = new Uint32Array(2 * count);
    const order = this.boxOrder.subarray(0, count);
    for (let b = 0; b < count; b++) order[b] = b;
    const boxes = this.boxes;
    order.sort((a, b) => boxes[4 * a]! - boxes[4 * b]! || a - b);
  }

  /** The route context over every block's position, NaN outside a measure; made on first use. */
  private bind(): RouteContext {
    this.context ??= {
      prepared: this.prepared,
      positions: new Float32Array(2 * this.prepared.blockCount).fill(Number.NaN),
      blockVisible: null,
      netVisible: null,
      mode: 'orthogonal',
      obstacles: this.obstacles,
      laneShift: this.shift,
    };
    return this.context;
  }

  /** An index of the unit's blocks with their extents, for a unit too large to scan. */
  private indexOf(order: Uint32Array, positions: Float32Array): Occupancy {
    const { size, extent } = this.prepared;
    let reach = 0;
    for (const block of order) {
      reach += Math.max(
        size[2 * block]! + extent[4 * block]! + extent[4 * block + 2]!,
        size[2 * block + 1]! + extent[4 * block + 1]! + extent[4 * block + 3]!,
      );
    }
    const index = new Occupancy(
      Math.max(8 * this.prepared.metrics.grid, (2 * reach) / order.length),
    );
    for (const block of order) {
      const x = positions[2 * block]!;
      const y = positions[2 * block + 1]!;
      index.add(
        block,
        x - extent[4 * block]!,
        y - extent[4 * block + 1]!,
        x + size[2 * block]! + extent[4 * block + 2]!,
        y + size[2 * block + 1]! + extent[4 * block + 3]!,
      );
    }
    return index;
  }

  /** Visit the unit's blocks whose extent rectangle's interior meets a box, by a scan. */
  private scan(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    visit: (block: number) => void,
  ): void {
    const { size, extent } = this.prepared;
    const positions = this.context!.positions;
    for (const block of this.order) {
      const x = positions[2 * block]!;
      const y = positions[2 * block + 1]!;
      if (
        x - extent[4 * block]! < x1 &&
        x0 < x + size[2 * block]! + extent[4 * block + 2]! &&
        y - extent[4 * block + 1]! < y1 &&
        y0 < y + size[2 * block + 1]! + extent[4 * block + 3]!
      ) {
        visit(block);
      }
    }
  }
}

/**
 * A route writer that keeps the box of what is written (segment ends and points) and the vertical
 * runs among the segments.
 */
class Bounds implements RouteWriter {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  /** Vertical runs, 3 each: `x`, top, bottom. */
  runs = new Float64Array(96);
  runCount = 0;

  reset(): void {
    this.x0 = Infinity;
    this.y0 = Infinity;
    this.x1 = -Infinity;
    this.y1 = -Infinity;
    this.runCount = 0;
  }

  add(x: number, y: number): void {
    if (x < this.x0) this.x0 = x;
    if (y < this.y0) this.y0 = y;
    if (x > this.x1) this.x1 = x;
    if (y > this.y1) this.y1 = y;
  }

  segment(ax: number, ay: number, bx: number, by: number): void {
    this.add(ax, ay);
    this.add(bx, by);
    if (ax !== bx || ay === by) return;
    if (3 * this.runCount === this.runs.length) {
      const runs = new Float64Array(2 * this.runs.length);
      runs.set(this.runs);
      this.runs = runs;
    }
    const at = 3 * this.runCount++;
    this.runs[at] = ax;
    this.runs[at + 1] = Math.min(ay, by);
    this.runs[at + 2] = Math.max(ay, by);
  }

  junction(x: number, y: number): void {
    this.add(x, y);
  }

  arrow(x: number, y: number): void {
    this.add(x, y);
  }

  anchor(): void {
    // Labels are bounded from their roots, at every anchor a router may give them.
  }
}
