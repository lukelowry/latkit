/**
 * The contract between CPU state and the renderer: every buffer a frame uploads, kept on the CPU
 * in exactly the layout its shaders read, with the word ranges written since the last upload. The
 * renderer never interprets controller state; it uploads what changed and draws.
 *
 * Record layouts are in 32-bit words; each constant here is mirrored by a WGSL `const` in
 * `shaders/common.wgsl`, and a unit test holds the two to the same values.
 */

import { NONE, type Prepared } from '../prepare.js';

/**
 * Dirty ranges fewer than this many words apart merge into one: uploading a short clean gap costs
 * less than another `writeBuffer`.
 */
export const DIRTY_MERGE_GAP = 1024;

/** Dirty ranges a mirror keeps apart; one more folds them all into a single span. */
export const DIRTY_RANGE_LIMIT = 16;

/**
 * A CPU copy of one GPU buffer in the exact layout its shaders read, with the ranges written since
 * the last upload.
 *
 * @remarks
 * Writes far apart stay apart, so a frame that moves one block, or flips hover between two distant
 * parts, uploads the few words it changed rather than everything between them. Ranges closer than
 * `DIRTY_MERGE_GAP` words merge, and past `DIRTY_RANGE_LIMIT` ranges the mirror gives up tracking
 * them and keeps one span over all of them.
 */
export class Mirror {
  /** Word views over one backing store; replaced when the mirror grows. */
  f32: Float32Array<ArrayBuffer>;
  u32: Uint32Array<ArrayBuffer>;
  /** Words in use. The GPU buffer holds at least `max(words, 4)`. */
  words: number;
  /** Bumped whenever the backing store is replaced; a renderer then reallocates and uploads all. */
  version = 0;
  /**
   * Dirty word ranges, sorted, disjoint, and at least `DIRTY_MERGE_GAP` words apart: range `i` is
   * `[dirtyRanges[2 * i], dirtyRanges[2 * i + 1])` for `i < dirtyCount`. Only the mirror writes it.
   */
  readonly dirtyRanges = new Uint32Array(2 * DIRTY_RANGE_LIMIT);
  private count = 0;

  constructor(
    /** The GPU buffer's debug label. */
    readonly label: string,
    /** How the GPU buffer binds. */
    readonly usage: 'storage' | 'uniform',
    words = 0,
  ) {
    const buffer = new ArrayBuffer(Math.max(words, MIN_WORDS) * 4);
    this.f32 = new Float32Array(buffer);
    this.u32 = new Uint32Array(buffer);
    this.words = words;
    this.touchAll();
  }

  /** Words the backing store holds; at least the words in use. */
  get capacity(): number {
    return this.u32.length;
  }

  /** Ranges in `dirtyRanges`; 0 when nothing is dirty. */
  get dirtyCount(): number {
    return this.count;
  }

  /**
   * The first dirty word. With `dirtyTo`, the span covering every dirty range; empty when
   * `dirtyFrom >= dirtyTo`.
   */
  get dirtyFrom(): number {
    return this.count > 0 ? this.dirtyRanges[0]! : 0;
  }

  /** One past the last dirty word; `0` when nothing is dirty. */
  get dirtyTo(): number {
    return this.count > 0 ? this.dirtyRanges[2 * this.count - 1]! : 0;
  }

  /**
   * Set the words in use, growing the backing store by half again when needed: a new version,
   * contents kept, everything dirty. Words gained within capacity hold whatever they held; the
   * writer that fills them touches them. Shrinking drops the dirty words past the end.
   */
  resize(words: number): void {
    if (words > this.capacity) {
      const grown = new ArrayBuffer(Math.max(words, Math.ceil(this.capacity * 1.5)) * 4);
      const u32 = new Uint32Array(grown);
      u32.set(this.u32);
      this.u32 = u32;
      this.f32 = new Float32Array(grown);
      this.version++;
      this.words = words;
      this.touchAll();
      return;
    }
    this.words = words;
    const ranges = this.dirtyRanges;
    let n = this.count;
    while (n > 0 && ranges[2 * n - 2]! >= words) n--;
    if (n > 0 && ranges[2 * n - 1]! > words) ranges[2 * n - 1] = words;
    this.count = n;
  }

  /**
   * Mark words `[from, to)` for upload, clamped to the words in use: merged into every dirty range
   * closer than `DIRTY_MERGE_GAP` words, else kept as a range of its own.
   */
  touch(from: number, to: number): void {
    const lo = Math.max(0, from);
    const hi = Math.min(this.words, to);
    if (lo >= hi) return;
    const ranges = this.dirtyRanges;
    const n = this.count;
    // Ranges stay sorted and farther apart than the gap, so the ones this touch reaches are the
    // run from the first that ends near `lo` to the last that starts near `hi`.
    let first = 0;
    while (first < n && ranges[2 * first + 1]! + DIRTY_MERGE_GAP <= lo) first++;
    let end = first;
    while (end < n && ranges[2 * end]! < hi + DIRTY_MERGE_GAP) end++;
    if (end > first) {
      ranges[2 * first] = Math.min(lo, ranges[2 * first]!);
      ranges[2 * first + 1] = Math.max(hi, ranges[2 * end - 1]!);
      ranges.copyWithin(2 * first + 2, 2 * end, 2 * n);
      this.count = n - (end - first - 1);
      return;
    }
    if (n === DIRTY_RANGE_LIMIT) {
      // Too scattered to be worth tracking: one span over all of it.
      ranges[0] = Math.min(lo, ranges[0]!);
      ranges[1] = Math.max(hi, ranges[2 * n - 1]!);
      this.count = 1;
      return;
    }
    ranges.copyWithin(2 * first + 2, 2 * first, 2 * n);
    ranges[2 * first] = lo;
    ranges[2 * first + 1] = hi;
    this.count = n + 1;
  }

  /** Mark every word in use for upload. */
  touchAll(): void {
    this.dirtyRanges[0] = 0;
    this.dirtyRanges[1] = this.words;
    this.count = this.words > 0 ? 1 : 0;
  }

  /** Forget the dirty ranges after an upload. */
  clean(): void {
    this.count = 0;
  }

  /**
   * Give the memory back: no words in use, nothing dirty, and the backing store replaced by the
   * smallest one under a new version, so a renderer reallocates its buffer at that size too.
   */
  release(): void {
    const buffer = new ArrayBuffer(MIN_WORDS * 4);
    this.f32 = new Float32Array(buffer);
    this.u32 = new Uint32Array(buffer);
    this.words = 0;
    this.version++;
    this.clean();
  }
}

/** The smallest backing store a mirror keeps, so a GPU buffer is never zero-sized. */
const MIN_WORDS = 4;

/** Words in the uniform block: `struct Uniforms` in `shaders/common.wgsl`, 848 bytes. */
export const UNIFORM_WORDS = 212;

/** Every mirror a frame uploads. */
export interface Mirrors {
  /** `struct Uniforms`; uploaded whole every frame. */
  readonly uniforms: Mirror;
  /** Block, port, and net records; rewritten per netlist. */
  readonly structure: Mirror;
  /** Effective block positions, group bounds, and net anchors. */
  readonly layout: Mirror;
  /** Channel slots in `SLOT` order. */
  readonly channels: Mirror;
  /** Per-part `FOCUS_*` flags. */
  readonly focus: Mirror;
  /** Routed net geometry: segments, junctions, and arrows. */
  readonly wires: Mirror;
  /** Glyph instances in the text window. */
  readonly glyphs: Mirror;
  /** Marquee, wire preview, and ghost instances. */
  readonly overlay: Mirror;
}

/** Create every mirror, empty but for the uniform block. */
export function createMirrors(): Mirrors {
  return {
    uniforms: new Mirror('diagram uniforms', 'uniform', UNIFORM_WORDS),
    structure: new Mirror('diagram structure', 'storage'),
    layout: new Mirror('diagram layout', 'storage'),
    channels: new Mirror('diagram channels', 'storage'),
    focus: new Mirror('diagram focus', 'storage'),
    wires: new Mirror('diagram wires', 'storage'),
    glyphs: new Mirror('diagram glyphs', 'storage'),
    overlay: new Mirror('diagram overlay', 'storage'),
  };
}

/** How many instances each pass draws this frame. */
export interface DrawCounts {
  readonly groups: number;
  readonly wires: number;
  readonly blocks: number;
  readonly ports: number;
  readonly glyphs: number;
  readonly overlay: number;
}

/** The counts every base offset derives from; a `Prepared` netlist is one. */
export interface PartCounts {
  readonly blockCount: number;
  readonly portCount: number;
  readonly netCount: number;
  readonly groupCount: number;
}

// structure: [blocks | ports | nets]

/** Block record: `w f32, h f32, group u32, flags u32`. */
export const BLOCK_WORDS = 4;
/** Block flag: the block has a non-empty title. */
export const BLOCK_TITLED = 1;

/** Port record: `block u32, offX f32, offY f32, packed u32, net u32, tagLength f32, pad, pad`. */
export const PORT_WORDS = 8;
/** Packed port bits 0-1: flow (`0` in, `1` out, `2` both). */
export const PORT_FLOW_MASK = 0x3;
/** Packed port bits 2-3: side (`0` left, `1` right, `2` top, `3` bottom). */
export const PORT_SIDE_SHIFT = 2;
/** Packed port bits 4-11: kind. */
export const PORT_KIND_SHIFT = 4;
/** Packed port bit 12: the port draws its net's tag. */
export const PORT_TAG = 0x1000;

/** Net record: `driver u32, group u32, style u32, portCount u32`. */
export const NET_WORDS = 4;

// focus: [blocks | ports | nets | groups], one u32 of flags per part.

export const FOCUS_HOVER = 1;
export const FOCUS_SELECTED = 2;
/** A port or net a wire being drawn could land on. */
export const FOCUS_COMPATIBLE = 4;
/** The port or net a wire being drawn would land on now. */
export const FOCUS_TARGET = 8;
/** A block moving with a drag. */
export const FOCUS_DRAGGING = 16;

// wires: WIRE_WORDS per entry.

/** Wire entry: `ax f32, ay f32, bx f32, by f32, net u32, kind u32, along f32, pad`. */
export const WIRE_WORDS = 8;
/** An unused entry; the wire pass culls it. */
export const WIRE_EMPTY = 0;
/** A segment from `a` to `b`. */
export const WIRE_SEGMENT = 1;
/** A junction dot at `a`. */
export const WIRE_JUNCTION = 2;
/** An arrowhead with its tip at `a`, pointing along the unit direction `b`. */
export const WIRE_ARROW = 3;

// glyphs: GLYPH_WORDS per entry.

/** Glyph entry: `anchor u32, index u32, offX f32, offY f32, em f32, cell u32, role u32, pad`. */
export const GLYPH_WORDS = 8;
/** Anchored at a block's top-left. */
export const ANCHOR_BLOCK = 0;
/** Anchored at a port's position. */
export const ANCHOR_PORT = 1;
/** Anchored at a net's label anchor. */
export const ANCHOR_NET = 2;
/** Anchored at a group frame's top-left. */
export const ANCHOR_GROUP = 3;
export const ROLE_TITLE = 0;
export const ROLE_LABEL = 1;
export const ROLE_PORT = 2;
export const ROLE_TAG = 3;
export const ROLE_NET = 4;
export const ROLE_GROUP = 5;
/** Cell bit 31: a wide glyph spanning two atlas cells. */
export const GLYPH_WIDE = 0x80000000;

// overlay: OVERLAY_WORDS per entry.

/** Overlay entry: `kind u32, x0 f32, y0 f32, x1 f32, y1 f32, alpha f32, along f32, pad`. */
export const OVERLAY_WORDS = 8;
/**
 * Overlay entry word: for an `OVERLAY_PREVIEW` entry, the length of the preview before it, in
 * diagram units, so its dashes run on unbroken around every bend; `0` for every other kind.
 */
export const OVERLAY_ALONG = 6;
/** The marquee rectangle. */
export const OVERLAY_MARQUEE = 1;
/** One wire-preview segment from `(x0, y0)` to `(x1, y1)`. */
export const OVERLAY_PREVIEW = 2;
/** A removed block's rectangle fading out at `alpha`. */
export const OVERLAY_GHOST = 3;

/** Word offsets of the port and net records in the structure mirror, and its size. */
export function structureBases(counts: PartCounts): {
  readonly port: number;
  readonly net: number;
  readonly words: number;
} {
  const port = counts.blockCount * BLOCK_WORDS;
  const net = port + counts.portCount * PORT_WORDS;
  return { port, net, words: net + counts.netCount * NET_WORDS };
}

/** Word offsets of group bounds and net anchors in the layout mirror, and its size. */
export function layoutBases(counts: PartCounts): {
  readonly group: number;
  readonly anchor: number;
  readonly words: number;
} {
  const group = 2 * counts.blockCount;
  const anchor = group + 4 * counts.groupCount;
  return { group, anchor, words: anchor + 2 * counts.netCount };
}

/** Word offsets of port, net, and group flags in the focus mirror, and its size. */
export function focusBases(counts: PartCounts): {
  readonly port: number;
  readonly net: number;
  readonly group: number;
  readonly words: number;
} {
  const port = counts.blockCount;
  const net = port + counts.portCount;
  const group = net + counts.netCount;
  return { port, net, group, words: group + counts.groupCount };
}

/** A port's packed word: flow, side, kind, and whether it draws a tag. */
export function packPort(flow: number, side: number, kind: number, tag: boolean): number {
  return (
    ((flow & PORT_FLOW_MASK) |
      ((side & 0x3) << PORT_SIDE_SHIFT) |
      ((kind & 0xff) << PORT_KIND_SHIFT) |
      (tag ? PORT_TAG : 0)) >>>
    0
  );
}

/**
 * Write a prepared netlist's block, port, and net records into the structure mirror, sized to
 * fit, and mark it all for upload. A port draws a tag when its net is drawn as tags.
 */
export function writeStructure(mirror: Mirror, prepared: Prepared): void {
  const bases = structureBases(prepared);
  mirror.resize(bases.words);
  const { f32, u32 } = mirror;
  const titles = prepared.netlist.blockTitle;
  for (let block = 0; block < prepared.blockCount; block++) {
    const at = block * BLOCK_WORDS;
    f32[at] = prepared.size[2 * block]!;
    f32[at + 1] = prepared.size[2 * block + 1]!;
    u32[at + 2] = prepared.blockGroup[block]!;
    u32[at + 3] = titles && titles[block] ? BLOCK_TITLED : 0;
  }
  const flow = prepared.netlist.portFlow;
  for (let port = 0; port < prepared.portCount; port++) {
    const at = bases.port + port * PORT_WORDS;
    const net = prepared.portNet[port]!;
    u32[at] = prepared.portBlock[port]!;
    f32[at + 1] = prepared.portOffset[2 * port]!;
    f32[at + 2] = prepared.portOffset[2 * port + 1]!;
    u32[at + 3] = packPort(
      flow[port]!,
      prepared.portSide[port]!,
      prepared.portKind[port]!,
      net !== NONE && prepared.netStyle[net] === 1,
    );
    u32[at + 4] = net;
    f32[at + 5] = prepared.tagLength[port]!;
    u32[at + 6] = 0;
    u32[at + 7] = 0;
  }
  const netStart = prepared.netlist.netStart;
  for (let net = 0; net < prepared.netCount; net++) {
    const at = bases.net + net * NET_WORDS;
    u32[at] = prepared.netDriver[net]!;
    u32[at + 1] = prepared.netGroup[net]!;
    u32[at + 2] = prepared.netStyle[net]!;
    u32[at + 3] = netStart[net + 1]! - netStart[net]!;
  }
  mirror.touchAll();
}
