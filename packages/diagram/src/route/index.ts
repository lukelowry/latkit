/**
 * Wire routing: every net's route, written as wire entries into per-net slots of the wires mirror
 * so a re-route rewrites one slot.
 */

import type { Routing } from '../options.js';
import { STYLE_WIRE, type Prepared } from '../prepare.js';
import {
  layoutBases,
  WIRE_ARROW,
  WIRE_JUNCTION,
  WIRE_SEGMENT,
  WIRE_WORDS,
  type Mirror,
} from '../webgpu/buffers.js';
import { routeOrthogonal } from './orthogonal.js';
import { routeStraight, type RouteWriter } from './straight.js';

/** What a route reads: the netlist, where blocks sit, what is hidden, and the obstacles. */
export interface RouteContext {
  /** The loaded netlist; a `Routes` given another rebinds to it. */
  readonly prepared: Prepared;
  /** Effective top-lefts, 2 per block. */
  readonly positions: Float32Array;
  /** The `blockVisible` values, or null when every block shows. */
  readonly blockVisible: Float32Array | null;
  /** The `netVisible` values, or null when every net shows. */
  readonly netVisible: Float32Array | null;
  /** How wires run: at right angles on the grid, or straight from port to port. */
  readonly mode: Routing;
  /**
   * A port routed as if it were off its net, while the wire it ends is picked up; `NONE` or
   * absent when none is.
   */
  readonly detached?: number;
  /**
   * Shown or hidden blocks whose extent rectangle meets a box's interior, each once; a box of
   * zero width or height finds the blocks its line runs through. Routing asks it for channels,
   * lane depths, and column stacks, and skips hidden blocks itself.
   */
  readonly obstacles: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    visit: (block: number) => void,
  ) => void;
  /**
   * Per block: `1` when the feedback lanes of the wires it roots run a grid step lower, as
   * `laneShifts` derives it from the block's place in its unit, so identical units route alike
   * wherever they sit; null lowers none.
   */
  readonly laneShift: Uint8Array | null;
}

/** Fewest entries the slot of a net that can draw keeps, so a wire that gains a jog still fits. */
const MIN_SLOT = 8;
/** Entries an arena keeps between routes; a larger one, grown by a whole-diagram route, is freed. */
const ARENA_KEEP = 1 << 16;
/** Entries a whole-diagram route reserves per wired port; routes take two and a half to three. */
const ENTRIES_PER_PORT = 3;

/** Ports on nets drawn as wires with two or more ports: the ports a whole-diagram route joins. */
function wiredPorts(prepared: Prepared): number {
  const { netStart } = prepared.netlist;
  let ports = 0;
  for (let net = 0; net < prepared.netCount; net++) {
    const count = netStart[net + 1]! - netStart[net]!;
    if (prepared.netStyle[net] === STYLE_WIRE && count >= 2) ports += count;
  }
  return ports;
}

/** A growable run of wire entries in the wires mirror's layout; the writer routers write to. */
class Entries implements RouteWriter {
  f32 = new Float32Array(64 * WIRE_WORDS);
  u32 = new Uint32Array(this.f32.buffer);
  /** Entries written. */
  size = 0;
  /** The net entries are written for. */
  net = 0;
  /** The net's label anchor, NaN until a router sets it. */
  anchorX = Number.NaN;
  anchorY = Number.NaN;

  /** Start writing `net`'s route after what is already written. */
  begin(net: number): void {
    this.net = net;
    this.anchorX = Number.NaN;
    this.anchorY = Number.NaN;
  }

  segment(ax: number, ay: number, bx: number, by: number, along: number): void {
    this.push(ax, ay, bx, by, WIRE_SEGMENT, along);
  }

  junction(x: number, y: number): void {
    this.push(x, y, 0, 0, WIRE_JUNCTION, 0);
  }

  arrow(x: number, y: number, dx: number, dy: number): void {
    this.push(x, y, dx, dy, WIRE_ARROW, 0);
  }

  anchor(x: number, y: number): void {
    this.anchorX = x;
    this.anchorY = y;
  }

  /** Drop what is written and the memory past `keep` entries, which a whole-diagram route took. */
  release(keep = ARENA_KEEP): void {
    this.size = 0;
    if (this.u32.length > Math.max(keep, 64) * WIRE_WORDS) {
      this.f32 = new Float32Array(64 * WIRE_WORDS);
      this.u32 = new Uint32Array(this.f32.buffer);
    }
  }

  private push(ax: number, ay: number, bx: number, by: number, kind: number, along: number): void {
    let at = this.size * WIRE_WORDS;
    if (at + WIRE_WORDS > this.u32.length) {
      const u32 = new Uint32Array(2 * this.u32.length);
      u32.set(this.u32);
      this.u32 = u32;
      this.f32 = new Float32Array(u32.buffer);
    }
    const { f32, u32 } = this;
    f32[at++] = ax;
    f32[at++] = ay;
    f32[at++] = bx;
    f32[at++] = by;
    u32[at++] = this.net;
    u32[at++] = kind;
    f32[at++] = along;
    u32[at] = 0;
    this.size++;
  }
}

/**
 * Every net's route, kept in per-net slots of the wires mirror so a re-route writes one slot.
 *
 * @remarks
 * The first `routeAll` after a `reset` sizes each slot at its route plus a quarter, at least
 * `MIN_SLOT` entries for a net that can draw, and none for a tag net. A re-route that no longer
 * fits its slot repacks every slot at the same headroom. Unused entries are `WIRE_EMPTY`, which the
 * wire pass culls, so the pass draws `capacity` instances. Each net's label anchor goes to the
 * layout mirror at `layoutBases(prepared).anchor`, NaN while nothing is drawn.
 */
export class Routes {
  private prepared: Prepared | null = null;
  private anchorBase = 0;
  /** Per net: its slot's first entry, entries in use, and entries reserved. */
  private starts = new Uint32Array(0);
  private counts = new Uint32Array(0);
  private rooms = new Uint32Array(0);
  private total = 0;
  /** Nets changed since the last drain, or every net after a reset or repack. */
  private changed = new Uint8Array(0);
  private changedList = new Uint32Array(0);
  private changedCount = 0;
  private everything = false;
  /** One route at a time, and the routes that overflowed their slots until the repack. */
  private readonly entries = new Entries();
  private readonly spill = new Entries();
  /** Per net: where its overflowed route starts in `spill`, or -1. */
  private spilled = new Int32Array(0);

  constructor(
    private readonly wires: Mirror,
    private readonly layout: Mirror,
  ) {}

  /** Entries in use: the wire pass instance count. */
  get capacity(): number {
    return this.total;
  }

  /**
   * Bind a prepared netlist and allocate slots (capacity = first route + 25%, min 8 entries);
   * null keeps nothing, the routing arenas included.
   */
  reset(prepared: Prepared | null): void {
    this.prepared = prepared;
    const nets = prepared ? prepared.netCount : 0;
    this.starts = new Uint32Array(nets);
    this.counts = new Uint32Array(nets);
    this.rooms = new Uint32Array(nets);
    this.changed = new Uint8Array(nets);
    this.changedList = new Uint32Array(nets);
    this.spilled = new Int32Array(nets).fill(-1);
    this.changedCount = 0;
    this.everything = true;
    this.total = 0;
    this.wires.resize(0);
    this.wires.touchAll();
    if (!prepared) {
      this.entries.release(0);
      this.spill.release(0);
      return;
    }
    const bases = layoutBases(prepared);
    this.anchorBase = bases.anchor;
    if (this.layout.words < bases.words) this.layout.resize(bases.words);
    this.layout.f32.fill(Number.NaN, bases.anchor, bases.anchor + 2 * nets);
    this.layout.touch(bases.anchor, bases.anchor + 2 * nets);
  }

  /** Route every net over `positions` (effective top-lefts), honoring hidden blocks and nets. */
  routeAll(ctx: RouteContext): void {
    if (ctx.prepared !== this.prepared) this.reset(ctx.prepared);
    const nets = ctx.prepared.netCount;
    const route = ctx.mode === 'straight' ? routeStraight : routeOrthogonal;
    const { entries, starts, counts, rooms } = this;
    entries.size = 0;
    // A route takes about three entries a wired port: room for all of them at once, rather than
    // doubling up from nothing on every whole-diagram route.
    growTo(entries, ENTRIES_PER_PORT * wiredPorts(ctx.prepared));
    for (let net = 0; net < nets; net++) {
      starts[net] = entries.size;
      entries.begin(net);
      route(ctx, net, entries);
      counts[net] = entries.size - starts[net]!;
      this.anchor(net, entries.anchorX, entries.anchorY);
    }
    let total = 0;
    for (let net = 0; net < nets; net++) {
      rooms[net] = this.room(net, counts[net]!);
      total += rooms[net]!;
    }
    this.wires.resize(total * WIRE_WORDS);
    const into = this.wires.u32;
    let at = 0;
    for (let net = 0; net < nets; net++) {
      const from = starts[net]!;
      starts[net] = at;
      copy(entries.u32, from, into, at, counts[net]!);
      into.fill(0, (at + counts[net]!) * WIRE_WORDS, (at + rooms[net]!) * WIRE_WORDS);
      at += rooms[net]!;
    }
    this.total = total;
    entries.release();
    this.wires.touchAll();
    this.layout.touch(this.anchorBase, this.anchorBase + 2 * nets);
    this.everything = true;
  }

  /** Re-route `nets`, writing their slots (repacking every slot when one overflows). */
  reroute(nets: Uint32Array | readonly number[], ctx: RouteContext): void {
    if (ctx.prepared !== this.prepared) {
      this.routeAll(ctx);
      return;
    }
    const route = ctx.mode === 'straight' ? routeStraight : routeOrthogonal;
    const { entries, spill, starts, counts, rooms, spilled } = this;
    const netCount = ctx.prepared.netCount;
    const wires = this.wires;
    spill.size = 0;
    let overflow = false;
    for (let i = 0; i < nets.length; i++) {
      const net = nets[i]!;
      if (!(net >= 0 && net < netCount)) continue;
      entries.size = 0;
      entries.begin(net);
      route(ctx, net, entries);
      this.anchor(net, entries.anchorX, entries.anchorY, true);
      this.mark(net);
      const count = entries.size;
      if (count > rooms[net]!) {
        // Held until every net is routed, so one repack takes in every overflow.
        const at = spill.size;
        growTo(spill, at + count);
        copy(entries.u32, 0, spill.u32, at, count);
        spill.size = at + count;
        spilled[net] = at;
        counts[net] = count;
        overflow = true;
        continue;
      }
      const start = starts[net]!;
      const was = counts[net]!;
      copy(entries.u32, 0, wires.u32, start, count);
      if (was > count) wires.u32.fill(0, (start + count) * WIRE_WORDS, (start + was) * WIRE_WORDS);
      wires.touch(start * WIRE_WORDS, (start + Math.max(was, count)) * WIRE_WORDS);
      counts[net] = count;
    }
    entries.release();
    if (overflow) this.repack();
    spill.release();
  }

  /** Clear `nets`' slots (hidden during a large animated move). */
  hide(nets: Uint32Array | readonly number[]): void {
    const netCount = this.counts.length;
    for (let i = 0; i < nets.length; i++) {
      const net = nets[i]!;
      if (!(net >= 0 && net < netCount)) continue;
      const start = this.starts[net]!;
      const count = this.counts[net]!;
      this.anchor(net, Number.NaN, Number.NaN, true);
      this.mark(net);
      if (count === 0) continue;
      this.wires.u32.fill(0, start * WIRE_WORDS, (start + count) * WIRE_WORDS);
      this.wires.touch(start * WIRE_WORDS, (start + count) * WIRE_WORDS);
      this.counts[net] = 0;
    }
  }

  /** Slot of a net: entries `[start, start + count)` in the wires mirror. */
  slot(net: number): { readonly start: number; readonly count: number } {
    return { start: this.slotStart(net), count: this.slotCount(net) };
  }

  /** The first entry of a net's slot, without allocating; 0 for an unknown net. */
  slotStart(net: number): number {
    return this.starts[net] ?? 0;
  }

  /** Entries in use in a net's slot, without allocating; 0 for an unknown net. */
  slotCount(net: number): number {
    return this.counts[net] ?? 0;
  }

  /** Called with each net whose entries changed since the last `drain` (for the pick index). */
  drain(visit: (net: number) => void): void {
    const everything = this.everything;
    const count = this.changedCount;
    this.everything = false;
    this.changedCount = 0;
    for (let i = 0; i < count; i++) this.changed[this.changedList[i]!] = 0;
    if (everything) {
      for (let net = 0; net < this.counts.length; net++) visit(net);
      return;
    }
    for (let i = 0; i < count; i++) visit(this.changedList[i]!);
  }

  /** Entries a slot reserves for a route of `count`: none for a net that never draws. */
  private room(net: number, count: number): number {
    const prepared = this.prepared!;
    const { netStart } = prepared.netlist;
    if (prepared.netStyle[net] !== STYLE_WIRE || netStart[net + 1]! - netStart[net]! < 2) {
      return count;
    }
    return Math.max(MIN_SLOT, count + Math.ceil(count / 4));
  }

  /** Lay every slot out again at its route's size plus headroom, taking spilled routes in. */
  private repack(): void {
    const { starts, counts, rooms, spilled } = this;
    const nets = counts.length;
    const old = this.wires.u32.slice(0, this.total * WIRE_WORDS);
    let total = 0;
    for (let net = 0; net < nets; net++) {
      rooms[net] = this.room(net, counts[net]!);
      total += rooms[net]!;
    }
    this.wires.resize(total * WIRE_WORDS);
    const into = this.wires.u32;
    let at = 0;
    for (let net = 0; net < nets; net++) {
      const count = counts[net]!;
      if (spilled[net]! >= 0) {
        copy(this.spill.u32, spilled[net]!, into, at, count);
        spilled[net] = -1;
      } else copy(old, starts[net]!, into, at, count);
      starts[net] = at;
      into.fill(0, (at + count) * WIRE_WORDS, (at + rooms[net]!) * WIRE_WORDS);
      at += rooms[net]!;
    }
    this.total = total;
    this.wires.touchAll();
    this.everything = true;
  }

  /** Write a net's label anchor into the layout mirror. */
  private anchor(net: number, x: number, y: number, touch = false): void {
    const at = this.anchorBase + 2 * net;
    const f32 = this.layout.f32;
    if (touch && f32[at] === x && f32[at + 1] === y) return;
    f32[at] = x;
    f32[at + 1] = y;
    if (touch) this.layout.touch(at, at + 2);
  }

  /** Remember that a net's entries changed. */
  private mark(net: number): void {
    if (this.everything || this.changed[net]) return;
    this.changed[net] = 1;
    this.changedList[this.changedCount++] = net;
  }
}

/** Copy `count` entries from entry `from` of `source` to entry `to` of `target`. */
function copy(
  source: Uint32Array,
  from: number,
  target: Uint32Array,
  to: number,
  count: number,
): void {
  const words = count * WIRE_WORDS;
  const a = from * WIRE_WORDS;
  const b = to * WIRE_WORDS;
  for (let w = 0; w < words; w++) target[b + w] = source[a + w]!;
}

/** Grow an arena so it holds `size` entries. */
function growTo(arena: Entries, size: number): void {
  const words = size * WIRE_WORDS;
  if (arena.u32.length >= words) return;
  let length = arena.u32.length;
  while (length < words) length *= 2;
  const u32 = new Uint32Array(length);
  u32.set(arena.u32);
  arena.u32 = u32;
  arena.f32 = new Float32Array(u32.buffer);
}
