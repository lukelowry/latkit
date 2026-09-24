import { textWidth } from '../geometry.js';
import { PART_BLOCK, PART_GROUP, PART_NET, PART_PORT, partId } from '../part.js';
import {
  FLOW_OUT,
  NONE,
  SIDE_LEFT,
  SIDE_RIGHT,
  SIDE_TOP,
  STYLE_WIRE,
  type Prepared,
} from '../prepare.js';
import { LINE } from '../text/metrics.js';
import {
  layoutBases,
  WIRE_EMPTY,
  WIRE_SEGMENT,
  WIRE_WORDS,
  type Mirror,
} from '../webgpu/buffers.js';
import { SpatialHash } from './grid.js';

/**
 * What the picker reads of a scene. The `Scene` implements it and owns the picker; the router's
 * obstacle query is `Picker.obstacles`.
 */
export interface PickSource {
  /** The loaded netlist, prepared, or null before a load. */
  readonly prepared: Prepared | null;
  /** Effective positions, group bounds, and net anchors, at `layoutBases`. */
  readonly layout: Mirror;
  /** Routed entries and each net's slot in them. */
  readonly wires: Mirror;
  /** Slot of a net: entries `[start, start + count)` in the wires mirror. */
  slot(net: number): { readonly start: number; readonly count: number };
  /** Whether a block is shown. */
  blockVisible(block: number): boolean;
  /** Whether a net is shown. */
  netVisible(net: number): boolean;
}

// The grids a query may find stale.
const STALE_BLOCKS = 1;
const STALE_WIRES = 2;
const STALE_GROUPS = 4;
const STALE_ALL = STALE_BLOCKS | STALE_WIRES | STALE_GROUPS;

/**
 * Synchronous picking over a spatial index of the scene: parts under a point, blocks in a
 * marquee, wire targets, and the router's obstacles.
 *
 * @remarks
 * A block matches inside its rectangle or its label strip; a port within `max(radius, portSize)`
 * of its position or inside its tag pill; a net within `radius` of a segment, junction, or arrow
 * of its route; a group inside its frame. Hidden parts never match. A port `p` is a compatible
 * target for a wire from `f` replacing `r` when `p` is neither, kinds match, `p` is not on `f`'s
 * net, and the union of `f`'s net (without `r`, or just `f` when unwired) and `p`'s net (or `p`)
 * holds at most one `out` port; a wired net is compatible under the same union rule. Port and net
 * results are part ids; `from` and `replaces` are port indices, `replaces` `NONE` for a new wire.
 *
 * The index holds three sparse grids (blocks with extents and port reach, wire entries, group
 * frames) keyed by index. Exact tests always read the live layout and wires mirrors, so a stale
 * box can only cost a candidate, never report a wrong position. Blocks under a drag are tested
 * linearly and their index entries skipped, so a drag re-indexes nothing per frame.
 *
 * Rebuilds are lazy: `rebuild`, or a source that loaded another netlist, marks every grid stale,
 * and the first query that reads a grid rebuilds it from the source. A load therefore builds only
 * the block grid its routing asks for obstacles; the wire and group grids wait for the first
 * pick. `moved`, `rerouted`, and `framed` skip a grid that is stale, since its rebuild reads the
 * source as it is then.
 */
export class Picker {
  private readonly source: PickSource;
  private blocks = new SpatialHash();
  private wires = new SpatialHash();
  private groups = new SpatialHash();

  /** The prepared netlist the tables are sized for. */
  private indexed: Prepared | null = null;
  /** The `STALE_*` grids a query rebuilds before reading them. */
  private stale = STALE_ALL;
  /** The grids' cell size for `indexed`. */
  private cell = 1;
  /** Where group frames start in the layout mirror. */
  private groupBase = 0;
  /** Per block: its label's width, `0` without a label; filled by the first pick. */
  private labelWidth = new Float32Array(0);
  private labelsMeasured = false;

  // Per net: the wire entries last indexed for it. Per entry: the net that indexed it, so a net
  // re-indexing its old range never drops entries another net has since taken over.
  private netFrom = new Uint32Array(0);
  private netLength = new Uint32Array(0);
  private entryNet = new Uint32Array(0);

  // Blocks under a drag, and the groups they belong to.
  private moving = new Uint8Array(0);
  private movingBlocks = new Uint32Array(0);
  private movingGroup = new Uint8Array(0);
  private movingGroups = new Uint32Array(0);

  // Groups whose frame changed since they were last indexed; re-indexed before a group query.
  private groupDirty = new Uint8Array(0);
  private dirtyGroups = new Uint32Array(0);
  private dirtyCount = 0;

  // The running query: one set of fields, read by visitors bound once, so a query allocates
  // nothing per candidate.
  private qx = 0;
  private qy = 0;
  private qr = 0;
  private bestPort = -1;
  private bestPortD = Infinity;
  private bestBlock = -1;
  private bestBlockRank = 0;
  private bestBlockD = Infinity;
  private bestNet = -1;
  private bestNetD = Infinity;
  private bestGroup = -1;
  private bestGroupD = Infinity;
  /** Whether the running port and net tests keep only compatible targets. */
  private filtered = false;
  private found = new Uint32Array(64);
  private foundCount = 0;
  private box0 = 0;
  private box1 = 0;
  private box2 = 0;
  private box3 = 0;

  // The compatibility of a wire being drawn, primed by `prime`.
  private cFrom = 0;
  private cReplaces = NONE;
  private cNet = NONE;
  private cKind = 0;
  private cOuts = 0;

  // The running obstacle query; saved and restored around a nested one.
  private ox0 = 0;
  private oy0 = 0;
  private ox1 = 0;
  private oy1 = 0;
  private oVisit: (block: number) => void = ignore;

  constructor(source: PickSource) {
    // The source may still be under construction (the scene builds its picker in its
    // constructor), so nothing is read from it here.
    this.source = source;
  }

  /**
   * Mark the whole index stale after a load or a large move; each grid is rebuilt by the first
   * query that reads it. Incremental `moved`, `rerouted`, and `framed` follow small changes.
   */
  rebuild(): void {
    this.sync();
    this.stale = STALE_ALL;
  }

  /** A block moved: refresh its box and its group's frame. */
  moved(block: number): void {
    const p = this.sync();
    if (!p || !(block >= 0 && block < p.blockCount)) return;
    // A dragged block is tested linearly; it is re-indexed once the drag ends.
    if (this.moving[block] === 1) return;
    if (!(this.stale & STALE_BLOCKS)) this.indexBlock(p, block);
    this.markGroup(p.blockGroup[block]!);
  }

  /** A net re-routed: refresh its entries. */
  rerouted(net: number): void {
    const p = this.sync();
    if (!p || !(net >= 0 && net < p.netCount) || this.stale & STALE_WIRES) return;
    this.unindexNet(net);
    this.indexNet(p, net);
  }

  /**
   * A group's frame changed: re-index it before the next group query. The frame of a group
   * under a drag is tested linearly instead, and re-indexed once the drag ends.
   */
  framed(group: number): void {
    const p = this.sync();
    if (!p || !(group >= 0 && group < p.groupCount) || this.movingGroup[group] === 1) return;
    this.markGroup(group);
  }

  /** Blocks excluded while they are dragged (tested linearly). */
  setMoving(blocks: Uint32Array | null): void {
    const p = this.sync();
    if (!p) return;
    const previous = this.movingBlocks;
    const previousGroups = this.movingGroups;
    for (const block of previous) this.moving[block] = 0;
    for (const group of previousGroups) this.movingGroup[group] = 0;

    let count = 0;
    if (blocks) {
      for (const block of blocks) if (block < p.blockCount) count++;
    }
    const next = new Uint32Array(count);
    let groupCount = 0;
    const groups = new Uint32Array(Math.min(count, p.groupCount));
    count = 0;
    if (blocks) {
      for (const block of blocks) {
        if (block >= p.blockCount || this.moving[block] === 1) continue;
        this.moving[block] = 1;
        next[count++] = block;
        const group = p.blockGroup[block]!;
        if (group !== NONE && this.movingGroup[group] === 0) {
          this.movingGroup[group] = 1;
          groups[groupCount++] = group;
        }
      }
    }
    this.movingBlocks = next.subarray(0, count);
    this.movingGroups = groups.subarray(0, groupCount);

    // Blocks that stopped moving come to rest where the layout now has them.
    const indexed = !(this.stale & STALE_BLOCKS);
    for (const block of previous) {
      if (this.moving[block] === 1) continue;
      if (indexed) this.indexBlock(p, block);
      this.markGroup(p.blockGroup[block]!);
    }
    for (const group of previousGroups) this.markGroup(group);
  }

  /**
   * Part ids under a diagram point within `radius` diagram units, priority port, block, net,
   * group, nearest of each kind, visible only.
   */
  pick(x: number, y: number, radius: number): number[] {
    const p = this.sync();
    if (!p || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    this.measureLabels(p);
    this.begin(x, y, radius, false);
    this.pickBlocks(p);
    this.pickWires(p);
    this.indexGroups(p);
    this.groups.query(x, y, x, y, this.visitGroup);
    for (const group of this.movingGroups) this.testGroup(group);

    const out: number[] = [];
    if (this.bestPort >= 0) out.push(partId(PART_PORT, this.bestPort));
    if (this.bestBlock >= 0) out.push(partId(PART_BLOCK, this.bestBlock));
    if (this.bestNet >= 0) out.push(partId(PART_NET, this.bestNet));
    if (this.bestGroup >= 0) out.push(partId(PART_GROUP, this.bestGroup));
    return out;
  }

  /** Visible blocks whose rectangles intersect a diagram rectangle, ascending. */
  marquee(x0: number, y0: number, x1: number, y1: number): Uint32Array {
    const p = this.sync();
    if (!p) return new Uint32Array(0);
    this.indexBlocks(p);
    this.box0 = Math.min(x0, x1);
    this.box1 = Math.min(y0, y1);
    this.box2 = Math.max(x0, x1);
    this.box3 = Math.max(y0, y1);
    this.foundCount = 0;
    this.blocks.query(this.box0, this.box1, this.box2, this.box3, this.visitMarquee);
    for (const block of this.movingBlocks) this.testMarquee(block);
    return this.found.slice(0, this.foundCount).sort();
  }

  /** The compatible port or net id nearest a point within `radius`, or null. */
  target(from: number, replaces: number, x: number, y: number, radius: number): number | null {
    const p = this.sync();
    if (!p || !this.prime(p, from, replaces) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    this.begin(x, y, radius, true);
    this.pickBlocks(p);
    if (this.bestPort >= 0) return partId(PART_PORT, this.bestPort);
    this.pickWires(p);
    if (this.bestNet >= 0) return partId(PART_NET, this.bestNet);
    return null;
  }

  /** Every port and net id a wire from `from`, replacing `replaces`, could land on. */
  compatible(from: number, replaces: number): number[] {
    const p = this.sync();
    if (!p || !this.prime(p, from, replaces)) return [];
    const out: number[] = [];
    const source = this.source;
    for (let port = 0; port < p.portCount; port++) {
      if (this.portCompatible(p, port) && source.blockVisible(p.portBlock[port]!)) {
        out.push(partId(PART_PORT, port));
      }
    }
    for (let net = 0; net < p.netCount; net++) {
      if (this.netCompatible(p, net) && source.netVisible(net)) out.push(partId(PART_NET, net));
    }
    return out;
  }

  /** Visible blocks whose extent rectangles intersect a box (the router's obstacle query). */
  obstacles(x0: number, y0: number, x1: number, y1: number, visit: (block: number) => void): void {
    const p = this.sync();
    if (!p) return;
    this.indexBlocks(p);
    // The router may query again from inside `visit`; keep the outer query's state.
    const saved0 = this.ox0;
    const saved1 = this.oy0;
    const saved2 = this.ox1;
    const saved3 = this.oy1;
    const savedVisit = this.oVisit;
    this.ox0 = Math.min(x0, x1);
    this.oy0 = Math.min(y0, y1);
    this.ox1 = Math.max(x0, x1);
    this.oy1 = Math.max(y0, y1);
    this.oVisit = visit;
    try {
      this.blocks.query(this.ox0, this.oy0, this.ox1, this.oy1, this.visitObstacle);
      for (const block of this.movingBlocks) this.testObstacle(p, block);
    } finally {
      this.ox0 = saved0;
      this.oy0 = saved1;
      this.ox1 = saved2;
      this.oy1 = saved3;
      this.oVisit = savedVisit;
    }
  }

  // Index maintenance.

  /**
   * The prepared netlist; when the source has loaded another, the tables are sized for it and
   * every grid is marked stale.
   */
  private sync(): Prepared | null {
    const p = this.source.prepared;
    if (p !== this.indexed) {
      this.indexed = p;
      this.prepareTables(p);
      this.stale = STALE_ALL;
    }
    return p;
  }

  /**
   * Size every per-part table for a newly loaded netlist, forgetting any drag. Without one, the
   * grids are dropped for empty ones, so a cleared scene holds nothing.
   */
  private prepareTables(p: Prepared | null): void {
    const blocks = p?.blockCount ?? 0;
    const nets = p?.netCount ?? 0;
    const groups = p?.groupCount ?? 0;
    if (p) {
      this.cell = cellSize(p);
      this.groupBase = layoutBases(p).group;
    } else {
      this.blocks = new SpatialHash();
      this.wires = new SpatialHash();
      this.groups = new SpatialHash();
    }
    this.labelWidth = new Float32Array(blocks);
    this.labelsMeasured = false;
    this.netFrom = new Uint32Array(nets);
    this.netLength = new Uint32Array(nets);
    this.entryNet = new Uint32Array(0);
    this.moving = new Uint8Array(blocks);
    this.movingBlocks = new Uint32Array(0);
    this.movingGroup = new Uint8Array(groups);
    this.movingGroups = new Uint32Array(0);
    this.groupDirty = new Uint8Array(groups);
    this.dirtyGroups = new Uint32Array(groups);
    this.dirtyCount = 0;
  }

  /** Rebuild the block grid when it is stale. */
  private indexBlocks(p: Prepared): void {
    if (!(this.stale & STALE_BLOCKS)) return;
    this.stale &= ~STALE_BLOCKS;
    this.blocks.reset(this.cell, p.blockCount);
    for (let block = 0; block < p.blockCount; block++) this.indexBlock(p, block);
  }

  /** Rebuild the wire grid when it is stale: every net's entries as its slot now holds them. */
  private indexWires(p: Prepared): void {
    if (!(this.stale & STALE_WIRES)) return;
    this.stale &= ~STALE_WIRES;
    const entries = Math.floor(this.source.wires.words / WIRE_WORDS);
    this.wires.reset(this.cell, entries);
    if (this.entryNet.length < entries) this.entryNet = new Uint32Array(entries);
    this.entryNet.fill(NONE);
    this.netFrom.fill(0);
    this.netLength.fill(0);
    for (let net = 0; net < p.netCount; net++) this.indexNet(p, net);
  }

  /** Rebuild the group grid when it is stale, else re-index the frames queued since. */
  private indexGroups(p: Prepared): void {
    if (this.stale & STALE_GROUPS) {
      this.stale &= ~STALE_GROUPS;
      this.groups.reset(this.cell, p.groupCount);
      for (let group = 0; group < p.groupCount; group++) this.indexGroup(group);
      for (let i = 0; i < this.dirtyCount; i++) this.groupDirty[this.dirtyGroups[i]!] = 0;
      this.dirtyCount = 0;
      return;
    }
    for (let i = 0; i < this.dirtyCount; i++) {
      const group = this.dirtyGroups[i]!;
      this.groupDirty[group] = 0;
      this.indexGroup(group);
    }
    this.dirtyCount = 0;
  }

  /** Measure every block label once per netlist, for the label strips picks test. */
  private measureLabels(p: Prepared): void {
    if (this.labelsMeasured) return;
    this.labelsMeasured = true;
    const labels = p.netlist.blockLabel;
    if (!labels) return;
    for (let block = 0; block < p.blockCount; block++) {
      this.labelWidth[block] = textWidth(labels[block] ?? '', p.metrics.labelEm);
    }
  }

  /** Index a block's rectangle with its extents and the reach of its port markers. */
  private indexBlock(p: Prepared, block: number): void {
    const { f32 } = this.source.layout;
    const x = f32[2 * block]!;
    const y = f32[2 * block + 1]!;
    const reach = p.metrics.portSize;
    const e = 4 * block;
    this.blocks.insert(
      block,
      x - Math.max(p.extent[e]!, reach),
      y - Math.max(p.extent[e + 1]!, reach),
      x + p.size[2 * block]! + Math.max(p.extent[e + 2]!, reach),
      y + p.size[2 * block + 1]! + Math.max(p.extent[e + 3]!, reach),
    );
  }

  /** Index a group's frame; a group with no visible member (NaN bounds) leaves the index. */
  private indexGroup(group: number): void {
    const { f32 } = this.source.layout;
    const at = this.groupBase + 4 * group;
    this.groups.insert(group, f32[at]!, f32[at + 1]!, f32[at + 2]!, f32[at + 3]!);
  }

  /**
   * Queue a group's frame for re-indexing before the next group query; nothing to queue while
   * the group grid waits for a rebuild.
   */
  private markGroup(group: number): void {
    if (group === NONE || group >= this.groupDirty.length || this.groupDirty[group] === 1) return;
    if (this.stale & STALE_GROUPS) return;
    this.groupDirty[group] = 1;
    this.dirtyGroups[this.dirtyCount++] = group;
  }

  /** Index the entries of a net's slot that belong to it. */
  private indexNet(p: Prepared, net: number): void {
    if (p.netStyle[net] !== STYLE_WIRE) return;
    const { start, count } = this.source.slot(net);
    const { f32, u32, words } = this.source.wires;
    const end = Math.min(start + count, Math.floor(words / WIRE_WORDS));
    if (end > this.entryNet.length) {
      const grown = new Uint32Array(Math.max(end, 2 * this.entryNet.length)).fill(NONE);
      grown.set(this.entryNet);
      this.entryNet = grown;
    }
    this.netFrom[net] = start;
    this.netLength[net] = Math.max(0, end - start);
    for (let entry = start; entry < end; entry++) {
      const at = entry * WIRE_WORDS;
      const kind = u32[at + 5]!;
      if (kind === WIRE_EMPTY || u32[at + 4] !== net) continue;
      const ax = f32[at]!;
      const ay = f32[at + 1]!;
      // Only a segment spans to `b`; a junction or an arrow sits at `a`.
      const segment = kind === WIRE_SEGMENT;
      this.wires.insert(entry, ax, ay, segment ? f32[at + 2]! : ax, segment ? f32[at + 3]! : ay);
      this.entryNet[entry] = net;
    }
  }

  /** Drop the entries a net last indexed and still owns. */
  private unindexNet(net: number): void {
    const from = this.netFrom[net]!;
    const end = Math.min(from + this.netLength[net]!, this.entryNet.length);
    for (let entry = from; entry < end; entry++) {
      if (this.entryNet[entry] !== net) continue;
      this.wires.remove(entry);
      this.entryNet[entry] = NONE;
    }
    this.netLength[net] = 0;
  }

  // Queries.

  /** Start a point query: the probe, and no best part of any kind. */
  private begin(x: number, y: number, radius: number, filtered: boolean): void {
    this.qx = x;
    this.qy = y;
    this.qr = radius > 0 ? radius : 0;
    this.filtered = filtered;
    this.bestPort = -1;
    this.bestPortD = Infinity;
    this.bestBlock = -1;
    this.bestBlockRank = 0;
    this.bestBlockD = Infinity;
    this.bestNet = -1;
    this.bestNetD = Infinity;
    this.bestGroup = -1;
    this.bestGroupD = Infinity;
  }

  /** Test the blocks and ports near the probe: indexed ones, then the dragged ones. */
  private pickBlocks(p: Prepared): void {
    this.indexBlocks(p);
    const { qx, qy, qr } = this;
    this.blocks.query(qx - qr, qy - qr, qx + qr, qy + qr, this.visitBlock);
    for (const block of this.movingBlocks) this.testBlock(p, block);
  }

  /** Test the wire entries near the probe. */
  private pickWires(p: Prepared): void {
    this.indexWires(p);
    const { qx, qy, qr } = this;
    this.wires.query(qx - qr, qy - qr, qx + qr, qy + qr, this.visitWire);
  }

  private readonly visitBlock = (block: number): void => {
    if (this.moving[block] === 1) return;
    this.testBlock(this.indexed!, block);
  };

  private readonly visitWire = (entry: number): void => {
    this.testWire(this.indexed!, entry);
  };

  private readonly visitGroup = (group: number): void => {
    if (this.movingGroup[group] === 1) return;
    this.testGroup(group);
  };

  private readonly visitMarquee = (block: number): void => {
    if (this.moving[block] === 1) return;
    this.testMarquee(block);
  };

  private readonly visitObstacle = (block: number): void => {
    if (this.moving[block] === 1) return;
    this.testObstacle(this.indexed!, block);
  };

  /** Test a block and its ports against the probe. */
  private testBlock(p: Prepared, block: number): void {
    if (!this.source.blockVisible(block)) return;
    const { qx, qy } = this;
    const { f32 } = this.source.layout;
    const x = f32[2 * block]!;
    const y = f32[2 * block + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const w = p.size[2 * block]!;
    const h = p.size[2 * block + 1]!;

    if (!this.filtered) {
      // Rank 1 inside the rectangle, 2 inside the label strip under it; ties go to the block
      // whose center is nearer, then to the later (topmost drawn) block.
      let rank = 0;
      if (qx >= x && qx <= x + w && qy >= y && qy <= y + h) rank = 1;
      else {
        const label = this.labelWidth[block]!;
        if (label > 0) {
          const half = Math.max(w, label) / 2;
          const m = p.metrics;
          const cx = x + w / 2;
          const bottom = y + h + m.labelGap + LINE * m.labelEm;
          if (qx >= cx - half && qx <= cx + half && qy >= y + h && qy <= bottom) rank = 2;
        }
      }
      if (rank > 0) {
        const d = Math.hypot(qx - (x + w / 2), qy - (y + h / 2));
        const best = this.bestBlockRank;
        if (
          this.bestBlock < 0 ||
          rank < best ||
          (rank === best &&
            (d < this.bestBlockD || (d === this.bestBlockD && block > this.bestBlock)))
        ) {
          this.bestBlock = block;
          this.bestBlockRank = rank;
          this.bestBlockD = d;
        }
      }
    }

    const m = p.metrics;
    const reach = Math.max(this.qr, m.portSize);
    const end = p.netlist.portStart[block + 1]!;
    for (let port = p.netlist.portStart[block]!; port < end; port++) {
      const px = x + p.portOffset[2 * port]!;
      const py = y + p.portOffset[2 * port + 1]!;
      let d = Math.hypot(qx - px, qy - py);
      if (d > reach) {
        if (!this.inTag(p, port, px, py)) continue;
        d = 0;
      }
      if (d > this.bestPortD || (d === this.bestPortD && port > this.bestPort)) continue;
      if (this.filtered && !this.portCompatible(p, port)) continue;
      this.bestPort = port;
      this.bestPortD = d;
    }
  }

  /** Whether the probe is inside a port's tag pill; a hidden tag net draws no pills. */
  private inTag(p: Prepared, port: number, px: number, py: number): boolean {
    const length = p.tagLength[port]!;
    if (length <= 0) return false;
    const net = p.portNet[port]!;
    if (net !== NONE && !this.source.netVisible(net)) return false;
    const { qx, qy } = this;
    const m = p.metrics;
    const side = p.portSide[port]!;
    if (side === SIDE_LEFT || side === SIDE_RIGHT) {
      if (Math.abs(qy - py) > m.tagHeight / 2) return false;
      const along = side === SIDE_LEFT ? px - qx : qx - px;
      return along >= m.tagGap && along <= length;
    }
    if (Math.abs(qx - px) > length / 2) return false;
    const along = side === SIDE_TOP ? py - qy : qy - py;
    return along >= m.tagGap && along <= m.tagGap + m.tagHeight;
  }

  /** Test one wire entry against the probe. */
  private testWire(p: Prepared, entry: number): void {
    const { f32, u32, words } = this.source.wires;
    const at = entry * WIRE_WORDS;
    if (at + WIRE_WORDS > words) return;
    const kind = u32[at + 5]!;
    const net = u32[at + 4]!;
    if (kind === WIRE_EMPTY || net >= p.netCount) return;
    const ax = f32[at]!;
    const ay = f32[at + 1]!;
    const d =
      kind === WIRE_SEGMENT
        ? segmentDistance(this.qx, this.qy, ax, ay, f32[at + 2]!, f32[at + 3]!)
        : Math.hypot(this.qx - ax, this.qy - ay);
    if (!(d <= this.qr)) return;
    if (d > this.bestNetD || (d === this.bestNetD && net >= this.bestNet && this.bestNet >= 0)) {
      return;
    }
    if (!this.source.netVisible(net)) return;
    if (this.filtered && !this.netCompatible(p, net)) return;
    this.bestNet = net;
    this.bestNetD = d;
  }

  /** Test a group frame against the probe: inside it, nearest center, then the later group. */
  private testGroup(group: number): void {
    const { f32 } = this.source.layout;
    const at = this.groupBase + 4 * group;
    const x0 = f32[at]!;
    const y0 = f32[at + 1]!;
    const x1 = f32[at + 2]!;
    const y1 = f32[at + 3]!;
    const { qx, qy } = this;
    // NaN bounds (no visible member) fail every comparison.
    if (!(qx >= x0 && qx <= x1 && qy >= y0 && qy <= y1)) return;
    const d = Math.hypot(qx - (x0 + x1) / 2, qy - (y0 + y1) / 2);
    if (d < this.bestGroupD || (d === this.bestGroupD && group > this.bestGroup)) {
      this.bestGroup = group;
      this.bestGroupD = d;
    }
  }

  /** Collect a block whose rectangle intersects the marquee. */
  private testMarquee(block: number): void {
    if (!this.source.blockVisible(block)) return;
    const p = this.indexed!;
    const { f32 } = this.source.layout;
    const x = f32[2 * block]!;
    const y = f32[2 * block + 1]!;
    if (!(
      x <= this.box2 &&
      x + p.size[2 * block]! >= this.box0 &&
      y <= this.box3 &&
      y + p.size[2 * block + 1]! >= this.box1
    )) {
      return;
    }
    if (this.foundCount === this.found.length) {
      const grown = new Uint32Array(2 * this.found.length);
      grown.set(this.found);
      this.found = grown;
    }
    this.found[this.foundCount++] = block;
  }

  /**
   * Visit a block whose extent rectangle's interior meets the obstacle box, as `RouteContext`
   * promises: a run along a block's edge does not cross it, and a box of zero width or height
   * finds the blocks its line runs through.
   */
  private testObstacle(p: Prepared, block: number): void {
    if (!this.source.blockVisible(block)) return;
    const { f32 } = this.source.layout;
    const e = 4 * block;
    const x = f32[2 * block]!;
    const y = f32[2 * block + 1]!;
    if (
      x - p.extent[e]! < this.ox1 &&
      x + p.size[2 * block]! + p.extent[e + 2]! > this.ox0 &&
      y - p.extent[e + 1]! < this.oy1 &&
      y + p.size[2 * block + 1]! + p.extent[e + 3]! > this.oy0
    ) {
      this.oVisit(block);
    }
  }

  // Compatibility.

  /**
   * Prime the union rule for a wire from `from` replacing `replaces`: its kind, its net, and the
   * `out` ports its side of the union holds. False when `from` is not a port.
   */
  private prime(p: Prepared, from: number, replaces: number): boolean {
    if (!Number.isInteger(from) || from < 0 || from >= p.portCount) return false;
    const flow = p.netlist.portFlow;
    const r =
      Number.isInteger(replaces) && replaces >= 0 && replaces < p.portCount ? replaces : NONE;
    const net = p.portNet[from]!;
    this.cFrom = from;
    this.cReplaces = r;
    this.cNet = net;
    this.cKind = p.portKind[from]!;
    if (net === NONE) {
      this.cOuts = flow[from] === FLOW_OUT ? 1 : 0;
    } else {
      const driver = p.netDriver[net]!;
      // The replaced port leaves the net, taking its drive with it.
      this.cOuts = driver !== NONE && driver !== r ? 1 : 0;
    }
    return true;
  }

  /** Whether a port is a compatible target under the primed union rule. */
  private portCompatible(p: Prepared, port: number): boolean {
    if (port === this.cFrom || port === this.cReplaces) return false;
    if (p.portKind[port] !== this.cKind) return false;
    const net = p.portNet[port]!;
    if (net !== NONE && net === this.cNet) return false;
    const outs =
      net === NONE
        ? p.netlist.portFlow[port] === FLOW_OUT
          ? 1
          : 0
        : p.netDriver[net] !== NONE
          ? 1
          : 0;
    return this.cOuts + outs <= 1;
  }

  /** Whether a wired net is a compatible target under the primed union rule. */
  private netCompatible(p: Prepared, net: number): boolean {
    if (net === this.cNet || p.netStyle[net] !== STYLE_WIRE) return false;
    const { netStart, netPorts } = p.netlist;
    if (netStart[net] === netStart[net + 1]) return false;
    if (p.portKind[netPorts[netStart[net]!]!] !== this.cKind) return false;
    return this.cOuts + (p.netDriver[net] !== NONE ? 1 : 0) <= 1;
  }
}

/** A visitor that does nothing: the idle obstacle query. */
function ignore(): void {}

/**
 * The index cell size: the median width of a block with its extents, so a typical block spans
 * one or two cells.
 */
function cellSize(p: Prepared): number {
  const n = p.blockCount;
  if (n === 0) return 16 * p.metrics.grid;
  const widths = new Float32Array(n);
  for (let block = 0; block < n; block++) {
    widths[block] = p.size[2 * block]! + p.extent[4 * block]! + p.extent[4 * block + 2]!;
  }
  widths.sort();
  return Math.max(widths[n >> 1]!, p.metrics.pitch);
}

/** Distance from `(x, y)` to the segment from `(ax, ay)` to `(bx, by)`. */
function segmentDistance(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}
