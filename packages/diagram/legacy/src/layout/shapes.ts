/**
 * Unit shapes: a canonical order of a unit's blocks and a structure equal for two units exactly
 * when the layered layout reads the same thing from them, so a system of thousands of plants lays
 * out a handful of shapes once each.
 */

import { NONE, STYLE_WIRE, type Prepared } from '../prepare.js';
import { layerUnit, type UnitLayout } from './layered.js';
import { labelSpans, Reach } from './reach.js';
import { units, type Units } from './units.js';

/** A unit's canonical block order and structural key. */
export interface Shape {
  /**
   * Equal for two units exactly when `layerUnit` reads the same structure from their orders:
   * block sizes, extents, and ports, which in-unit ports each wire joins, and the labels the
   * unit's ports root. Opaque; compare it, never parse it.
   */
  readonly key: string;
  /** The unit's blocks in canonical order: by title, then by index. */
  readonly order: Uint32Array;
}

/** Units up to this many blocks order by insertion; a larger one sorts. */
const INSERTION = 32;
/** Code units per `String.fromCharCode` call, well under every engine's argument limit. */
const CHUNK = 8192;

/**
 * Canonical block order and a structural key for one unit; two units with the same key get the
 * same relative layout.
 *
 * @remarks
 * Allocates scratch sized to the whole netlist and builds a string; shape many units with one
 * {@link Shaper}, which numbers shapes instead.
 */
export function shapeOf(prepared: Prepared, blocks: Uint32Array): Shape {
  const shaper = new Shaper(prepared);
  shaper.shape(blocks, 0, blocks.length);
  return { key: shaper.key(), order: shaper.order.slice(0, shaper.size) };
}

/**
 * Shapes the units of one prepared netlist, numbering each distinct structure as it first meets
 * it: two units get one id exactly when `layerUnit` reads the same structure from their orders.
 *
 * @remarks
 * The order sorts by `blockTitle` (a block's class), so two plants that list their classes in a
 * different order still share a shape; equal titles keep index order. The structure is the unit's
 * words in that order as raw float bits: per block its size, extents and port count, per port its
 * flow and side, offset, the unit-local number of the wire it is on, or -1 when the wire joins no
 * other port of the unit or is driven from outside it (such a wire lays out nothing), and the span
 * of the label the port roots (`labelSpans`), negated past -1 when the port is the first of a
 * driverless wire in the unit, which roots the route `Reach` measures. Scratch is sized once to
 * the netlist and ids come from a hash of the words, so shaping a unit whose shape was met before
 * allocates nothing.
 */
export class Shaper {
  /** The last shaped unit's blocks in canonical order, in its first `size` entries. */
  order = new Uint32Array(16);
  /** Blocks in the last shaped unit. */
  size = 0;
  /** Distinct shapes met so far; ids run from 0. */
  count = 0;

  private readonly prepared: Prepared;
  /** Per port: `labelSpans` of the prepared netlist. */
  private readonly labelSpan: Float32Array;
  /** Per block: its title's rank among the distinct titles; all 0 without titles. */
  private readonly rank: Uint32Array;
  // Stamps: a block or net carries the current call's stamp while the call reads it.
  private readonly member: Uint32Array;
  private readonly counted: Uint32Array;
  private readonly numbered: Uint32Array;
  private readonly ports: Uint32Array;
  private readonly local: Uint32Array;
  /** Per driverless net: its first port in the unit, in net order. */
  private readonly first: Uint32Array;
  private stamp = 0;
  /** The last unit's structure; `f32` and `u32` view one store. */
  private f32 = new Float32Array(256);
  private u32 = new Uint32Array(this.f32.buffer);
  private used = 0;
  /** Known shapes by structure hash: the latest id, earlier ids with the hash chained behind it. */
  private readonly byHash = new Map<number, number>();
  private chain = new Int32Array(16);
  /** Per id: its structure's words in `pool`, from `start[id]` up to `start[id + 1]`. */
  private start = new Uint32Array(17);
  private pool = new Uint32Array(1024);

  /**
   * @param prepared - The prepared netlist whose units this shapes.
   * @param labelSpan - Per port: `labelSpans(prepared)`, when the caller has it already.
   */
  constructor(prepared: Prepared, labelSpan: Float32Array = labelSpans(prepared)) {
    this.prepared = prepared;
    this.labelSpan = labelSpan;
    const { blockCount, netCount } = prepared;
    this.member = new Uint32Array(blockCount);
    this.counted = new Uint32Array(netCount);
    this.numbered = new Uint32Array(netCount);
    this.ports = new Uint32Array(netCount);
    this.local = new Uint32Array(netCount);
    this.first = new Uint32Array(netCount);
    this.rank = titleRanks(prepared);
  }

  /**
   * Shape the unit `blocks[from]` up to `blocks[to]`: write its canonical order into `order` and
   * return its shape's id.
   */
  shape(blocks: Uint32Array, from: number, to: number): number {
    const n = to - from;
    if (this.order.length < n) this.order = new Uint32Array(Math.max(n, 2 * this.order.length));
    const order = this.order;
    for (let i = 0; i < n; i++) order[i] = blocks[from + i]!;
    this.size = n;
    canonical(order, n, this.rank);
    this.write(n);
    return this.intern();
  }

  /**
   * The last shaped unit's structure as a string: equal for two units exactly when a shaper gives
   * them one id.
   */
  key(): string {
    const units = new Uint16Array(this.f32.buffer, 0, 2 * this.used);
    if (units.length <= CHUNK) return String.fromCharCode(...units);
    let key = '';
    for (let at = 0; at < units.length; at += CHUNK) {
      key += String.fromCharCode(...units.subarray(at, at + CHUNK));
    }
    return key;
  }

  /** Write the structure of the first `n` blocks of `order` into the scratch words. */
  private write(n: number): void {
    const { portBlock, portNet, portSide, netStyle, netDriver } = this.prepared;
    const { size, extent, portOffset, blockGroup } = this.prepared;
    const { portStart, portFlow, netStart, netPorts } = this.prepared.netlist;
    const { order, member, counted, numbered, ports, local, first, labelSpan } = this;
    if (++this.stamp === 0x100000000) {
      member.fill(0);
      counted.fill(0);
      numbered.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;

    let need = 1;
    for (let i = 0; i < n; i++) {
      const block = order[i]!;
      member[block] = stamp;
      need += 7 + 5 * (portStart[block + 1]! - portStart[block]!);
      for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
        const net = portNet[port]!;
        if (net === NONE || netStyle[net] !== STYLE_WIRE) continue;
        if (counted[net] !== stamp) {
          counted[net] = stamp;
          ports[net] = 0;
        }
        ports[net]!++;
      }
    }
    if (this.f32.length < need) {
      this.f32 = new Float32Array(Math.max(need, 2 * this.f32.length));
      this.u32 = new Uint32Array(this.f32.buffer);
    }
    const words = this.f32;

    let at = 0;
    let nets = 0;
    words[at++] = n > 0 && blockGroup[order[0]!] !== NONE ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const block = order[i]!;
      words[at++] = size[2 * block]!;
      words[at++] = size[2 * block + 1]!;
      words[at++] = extent[4 * block]!;
      words[at++] = extent[4 * block + 1]!;
      words[at++] = extent[4 * block + 2]!;
      words[at++] = extent[4 * block + 3]!;
      words[at++] = portStart[block + 1]! - portStart[block]!;
      for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
        const net = portNet[port]!;
        let code = -1;
        let root = false;
        if (net !== NONE && netStyle[net] === STYLE_WIRE && ports[net]! > 1) {
          const driver = netDriver[net]!;
          if (driver === NONE || member[portBlock[driver]!] === stamp) {
            if (numbered[net] !== stamp) {
              numbered[net] = stamp;
              local[net] = nets++;
              if (driver === NONE) {
                let k = netStart[net]!;
                while (member[portBlock[netPorts[k]!]!] !== stamp) k++;
                first[net] = netPorts[k]!;
              }
            }
            code = local[net]!;
            root = driver === NONE && first[net] === port;
          }
        }
        const span = labelSpan[port]!;
        words[at++] = portFlow[port]! | (portSide[port]! << 2);
        words[at++] = portOffset[2 * port]!;
        words[at++] = portOffset[2 * port + 1]!;
        words[at++] = code;
        words[at++] = root ? -1 - span : span;
      }
    }
    this.used = at;
  }

  /** The id of the scratch structure, numbering it when it is new. */
  private intern(): number {
    const { u32, used } = this;
    let hash = used;
    for (let i = 0; i < used; i++) {
      hash = Math.imul(hash ^ u32[i]!, 0x9e3779b1);
      hash ^= hash >>> 15;
    }
    // Small integers stay unboxed map keys.
    hash &= 0x3fffffff;
    const head = this.byHash.get(hash);
    for (let id = head ?? -1; id >= 0; id = this.chain[id]!) {
      const from = this.start[id]!;
      if (this.start[id + 1]! - from !== used) continue;
      let same = true;
      for (let i = 0; i < used && same; i++) same = this.pool[from + i] === u32[i];
      if (same) return id;
    }
    const id = this.count++;
    if (this.chain.length < this.count) {
      this.chain = grow(this.chain, this.count);
      this.start = grow(this.start, this.count + 1);
    }
    const from = this.start[id]!;
    if (this.pool.length < from + used) this.pool = grow(this.pool, from + used);
    this.pool.set(u32.subarray(0, used), from);
    this.start[id + 1] = from + used;
    this.chain[id] = head ?? -1;
    this.byHash.set(hash, id);
    return id;
  }
}

/**
 * One layout per unit shape within one arrangement, laid out on first sight; the shaper and the
 * reach measure are shared by every unit.
 */
export class Layouts {
  private readonly shaper: Shaper;
  private readonly reach: Reach;
  private readonly byShape: UnitLayout[] = [];

  constructor(private readonly prepared: Prepared) {
    this.reach = new Reach(prepared);
    this.shaper = new Shaper(prepared, this.reach.labelSpan);
  }

  /** The layout of the unit `blocks[from]` up to `blocks[to]`, its order in the shaper's scratch. */
  of(blocks: Uint32Array, from: number, to: number): UnitLayout {
    const shaper = this.shaper;
    const id = shaper.shape(blocks, from, to);
    let layout = this.byShape[id];
    if (!layout) {
      layout = layerUnit(this.prepared, shaper.order.subarray(0, shaper.size), this.reach);
      this.byShape[id] = layout;
    }
    return layout;
  }

  /** The canonical order of the unit `of` shaped last. */
  get order(): Uint32Array {
    return this.shaper.order;
  }

  /**
   * Lay out the unit `blocks[from]` up to `blocks[to]`: write each member's top-left relative to
   * the unit's own into `into` (2 per block) and return the unit's layout.
   */
  place(blocks: Uint32Array, from: number, to: number, into: Float32Array): UnitLayout {
    const layout = this.of(blocks, from, to);
    const order = this.shaper.order;
    const positions = layout.positions;
    for (let i = 0; i < to - from; i++) {
      const block = order[i]!;
      into[2 * block] = positions[2 * i]!;
      into[2 * block + 1] = positions[2 * i + 1]!;
    }
    return layout;
  }
}

/**
 * Per block: `1` when it sits at an odd place in its unit's canonical order (the order a
 * {@link Shaper} gives it), else `0`; the router's `RouteContext.laneShift`.
 *
 * @remarks
 * The router lowers the feedback lanes of the wires a shifted block roots by a grid step, so the
 * feedback of two blocks of a unit that share no column keeps apart. Taken from the unit's own
 * structure rather than from block indices, it is the same for every unit of one shape, so such
 * units route alike wherever they sit, and `Reach` measures the routes every one of them draws.
 */
export function laneShifts(prepared: Prepared, all: Units = units(prepared)): Uint8Array {
  const rank = titleRanks(prepared);
  const shifts = new Uint8Array(prepared.blockCount);
  let order = new Uint32Array(16);
  for (let unit = 0; unit < all.count; unit++) {
    const from = all.start[unit]!;
    const n = all.start[unit + 1]! - from;
    if (order.length < n) order = new Uint32Array(Math.max(n, 2 * order.length));
    for (let i = 0; i < n; i++) order[i] = all.blocks[from + i]!;
    canonical(order, n, rank);
    for (let i = 1; i < n; i += 2) shifts[order[i]!] = 1;
  }
  return shifts;
}

/** Sort the first `n` entries of `order` into canonical order: by title rank, then index. */
function canonical(order: Uint32Array, n: number, rank: Uint32Array): void {
  if (n > INSERTION) {
    order.subarray(0, n).sort((a, b) => rank[a]! - rank[b]! || a - b);
    return;
  }
  for (let i = 1; i < n; i++) {
    const block = order[i]!;
    const r = rank[block]!;
    let j = i - 1;
    for (; j >= 0; j--) {
      const other = order[j]!;
      const ro = rank[other]!;
      if (ro < r || (ro === r && other < block)) break;
      order[j + 1] = other;
    }
    order[j + 1] = block;
  }
}

/** Per block: its title's rank among the netlist's distinct titles, so an order sorts by number. */
function titleRanks(prepared: Prepared): Uint32Array {
  const { blockCount } = prepared;
  const { blockTitle } = prepared.netlist;
  const rank = new Uint32Array(blockCount);
  if (!blockTitle) return rank;
  const ids = new Map<string, number>();
  for (let block = 0; block < blockCount; block++) {
    const title = blockTitle[block] ?? '';
    let id = ids.get(title);
    if (id === undefined) {
      id = ids.size;
      ids.set(title, id);
    }
    rank[block] = id;
  }
  const titles = Array.from(ids.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const byId = new Uint32Array(titles.length);
  titles.forEach((title, at) => (byId[ids.get(title)!] = at));
  for (let block = 0; block < blockCount; block++) rank[block] = byId[rank[block]!]!;
  return rank;
}

/** A typed array at least `need` long, doubling, contents kept. */
function grow<T extends Int32Array | Uint32Array>(array: T, need: number): T {
  let length = Math.max(array.length, 1);
  while (length < need) length *= 2;
  const next = new (array.constructor as new (length: number) => T)(length);
  next.set(array);
  return next;
}
