/**
 * Everything a diagram derives from a netlist once per load: resolved defaults, the inverse and
 * adjacency tables every later stage walks, and every block's size, extents, and port offsets.
 * Pure and allocation-bounded by the netlist, so layout in a worker sizes blocks exactly as the
 * page draws them.
 */

import type { Netlist } from '@latkit/model';

import { ceilTo, metrics, textWidth, type Metrics } from './geometry.js';
import { LINE } from './text/metrics.js';

/** The "none" index wherever an index may be absent. */
export const NONE = 0xffffffff;

/** Port flows. */
export const FLOW_IN = 0;
export const FLOW_OUT = 1;
export const FLOW_BOTH = 2;

/** Port sides. */
export const SIDE_LEFT = 0;
export const SIDE_RIGHT = 1;
export const SIDE_TOP = 2;
export const SIDE_BOTTOM = 3;

/** Net styles: drawn as wires, or as a tag at each port. */
export const STYLE_WIRE = 0;
export const STYLE_TAG = 1;

/** Band flags: a block's top, or bottom, ports have labels, which take a band inside that edge. */
export const BAND_TOP = 1;
export const BAND_BOTTOM = 2;

/** A validated netlist with everything derived once per load. */
export interface Prepared {
  /** The netlist this was derived from; borrowed, never changed. */
  readonly netlist: Netlist;
  /** The sizing constants of the grid it was prepared at. */
  readonly metrics: Metrics;
  readonly blockCount: number;
  readonly portCount: number;
  readonly netCount: number;
  readonly groupCount: number;
  /** Per port: its block. */
  readonly portBlock: Uint32Array;
  /** Per port: its net, or `NONE`. */
  readonly portNet: Uint32Array;
  /** Per port: its kind, all `0` when the netlist has none. */
  readonly portKind: Uint8Array;
  /** Per port: its side, defaults resolved (in left, out right, both top). */
  readonly portSide: Uint8Array;
  /** Per net: its `out` port, or `NONE`. */
  readonly netDriver: Uint32Array;
  /** Per net: its style, all wires when the netlist has none. */
  readonly netStyle: Uint8Array;
  /** Per net: the group every block on it shares, or `NONE`. */
  readonly netGroup: Uint32Array;
  /** Per block: its group, or `NONE`. */
  readonly blockGroup: Uint32Array;
  /** Group `g` holds blocks `groupBlocks[groupStart[g]]` up to `groupBlocks[groupStart[g + 1]]`. */
  readonly groupStart: Uint32Array;
  readonly groupBlocks: Uint32Array;
  /**
   * Block `b` has ports on nets `blockNets[blockNetStart[b]]` up to
   * `blockNets[blockNetStart[b + 1]]`, each once, in port order.
   */
  readonly blockNetStart: Uint32Array;
  readonly blockNets: Uint32Array;
  /** Per block: width and height, multiples of `metrics.pitch`. */
  readonly size: Float32Array;
  /**
   * Per block: its `BAND_*` flags, set when a top (bottom) port has a label. Each band is
   * `metrics.band` tall inside that edge; the side ports and the title sit between the bands.
   */
  readonly bands: Uint8Array;
  /** Per block: the margins its tags and label reach beyond its rectangle: left, top, right, bottom. */
  readonly extent: Float32Array;
  /** Per port: its position relative to its block's top-left, on the grid. */
  readonly portOffset: Float32Array;
  /** Per port: the length of its tag pill from the port, or `0` when its net is not a tag net. */
  readonly tagLength: Float32Array;
  /** Block by `blockKey`, or null when the netlist has no keys. */
  readonly keys: ReadonlyMap<string, number> | null;
}

/**
 * Derive everything a diagram needs from a validated netlist; pure.
 *
 * @remarks
 * A block lays its text out without collisions by construction, and `textRuns` places the text by
 * the same rules. When a top (bottom) port has a label, a `metrics.band` inside that edge holds the
 * top (bottom) labels (`bands` flags it), and the side ports and the title sit in the side region
 * between the bands: side ports a pitch apart and centered in it, the title centered in it. The
 * width keeps the title `textGap` clear of every side label whose line comes within `textGap` of
 * the title's line, keeps left and right labels apart, and keeps top and bottom labels inside the
 * block; neighboring top (bottom) ports sit far enough apart that their labels and tag pills keep
 * `textGap` between them. Every size is a multiple of the pitch and every port offset a multiple
 * of the grid, and text a block does not have takes no room.
 *
 * @param netlist - A netlist `validateNetlist` accepts.
 * @param grid - The grid pitch in diagram units.
 */
export function prepare(netlist: Netlist, grid: number): Prepared {
  const m = metrics(grid);
  const { blockCount, portStart, portFlow, netStart, netPorts } = netlist;
  const portCount = portStart[blockCount]!;
  const netCount = netStart.length - 1;
  const groupCount = netlist.groupCount ?? 0;

  const portBlock = new Uint32Array(portCount);
  for (let block = 0; block < blockCount; block++) {
    portBlock.fill(block, portStart[block]!, portStart[block + 1]!);
  }

  const portNet = new Uint32Array(portCount).fill(NONE);
  const netDriver = new Uint32Array(netCount).fill(NONE);
  for (let net = 0; net < netCount; net++) {
    for (let i = netStart[net]!; i < netStart[net + 1]!; i++) {
      const port = netPorts[i]!;
      portNet[port] = net;
      if (portFlow[port] === FLOW_OUT) netDriver[net] = port;
    }
  }

  const portKind = netlist.portKind ?? new Uint8Array(portCount);
  const portSide = netlist.portSide ?? defaultSides(portFlow);
  const netStyle = netlist.netStyle ?? new Uint8Array(netCount);
  const blockGroup = netlist.blockGroup ?? new Uint32Array(blockCount).fill(NONE);

  const netGroup = new Uint32Array(netCount);
  for (let net = 0; net < netCount; net++) {
    let group = NONE;
    for (let i = netStart[net]!; i < netStart[net + 1]!; i++) {
      const member = blockGroup[portBlock[netPorts[i]!]!]!;
      if (i === netStart[net]) group = member;
      else if (member !== group) {
        group = NONE;
        break;
      }
    }
    netGroup[net] = group;
  }

  const groupStart = new Uint32Array(groupCount + 1);
  for (let block = 0; block < blockCount; block++) {
    const group = blockGroup[block]!;
    if (group !== NONE) groupStart[group + 1]!++;
  }
  for (let group = 0; group < groupCount; group++) {
    groupStart[group + 1]! += groupStart[group]!;
  }
  const groupBlocks = new Uint32Array(groupStart[groupCount]!);
  const fill = groupStart.slice(0, groupCount);
  for (let block = 0; block < blockCount; block++) {
    const group = blockGroup[block]!;
    if (group !== NONE) groupBlocks[fill[group]!++] = block;
  }

  const { start: blockNetStart, nets: blockNets } = blockNetTable(
    portStart,
    portNet,
    blockCount,
    netCount,
  );

  const tagLength = new Float32Array(portCount);
  const netLabel = netlist.netLabel;
  for (let port = 0; port < portCount; port++) {
    const net = portNet[port]!;
    if (net === NONE || netStyle[net] !== STYLE_TAG) continue;
    const text = textWidth(netLabel?.[net] ?? '', m.labelEm);
    tagLength[port] = ceilTo(m.tagGap + 2 * m.tagPad + text, grid);
  }

  const size = new Float32Array(2 * blockCount);
  const bands = new Uint8Array(blockCount);
  const extent = new Float32Array(4 * blockCount);
  const portOffset = new Float32Array(2 * portCount);
  const sides = new Uint32Array(4);
  const seen = new Uint32Array(4);
  // Label width of each port of the block at hand, measured once.
  let widths = new Float64Array(16);
  const portLabel = netlist.portLabel;
  const labelLine = LINE * m.labelEm;
  const titleLine = LINE * m.titleEm;
  // A side label whose row lies nearer the title's middle than this comes within `textGap` of the
  // title's line, so the title must clear it across instead.
  const titleReach = (labelLine + titleLine) / 2 + m.textGap;
  // The side region a title needs: its line and `textGap` above and below it.
  const titleRegion = ceilTo(titleLine + 2 * m.textGap, m.pitch);
  for (let block = 0; block < blockCount; block++) {
    const first = portStart[block]!;
    const end = portStart[block + 1]!;
    if (widths.length < end - first) widths = new Float64Array(2 * (end - first));
    sides.fill(0);
    let banded = 0;
    let widestLeft = 0;
    let widestRight = 0;
    // The widest label along the top (bottom), and the widest label or tag pill there.
    let labelTop = 0;
    let labelBottom = 0;
    let spanTop = 0;
    let spanBottom = 0;
    for (let port = first; port < end; port++) {
      const side = portSide[port]!;
      sides[side]!++;
      const label = portLabel?.[port];
      const width = label ? textWidth(label, m.labelEm) : 0;
      widths[port - first] = width;
      if (side === SIDE_LEFT) widestLeft = Math.max(widestLeft, width);
      else if (side === SIDE_RIGHT) widestRight = Math.max(widestRight, width);
      else if (side === SIDE_TOP) {
        if (label) banded |= BAND_TOP;
        labelTop = Math.max(labelTop, width);
        spanTop = Math.max(spanTop, width, tagLength[port]!);
      } else {
        if (label) banded |= BAND_BOTTOM;
        labelBottom = Math.max(labelBottom, width);
        spanBottom = Math.max(spanBottom, width, tagLength[port]!);
      }
    }
    const titleWidth = textWidth(netlist.blockTitle?.[block] ?? '', m.titleEm);
    // The widest side label on a row near the title's middle: the title clears it across. When
    // every row is that near, it is simply the widest side label.
    let beside = 0;
    const outermost = ((Math.max(sides[SIDE_LEFT]!, sides[SIDE_RIGHT]!) - 1) / 2) * m.pitch;
    if (titleWidth > 0 && outermost < titleReach) beside = Math.max(widestLeft, widestRight);
    else if (titleWidth > 0 && (widestLeft > 0 || widestRight > 0)) {
      seen.fill(0);
      for (let port = first; port < end; port++) {
        const side = portSide[port]!;
        if (side !== SIDE_LEFT && side !== SIDE_RIGHT) continue;
        const along = (seen[side]!++ - (sides[side]! - 1) / 2) * m.pitch;
        if (Math.abs(along) < titleReach) beside = Math.max(beside, widths[port - first]!);
      }
    }
    const stepTop = edgeStep(sides[SIDE_TOP]!, spanTop, m);
    const stepBottom = edgeStep(sides[SIDE_BOTTOM]!, spanBottom, m);
    const w = ceilTo(
      Math.max(
        6 * grid,
        titleWidth + 2 * m.pitch,
        beside > 0 ? titleWidth + 2 * (beside + m.inset + m.textGap) : 0,
        widestLeft + widestRight + 3 * m.pitch,
        edgeWidth(sides[SIDE_TOP]!, stepTop, labelTop, m),
        edgeWidth(sides[SIDE_BOTTOM]!, stepBottom, labelBottom, m),
      ),
      m.pitch,
    );
    const bandTop = banded & BAND_TOP ? m.band : 0;
    const bandBottom = banded & BAND_BOTTOM ? m.band : 0;
    // The side region between the bands holds the side ports a pitch apart with a pitch beyond
    // each end, and the title's region; with the bands, the block is at least three pitches tall.
    const middle = ceilTo(
      Math.max(
        (Math.max(sides[SIDE_LEFT]!, sides[SIDE_RIGHT]!) + 1) * m.pitch,
        3 * m.pitch - bandTop - bandBottom,
        titleWidth > 0 ? titleRegion : 0,
      ),
      m.pitch,
    );
    const h = bandTop + middle + bandBottom;
    const middleY = bandTop + middle / 2;
    size[2 * block] = w;
    size[2 * block + 1] = h;
    bands[block] = banded;

    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    seen.fill(0);
    for (let port = first; port < end; port++) {
      const side = portSide[port]!;
      const k = sides[side]!;
      // Centered on the side, one step apart: (2i - k + 1) half steps from the middle, and every
      // step is whole pitches, so a half step is whole grid steps.
      const slot = seen[side]!++ - (k - 1) / 2;
      let x: number;
      let y: number;
      if (side === SIDE_LEFT || side === SIDE_RIGHT) {
        x = side === SIDE_LEFT ? 0 : w;
        y = middleY + slot * m.pitch;
      } else {
        x = w / 2 + slot * (side === SIDE_TOP ? stepTop : stepBottom);
        y = side === SIDE_TOP ? 0 : h;
      }
      portOffset[2 * port] = x;
      portOffset[2 * port + 1] = y;
      const tag = tagLength[port]!;
      if (tag === 0) continue;
      if (side === SIDE_LEFT) left = Math.max(left, tag);
      else if (side === SIDE_RIGHT) right = Math.max(right, tag);
      else {
        // A top or bottom tag is a horizontal pill centered on its port.
        if (side === SIDE_TOP) top = m.tagHeight + m.tagGap;
        else bottom = m.tagHeight + m.tagGap;
        left = Math.max(left, tag / 2 - x);
        right = Math.max(right, tag / 2 - (w - x));
      }
    }
    const label = netlist.blockLabel?.[block];
    if (label) {
      bottom += m.labelGap + labelLine;
      const overhang = Math.max(0, (textWidth(label, m.labelEm) - w) / 2);
      left = Math.max(left, overhang);
      right = Math.max(right, overhang);
    }
    extent[4 * block] = left;
    extent[4 * block + 1] = top;
    extent[4 * block + 2] = right;
    extent[4 * block + 3] = bottom;
  }

  let keys: Map<string, number> | null = null;
  if (netlist.blockKey) {
    keys = new Map();
    for (let block = 0; block < blockCount; block++) keys.set(netlist.blockKey[block]!, block);
  }

  return {
    netlist,
    metrics: m,
    blockCount,
    portCount,
    netCount,
    groupCount,
    portBlock,
    portNet,
    portKind,
    portSide,
    netDriver,
    netStyle,
    netGroup,
    blockGroup,
    groupStart,
    groupBlocks,
    blockNetStart,
    blockNets,
    size,
    bands,
    extent,
    portOffset,
    tagLength,
    keys,
  };
}

/**
 * The distance between neighboring ports along a top or bottom edge: one pitch, or whole pitches
 * enough that the widest label or tag pill there (`span`) keeps `textGap` from the next.
 */
function edgeStep(count: number, span: number, m: Metrics): number {
  return count < 2 ? m.pitch : Math.max(m.pitch, ceilTo(span + m.textGap, m.pitch));
}

/**
 * The block width a top or bottom edge of `count` ports needs: a pitch beyond each end port, and
 * its widest label (`label`) centered on an end port still `inset` inside the corner.
 */
function edgeWidth(count: number, step: number, label: number, m: Metrics): number {
  if (count === 0) return 0;
  const run = (count - 1) * step;
  return Math.max(run + 2 * m.pitch, label > 0 ? run + label + 2 * m.inset : 0);
}

/** The default side of every port: in left, out right, both top. */
function defaultSides(flow: Uint8Array): Uint8Array {
  const sides = new Uint8Array(flow.length);
  for (let port = 0; port < flow.length; port++) {
    const f = flow[port]!;
    sides[port] = f === FLOW_IN ? SIDE_LEFT : f === FLOW_OUT ? SIDE_RIGHT : SIDE_TOP;
  }
  return sides;
}

/** The CSR table from each block to the distinct nets its ports are on, in port order. */
function blockNetTable(
  portStart: Uint32Array,
  portNet: Uint32Array,
  blockCount: number,
  netCount: number,
): { readonly start: Uint32Array; readonly nets: Uint32Array } {
  // `stamp[net]` holds the last block (plus one) that counted the net, so each counts once.
  const stamp = new Uint32Array(netCount);
  const start = new Uint32Array(blockCount + 1);
  let total = 0;
  for (let block = 0; block < blockCount; block++) {
    for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
      const net = portNet[port]!;
      if (net === NONE || stamp[net] === block + 1) continue;
      stamp[net] = block + 1;
      total++;
    }
    start[block + 1] = total;
  }
  stamp.fill(0);
  const nets = new Uint32Array(total);
  let at = 0;
  for (let block = 0; block < blockCount; block++) {
    for (let port = portStart[block]!; port < portStart[block + 1]!; port++) {
      const net = portNet[port]!;
      if (net === NONE || stamp[net] === block + 1) continue;
      stamp[net] = block + 1;
      nets[at++] = net;
    }
  }
  return { start, nets };
}

/** Whether two netlists are the same content: counts, every column, and every label. */
export function sameNetlist(a: Netlist, b: Netlist): boolean {
  if (a === b) return true;
  return (
    a.blockCount === b.blockCount &&
    (a.groupCount ?? 0) === (b.groupCount ?? 0) &&
    sameColumn(a.portStart, b.portStart) &&
    sameColumn(a.portFlow, b.portFlow) &&
    sameColumn(a.netStart, b.netStart) &&
    sameColumn(a.netPorts, b.netPorts) &&
    sameColumn(a.portKind, b.portKind) &&
    sameColumn(a.portSide, b.portSide) &&
    sameColumn(a.netStyle, b.netStyle) &&
    sameColumn(a.blockGroup, b.blockGroup) &&
    sameText(a.blockKey, b.blockKey) &&
    sameText(a.blockTitle, b.blockTitle) &&
    sameText(a.blockLabel, b.blockLabel) &&
    sameText(a.portLabel, b.portLabel) &&
    sameText(a.netLabel, b.netLabel) &&
    sameText(a.groupLabel, b.groupLabel)
  );
}

/** Two optional numeric columns: both absent, or the same values. */
function sameColumn(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Two optional label columns: both absent, or the same strings. */
function sameText(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
