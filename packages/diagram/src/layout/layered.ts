/**
 * The layered layout of one unit, drawn the way a control engineer draws a plant: signal flow left
 * to right, controllers feeding the machine on the right, one-to-one wires straight, and feedback
 * returning underneath through lanes below the blocks.
 *
 * @remarks
 * Five stages over typed arrays: a weighted graph of the unit's wires; cycle breaking with a
 * weighted greedy feedback arc set; longest-path layers with long edges split into pass-through
 * items; port-level barycenter ordering, keeping the order with the fewest crossings; and a
 * priority placement that moves each item to the weighted median of the straight positions its
 * wires offer, alternating directions. Columns then leave room for the labels of the wires leaving
 * them and for the wires routed past those labels, and the unit's rectangle is measured around
 * everything drawn for it (`Reach`).
 * Everything reads the unit in canonical order, so two units with one shape lay out identically.
 */

import { ceilTo, snapTo } from '../geometry.js';
import { FLOW_BOTH, NONE, SIDE_RIGHT, STYLE_WIRE, type Prepared } from '../prepare.js';
import { Reach } from './reach.js';

/**
 * One unit laid out on its own, in a rectangle holding everything drawn for it: its blocks with
 * their extents, its wires and lanes, their labels, and a group's padding on every side with its
 * header on top. A group's frame is that rectangle or inside it.
 */
export interface UnitLayout {
  /** Top-left per block of the order, 2 floats each, relative to the unit's top-left. */
  readonly positions: Float32Array;
  /** The unit's width; a grid multiple. */
  readonly width: number;
  /** The unit's height; a grid multiple. */
  readonly height: number;
  /**
   * How far the rectangle reaches past the box of the unit's blocks with their extents (each
   * rounded up to the grid): left, top, right, bottom; grid multiples. Wherever the blocks sit,
   * that box grown by these is the rectangle the unit is drawn in.
   */
  readonly margin: readonly [left: number, top: number, right: number, bottom: number];
}

/** Grid steps between two blocks stacked in a layer, beyond their extents. */
const ROW_GAP = 4;
/** Grid steps between a wire passing through a layer and whatever it passes. */
const PASS_GAP = 2;
/** Grid steps between layers, plus one per wire crossing the gap up to `CROSSING_CAP`. */
const COLUMN_GAP = 8;
const CROSSING_CAP = 4;
/**
 * Measures after the first that may open column gaps whose wires cross labels. A gap opens once,
 * by as much as its wires need; the wires routed again in the wider unit can find another gap
 * to open, so a few passes settle a tangle, and a plant settles in one.
 */
const OPEN_PASSES = 3;
/**
 * Weight of the edges out of a measured block, one whose signal several blocks read, while
 * breaking cycles: a machine's speed or a converter's power is feedback, so the machine sits right
 * of its controllers.
 */
const MEASURED = 0.25;
/** Weight multiplier along a long edge, so it stays straight through the layers it crosses. */
const CHAIN = 2;
/** Priority of a pass-through over any block: long edges stay straight, blocks move around them. */
const PASS_PRIORITY = 1e9;
/**
 * Pass-throughs a unit affords per block, plus a floor: a tangle whose long edges would need more
 * leaves its longest edges out of ordering and placement rather than grow without bound.
 */
const PASS_BUDGET = 8;
const PASS_FLOOR = 4096;
/** Down-and-up ordering sweeps. */
const ORDER_SWEEPS = 4;
/** Placement passes, alternating direction, stopping early once nothing moves. */
const PLACE_PASSES = 8;
/** Quantum of cycle-breaking scores, so sums equal in exact arithmetic compare equal. */
const QUANTUM = 1 << 20;
/** Tolerance of weight sums when taking a weighted median. */
const EPSILON = 1e-9;

/**
 * Lay out one unit: top-left per block of `order`, relative to the unit's own top-left (0, 0),
 * and the unit's size including extents, wires, lanes, labels, and a group's frame.
 *
 * @param prepared - The prepared netlist the unit's blocks belong to.
 * @param order - The unit's blocks in canonical order (`Shaper`); ties break by this order.
 * @param reach - The measure of wires and labels to share across units. @defaultValue a new one
 */
export function layerUnit(
  prepared: Prepared,
  order: Uint32Array,
  reach: Reach = new Reach(prepared),
): UnitLayout {
  if (order.length === 0) {
    return { positions: new Float32Array(0), width: 0, height: 0, margin: [0, 0, 0, 0] };
  }
  const graph = unitGraph(prepared, order);
  const rank = breakCycles(graph);
  const layer = assignLayers(graph, rank);
  const rows = buildRows(prepared, order, graph, rank, layer);
  orderRows(rows);
  placeRows(rows);
  return finish(prepared, order, graph, rank, layer, rows, reach);
}

/** The unit's wires as weighted edges between local blocks (indices into the order). */
interface UnitGraph {
  readonly n: number;
  readonly edgeCount: number;
  /** Per edge: driver and reader local block, their port y offsets, weight, and local net. */
  readonly from: Uint32Array;
  readonly to: Uint32Array;
  readonly fromY: Float64Array;
  readonly toY: Float64Array;
  readonly weight: Float64Array;
  readonly net: Uint32Array;
  /** Local wires, numbered as the canonical order first reaches them. */
  readonly netCount: number;
  /** Per local block: its `both` ports, and whether it drives a wire several blocks read. */
  readonly both: Uint32Array;
  readonly measured: Uint8Array;
}

/**
 * The edges of a unit: driver block to reader block for every in-unit reader of a wire the unit
 * drives, weighted `1 / readers`; a wire without a driver joins its ports from the one nearest a
 * breadth-first root (the busiest block), so an undirected unit lays out as a tree.
 */
function unitGraph(prepared: Prepared, order: Uint32Array): UnitGraph {
  const n = order.length;
  const { portBlock, portNet, netStyle, netDriver, portOffset } = prepared;
  const { portStart, portFlow } = prepared.netlist;
  const local = new Map<number, number>();
  for (let i = 0; i < n; i++) local.set(order[i]!, i);

  const localNet = new Map<number, number>();
  const nets: number[] = [];
  const counts: number[] = [];
  const both = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const block = order[i]!;
    for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
      if (portFlow[port] === FLOW_BOTH) both[i]!++;
      const net = portNet[port]!;
      if (net === NONE || netStyle[net] !== STYLE_WIRE) continue;
      let k = localNet.get(net);
      if (k === undefined) {
        k = nets.length;
        localNet.set(net, k);
        nets.push(net);
        counts.push(0);
      }
      counts[k]!++;
    }
  }
  const netCount = nets.length;
  // Each wire's in-unit ports, in canonical order, so edges never depend on global numbering.
  const memberStart = new Uint32Array(netCount + 1);
  for (let k = 0; k < netCount; k++) memberStart[k + 1] = memberStart[k]! + counts[k]!;
  const members = new Uint32Array(memberStart[netCount]!);
  const fill = memberStart.slice(0, netCount);
  for (let i = 0; i < n; i++) {
    const block = order[i]!;
    for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
      const k = localNet.get(portNet[port]!);
      if (k !== undefined) members[fill[k]!++] = port;
    }
  }

  const bound = members.length;
  const from = new Uint32Array(bound);
  const to = new Uint32Array(bound);
  const fromY = new Float64Array(bound);
  const toY = new Float64Array(bound);
  const weight = new Float64Array(bound);
  const netOf = new Uint32Array(bound);
  const measured = new Uint8Array(n);
  let edges = 0;
  const edge = (a: number, pa: number, b: number, pb: number, w: number, k: number): void => {
    from[edges] = a;
    to[edges] = b;
    fromY[edges] = portOffset[2 * pa + 1]!;
    toY[edges] = portOffset[2 * pb + 1]!;
    weight[edges] = w;
    netOf[edges] = k;
    edges++;
  };

  const undirected: number[] = [];
  for (let k = 0; k < netCount; k++) {
    const first = memberStart[k]!;
    const end = memberStart[k + 1]!;
    if (end - first < 2) continue;
    const driver = netDriver[nets[k]!]!;
    if (driver === NONE) {
      undirected.push(k);
      continue;
    }
    const source = local.get(portBlock[driver]!);
    if (source === undefined) continue;
    const readers = end - first - 1;
    if (readers >= 2) measured[source] = 1;
    for (let at = first; at < end; at++) {
      const port = members[at]!;
      if (port === driver) continue;
      const reader = local.get(portBlock[port]!)!;
      if (reader !== source) edge(source, driver, reader, port, 1 / readers, k);
    }
  }

  if (undirected.length > 0) {
    // Block -> undirected wires, then breadth-first depths from the busiest blocks.
    const degree = new Uint32Array(n);
    for (const k of undirected) {
      for (let at = memberStart[k]!; at < memberStart[k + 1]!; at++) {
        degree[local.get(portBlock[members[at]!]!)!]!++;
      }
    }
    const incidentStart = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) incidentStart[i + 1] = incidentStart[i]! + degree[i]!;
    const incident = new Uint32Array(incidentStart[n]!);
    const cursor = incidentStart.slice(0, n);
    for (const k of undirected) {
      for (let at = memberStart[k]!; at < memberStart[k + 1]!; at++) {
        incident[cursor[local.get(portBlock[members[at]!]!)!]!++] = k;
      }
    }
    const seeds = Uint32Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => degree[b]! - degree[a]! || a - b,
    );
    const depth = new Int32Array(n).fill(-1);
    const queue = new Uint32Array(n);
    for (const seed of seeds) {
      if (degree[seed] === 0) break;
      if (depth[seed]! >= 0) continue;
      depth[seed] = 0;
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      while (head < tail) {
        const block = queue[head++]!;
        for (let at = incidentStart[block]!; at < incidentStart[block + 1]!; at++) {
          const k = incident[at]!;
          for (let m = memberStart[k]!; m < memberStart[k + 1]!; m++) {
            const other = local.get(portBlock[members[m]!]!)!;
            if (depth[other]! >= 0) continue;
            depth[other] = depth[block]! + 1;
            queue[tail++] = other;
          }
        }
      }
    }
    for (const k of undirected) {
      const first = memberStart[k]!;
      const end = memberStart[k + 1]!;
      // Members run in canonical block order, so the first shallowest one is the lowest block.
      let root = members[first]!;
      let rootBlock = local.get(portBlock[root]!)!;
      for (let at = first + 1; at < end; at++) {
        const block = local.get(portBlock[members[at]!]!)!;
        if (depth[block]! < depth[rootBlock]!) {
          root = members[at]!;
          rootBlock = block;
        }
      }
      const w = 1 / (end - first - 1);
      for (let at = first; at < end; at++) {
        const port = members[at]!;
        const block = local.get(portBlock[port]!)!;
        if (block !== rootBlock) edge(rootBlock, root, block, port, w, k);
      }
    }
  }

  return {
    n,
    edgeCount: edges,
    from,
    to,
    fromY,
    toY,
    weight,
    net: netOf,
    netCount,
    both,
    measured,
  };
}

/** Out-edge and in-edge lists per local block. */
interface Incidence {
  readonly outStart: Uint32Array;
  readonly outEdges: Uint32Array;
  readonly inStart: Uint32Array;
  readonly inEdges: Uint32Array;
}

/** Index a graph's edges by driver and by reader. */
function incidence(graph: UnitGraph): Incidence {
  const { n, edgeCount, from, to } = graph;
  const outStart = new Uint32Array(n + 1);
  const inStart = new Uint32Array(n + 1);
  for (let e = 0; e < edgeCount; e++) {
    outStart[from[e]! + 1]!++;
    inStart[to[e]! + 1]!++;
  }
  for (let i = 0; i < n; i++) {
    outStart[i + 1]! += outStart[i]!;
    inStart[i + 1]! += inStart[i]!;
  }
  const outEdges = new Uint32Array(edgeCount);
  const inEdges = new Uint32Array(edgeCount);
  const outFill = outStart.slice(0, n);
  const inFill = inStart.slice(0, n);
  for (let e = 0; e < edgeCount; e++) {
    outEdges[outFill[from[e]!]!++] = e;
    inEdges[inFill[to[e]!]!++] = e;
  }
  return { outStart, outEdges, inStart, inEdges };
}

/**
 * Order the unit's blocks by a weighted Eades-Lin-Smyth feedback arc set: sinks go to the right
 * end, sources to the left end, otherwise the block with the most outgoing over incoming weight
 * goes left, ties to fewer `both` ports (a machine on a bus sits rightmost) and then canonical
 * order. Returns each block's rank; an edge from a higher rank to a lower one is feedback.
 */
function breakCycles(graph: UnitGraph): Uint32Array {
  const { n, edgeCount, from, to, weight, both, measured } = graph;
  const { outStart, outEdges, inStart, inEdges } = incidence(graph);
  const ew = new Float64Array(edgeCount);
  const outW = new Float64Array(n);
  const inW = new Float64Array(n);
  const outC = new Uint32Array(n);
  const inC = new Uint32Array(n);
  for (let e = 0; e < edgeCount; e++) {
    const w = weight[e]! * (measured[from[e]!] ? MEASURED : 1);
    ew[e] = w;
    outW[from[e]!]! += w;
    inW[to[e]!]! += w;
    outC[from[e]!]!++;
    inC[to[e]!]!++;
  }

  // A binary max-heap of (score, both, block) with lazy invalidation by per-block versions.
  const capacity = n + 2 * edgeCount + 1;
  const heapScore = new Float64Array(capacity);
  const heapBlock = new Uint32Array(capacity);
  const heapVersion = new Uint32Array(capacity);
  const version = new Uint32Array(n);
  let heapSize = 0;
  const before = (a: number, b: number): boolean => {
    const sa = heapScore[a]!;
    const sb = heapScore[b]!;
    if (sa !== sb) return sa > sb;
    const ba = both[heapBlock[a]!]!;
    const bb = both[heapBlock[b]!]!;
    if (ba !== bb) return ba < bb;
    return heapBlock[a]! < heapBlock[b]!;
  };
  const swap = (a: number, b: number): void => {
    const s = heapScore[a]!;
    heapScore[a] = heapScore[b]!;
    heapScore[b] = s;
    const k = heapBlock[a]!;
    heapBlock[a] = heapBlock[b]!;
    heapBlock[b] = k;
    const v = heapVersion[a]!;
    heapVersion[a] = heapVersion[b]!;
    heapVersion[b] = v;
  };
  const push = (block: number): void => {
    let at = heapSize++;
    heapScore[at] = Math.round((outW[block]! - inW[block]!) * QUANTUM);
    heapBlock[at] = block;
    heapVersion[at] = version[block]!;
    while (at > 0) {
      const up = (at - 1) >> 1;
      if (!before(at, up)) break;
      swap(at, up);
      at = up;
    }
  };
  const pop = (): void => {
    heapSize--;
    if (heapSize === 0) return;
    swap(0, heapSize);
    let at = 0;
    for (;;) {
      const left = 2 * at + 1;
      if (left >= heapSize) break;
      const right = left + 1;
      const best = right < heapSize && before(right, left) ? right : left;
      if (!before(best, at)) break;
      swap(best, at);
      at = best;
    }
  };

  const removed = new Uint8Array(n);
  const sinks = new Uint32Array(2 * n);
  const sources = new Uint32Array(2 * n);
  let sinkTop = 0;
  let sourceTop = 0;
  for (let block = n - 1; block >= 0; block--) {
    if (outC[block] === 0) sinks[sinkTop++] = block;
    else if (inC[block] === 0) sources[sourceTop++] = block;
    push(block);
  }
  const remove = (block: number): void => {
    removed[block] = 1;
    for (let at = outStart[block]!; at < outStart[block + 1]!; at++) {
      const e = outEdges[at]!;
      const other = to[e]!;
      if (removed[other]) continue;
      inW[other]! -= ew[e]!;
      if (--inC[other]! === 0) sources[sourceTop++] = other;
      version[other]!++;
      push(other);
    }
    for (let at = inStart[block]!; at < inStart[block + 1]!; at++) {
      const e = inEdges[at]!;
      const other = from[e]!;
      if (removed[other]) continue;
      outW[other]! -= ew[e]!;
      if (--outC[other]! === 0) sinks[sinkTop++] = other;
      version[other]!++;
      push(other);
    }
  };

  const sequence = new Uint32Array(n);
  let head = 0;
  let tail = n;
  while (head < tail) {
    if (sinkTop > 0) {
      const block = sinks[--sinkTop]!;
      if (removed[block] || outC[block] !== 0) continue;
      sequence[--tail] = block;
      remove(block);
      continue;
    }
    if (sourceTop > 0) {
      const block = sources[--sourceTop]!;
      if (removed[block] || inC[block] !== 0) continue;
      sequence[head++] = block;
      remove(block);
      continue;
    }
    const block = heapBlock[0]!;
    const stale = removed[block] || heapVersion[0] !== version[block];
    pop();
    if (stale) continue;
    sequence[head++] = block;
    remove(block);
  }

  const rank = new Uint32Array(n);
  for (let at = 0; at < n; at++) rank[sequence[at]!] = at;
  return rank;
}

/**
 * Longest-path layers over the forward edges, then every source pulled right next to its nearest
 * reader, so a governor feeding the machine sits in the column before it. Layers are compact.
 */
function assignLayers(graph: UnitGraph, rank: Uint32Array): Uint32Array {
  const { n, from, to } = graph;
  const { outStart, outEdges, inStart, inEdges } = incidence(graph);
  const sequence = new Uint32Array(n);
  for (let block = 0; block < n; block++) sequence[rank[block]!] = block;
  const layer = new Uint32Array(n);
  const fed = new Uint8Array(n);
  for (const block of sequence) {
    let at = 0;
    for (let i = inStart[block]!; i < inStart[block + 1]!; i++) {
      const source = from[inEdges[i]!]!;
      if (rank[source]! > rank[block]!) continue;
      fed[block] = 1;
      at = Math.max(at, layer[source]! + 1);
    }
    layer[block] = at;
  }
  for (let i = n - 1; i >= 0; i--) {
    const block = sequence[i]!;
    if (fed[block]) continue;
    let nearest = Infinity;
    for (let at = outStart[block]!; at < outStart[block + 1]!; at++) {
      const reader = to[outEdges[at]!]!;
      if (rank[reader]! > rank[block]!) nearest = Math.min(nearest, layer[reader]!);
    }
    if (nearest !== Infinity && nearest - 1 > layer[block]!) layer[block] = nearest - 1;
  }
  let top = 0;
  for (let block = 0; block < n; block++) top = Math.max(top, layer[block]!);
  const used = new Uint32Array(top + 2);
  for (let block = 0; block < n; block++) used[layer[block]! + 1] = 1;
  for (let at = 0; at <= top; at++) used[at + 1]! += used[at]!;
  for (let block = 0; block < n; block++) layer[block] = used[layer[block]!]!;
  return layer;
}

/**
 * The unit as layered rows: items are blocks (`0..n-1`, the local blocks) and pass-throughs (a long
 * edge's wire where it crosses a layer); links join items in adjacent layers at port offsets.
 */
interface Rows {
  readonly grid: number;
  readonly blocks: number;
  readonly itemCount: number;
  readonly layerCount: number;
  readonly itemLayer: Uint32Array;
  /** Per item: height, and the extents above and below it (all 0 for a pass-through). */
  readonly height: Float64Array;
  readonly above: Float64Array;
  readonly below: Float64Array;
  /** Layer `l` holds `items[layerStart[l]]` up to `items[layerStart[l + 1]]`, top to bottom. */
  readonly layerStart: Uint32Array;
  readonly items: Uint32Array;
  /** Per item: its index in `items`, and its top when its layer is stacked tight from 0. */
  readonly slot: Uint32Array;
  readonly stacked: Float64Array;
  /** Per item: its placed top. */
  readonly y: Float64Array;
  readonly linkCount: number;
  /** Per link: upper-layer item and offset, lower-layer item and offset, weight, local net. */
  readonly la: Uint32Array;
  readonly oa: Float64Array;
  readonly lb: Uint32Array;
  readonly ob: Float64Array;
  readonly lw: Float64Array;
  readonly lnet: Uint32Array;
  /** Per item: links to the previous layer (it is `lb`) and to the next (it is `la`). */
  readonly leftStart: Uint32Array;
  readonly leftLinks: Uint32Array;
  readonly rightStart: Uint32Array;
  readonly rightLinks: Uint32Array;
  /** Links by gap; gap `l` runs from layer `l` to layer `l + 1`. */
  readonly gapStart: Uint32Array;
  readonly gapLinks: Uint32Array;
}

/** Split long forward edges into pass-throughs and index items and links by layer. */
function buildRows(
  prepared: Prepared,
  order: Uint32Array,
  graph: UnitGraph,
  rank: Uint32Array,
  layer: Uint32Array,
): Rows {
  const { n, edgeCount, from, to, fromY, toY, weight, net } = graph;
  const { size, extent } = prepared;
  let layerCount = 0;
  for (let block = 0; block < n; block++) layerCount = Math.max(layerCount, layer[block]! + 1);
  // Spans of the forward edges; past the budget, the longest stop steering order and placement.
  const spans = new Uint32Array(layerCount + 1);
  let passes = 0;
  for (let e = 0; e < edgeCount; e++) {
    if (rank[from[e]!]! > rank[to[e]!]!) continue;
    const span = layer[to[e]!]! - layer[from[e]!]!;
    spans[span]!++;
    passes += span - 1;
  }
  let longest = layerCount;
  const budget = PASS_BUDGET * n + PASS_FLOOR;
  while (passes > budget && longest > 1) {
    passes -= spans[longest]! * (longest - 1);
    longest--;
  }
  let linkCount = 0;
  for (let span = 1; span <= longest; span++) linkCount += spans[span]! * span;
  const itemCount = n + passes;
  const itemLayer = new Uint32Array(itemCount);
  const height = new Float64Array(itemCount);
  const above = new Float64Array(itemCount);
  const below = new Float64Array(itemCount);
  // Initial order within a layer: blocks by rank, a pass-through by its edge's ranks.
  const key = new Float64Array(itemCount);
  for (let i = 0; i < n; i++) {
    const block = order[i]!;
    itemLayer[i] = layer[i]!;
    height[i] = size[2 * block + 1]!;
    above[i] = extent[4 * block + 1]!;
    below[i] = extent[4 * block + 3]!;
    key[i] = rank[i]! * (n + 1) + n;
  }
  const la = new Uint32Array(linkCount);
  const lb = new Uint32Array(linkCount);
  const oa = new Float64Array(linkCount);
  const ob = new Float64Array(linkCount);
  const lw = new Float64Array(linkCount);
  const lnet = new Uint32Array(linkCount);
  let links = 0;
  const link = (a: number, offA: number, b: number, offB: number, w: number, k: number): void => {
    la[links] = a;
    oa[links] = offA;
    lb[links] = b;
    ob[links] = offB;
    lw[links] = w;
    lnet[links] = k;
    links++;
  };
  let pass = n;
  for (let e = 0; e < edgeCount; e++) {
    const a = from[e]!;
    const b = to[e]!;
    if (rank[a]! > rank[b]!) continue;
    const span = layer[b]! - layer[a]!;
    if (span > longest) continue;
    if (span === 1) {
      link(a, fromY[e]!, b, toY[e]!, weight[e]!, net[e]!);
      continue;
    }
    const w = weight[e]! * CHAIN;
    let previous = a;
    let offset = fromY[e]!;
    for (let step = 1; step < span; step++) {
      const item = pass++;
      itemLayer[item] = layer[a]! + step;
      key[item] = rank[a]! * (n + 1) + rank[b]!;
      link(previous, offset, item, 0, w, net[e]!);
      previous = item;
      offset = 0;
    }
    link(previous, 0, b, toY[e]!, w, net[e]!);
  }

  const layerStart = new Uint32Array(layerCount + 1);
  for (let item = 0; item < itemCount; item++) layerStart[itemLayer[item]! + 1]!++;
  for (let l = 0; l < layerCount; l++) layerStart[l + 1]! += layerStart[l]!;
  const items = new Uint32Array(itemCount);
  const fill = layerStart.slice(0, layerCount);
  for (let item = 0; item < itemCount; item++) items[fill[itemLayer[item]!]!++] = item;
  for (let l = 0; l < layerCount; l++) {
    items.subarray(layerStart[l]!, layerStart[l + 1]!).sort((a, b) => key[a]! - key[b]! || a - b);
  }

  const leftStart = new Uint32Array(itemCount + 1);
  const rightStart = new Uint32Array(itemCount + 1);
  const gapStart = new Uint32Array(Math.max(layerCount, 1));
  for (let l = 0; l < linkCount; l++) {
    leftStart[lb[l]! + 1]!++;
    rightStart[la[l]! + 1]!++;
    gapStart[itemLayer[la[l]!]! + 1]!++;
  }
  for (let item = 0; item < itemCount; item++) {
    leftStart[item + 1]! += leftStart[item]!;
    rightStart[item + 1]! += rightStart[item]!;
  }
  for (let g = 0; g + 1 < gapStart.length; g++) gapStart[g + 1]! += gapStart[g]!;
  const leftLinks = new Uint32Array(linkCount);
  const rightLinks = new Uint32Array(linkCount);
  const gapLinks = new Uint32Array(linkCount);
  const leftFill = leftStart.slice(0, itemCount);
  const rightFill = rightStart.slice(0, itemCount);
  const gapFill = gapStart.slice(0, gapStart.length - 1);
  for (let l = 0; l < linkCount; l++) {
    leftLinks[leftFill[lb[l]!]!++] = l;
    rightLinks[rightFill[la[l]!]!++] = l;
    gapLinks[gapFill[itemLayer[la[l]!]!]!++] = l;
  }

  return {
    grid: prepared.metrics.grid,
    blocks: n,
    itemCount,
    layerCount,
    itemLayer,
    height,
    above,
    below,
    layerStart,
    items,
    slot: new Uint32Array(itemCount),
    stacked: new Float64Array(itemCount),
    y: new Float64Array(itemCount),
    linkCount,
    la,
    oa,
    lb,
    ob,
    lw,
    lnet,
    leftStart,
    leftLinks,
    rightStart,
    rightLinks,
    gapStart,
    gapLinks,
  };
}

/** The least distance from item `a`'s top to item `b`'s top when `b` sits right below `a`. */
function separation(rows: Rows, a: number, b: number): number {
  const gap = a < rows.blocks && b < rows.blocks ? ROW_GAP : PASS_GAP;
  return ceilTo(rows.height[a]! + rows.below[a]! + gap * rows.grid + rows.above[b]!, rows.grid);
}

/** Stack layer `l` tight from 0 in its current order, recording each item's slot and top. */
function stack(rows: Rows, l: number): void {
  const { items, layerStart, slot, stacked } = rows;
  let top = 0;
  for (let at = layerStart[l]!; at < layerStart[l + 1]!; at++) {
    const item = items[at]!;
    if (at > layerStart[l]!) top += separation(rows, items[at - 1]!, item);
    slot[item] = at;
    stacked[item] = top;
  }
}

/**
 * Order each layer by port-level barycenters: down sweeps against the layer before, up sweeps
 * against the layer after. The order with the fewest crossings wins, first found on ties.
 */
function orderRows(rows: Rows): void {
  const { layerCount, items, itemCount, gapStart } = rows;
  for (let l = 0; l < layerCount; l++) stack(rows, l);
  if (layerCount < 2) return;
  let widest = 0;
  for (let g = 0; g + 1 < gapStart.length; g++) {
    widest = Math.max(widest, gapStart[g + 1]! - gapStart[g]!);
  }
  const scratch: Scratch = {
    key: new Float64Array(itemCount),
    ya: new Float64Array(widest),
    yb: new Float64Array(widest),
    index: new Uint32Array(widest),
    values: new Float64Array(widest),
    merge: new Float64Array(widest),
  };
  let best = crossings(rows, scratch);
  const bestItems = items.slice();
  for (let sweep = 0; sweep < ORDER_SWEEPS && best > 0; sweep++) {
    for (let l = 1; l < layerCount; l++) sortLayer(rows, l, true, scratch.key);
    for (let l = layerCount - 2; l >= 0; l--) sortLayer(rows, l, false, scratch.key);
    const count = crossings(rows, scratch);
    if (count < best) {
      best = count;
      bestItems.set(items);
    }
  }
  items.set(bestItems);
  for (let l = 0; l < layerCount; l++) stack(rows, l);
}

/** Scratch shared by the ordering sweeps. */
interface Scratch {
  readonly key: Float64Array;
  readonly ya: Float64Array;
  readonly yb: Float64Array;
  readonly index: Uint32Array;
  readonly values: Float64Array;
  readonly merge: Float64Array;
}

/**
 * Sort layer `l` by where its items' wires would have them: the weighted mean of the tops that
 * make each link straight, plus half the item's height; an item with no link that way keeps its
 * center. Stable by current slot.
 */
function sortLayer(rows: Rows, l: number, fromLeft: boolean, key: Float64Array): void {
  const { items, layerStart, slot, stacked, height, la, lb, oa, ob, lw } = rows;
  const start = layerStart[l]!;
  const end = layerStart[l + 1]!;
  if (end - start < 2) return;
  const linkStart = fromLeft ? rows.leftStart : rows.rightStart;
  const links = fromLeft ? rows.leftLinks : rows.rightLinks;
  for (let at = start; at < end; at++) {
    const item = items[at]!;
    let sum = 0;
    let total = 0;
    for (let i = linkStart[item]!; i < linkStart[item + 1]!; i++) {
      const k = links[i]!;
      const w = lw[k]!;
      sum +=
        w * (fromLeft ? stacked[la[k]!]! + oa[k]! - ob[k]! : stacked[lb[k]!]! + ob[k]! - oa[k]!);
      total += w;
    }
    key[item] = (total > 0 ? sum / total : stacked[item]!) + height[item]! / 2;
  }
  items.subarray(start, end).sort((a, b) => key[a]! - key[b]! || slot[a]! - slot[b]!);
  stack(rows, l);
}

/** Link crossings over every gap, ports at their stacked positions. */
function crossings(rows: Rows, scratch: Scratch): number {
  const { gapStart, gapLinks, stacked, la, lb, oa, ob } = rows;
  const { ya, yb, index, values, merge } = scratch;
  let total = 0;
  for (let g = 0; g + 1 < gapStart.length; g++) {
    const first = gapStart[g]!;
    const count = gapStart[g + 1]! - first;
    if (count < 2) continue;
    for (let i = 0; i < count; i++) {
      const k = gapLinks[first + i]!;
      ya[i] = stacked[la[k]!]! + oa[k]!;
      yb[i] = stacked[lb[k]!]! + ob[k]!;
      index[i] = i;
    }
    const sorted = index.subarray(0, count).sort((a, b) => ya[a]! - ya[b]! || yb[a]! - yb[b]!);
    for (let i = 0; i < count; i++) values[i] = yb[sorted[i]!]!;
    total += inversions(values, merge, count);
  }
  return total;
}

/** Pairs `i < j` with `values[i] > values[j]` among the first `count`, by bottom-up merge sort. */
function inversions(values: Float64Array, merge: Float64Array, count: number): number {
  let total = 0;
  let source = values;
  let target = merge;
  for (let width = 1; width < count; width *= 2) {
    for (let lo = 0; lo < count; lo += 2 * width) {
      const mid = Math.min(lo + width, count);
      const hi = Math.min(lo + 2 * width, count);
      let i = lo;
      let j = mid;
      let k = lo;
      while (i < mid && j < hi) {
        if (source[j]! < source[i]!) {
          target[k++] = source[j++]!;
          total += mid - i;
        } else target[k++] = source[i++]!;
      }
      while (i < mid) target[k++] = source[i++]!;
      while (j < hi) target[k++] = source[j++]!;
    }
    const swap = source;
    source = target;
    target = swap;
  }
  return total;
}

/**
 * Place every item vertically. Each pass visits the layers in one direction (alternating) and
 * gives each item, in priority order (pass-throughs first, then by link weight), the weighted
 * median of the tops that make its links straight, clamped between the items already placed
 * above and below it at their separations. A median interval resolves to its end nearest the
 * item, so a tie straightens one wire, the one closest to straight already.
 */
function placeRows(rows: Rows): void {
  const { layerCount, layerStart, stacked, y, leftStart, rightStart } = rows;
  y.set(stacked);
  let widest = 0;
  let degree = 0;
  for (let l = 0; l < layerCount; l++) {
    widest = Math.max(widest, layerStart[l + 1]! - layerStart[l]!);
  }
  for (let item = 0; item < rows.itemCount; item++) {
    degree = Math.max(
      degree,
      leftStart[item + 1]! - leftStart[item]! + rightStart[item + 1]! - rightStart[item]!,
    );
  }
  const place: Placement = {
    desired: new Float64Array(rows.itemCount),
    priority: new Float64Array(rows.itemCount),
    visit: new Uint32Array(widest),
    tree: new Int32Array(widest + 1),
    z: new Float64Array(widest),
    targets: new Float64Array(degree),
    weights: new Float64Array(degree),
    order: new Uint32Array(degree),
  };
  for (let pass = 0; pass < PLACE_PASSES; pass++) {
    let moved = false;
    for (let step = 0; step < layerCount; step++) {
      const l = pass % 2 === 0 ? step : layerCount - 1 - step;
      if (placeLayer(rows, l, place)) moved = true;
    }
    if (!moved) break;
  }
}

/** Scratch shared by the placement passes. */
interface Placement {
  readonly desired: Float64Array;
  readonly priority: Float64Array;
  readonly visit: Uint32Array;
  /** A Fenwick tree over a layer's slots marking the items already placed. */
  readonly tree: Int32Array;
  /** Per slot: the placed top minus the stacked top, nondecreasing down a layer. */
  readonly z: Float64Array;
  /** One item's straight tops, their weights, and their sorted order. */
  readonly targets: Float64Array;
  readonly weights: Float64Array;
  readonly order: Uint32Array;
}

/** Place one layer; returns whether any item moved. */
function placeLayer(rows: Rows, l: number, place: Placement): boolean {
  const { items, layerStart, stacked, y, blocks, la, lb, oa, ob, lw } = rows;
  const { leftStart, leftLinks, rightStart, rightLinks } = rows;
  const { desired, priority, visit, tree, z, targets, weights, order } = place;
  const start = layerStart[l]!;
  const count = layerStart[l + 1]! - start;
  for (let slot = 0; slot < count; slot++) {
    const item = items[start + slot]!;
    let c = 0;
    let total = 0;
    for (let i = leftStart[item]!; i < leftStart[item + 1]!; i++) {
      const k = leftLinks[i]!;
      targets[c] = y[la[k]!]! + oa[k]! - ob[k]!;
      weights[c++] = lw[k]!;
      total += lw[k]!;
    }
    for (let i = rightStart[item]!; i < rightStart[item + 1]!; i++) {
      const k = rightLinks[i]!;
      targets[c] = y[lb[k]!]! + ob[k]! - oa[k]!;
      weights[c++] = lw[k]!;
      total += lw[k]!;
    }
    desired[item] = c === 0 ? y[item]! : median(targets, weights, order, c, total, y[item]!);
    priority[item] = total + (item >= blocks && c > 0 ? PASS_PRIORITY : 0);
    visit[slot] = slot;
  }
  const byPriority = visit.subarray(0, count);
  byPriority.sort((a, b) => priority[items[start + b]!]! - priority[items[start + a]!]! || a - b);
  tree.fill(0, 0, count + 1);
  let placed = 0;
  for (const slot of byPriority) {
    const item = items[start + slot]!;
    let value = desired[item]! - stacked[item]!;
    const above = slot > 0 ? prefix(tree, slot - 1) : 0;
    if (above > 0) value = Math.max(value, z[kth(tree, count, above)]!);
    if (above < placed) value = Math.min(value, z[kth(tree, count, above + 1)]!);
    z[slot] = value;
    for (let i = slot + 1; i <= count; i += i & -i) tree[i]!++;
    placed++;
  }
  let moved = false;
  for (let slot = 0; slot < count; slot++) {
    const item = items[start + slot]!;
    const top = z[slot]! + stacked[item]!;
    if (top !== y[item]) {
      y[item] = top;
      moved = true;
    }
  }
  return moved;
}

/** Items placed among slots `0..slot` of a Fenwick tree. */
function prefix(tree: Int32Array, slot: number): number {
  let sum = 0;
  for (let i = slot + 1; i > 0; i -= i & -i) sum += tree[i]!;
  return sum;
}

/** The slot of the `k`-th placed item (from 1) in a Fenwick tree over `count` slots. */
function kth(tree: Int32Array, count: number, k: number): number {
  let at = 0;
  let step = 1;
  while (step * 2 <= count) step *= 2;
  for (; step > 0; step >>= 1) {
    if (at + step <= count && tree[at + step]! < k) {
      at += step;
      k -= tree[at]!;
    }
  }
  return at;
}

/**
 * The weighted median of `count` targets. When the median is an interval, every point in it costs
 * the same total misalignment, but only its ends make a wire straight: the end closest to
 * `current` wins, the lower on a tie. `index` is scratch, at least `count` long.
 */
function median(
  targets: Float64Array,
  weights: Float64Array,
  index: Uint32Array,
  count: number,
  total: number,
  current: number,
): number {
  const sorted = index.subarray(0, count);
  for (let i = 0; i < count; i++) sorted[i] = i;
  if (count > 16) sorted.sort((a, b) => targets[a]! - targets[b]! || a - b);
  else {
    for (let i = 1; i < count; i++) {
      const at = sorted[i]!;
      let j = i - 1;
      for (; j >= 0 && targets[sorted[j]!]! > targets[at]!; j--) sorted[j + 1] = sorted[j]!;
      sorted[j + 1] = at;
    }
  }
  const half = total / 2;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += weights[sorted[i]!]!;
    if (sum < half - EPSILON) continue;
    const low = targets[sorted[i]!]!;
    const high = sum <= half + EPSILON && i + 1 < count ? targets[sorted[i + 1]!]! : low;
    return Math.abs(current - low) <= Math.abs(high - current) ? low : high;
  }
  return targets[sorted[count - 1]!]!;
}

/**
 * Columns, normalization, and the unit's frame: each layer's blocks centered on its column, the
 * column gap widening with the wires crossing it and with the labels of the wires leaving it, and
 * opening further where the wires routed through it would cross those labels, so the runs beside
 * the next column start past the text; then the unit shifted so everything drawn for it (blocks
 * with extents, its wires, their labels) sits inside a group's padding and header.
 */
function finish(
  prepared: Prepared,
  order: Uint32Array,
  graph: UnitGraph,
  rank: Uint32Array,
  layer: Uint32Array,
  rows: Rows,
  reach: Reach,
): UnitLayout {
  const { size, extent, blockGroup, portSide, portOffset } = prepared;
  const { portStart } = prepared.netlist;
  const m = prepared.metrics;
  const g = m.grid;
  const { n, edgeCount, from, to, net } = graph;
  const { layerCount, gapStart, gapLinks, lnet } = rows;

  // Per layer: its blocks' reach either side of its center, and how far right of the center the
  // labels of the wires its blocks root reach.
  const half = new Float64Array(layerCount);
  const labels = new Float64Array(layerCount);
  for (let i = 0; i < n; i++) {
    const block = order[i]!;
    const w = size[2 * block]!;
    const reachX =
      w / 2 + Math.max(ceilTo(extent[4 * block]!, g), ceilTo(extent[4 * block + 2]!, g));
    half[layer[i]!] = Math.max(half[layer[i]!]!, reachX);
    for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
      const span = reach.labelSpan[port]!;
      if (span === 0) continue;
      const anchor = portOffset[2 * port]! + (portSide[port] === SIDE_RIGHT ? m.stub : 0);
      labels[layer[i]!] = Math.max(labels[layer[i]!]!, anchor - w / 2 + span);
    }
  }

  // Wires crossing each gap: forward links, and the verticals of feedback U-turns, per net once.
  const gaps = Math.max(layerCount - 1, 0);
  const verticalStart = new Uint32Array(gaps + 1);
  const eachVertical = (visit: (gap: number, k: number) => void): void => {
    for (let e = 0; e < edgeCount; e++) {
      const a = from[e]!;
      const b = to[e]!;
      if (rank[a]! < rank[b]!) continue;
      if (layer[a]! < gaps) visit(layer[a]!, net[e]!);
      if (layer[b]! > 0) visit(layer[b]! - 1, net[e]!);
    }
  };
  eachVertical((gap) => verticalStart[gap + 1]!++);
  for (let gap = 0; gap < gaps; gap++) verticalStart[gap + 1]! += verticalStart[gap]!;
  const verticals = new Uint32Array(verticalStart[gaps]!);
  const verticalFill = verticalStart.slice(0, gaps);
  eachVertical((gap, k) => {
    verticals[verticalFill[gap]!++] = k;
  });

  // How far right of each column's center the next one's center sits, before any opening.
  const seen = new Uint32Array(graph.netCount);
  const step = new Float64Array(gaps);
  for (let gap = 0; gap < gaps; gap++) {
    let wires = 0;
    for (let at = gapStart[gap]!; at < gapStart[gap + 1]!; at++) {
      const k = lnet[gapLinks[at]!]!;
      if (seen[k] === gap + 1) continue;
      seen[k] = gap + 1;
      wires++;
    }
    for (let at = verticalStart[gap]!; at < verticalStart[gap + 1]!; at++) {
      const k = verticals[at]!;
      if (seen[k] === gap + 1) continue;
      seen[k] = gap + 1;
      wires++;
    }
    // The next column starts past the gap and past every label leaving this one.
    const spacing = (COLUMN_GAP + Math.min(CROSSING_CAP, wires)) * g;
    const right = Math.max(ceilTo(half[gap]!, g) + spacing, labels[gap]!);
    step[gap] = right + ceilTo(half[gap + 1]!, g);
  }

  // Everything drawn for the unit: blocks with extents on the grid, then its wires and labels.
  // A gap whose wires would cross a label opens, once, by as much as they need (`clearance`).
  const center = new Float64Array(layerCount);
  const opening = new Float64Array(gaps);
  const need = new Float64Array(gaps);
  const columns = new Float64Array(2 * layerCount);
  const positions = new Float32Array(2 * n);
  const box = new Float64Array(4);
  // The blocks' box, before the wires and labels grow it: the margin is measured from it.
  const blocks = new Float64Array(4);
  for (let pass = 0; ; pass++) {
    if (layerCount > 0) center[0] = ceilTo(half[0]!, g);
    for (let gap = 0; gap < gaps; gap++) {
      center[gap + 1] = center[gap]! + step[gap]! + opening[gap]!;
    }
    box[0] = Infinity;
    box[1] = Infinity;
    box[2] = -Infinity;
    box[3] = -Infinity;
    for (let l = 0; l < layerCount; l++) {
      columns[2 * l] = Infinity;
      columns[2 * l + 1] = -Infinity;
    }
    for (let i = 0; i < n; i++) {
      const block = order[i]!;
      const x = center[layer[i]!]! - size[2 * block]! / 2;
      const y = snapTo(rows.y[i]!, g);
      positions[2 * i] = x;
      positions[2 * i + 1] = y;
      const left = x - ceilTo(extent[4 * block]!, g);
      const right = x + size[2 * block]! + ceilTo(extent[4 * block + 2]!, g);
      box[0] = Math.min(box[0]!, left);
      box[1] = Math.min(box[1]!, y - ceilTo(extent[4 * block + 1]!, g));
      box[2] = Math.max(box[2]!, right);
      box[3] = Math.max(box[3]!, y + size[2 * block + 1]! + ceilTo(extent[4 * block + 3]!, g));
      const l = layer[i]!;
      columns[2 * l] = Math.min(columns[2 * l]!, left);
      columns[2 * l + 1] = Math.max(columns[2 * l + 1]!, right);
    }
    blocks.set(box);
    reach.measure(order, positions, box);
    if (pass === OPEN_PASSES || !reach.clearance(columns, need)) break;
    let opened = false;
    for (let gap = 0; gap < gaps; gap++) {
      if (need[gap] === 0 || opening[gap] !== 0) continue;
      opening[gap] = need[gap]!;
      opened = true;
    }
    if (!opened) break;
  }

  const grouped = blockGroup[order[0]!] !== NONE;
  const pad = grouped ? m.groupPad : 0;
  const header = grouped ? m.groupHeader : 0;
  const x0 = floorTo(box[0]!, g);
  const y0 = floorTo(box[1]!, g);
  const dx = pad - x0;
  const dy = pad + header - y0;
  for (let i = 0; i < n; i++) {
    positions[2 * i] = positions[2 * i]! + dx;
    positions[2 * i + 1] = positions[2 * i + 1]! + dy;
  }
  const width = ceilTo(box[2]!, g) - x0 + 2 * pad;
  const height = ceilTo(box[3]!, g) - y0 + header + 2 * pad;
  return {
    positions,
    width,
    height,
    margin: [blocks[0]! + dx, blocks[1]! + dy, width - blocks[2]! - dx, height - blocks[3]! - dy],
  };
}

/** `value` rounded down to a multiple of `quantum`, within float noise. */
function floorTo(value: number, quantum: number): number {
  return -ceilTo(-value, quantum);
}
