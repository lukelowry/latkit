/**
 * Right-angle routing on the grid, the way a hand-drawn block diagram runs its wires: a stub out
 * of every port, one vertical trunk between columns for the readers ahead of the root, a U-turn
 * through a lane under the blocks for the readers behind it, and T-junctions where branches leave.
 *
 * @remarks
 * A route is built as a tree of joints rooted at the root port. Each reader's path is traced into
 * the tree from the root's stub end, following whatever part of it is already drawn, so readers
 * share the trunk and the lane without overlapping segments; junctions are the joints where three
 * or more directions meet, and `along` is each joint's distance from the root through the tree.
 *
 * Everything is worked out in the root's frame, `u = s * x`, where `s` mirrors a diagram whose
 * signal flows right to left (a root on a block's left side) so the rules read in one direction.
 * All state is module scratch in typed arrays: routing a net allocates nothing but, for a trunk
 * of many rows, the view that sorts them.
 */

import { netLabelBox, textWidth } from '../geometry.js';
import { partIndex, partKind, PART_PORT } from '../part.js';
import {
  FLOW_IN,
  NONE,
  SIDE_LEFT,
  SIDE_RIGHT,
  SIDE_TOP,
  STYLE_WIRE,
  type Prepared,
} from '../prepare.js';
import type { RouteContext } from './index.js';
import { members, normalX, normalY, portX, portY, type RouteWriter } from './straight.js';

/** `rootLabels` per prepared netlist, measured on first use. */
const rootLabelCache = new WeakMap<Prepared, Float64Array>();

/**
 * Per port: the width of the label drawn over the wire it roots (`textWidth(label, labelEm)`), or
 * `0` for a port that roots no labeled wire. A wire's root is its driver, else its first port, and
 * only a wire joining two ports or more is drawn with its label, in its `netLabelBox` over the
 * root's stub end. Measured once per prepared netlist.
 */
export function rootLabels(prepared: Prepared): Float64Array {
  let widths = rootLabelCache.get(prepared);
  if (widths) return widths;
  const { portCount, netCount, netStyle, netDriver, metrics } = prepared;
  const { netStart, netPorts, netLabel } = prepared.netlist;
  widths = new Float64Array(portCount);
  for (let net = 0; netLabel && net < netCount; net++) {
    const label = netLabel[net];
    if (!label || netStyle[net] !== STYLE_WIRE || netStart[net + 1]! - netStart[net]! < 2) {
      continue;
    }
    const root = netDriver[net] !== NONE ? netDriver[net]! : netPorts[netStart[net]!]!;
    widths[root] = textWidth(label, metrics.labelEm);
  }
  rootLabelCache.set(prepared, widths);
  return widths;
}

/** Candidate grid lines a channel search tries before settling for the fewest crossings. */
const MAX_CANDIDATES = 16;
/** Deepest nesting a port's rank adds to a lane or an offset, in lanes or grid steps. */
const MAX_RANK = 8;
/** Passes that deepen a lane past blocks reaching below the band it runs under. */
const MAX_DEPTH_PASSES = 8;
/** Grid steps within which a block under another continues its column's stack. */
const STACK_GAP = 8;
/** Blocks a stack walk follows down a column. */
const MAX_STACK = 32;

/** A reader the trunk serves. */
const FORWARD = 1;
/** A reader the lane serves. */
const BACKWARD = 2;

/** Joint flags. */
const DEAD = 1;
const TERMINAL = 2;

/** The root joint: the root port itself. */
const ROOT = 0;

/**
 * One route as a tree of joints rooted at the root port, in the root's frame. Edges run from each
 * joint to its parent and are axis-aligned; children are linked lists so a trace finds the edge
 * leaving a joint in a direction in O(degree).
 */
class Tree {
  size = 0;
  x = new Float64Array(64);
  y = new Float64Array(64);
  /** Distance from the root through the tree. */
  along = new Float64Array(64);
  parent = new Int32Array(64);
  first = new Int32Array(64);
  next = new Int32Array(64);
  kids = new Int32Array(64);
  flags = new Uint8Array(64);
  /** Per joint with one child, that child; filled before emitting. */
  only = new Int32Array(64);
  /** Pruning worklist. */
  private stack = new Int32Array(64);

  /** Start over with the root at `(x, y)`. */
  clear(x: number, y: number): void {
    this.size = 0;
    this.add(x, y, -1);
  }

  /** A new joint at `(x, y)` under `parent` (-1 for the root). */
  add(x: number, y: number, parent: number): number {
    if (this.size === this.x.length) this.grow();
    const j = this.size++;
    this.x[j] = x;
    this.y[j] = y;
    this.first[j] = -1;
    this.next[j] = -1;
    this.kids[j] = 0;
    this.flags[j] = 0;
    this.parent[j] = -1;
    if (parent < 0) {
      this.along[j] = 0;
      return j;
    }
    this.along[j] =
      this.along[parent]! + Math.abs(x - this.x[parent]!) + Math.abs(y - this.y[parent]!);
    this.link(j, parent);
    return j;
  }

  /**
   * Trace a straight run from joint `from` to `(x, y)`, following edges already drawn in that
   * direction and splitting the one the point falls inside. Returns the joint at `(x, y)`.
   */
  lineTo(from: number, x: number, y: number): number {
    let j = from;
    for (;;) {
      const jx = this.x[j]!;
      const jy = this.y[j]!;
      if (jx === x && jy === y) return j;
      const dx = Math.sign(x - jx);
      const dy = Math.sign(y - jy);
      // A diagonal never arises from the planner; draw it rather than loop on it.
      if (dx !== 0 && dy !== 0) return this.add(x, y, j);
      const k = this.toward(j, dx, dy);
      if (k < 0) return this.add(x, y, j);
      const reach = Math.abs(this.x[k]! - jx) + Math.abs(this.y[k]! - jy);
      const want = Math.abs(x - jx) + Math.abs(y - jy);
      if (want < reach) return this.split(j, k, x, y);
      j = k;
    }
  }

  /** Mark the joint a reader's path ends at. */
  terminal(j: number): void {
    this.flags[j]! |= TERMINAL;
  }

  /** Drop every branch that ends short of a reader: the tail a path leaves when it turns back. */
  prune(): void {
    if (this.stack.length < this.size) this.stack = new Int32Array(this.x.length);
    let top = 0;
    for (let j = 1; j < this.size; j++) if (this.kids[j] === 0) this.stack[top++] = j;
    while (top > 0) {
      const j = this.stack[--top]!;
      if (j === ROOT || this.flags[j]! & (DEAD | TERMINAL) || this.kids[j]! > 0) continue;
      this.flags[j]! |= DEAD;
      const p = this.parent[j]!;
      this.unlink(j);
      if (p !== ROOT) this.stack[top++] = p;
    }
  }

  /** Write every segment, collinear runs merged, and a junction wherever three directions meet. */
  emit(out: RouteWriter, s: number): void {
    for (let j = 1; j < this.size; j++) {
      if (!(this.flags[j]! & DEAD)) this.only[this.parent[j]!] = j;
    }
    for (let j = 1; j < this.size; j++) {
      if (this.flags[j]! & DEAD || this.through(j)) continue;
      let top = this.parent[j]!;
      while (this.through(top)) top = this.parent[top]!;
      out.segment(
        world(s, this.x[top]!),
        this.y[top]!,
        world(s, this.x[j]!),
        this.y[j]!,
        this.along[top]!,
      );
    }
    for (let j = 0; j < this.size; j++) {
      if (this.flags[j]! & DEAD) continue;
      if (this.kids[j]! + (j === ROOT ? 0 : 1) >= 3) out.junction(world(s, this.x[j]!), this.y[j]!);
    }
  }

  /** The points from the root to joint `to`, corners only, as world `x, y` pairs. */
  path(to: number, s: number): Float32Array {
    let count = 0;
    for (let j = to; j >= 0; j = this.parent[j]!) count++;
    const chain = new Int32Array(count);
    for (let j = to, i = count - 1; j >= 0; j = this.parent[j]!, i--) chain[i] = j;
    const points: number[] = [];
    for (let i = 0; i < count; i++) {
      const j = chain[i]!;
      // Keep the ends and every corner; a joint in line with both neighbors adds nothing.
      if (i > 0 && i < count - 1 && collinear(this, chain[i - 1]!, j, chain[i + 1]!)) continue;
      points.push(world(s, this.x[j]!), this.y[j]!);
    }
    return Float32Array.from(points);
  }

  /** Whether joint `j` only continues a straight run: one parent, one child, all in line. */
  private through(j: number): boolean {
    return (
      j !== ROOT &&
      this.kids[j] === 1 &&
      !(this.flags[j]! & TERMINAL) &&
      collinear(this, this.parent[j]!, j, this.only[j]!)
    );
  }

  /** The neighbor of `j` in direction `(dx, dy)`: its parent or a live child, or -1. */
  private toward(j: number, dx: number, dy: number): number {
    const p = this.parent[j]!;
    if (p >= 0 && this.heads(j, p, dx, dy)) return p;
    for (let c = this.first[j]!; c >= 0; c = this.next[c]!) {
      if (this.heads(j, c, dx, dy)) return c;
    }
    return -1;
  }

  /** Whether the edge from `a` to `b` heads in direction `(dx, dy)`. */
  private heads(a: number, b: number, dx: number, dy: number): boolean {
    return Math.sign(this.x[b]! - this.x[a]!) === dx && Math.sign(this.y[b]! - this.y[a]!) === dy;
  }

  /** Split the edge between neighbors `a` and `b` with a joint at `(x, y)`. */
  private split(a: number, b: number, x: number, y: number): number {
    const upper = this.parent[b] === a ? a : b;
    const lower = upper === a ? b : a;
    const t = this.add(x, y, upper);
    this.unlink(lower);
    this.link(lower, t);
    return t;
  }

  private link(child: number, parent: number): void {
    this.parent[child] = parent;
    this.next[child] = this.first[parent]!;
    this.first[parent] = child;
    this.kids[parent]!++;
  }

  private unlink(child: number): void {
    const p = this.parent[child]!;
    if (this.first[p] === child) this.first[p] = this.next[child]!;
    else {
      let c = this.first[p]!;
      while (this.next[c] !== child) c = this.next[c]!;
      this.next[c] = this.next[child]!;
    }
    this.kids[p]!--;
    this.parent[child] = -1;
  }

  private grow(): void {
    const n = 2 * this.x.length;
    this.x = grown(this.x, new Float64Array(n));
    this.y = grown(this.y, new Float64Array(n));
    this.along = grown(this.along, new Float64Array(n));
    this.parent = grown(this.parent, new Int32Array(n));
    this.first = grown(this.first, new Int32Array(n));
    this.next = grown(this.next, new Int32Array(n));
    this.kids = grown(this.kids, new Int32Array(n));
    this.flags = grown(this.flags, new Uint8Array(n));
    this.only = new Int32Array(n);
  }
}

/** `into` holding `from`'s values. */
function grown<T extends Float64Array | Int32Array | Uint8Array>(from: T, into: T): T {
  into.set(from);
  return into;
}

/** Whether joints `a`, `b`, `c` lie on one axis-aligned line. */
function collinear(tree: Tree, a: number, b: number, c: number): boolean {
  const { x, y } = tree;
  return (x[a] === x[b] && x[b] === x[c]) || (y[a] === y[b] && y[b] === y[c]);
}

/** A root-frame coordinate back in diagram x, never `-0`. */
function world(s: number, u: number): number {
  return s === 1 ? u : 0 - u;
}

const tree = new Tree();

/**
 * The members of the route being planned, in the root's frame: port position, outward normal,
 * stub end, class, and the x a backward reader's rise prefers and runs at. Index 0 is the root.
 */
const plan = {
  qx: new Float64Array(16),
  qy: new Float64Array(16),
  nx: new Int8Array(16),
  ny: new Int8Array(16),
  rx: new Float64Array(16),
  ry: new Float64Array(16),
  kind: new Uint8Array(16),
  rise: new Float64Array(16),
  run: new Float64Array(16),
  /** The frame: `1`, or `-1` when the flow runs right to left. */
  s: 1,
  /** The joint each member's path ends at. */
  end: new Int32Array(16),
  /** Per forward reader: the row its branch leaves the trunk at. */
  row: new Float64Array(16),
  /** Per forward reader: the line its detour climbs or falls along, or NaN for none. */
  line: new Float64Array(16),
};

/** Size the plan for `count` members. */
function reserve(count: number): void {
  if (plan.qx.length >= count) return;
  const n = 2 * count;
  plan.qx = new Float64Array(n);
  plan.qy = new Float64Array(n);
  plan.nx = new Int8Array(n);
  plan.ny = new Int8Array(n);
  plan.rx = new Float64Array(n);
  plan.ry = new Float64Array(n);
  plan.kind = new Uint8Array(n);
  plan.rise = new Float64Array(n);
  plan.run = new Float64Array(n);
  plan.end = new Int32Array(n);
  plan.row = new Float64Array(n);
  plan.line = new Float64Array(n);
}

/**
 * The trunk's rows, ascending and distinct: every y a forward branch meets it at, with the joint
 * drawn there so far, or -1. Tracing a branch from the nearest row already drawn lands on the joint
 * a trace from the trunk's join would: the trunk is one straight chain of joints, and a trace
 * along it from any of them splits or extends the same edge. Each trace then takes one step, and
 * finding the nearest drawn row costs, over a whole route, no more than splitting the rows in half
 * again and again: `O(k log k)` for `k` readers where a walk from the join costs `O(k^2)`.
 */
const trunkRows = {
  y: new Float64Array(16),
  joint: new Int32Array(16),
  count: 0,
  /** The trunk's line. */
  x: 0,
};

/** Rows at most this many sort by insertion; more by the typed array's own sort. */
const INSERTION_SORT = 32;

/**
 * Collect the trunk's rows from the planned forward readers: the join's row `ey`, each branch's
 * row, and the reader's own row for a detour that runs down the trunk itself.
 */
function trunkRowsOf(join: number, x: number, ey: number, count: number): void {
  const { kind, row, line, ry } = plan;
  let n = 1;
  for (let i = 1; i < count; i++) if (kind[i] === FORWARD) n += line[i] === x ? 2 : 1;
  if (trunkRows.y.length < n) {
    trunkRows.y = new Float64Array(2 * n);
    trunkRows.joint = new Int32Array(2 * n);
  }
  const ys = trunkRows.y;
  ys[0] = ey;
  n = 1;
  for (let i = 1; i < count; i++) {
    if (kind[i] !== FORWARD) continue;
    ys[n++] = row[i]!;
    if (line[i] === x) ys[n++] = ry[i]!;
  }
  if (n <= INSERTION_SORT) {
    for (let i = 1; i < n; i++) {
      const v = ys[i]!;
      let k = i - 1;
      while (k >= 0 && ys[k]! > v) {
        ys[k + 1] = ys[k]!;
        k--;
      }
      ys[k + 1] = v;
    }
  } else ys.subarray(0, n).sort();
  let distinct = 0;
  for (let i = 0; i < n; i++) if (i === 0 || ys[i] !== ys[distinct - 1]) ys[distinct++] = ys[i]!;
  trunkRows.count = distinct;
  trunkRows.x = x;
  trunkRows.joint.fill(-1, 0, distinct);
  trunkRows.joint[rowIndex(ey)] = join;
}

/** The index of row `y`, one of the trunk's rows. */
function rowIndex(y: number): number {
  const ys = trunkRows.y;
  let lo = 0;
  let hi = trunkRows.count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ys[mid]! < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The trunk's joint at row `y`, drawn from the nearest row already drawn when it is new. */
function trunkAt(y: number): number {
  const { joint, count } = trunkRows;
  const at = rowIndex(y);
  if (joint[at]! >= 0) return joint[at]!;
  // The join's row is drawn, so looking both ways always finds one.
  let from = -1;
  for (let step = 1; from < 0 && (at - step >= 0 || at + step < count); step++) {
    if (at - step >= 0 && joint[at - step]! >= 0) from = joint[at - step]!;
    else if (at + step < count && joint[at + step]! >= 0) from = joint[at + step]!;
  }
  const j = tree.lineTo(from, trunkRows.x, y);
  joint[at] = j;
  return j;
}

/** What a plan reads besides its members. */
interface Scope {
  prepared: Prepared;
  positions: Float32Array;
  blockVisible: Float32Array | null;
  obstacles: RouteContext['obstacles'];
  laneShift: Uint8Array | null;
  /** `rootLabels` of the prepared netlist. */
  labels: Float64Array;
}

/** The scope of the plan in progress, read by the obstacle visitors. */
const scope: Scope = {
  prepared: null as unknown as Prepared,
  positions: new Float32Array(0),
  blockVisible: null,
  obstacles: noObstacles,
  laneShift: null,
  labels: new Float64Array(0),
};

/** An obstacle query that finds nothing, for previews. */
function noObstacles(): void {}

// Obstacle visitors write here; module functions, so a query allocates no closure.
let crossed = 0;
let deepest = 0;
/** A block crossings do not count: the reader a branch is approaching, whose extents it meets. */
let ignored = -1;

function countCrossing(block: number): void {
  const visible = scope.blockVisible;
  if (block !== ignored && (visible === null || visible[block] !== 0)) crossed++;
}

function deepen(block: number): void {
  const visible = scope.blockVisible;
  if (visible !== null && visible[block] === 0) return;
  const bottom = blockBottom(scope.prepared, scope.positions, block);
  if (bottom > deepest) deepest = bottom;
}

let shallowest = Infinity;
let shallowestBottom = 0;

function underneath(block: number): void {
  const { prepared, positions, blockVisible } = scope;
  if (blockVisible !== null && blockVisible[block] === 0) return;
  const top = positions[2 * block + 1]! - prepared.extent[4 * block + 1]!;
  if (top >= shallowest) return;
  shallowest = top;
  shallowestBottom = blockBottom(prepared, positions, block);
}

/** The lowest point a block reaches: its bottom edge plus its bottom extent (tags, label). */
function blockBottom(prepared: Prepared, positions: Float32Array, block: number): number {
  return (
    positions[2 * block + 1]! + prepared.size[2 * block + 1]! + prepared.extent[4 * block + 3]!
  );
}

/** A block's lesser edge along u in the plan's frame. */
function edgeLow(block: number): number {
  const x0 = scope.positions[2 * block]!;
  return plan.s === 1 ? x0 : -(x0 + scope.prepared.size[2 * block]!);
}

/** A block's greater edge along u in the plan's frame. */
function edgeHigh(block: number): number {
  const x0 = scope.positions[2 * block]!;
  return plan.s === 1 ? x0 + scope.prepared.size[2 * block]! : -x0;
}

/**
 * Blocks whose extents cross the vertical run at `u` from `y0` to `y1` (in the plan's frame).
 */
function crossings(u: number, y0: number, y1: number): number {
  if (y0 === y1) return 0;
  crossed = 0;
  const x = world(plan.s, u);
  scope.obstacles(x, Math.min(y0, y1), x, Math.max(y0, y1), countCrossing);
  return crossed;
}

/** Blocks whose extents cross the horizontal run at `y` from `u0` to `u1` (in the plan's frame). */
function across(u0: number, u1: number, y: number): number {
  if (u0 === u1) return 0;
  crossed = 0;
  const x0 = world(plan.s, u0);
  const x1 = world(plan.s, u1);
  scope.obstacles(Math.min(x0, x1), y, Math.max(x0, x1), y, countCrossing);
  return crossed;
}

// The extents of the blocks in a branch's way.
let spanTop = Infinity;
let spanBottom = -Infinity;

/** Count a block in a branch's way, as `countCrossing` does, and take in its extents. */
function spanVisit(block: number): void {
  const { prepared, positions, blockVisible } = scope;
  if (block === ignored || (blockVisible !== null && blockVisible[block] === 0)) return;
  crossed++;
  const top = positions[2 * block + 1]! - prepared.extent[4 * block + 1]!;
  if (top < spanTop) spanTop = top;
  const bottom = blockBottom(prepared, positions, block);
  if (bottom > spanBottom) spanBottom = bottom;
}

/**
 * `across(u0, u1, y)`, keeping the top and bottom extents of the blocks it counts in `spanTop`
 * and `spanBottom` for a detour around them.
 */
function span(u0: number, u1: number, y: number): number {
  spanTop = Infinity;
  spanBottom = -Infinity;
  if (u0 === u1) return 0;
  crossed = 0;
  const x0 = world(plan.s, u0);
  const x1 = world(plan.s, u1);
  scope.obstacles(Math.min(x0, x1), y, Math.max(x0, x1), y, spanVisit);
  return crossed;
}

// The blocks a channel search's band meets, by the world x extent of each, so one obstacle
// query answers the crossings of every line the search tries.
let bandCount = 0;
let bandLow = new Float64Array(64);
let bandHigh = new Float64Array(64);

function bandVisit(block: number): void {
  const { prepared, positions, blockVisible } = scope;
  if (block === ignored || (blockVisible !== null && blockVisible[block] === 0)) return;
  if (bandCount === bandLow.length) {
    bandLow = grown(bandLow, new Float64Array(2 * bandCount));
    bandHigh = grown(bandHigh, new Float64Array(2 * bandCount));
  }
  const x0 = positions[2 * block]!;
  bandLow[bandCount] = x0 - prepared.extent[4 * block]!;
  bandHigh[bandCount] = x0 + prepared.size[2 * block]! + prepared.extent[4 * block + 2]!;
  bandCount++;
}

/**
 * The band's blocks a vertical run at world `x` crosses: `crossings` for a line inside the band,
 * since a block whose extent meets the line meets the band over the same rows.
 */
function bandCrossings(x: number): number {
  let count = 0;
  for (let i = 0; i < bandCount; i++) if (bandLow[i]! < x && bandHigh[i]! > x) count++;
  return count;
}

/** The crossings of the line the last `channel` returned, or NaN when it tried none. */
let channelCost = Number.NaN;

/**
 * The grid line in `[lo, hi]` for a vertical run from `y0` to `y1` that crosses the fewest
 * blocks, searching outward from `pref` and taking the first line that crosses none. Its
 * crossings go to `channelCost`.
 */
function channel(pref: number, lo: number, hi: number, y0: number, y1: number, g: number): number {
  const first = Math.ceil(lo / g - 1e-9);
  const last = Math.floor(hi / g + 1e-9);
  channelCost = Number.NaN;
  if (first > last) return lo <= hi ? (lo + hi) / 2 : lo;
  const start = Math.min(last, Math.max(first, Math.round(pref / g)));
  if (y0 === y1) {
    channelCost = 0;
    return onGrid(start, g);
  }
  // Every line the search tries lies within `MAX_CANDIDATES` lines of the start.
  const x0 = world(plan.s, Math.max(first, start - MAX_CANDIDATES) * g);
  const x1 = world(plan.s, Math.min(last, start + MAX_CANDIDATES) * g);
  bandCount = 0;
  scope.obstacles(
    Math.min(x0, x1),
    Math.min(y0, y1),
    Math.max(x0, x1),
    Math.max(y0, y1),
    bandVisit,
  );
  let best = start;
  let fewest = Infinity;
  let tried = 0;
  for (let step = 0; tried < MAX_CANDIDATES; step++) {
    const up = start + step;
    const down = start - step;
    const upIn = up <= last;
    const downIn = step > 0 && down >= first;
    if (!upIn && !downIn) break;
    for (let side = 0; side < 2 && tried < MAX_CANDIDATES; side++) {
      const line = side === 0 ? up : down;
      if (side === 0 ? !upIn : !downIn) continue;
      const cost = bandCrossings(world(plan.s, line * g));
      tried++;
      if (cost < fewest) {
        fewest = cost;
        best = line;
        if (cost === 0) break;
      }
    }
    if (fewest === 0) break;
  }
  channelCost = fewest;
  return onGrid(best, g);
}

/** `steps` grid lines as a coordinate, never `-0`. */
function onGrid(steps: number, g: number): number {
  return steps === 0 ? 0 : steps * g;
}

/** `value` rounded up to the grid, within float noise. */
function ceilGrid(value: number, g: number): number {
  return onGrid(Math.ceil(value / g - 1e-9), g);
}

/** `value` rounded down to the grid, within float noise. */
function floorGrid(value: number, g: number): number {
  return onGrid(Math.floor(value / g + 1e-9), g);
}

// What a count of ports finds of the labels over their wires; see `track`.
/** Whether the ports counted face right in the diagram, the way the labels over wires reach. */
let clearing = false;
/** Ports counted on the blocks above the one being read. */
let clearBase = 0;
/** The least diagram x a run nesting outside the counted ports takes past their labels. */
let clearAt = -Infinity;
const labelBox = new Float64Array(4);

/**
 * Wired ports on `block`'s side facing `normal` (along u, in the plan's frame) below `y`. While
 * `clearing`, takes each counted port's label into `clearAt`: its end on the grid, a grid step
 * further for each port counted between (ports run down a side in port order).
 */
function edgePorts(block: number, normal: number, y: number): number {
  const { prepared, positions, labels } = scope;
  const start = prepared.netlist.portStart;
  const top = positions[2 * block + 1]!;
  let count = 0;
  for (let p = start[block]!; p < start[block + 1]!; p++) {
    if (plan.s * normalX(prepared.portSide[p]!) !== normal) continue;
    const net = prepared.portNet[p]!;
    if (net === NONE || prepared.netStyle[net] !== STYLE_WIRE) continue;
    const py = top + prepared.portOffset[2 * p + 1]!;
    if (py <= y) continue;
    if (clearing && labels[p]! > 0) {
      const m = prepared.metrics;
      const anchor = positions[2 * block]! + prepared.portOffset[2 * p]! + m.stub;
      const end = netLabelBox(m, anchor, py, labels[p]!, labelBox)[2]!;
      const at = ceilGrid(end, m.grid) + m.grid * (clearBase + count);
      if (at > clearAt) clearAt = at;
    }
    count++;
  }
  return count;
}

// The stack walk's visitor state.
let stackNormal = 0;
let stackFrom = 0;
let stackBottom = 0;
let stackPorts = 0;
let stackFound = false;

function stackVisit(block: number): void {
  const { prepared, positions, blockVisible } = scope;
  if (blockVisible !== null && blockVisible[block] === 0) return;
  // Only a block that starts below the window's top continues the stack; one reaching up past it
  // stands beside the stack, not under it.
  if (positions[2 * block + 1]! - prepared.extent[4 * block + 1]! < stackFrom) return;
  stackFound = true;
  stackPorts += edgePorts(block, stackNormal, -Infinity);
  const bottom = blockBottom(prepared, positions, block);
  if (bottom > stackBottom) stackBottom = bottom;
}

/**
 * The track a vertical run takes beside a column of blocks: how many wired ports face `normal`
 * below `port`, on its block and on the blocks stacked under it (each starting within
 * `STACK_GAP` grid steps of the one above). Runs take their line that many grid steps out from
 * the column, so every run along one column edge has a line of its own and runs nest: a wire from
 * higher up runs outside the ones below it. Wires arriving from below (rises, climbing trunks)
 * take tracks at the reader's edge; wires leaving downward (descents, falling trunks) at the
 * root's. Counting ports that face right in the diagram also finds where their labels end
 * (`clearAt`, for `track`).
 */
function below(block: number, port: number, normal: number): number {
  const { prepared, positions } = scope;
  const g = prepared.metrics.grid;
  clearing = plan.s * normal === 1;
  clearAt = -Infinity;
  clearBase = 0;
  let count = edgePorts(
    block,
    normal,
    positions[2 * block + 1]! + prepared.portOffset[2 * port + 1]!,
  );
  const x0 = positions[2 * block]!;
  const x1 = x0 + prepared.size[2 * block]!;
  let bottom = blockBottom(prepared, positions, block);
  for (let pass = 0; pass < MAX_STACK && count < MAX_RANK; pass++) {
    stackNormal = normal;
    stackFrom = bottom;
    stackBottom = bottom;
    stackPorts = 0;
    stackFound = false;
    // Every block a pass finds counts from here, whatever order the obstacles come in.
    clearBase = count;
    scope.obstacles(x0, bottom, x1, bottom + STACK_GAP * g, stackVisit);
    if (!stackFound) break;
    count += stackPorts;
    bottom = stackBottom;
  }
  clearing = false;
  return Math.min(count, MAX_RANK);
}

/** The rank the last `track` found: `below` of its port. */
let trackRank = 0;

/**
 * The line (along u, in the plan's frame) a vertical run beside `port`'s column takes: its track
 * (see `below`), `normal` out from `u`, the stub end it leaves or enters by. A run nesting to the
 * right of the diagram's ports also clears the label over each wire it nests outside, a grid step
 * further out per port between, so no run crosses the text of a wire below it while every run
 * still has a line of its own. Leaves the port's rank in `trackRank`.
 */
function track(block: number, port: number, normal: number, u: number): number {
  const rank = below(block, port, normal);
  trackRank = rank;
  const line = u + normal * scope.prepared.metrics.grid * rank;
  if (clearAt === -Infinity) return line;
  // Only a run nesting toward diagram +x clears labels, and that way is `normal` along u.
  const past = plan.s * clearAt;
  return normal === 1 ? Math.max(line, past) : Math.min(line, past);
}

/**
 * Plan the route of the gathered members (root first) into the tree, in the root's frame.
 * Returns the frame's sign.
 */
function build(scopeIn: Omit<Scope, 'labels'>, count: number): number {
  if (scope.prepared !== scopeIn.prepared) {
    scope.prepared = scopeIn.prepared;
    scope.labels = rootLabels(scopeIn.prepared);
  }
  scope.positions = scopeIn.positions;
  scope.blockVisible = scopeIn.blockVisible;
  scope.obstacles = scopeIn.obstacles;
  scope.laneShift = scopeIn.laneShift;
  const { prepared, positions } = scope;
  const { grid: g, stub } = prepared.metrics;
  const ports = members.ports;
  reserve(count);
  const { qx, qy, nx, ny, rx, ry, kind, rise, run, end } = plan;

  // The frame: flow runs away from a side root; a top or bottom root faces where its readers are.
  const root = ports[0]!;
  const rootSide = prepared.portSide[root]!;
  let s = 1;
  if (rootSide === SIDE_LEFT) s = -1;
  else if (rootSide !== SIDE_RIGHT) {
    let lean = 0;
    const x0 = portX(prepared, positions, root);
    for (let i = 1; i < count; i++) lean += portX(prepared, positions, ports[i]!) - x0;
    s = lean >= 0 ? 1 : -1;
  }
  plan.s = s;

  for (let i = 0; i < count; i++) {
    const port = ports[i]!;
    const side = prepared.portSide[port]!;
    qx[i] = s * portX(prepared, positions, port);
    qy[i] = portY(prepared, positions, port);
    nx[i] = s * normalX(side);
    ny[i] = normalY(side);
    rx[i] = qx[i]! + nx[i]! * stub;
    ry[i] = qy[i]! + ny[i]! * stub;
    kind[i] = 0;
  }

  const rootBlock = prepared.portBlock[root]!;
  const ex = rx[0]!;
  const ey = ry[0]!;
  const rootVertical = nx[0] === 0;
  const rootLow = positions[2 * rootBlock + 1]!;
  const rootHigh = rootLow + prepared.size[2 * rootBlock + 1]!;
  tree.clear(qx[0]!, qy[0]!);
  const exit = tree.lineTo(ROOT, ex, ey);

  // Readers ahead: a facing port whose stub end is not behind the trunk's earliest line, or a top
  // or bottom port whose block lies wholly past it. The nearest bounds the trunk.
  const lo0 = rootVertical ? edgeHigh(rootBlock) + stub : ex;
  let hi = Infinity;
  let nearest = -1;
  for (let i = 1; i < count; i++) {
    let bound: number;
    if (nx[i] === -1) bound = rx[i]!;
    else if (nx[i] === 0) bound = edgeLow(prepared.portBlock[ports[i]!]!) - stub;
    else continue;
    if (bound < lo0) {
      kind[i] = BACKWARD;
      continue;
    }
    kind[i] = FORWARD;
    if (bound < hi) hi = bound;
    if (nx[i] === -1 && (nearest < 0 || bound < rx[nearest]!)) nearest = i;
  }
  // A port facing the same way as the root joins from beyond it, when neither its branch nor the
  // root's run would pass through a block on the way.
  let lo = lo0;
  for (let i = 1; i < count; i++) {
    if (nx[i] !== 1) continue;
    const block = prepared.portBlock[ports[i]!]!;
    const readerLow = positions[2 * block + 1]!;
    const readerHigh = readerLow + prepared.size[2 * block + 1]!;
    const overRoot = ry[i]! > rootLow && ry[i]! < rootHigh && rx[i]! < edgeHigh(rootBlock);
    const throughReader = ey > readerLow && ey < readerHigh && edgeHigh(block) > ex;
    if (rx[i]! > hi || overRoot || throughReader) {
      kind[i] = BACKWARD;
      continue;
    }
    kind[i] = FORWARD;
    if (rx[i]! > lo) lo = rx[i]!;
  }

  let forward = 0;
  let backward = 0;
  let top = ey;
  let bottom = ey;
  for (let i = 1; i < count; i++) {
    if (kind[i] === FORWARD) {
      forward++;
      if (ry[i]! < top) top = ry[i]!;
      if (ry[i]! > bottom) bottom = ry[i]!;
    } else if (kind[i] === BACKWARD) backward++;
  }

  // The trunk: a grid line between the root and the nearest reader ahead, crossing the fewest
  // blocks, tried first on its track (see `below`): at the root's column when it falls to the
  // nearest reader, at the reader's when it climbs.
  let trunk = lo;
  if (forward > 0 && top !== bottom) {
    let pref = lo;
    if (nearest > 0 && ry[nearest]! > ey && !rootVertical) {
      pref = track(rootBlock, root, 1, ex);
    } else if (nearest > 0) {
      const port = ports[nearest]!;
      pref = track(prepared.portBlock[port]!, port, -1, rx[nearest]!);
    }
    trunk = channel(pref, lo, Number.isFinite(hi) ? hi : lo, top, bottom, g);
  }
  if (forward > 0) {
    const join = tree.lineTo(exit, trunk, ey);
    // Every branch is planned before any is drawn: planning reads only the blocks, never the
    // tree, so the rows the trunk carries are known up front.
    const { row, line } = plan;
    for (let i = 1; i < count; i++) {
      if (kind[i] !== FORWARD) continue;
      // A branch to a reader further on that would cross a block on its way jogs near the reader
      // instead, reaching it along a row that is clear.
      ignored = prepared.portBlock[ports[i]!]!;
      if (nx[i] !== 1 && span(trunk, rx[i]!, ry[i]!) > 0) detour(i, trunk, ey);
      else {
        row[i] = ry[i]!;
        line[i] = Number.NaN;
      }
      ignored = -1;
    }
    trunkRowsOf(join, trunk, ey, count);
    for (let i = 1; i < count; i++) {
      if (kind[i] !== FORWARD) continue;
      let j = trunkAt(row[i]!);
      // A detour runs along its row to its line, then along the line to the reader's height; a
      // line on the trunk itself runs down the trunk.
      if (line[i] === trunk) j = trunkAt(ry[i]!);
      else if (!Number.isNaN(line[i]!)) {
        j = tree.lineTo(tree.lineTo(j, line[i]!, row[i]!), line[i]!, ry[i]!);
      }
      j = tree.lineTo(j, rx[i]!, ry[i]!);
      end[i] = tree.lineTo(j, qx[i]!, qy[i]!);
      tree.terminal(end[i]!);
    }
  }

  if (backward > 0) {
    // Where each backward reader's rise runs, preferred first: on its track beside its column.
    let span0 = Infinity;
    let span1 = -Infinity;
    let low = Math.max(ey, blockBottom(prepared, positions, rootBlock));
    for (let i = 1; i < count; i++) {
      if (kind[i] !== BACKWARD) continue;
      const port = ports[i]!;
      const block = prepared.portBlock[port]!;
      rise[i] =
        nx[i] === 0
          ? ny[i] === 1
            ? rx[i]!
            : edgeLow(block) - stub
          : track(block, port, nx[i]!, rx[i]!);
      span0 = Math.min(span0, rise[i]!);
      span1 = Math.max(span1, rise[i]!);
      top = Math.min(top, ry[i]!);
      low = Math.max(low, ry[i]!, blockBottom(prepared, positions, block));
    }
    // The descent nests like a rise, and its lane with it: the higher the port it leaves, the
    // further out it runs and the deeper its lane. With readers ahead too, it continues the
    // trunk down, or leaves the root's run short of it, so it never crosses a forward branch.
    // Lanes of a shifted root block sit a grid step lower, so the feedback of two blocks of a
    // unit that share no column still keeps apart, while the lanes of one block stay evenly
    // spaced; the shift comes from the block's place in its unit, so identical units match.
    const room = MAX_CANDIDATES * g;
    const descent0 = rootSide === SIDE_TOP ? edgeHigh(rootBlock) + stub : ex;
    let laneRank = 0;
    let own = descent0;
    if (!rootVertical) {
      own = track(rootBlock, root, 1, descent0);
      laneRank = trackRank;
    }
    const descentPref = forward > 0 ? trunk : own;
    const descentMax = forward > 0 ? trunk : descentPref + room;
    span0 = Math.min(span0, descentPref);
    span1 = Math.max(span1, descentPref);

    // The lane runs under every block between the descent and the rises. The runs down to it are
    // searched sideways once it is known; when that widens the stretch it spans, it settles again.
    const shift = scope.laneShift?.[rootBlock] ?? 0;
    const offset = 2 * g * (1 + laneRank) + g * shift;
    let lane = laneAt(span0, span1, top, low, offset, g);
    let descent = descentPref;
    for (let pass = 0; pass < 2; pass++) {
      descent = channel(descentPref, descent0, descentMax, ey, lane, g);
      let reach0 = Math.min(span0, descent);
      let reach1 = Math.max(span1, descent);
      for (let i = 1; i < count; i++) {
        if (kind[i] !== BACKWARD) continue;
        let x = rise[i]!;
        if (nx[i] === -1) x = channel(x, Math.min(rx[i]!, x) - room, rx[i]!, ry[i]!, lane, g);
        else if (nx[i] === 1) x = channel(x, rx[i]!, Math.max(rx[i]!, x) + room, ry[i]!, lane, g);
        else if (ny[i] === -1) x = channel(x, x - room, x, ry[i]!, lane, g);
        run[i] = x;
        reach0 = Math.min(reach0, x);
        reach1 = Math.max(reach1, x);
      }
      if (reach0 >= span0 && reach1 <= span1) break;
      span0 = reach0;
      span1 = reach1;
      const deeper = laneAt(span0, span1, top, low, offset, g);
      if (deeper === lane) break;
      lane = deeper;
    }

    let j = tree.lineTo(exit, descent, ey);
    const dip = tree.lineTo(j, descent, lane);
    for (let i = 1; i < count; i++) {
      if (kind[i] !== BACKWARD) continue;
      j = tree.lineTo(dip, run[i]!, lane);
      j = tree.lineTo(j, run[i]!, ry[i]!);
      j = tree.lineTo(j, rx[i]!, ry[i]!);
      end[i] = tree.lineTo(j, qx[i]!, qy[i]!);
      tree.terminal(end[i]!);
    }
  }

  tree.prune();
  return s;
}

/**
 * Plan how forward reader `i` leaves the trunk when the straight branch at its height is blocked:
 * along the root's row, or the row just above or below the blocks in the way, to a line near the
 * reader (its track when clear), then to its height. Takes the way crossing the fewest blocks,
 * nearest the reader's height on a tie, into `plan.row[i]` and `plan.line[i]`. Reads the blocks
 * in the way from the `span` that found the branch blocked.
 */
function detour(i: number, trunk: number, ey: number): void {
  const { prepared } = scope;
  const g = prepared.metrics.grid;
  const { rx, ry, nx } = plan;
  const port = members.ports[i]!;
  const block = prepared.portBlock[port]!;
  const bound = nx[i] === -1 ? rx[i]! : edgeLow(block) - prepared.metrics.stub;
  const pref = nx[i] === -1 ? track(block, port, -1, bound) : bound;
  const y = ry[i]!;
  const blockedTop = spanTop;
  const blockedBottom = spanBottom;
  let bestRow = y;
  let bestLine = trunk;
  let fewest = Infinity;
  for (let k = 0; k < 3; k++) {
    const row =
      k === 0 ? ey : k === 1 ? floorGrid(blockedTop - g, g) : ceilGrid(blockedBottom + g, g);
    if (!Number.isFinite(row)) continue;
    const line = channel(pref, trunk, bound, row, y, g);
    // The search already counted the crossings of the line it chose.
    const climb = Number.isNaN(channelCost) ? crossings(line, row, y) : channelCost;
    const cost =
      crossings(trunk, ey, row) + across(trunk, line, row) + climb + across(line, rx[i]!, y);
    if (cost < fewest || (cost === fewest && Math.abs(row - y) < Math.abs(bestRow - y))) {
      fewest = cost;
      bestRow = row;
      bestLine = line;
    }
  }
  plan.row[i] = bestRow;
  plan.line[i] = bestLine;
}

/**
 * The y of a lane `offset` below the blocks within u from `u0` to `u1`. Starting from the band
 * from `y0` down to `y1`, it deepens past every shown block reaching into the band. A block
 * further down that the lane would reach (with a grid step of clearance) holds it just above that
 * block when there is room, so a lane never runs through a block nor dives under a whole row of
 * them; without room it passes under that block too.
 */
function laneAt(u0: number, u1: number, y0: number, y1: number, offset: number, g: number): number {
  const x0 = Math.min(world(plan.s, u0), world(plan.s, u1));
  const x1 = Math.max(world(plan.s, u0), world(plan.s, u1));
  let bottom = y1;
  for (let pass = 0; pass < MAX_DEPTH_PASSES; pass++) {
    deepest = bottom;
    scope.obstacles(x0, y0, x1, bottom, deepen);
    if (deepest > bottom) {
      bottom = deepest;
      continue;
    }
    const base = ceilGrid(bottom, g);
    const want = base + offset;
    shallowest = Infinity;
    scope.obstacles(x0, bottom, x1, want + g, underneath);
    if (shallowest === Infinity) return want;
    const room = floorGrid(shallowest - g, g);
    if (room >= base + g) return Math.min(want, room);
    bottom = shallowestBottom;
  }
  return ceilGrid(bottom, g) + offset;
}

/**
 * Route one net at right angles on the grid: a stub out of every port, one trunk for the forward
 * readers with T-junctions, a U-turn through a lane below the blocks for each backward reader, an
 * arrow at each `in` port, and the label anchor at the root's stub end.
 *
 * @remarks
 * Only ports of shown blocks on a shown net drawn as wires take part; with fewer than two, nothing
 * is written. The root is the driver, else the first port shown. A reader is forward when its
 * stub end is not behind the root's. The trunk is the grid line between the root and the nearest
 * forward reader crossing the fewest blocks, tried first on its track: every vertical run beside a
 * column takes a line one grid step further out per wired port below it in that column, so runs
 * along one column edge nest instead of overlapping, and a run nesting rightward from a column's
 * right edge also passes the labels of the wires below it there (the layout opens column gaps so
 * the runs beside the next column pass them too). A branch that would cross a block to reach a
 * reader further on jogs near that reader instead. A backward reader's lane runs under the blocks
 * between, `2g` deeper per track of the root's descent and `g` deeper under a root block
 * `ctx.laneShift` shifts, and never through a block.
 */
export function routeOrthogonal(ctx: RouteContext, net: number, out: RouteWriter): void {
  const count = members.gather(ctx, net);
  if (count < 2) return;
  const s = build(ctx, count);
  tree.emit(out, s);
  const flow = ctx.prepared.netlist.portFlow;
  const { qx, qy, nx, ny } = plan;
  for (let i = 0; i < count; i++) {
    if (flow[members.ports[i]!] !== FLOW_IN) continue;
    // Into the block: against the port's normal, as `0 - n` so a zero stays `+0`.
    out.arrow(world(s, qx[i]!), qy[i]!, world(s, 0 - nx[i]!), 0 - ny[i]!);
  }
  out.anchor(world(s, plan.rx[0]!), plan.ry[0]!);
}

/**
 * The wire preview from port `from` as `x, y` pairs in diagram units: out along its side's normal,
 * then to the free point `(x, y)` with one or two bends, or, when `target` is a port's part id,
 * into that port the way a routed wire would enter it. Empty when `from` has no position.
 *
 * @param positions - Effective top-lefts, 2 per block.
 * @param from - The port the wire is drawn from.
 * @param target - The part id the wire would land on, or null; only a port changes the shape.
 * @param laneShift - The lane shifts routes read (`RouteContext.laneShift`), or null for none.
 */
export function routePreview(
  prepared: Prepared,
  positions: Float32Array,
  from: number,
  x: number,
  y: number,
  target: number | null,
  laneShift: Uint8Array | null = null,
): Float32Array {
  const block = prepared.portBlock[from]!;
  if (!Number.isFinite(positions[2 * block]!) || !Number.isFinite(positions[2 * block + 1]!)) {
    return new Float32Array(0);
  }
  if (target !== null && partKind(target) === PART_PORT) {
    const port = partIndex(target);
    const other = port < prepared.portCount ? prepared.portBlock[port]! : NONE;
    if (
      port !== from &&
      other !== NONE &&
      Number.isFinite(positions[2 * other]!) &&
      Number.isFinite(positions[2 * other + 1]!)
    ) {
      members.set(from, port);
      const s = build(
        { prepared, positions, blockVisible: null, obstacles: noObstacles, laneShift },
        2,
      );
      return tree.path(plan.end[1]!, s);
    }
  }
  const px = portX(prepared, positions, from);
  const py = portY(prepared, positions, from);
  const side = prepared.portSide[from]!;
  const nx = normalX(side);
  const ny = normalY(side);
  const stub = prepared.metrics.stub;
  const ex = px + nx * stub;
  const ey = py + ny * stub;
  // Ahead of the stub, one bend turns toward the point; behind it, the stub runs out first.
  let points: number[];
  if (nx !== 0) {
    points = (x - ex) * nx >= 0 ? [px, py, x, py, x, y] : [px, py, ex, ey, ex, y, x, y];
  } else {
    points = (y - ey) * ny >= 0 ? [px, py, px, y, x, y] : [px, py, ex, ey, x, ey, x, y];
  }
  return Float32Array.from(corners(points));
}

/** The points of a polyline without repeats or in-line middles. */
function corners(points: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const n = out.length;
    if (n >= 2 && out[n - 2] === x && out[n - 1] === y) continue;
    if (n >= 4) {
      const ax = out[n - 4]!;
      const ay = out[n - 3]!;
      const bx = out[n - 2]!;
      const by = out[n - 1]!;
      if ((ax === bx && bx === x) || (ay === by && by === y)) {
        out[n - 2] = x;
        out[n - 1] = y;
        continue;
      }
    }
    out.push(x, y);
  }
  return out;
}
