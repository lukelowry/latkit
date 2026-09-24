/**
 * A hand-driven `PickSource` for picker tests: a prepared netlist, positions and group frames
 * written straight into a layout mirror, and wire entries written straight into a wires mirror
 * with per-net slots, so picking is tested without the scene or the router.
 */

import type { Netlist } from '@latkit/model';

import type { PickSource } from '../../src/pick/picker.js';
import { prepare, type Prepared } from '../../src/prepare.js';
import {
  layoutBases,
  Mirror,
  WIRE_ARROW,
  WIRE_EMPTY,
  WIRE_JUNCTION,
  WIRE_SEGMENT,
  WIRE_WORDS,
} from '../../src/webgpu/buffers.js';

/** One hand-written wire entry. */
export type Entry =
  | readonly ['segment', ax: number, ay: number, bx: number, by: number]
  | readonly ['junction', x: number, y: number]
  | readonly ['arrow', x: number, y: number, dx: number, dy: number];

/** A `PickSource` whose every column a test writes by hand. */
export class FakeSource implements PickSource {
  prepared: Prepared | null = null;
  readonly layout = new Mirror('layout', 'storage');
  readonly wires = new Mirror('wires', 'storage');
  readonly hiddenBlocks = new Set<number>();
  readonly hiddenNets = new Set<number>();
  private readonly slots = new Map<number, { start: number; count: number }>();

  constructor(netlist?: Netlist, grid = 8) {
    if (netlist) this.load(netlist, grid);
  }

  /** Prepare a netlist and size the layout for it: every position and frame NaN, no wires. */
  load(netlist: Netlist, grid = 8): Prepared {
    const p = prepare(netlist, grid);
    this.prepared = p;
    this.layout.resize(layoutBases(p).words);
    this.layout.f32.fill(NaN);
    this.wires.resize(0);
    this.slots.clear();
    this.hiddenBlocks.clear();
    this.hiddenNets.clear();
    return p;
  }

  /** Put a block's top-left at `(x, y)`. */
  place(block: number, x: number, y: number): void {
    this.layout.f32[2 * block] = x;
    this.layout.f32[2 * block + 1] = y;
  }

  /** Place blocks in a row `gap` apart from `(x, y)`. */
  row(blocks: readonly number[], x = 0, y = 0, gap = 200): void {
    blocks.forEach((block, i) => this.place(block, x + i * gap, y));
  }

  /** Write a group's frame bounds (NaN for none). */
  frame(group: number, x0: number, y0: number, x1: number, y1: number): void {
    const at = layoutBases(this.prepared!).group + 4 * group;
    this.layout.f32.set([x0, y0, x1, y1], at);
  }

  /** A port's position in diagram units, from its block's position and offset. */
  port(port: number): readonly [number, number] {
    const p = this.prepared!;
    const block = p.portBlock[port]!;
    return [
      this.layout.f32[2 * block]! + p.portOffset[2 * port]!,
      this.layout.f32[2 * block + 1]! + p.portOffset[2 * port + 1]!,
    ];
  }

  /**
   * Write a net's route as its slot, at `start` (default: after every entry in use), with
   * `capacity` entries (default: the entries given); unused entries are empty.
   */
  route(net: number, entries: readonly Entry[], start?: number, capacity?: number): void {
    const at = start ?? this.wires.words / WIRE_WORDS;
    const size = Math.max(capacity ?? entries.length, entries.length);
    const end = (at + size) * WIRE_WORDS;
    if (end > this.wires.words) this.wires.resize(end);
    const { f32, u32 } = this.wires;
    for (let i = 0; i < size; i++) {
      const w = (at + i) * WIRE_WORDS;
      f32.fill(0, w, w + WIRE_WORDS);
      const entry = entries[i];
      u32[w + 4] = net;
      if (!entry) {
        u32[w + 5] = WIRE_EMPTY;
        continue;
      }
      const [kind, ax, ay] = entry;
      f32[w] = ax;
      f32[w + 1] = ay;
      if (kind === 'junction') {
        u32[w + 5] = WIRE_JUNCTION;
        continue;
      }
      f32[w + 2] = entry[3];
      f32[w + 3] = entry[4];
      u32[w + 5] = kind === 'segment' ? WIRE_SEGMENT : WIRE_ARROW;
    }
    this.slots.set(net, { start: at, count: size });
  }

  /** A straight segment between two ports, as one entry. */
  between(a: number, b: number): Entry {
    const [ax, ay] = this.port(a);
    const [bx, by] = this.port(b);
    return ['segment', ax, ay, bx, by];
  }

  slot(net: number): { readonly start: number; readonly count: number } {
    return this.slots.get(net) ?? { start: 0, count: 0 };
  }

  blockVisible(block: number): boolean {
    return !this.hiddenBlocks.has(block);
  }

  netVisible(net: number): boolean {
    return !this.hiddenNets.has(net);
  }
}
