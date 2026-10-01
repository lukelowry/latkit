import {
  PART_BLOCK,
  PART_GROUP,
  PART_NET,
  PART_PORT,
  partId,
  partIndex,
  partKind,
  partOf,
  type Part,
} from './part.js';
import { NONE, type Prepared } from './prepare.js';
import {
  FOCUS_COMPATIBLE,
  FOCUS_DRAGGING,
  FOCUS_HOVER,
  FOCUS_SELECTED,
  FOCUS_TARGET,
  focusBases,
  type Mirror,
} from './webgpu/buffers.js';

/** An empty id list, shared by every state that holds none. */
const NO_IDS: readonly number[] = Object.freeze([]);
/** No blocks. */
const NO_BLOCKS = new Uint32Array(0);

/**
 * Hover, selection, and wire-drag glow as part ids, written into the focus mirror as `FOCUS_*`
 * flags, touching only the words that changed.
 *
 * @remarks
 * Each flag bit has one owner: hover owns `FOCUS_HOVER`, the selection `FOCUS_SELECTED`, the glow
 * `FOCUS_COMPATIBLE` and `FOCUS_TARGET`, a drag `FOCUS_DRAGGING`. A change clears its bit on the
 * parts that lost it and sets it on the parts that gained it, so a word is touched only when its
 * value changes. Ids that name no part of the loaded netlist are dropped.
 */
export class Focus {
  private readonly mirror: Mirror;
  private prepared: Prepared | null = null;
  // Word offsets of each kind's flags, and each kind's count.
  private portBase = 0;
  private netBase = 0;
  private groupBase = 0;

  private hovered: number | null = null;
  private readonly selected = new Set<number>();
  private glow: readonly number[] = NO_IDS;
  /** The iterable the glow was last built from, so a repeat with a new target skips the diff. */
  private glowSource: Iterable<number> | null = null;
  private target: number | null = null;
  private dragging: Uint32Array | null = null;

  constructor(mirror: Mirror) {
    this.mirror = mirror;
    this.reset(null);
  }

  /** The hovered part id, or null. */
  get hover(): number | null {
    return this.hovered;
  }

  /** Selected part ids, in insertion order. */
  get selection(): ReadonlySet<number> {
    return this.selected;
  }

  /** Whether any port or net glows as a compatible wire target; the glow pulses while it does. */
  get glowing(): boolean {
    return this.glow.length > 0;
  }

  /**
   * Size the focus mirror for a prepared netlist and clear everything; with none, the mirror
   * gives its memory back.
   */
  reset(prepared: Prepared | null): void {
    this.prepared = prepared;
    const bases = prepared ? focusBases(prepared) : { port: 0, net: 0, group: 0, words: 0 };
    this.portBase = bases.port;
    this.netBase = bases.net;
    this.groupBase = bases.group;
    if (prepared) {
      this.mirror.resize(bases.words);
      this.mirror.u32.fill(0, 0, bases.words);
      this.mirror.touchAll();
    } else this.mirror.release();
    this.hovered = null;
    this.selected.clear();
    this.glow = NO_IDS;
    this.glowSource = null;
    this.target = null;
    this.dragging = null;
  }

  /**
   * Remap the selection through a load's survivor map and size the mirror for `next`; hover,
   * glow, and dragging clear. Call it in place of `reset` on a load, while the selection still
   * names parts of `prev`.
   *
   * @remarks
   * A block survives as its survivor, a port as the same local port of its block's survivor, a
   * net through any of its ports that survives on a net, and a group through any member that
   * survives in a group. The order of the selection is kept.
   *
   * @param survivors - Per block of `next`, its block in `prev`, or `NONE`.
   */
  remap(prev: Prepared, next: Prepared, survivors: Uint32Array): void {
    const old = this.prepared === prev ? Array.from(this.selected) : [];
    this.reset(next);
    if (old.length === 0) return;
    const blockOf = new Uint32Array(prev.blockCount).fill(NONE);
    const count = Math.min(survivors.length, next.blockCount);
    for (let block = 0; block < count; block++) {
      const was = survivors[block]!;
      if (was < prev.blockCount) blockOf[was] = block;
    }
    const portOf = (port: number): number => {
      const block = blockOf[prev.portBlock[port]!]!;
      if (block === NONE) return NONE;
      const local = port - prev.netlist.portStart[prev.portBlock[port]!]!;
      const start = next.netlist.portStart[block]!;
      return local < next.netlist.portStart[block + 1]! - start ? start + local : NONE;
    };
    const mapped: number[] = [];
    for (const id of old) {
      const index = partIndex(id);
      switch (partKind(id)) {
        case PART_BLOCK: {
          const block = blockOf[index]!;
          if (block !== NONE) mapped.push(partId(PART_BLOCK, block));
          break;
        }
        case PART_PORT: {
          const port = portOf(index);
          if (port !== NONE) mapped.push(partId(PART_PORT, port));
          break;
        }
        case PART_NET: {
          const { netStart, netPorts } = prev.netlist;
          for (let at = netStart[index]!; at < netStart[index + 1]!; at++) {
            const port = portOf(netPorts[at]!);
            const net = port === NONE ? NONE : next.portNet[port]!;
            if (net === NONE) continue;
            mapped.push(partId(PART_NET, net));
            break;
          }
          break;
        }
        case PART_GROUP: {
          for (let at = prev.groupStart[index]!; at < prev.groupStart[index + 1]!; at++) {
            const block = blockOf[prev.groupBlocks[at]!]!;
            const group = block === NONE ? NONE : next.blockGroup[block]!;
            if (group === NONE) continue;
            mapped.push(partId(PART_GROUP, group));
            break;
          }
          break;
        }
      }
    }
    this.select(mapped);
  }

  /** Hover a part id, or nothing; true when it changed. An id naming no part hovers nothing. */
  setHover(id: number | null): boolean {
    const next = id !== null && this.word(id) >= 0 ? id : null;
    if (next === this.hovered) return false;
    if (this.hovered !== null) this.flag(this.hovered, FOCUS_HOVER, false);
    this.hovered = next;
    if (next !== null) this.flag(next, FOCUS_HOVER, true);
    return true;
  }

  /**
   * Replace the selection with the ids that name parts, each once, in order; true when the
   * selection changed, its order included.
   */
  select(ids: Iterable<number>): boolean {
    const next: number[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id) || this.word(id) < 0) continue;
      seen.add(id);
      next.push(id);
    }
    let same = next.length === this.selected.size;
    if (same) {
      let i = 0;
      for (const id of this.selected) {
        if (id !== next[i++]) {
          same = false;
          break;
        }
      }
    }
    if (same) return false;
    for (const id of this.selected) if (!seen.has(id)) this.flag(id, FOCUS_SELECTED, false);
    this.selected.clear();
    for (const id of next) {
      this.selected.add(id);
      this.flag(id, FOCUS_SELECTED, true);
    }
    return true;
  }

  /** Add a part id to the selection, or remove it when present; an id naming no part is ignored. */
  toggle(id: number): void {
    if (this.selected.delete(id)) {
      this.flag(id, FOCUS_SELECTED, false);
      return;
    }
    if (this.word(id) < 0) return;
    this.selected.add(id);
    this.flag(id, FOCUS_SELECTED, true);
  }

  /** The selection as parts. */
  parts(): Part[] {
    return Array.from(this.selected, partOf);
  }

  /** The selected blocks, in selection order. */
  selectedBlocks(): Uint32Array {
    let count = 0;
    for (const id of this.selected) if (partKind(id) === PART_BLOCK) count++;
    const blocks = new Uint32Array(count);
    count = 0;
    for (const id of this.selected)
      if (partKind(id) === PART_BLOCK) blocks[count++] = partIndex(id);
    return blocks;
  }

  /**
   * Wire-drag glow: the port and net ids a wire could land on, and the one it would land on now;
   * null clears either. The same iterable passed again is taken as unchanged, so moving the
   * target over one glow costs two words.
   */
  setGlow(compatible: Iterable<number> | null, target: number | null): void {
    if (compatible !== this.glowSource || compatible === null) {
      const next = compatible === null ? NO_IDS : this.valid(compatible);
      const keep = new Set(next);
      for (const id of this.glow) if (!keep.has(id)) this.flag(id, FOCUS_COMPATIBLE, false);
      const had = new Set(this.glow);
      for (const id of next) if (!had.has(id)) this.flag(id, FOCUS_COMPATIBLE, true);
      this.glow = next;
      this.glowSource = compatible;
    }
    const nextTarget = target !== null && this.word(target) >= 0 ? target : null;
    if (nextTarget === this.target) return;
    if (this.target !== null) this.flag(this.target, FOCUS_TARGET, false);
    this.target = nextTarget;
    if (nextTarget !== null) this.flag(nextTarget, FOCUS_TARGET, true);
  }

  /** Mark the blocks moving with a drag, or none. */
  setDragging(blocks: Uint32Array | null): void {
    const previous = this.dragging ?? NO_BLOCKS;
    const next = blocks ? blocks.slice() : NO_BLOCKS;
    this.dragging = blocks ? next : null;
    const keep = new Set(next);
    for (const block of previous) {
      if (!keep.has(block)) this.flag(partId(PART_BLOCK, block), FOCUS_DRAGGING, false);
    }
    for (const block of next) this.flag(partId(PART_BLOCK, block), FOCUS_DRAGGING, true);
  }

  /** The ids of `ids` that name parts, each once. */
  private valid(ids: Iterable<number>): readonly number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id) || this.word(id) < 0) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /** The focus word of a part id, or -1 when it names no part of the loaded netlist. */
  private word(id: number): number {
    const p = this.prepared;
    if (!p || !Number.isSafeInteger(id) || id < 0) return -1;
    const index = partIndex(id);
    switch (partKind(id)) {
      case PART_BLOCK:
        return index < p.blockCount ? index : -1;
      case PART_PORT:
        return index < p.portCount ? this.portBase + index : -1;
      case PART_NET:
        return index < p.netCount ? this.netBase + index : -1;
      case PART_GROUP:
        return index < p.groupCount ? this.groupBase + index : -1;
      default:
        return -1;
    }
  }

  /** Set or clear one flag bit of a part, touching its word only when the value changes. */
  private flag(id: number, bit: number, on: boolean): void {
    const at = this.word(id);
    if (at < 0) return;
    const u32 = this.mirror.u32;
    const was = u32[at]!;
    const next = (on ? was | bit : was & ~bit) >>> 0;
    if (next === was) return;
    u32[at] = next;
    this.mirror.touch(at, at + 1);
  }
}
