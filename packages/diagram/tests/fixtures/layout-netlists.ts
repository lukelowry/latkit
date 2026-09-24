/**
 * Netlists and checks the layout tests add to the shared fixtures: copies of a unit side by side,
 * a steam plant listed in any block order, and the geometric checks every layout must pass,
 * including what the router and the scene draw around it (routes, labels, group frames).
 */

import type { Netlist } from '@latkit/model';

import { textWidth } from '../../src/geometry.js';
import { NONE, type Prepared } from '../../src/prepare.js';
import { routeOrthogonal } from '../../src/route/orthogonal.js';
import { routeStraight } from '../../src/route/straight.js';
import { LINE } from '../../src/text/metrics.js';
import { build, CLASSES, type NetSpec } from './netlists.js';
import { contextOf, Recorder } from './route-scenes.js';

/** `count` copies of `netlist` in one netlist; keys and labels gain a `#copy` suffix. */
export function tile(netlist: Netlist, count: number): Netlist {
  const blocks = netlist.blockCount;
  const ports = netlist.portStart[blocks]!;
  const nets = netlist.netStart.length - 1;
  const members = netlist.netPorts.length;
  const groups = netlist.groupCount ?? 0;
  const portStart = new Uint32Array(blocks * count + 1);
  const netStart = new Uint32Array(nets * count + 1);
  const netPorts = new Uint32Array(members * count);
  const portFlow = new Uint8Array(ports * count);
  const portKind = new Uint8Array(ports * count);
  const portSide = netlist.portSide ? new Uint8Array(ports * count) : undefined;
  const netStyle = new Uint8Array(nets * count);
  const blockGroup = netlist.blockGroup ? new Uint32Array(blocks * count) : undefined;
  const suffix = (labels: readonly string[] | undefined): string[] | undefined =>
    labels && Array.from({ length: count }, (_, i) => labels.map((s) => `${s}#${i}`)).flat();
  const repeat = (labels: readonly string[] | undefined): string[] | undefined =>
    labels && Array.from({ length: count }, () => labels).flat();
  for (let i = 0; i < count; i++) {
    for (let b = 0; b < blocks; b++) {
      portStart[i * blocks + b + 1] = i * ports + netlist.portStart[b + 1]!;
      if (blockGroup) {
        const group = netlist.blockGroup![b]!;
        blockGroup[i * blocks + b] = group === NONE ? NONE : i * groups + group;
      }
    }
    portFlow.set(netlist.portFlow, i * ports);
    if (netlist.portKind) portKind.set(netlist.portKind, i * ports);
    if (portSide) portSide.set(netlist.portSide!, i * ports);
    for (let n = 0; n < nets; n++)
      netStart[i * nets + n + 1] = i * members + netlist.netStart[n + 1]!;
    for (let at = 0; at < members; at++)
      netPorts[i * members + at] = netlist.netPorts[at]! + i * ports;
    if (netlist.netStyle) netStyle.set(netlist.netStyle, i * nets);
  }
  return {
    blockCount: blocks * count,
    blockKey: suffix(netlist.blockKey),
    blockTitle: repeat(netlist.blockTitle),
    blockLabel: suffix(netlist.blockLabel),
    portStart,
    portFlow,
    portKind,
    portSide,
    portLabel: repeat(netlist.portLabel),
    netStart,
    netPorts,
    netStyle,
    netLabel: suffix(netlist.netLabel),
    blockGroup,
    groupCount: groups * count,
    groupLabel: suffix(netlist.groupLabel),
  };
}

/** A grouped steam plant (GENROU, TGOV1, IEEET1, bus tag) with its blocks listed in `order`. */
export function steamIn(order: readonly ('GENROU' | 'TGOV1' | 'IEEET1')[]): Netlist {
  const at = (cls: string): number => order.indexOf(cls as 'GENROU');
  const nets: NetSpec[] = [
    {
      label: '1_1_pmech',
      ports: [
        [at('TGOV1'), 'pmech'],
        [at('GENROU'), 'pmech'],
      ],
    },
    {
      label: '1_1_efd',
      ports: [
        [at('IEEET1'), 'efd'],
        [at('GENROU'), 'efd'],
      ],
    },
    {
      label: '1_1_speed',
      ports: [
        [at('GENROU'), 'speed'],
        [at('TGOV1'), 'speed'],
        [at('IEEET1'), 'speed'],
      ],
    },
    {
      label: 'bus_1',
      style: 1,
      ports: [
        [at('GENROU'), 'bus'],
        [at('IEEET1'), 'bus'],
      ],
    },
  ];
  return build({
    blocks: order.map((cls) => ({
      key: cls,
      title: cls,
      label: `1_1_${cls.toLowerCase()}`,
      group: 0,
      ports: CLASSES[cls],
    })),
    nets,
    groups: ['plant 1_1'],
  });
}

/** Every block's extent rectangle, 4 per block: `[x0, y0, x1, y1]`. */
export function rectangles(prepared: Prepared, positions: Float32Array): Float64Array {
  const { blockCount, size, extent } = prepared;
  const rects = new Float64Array(4 * blockCount);
  for (let b = 0; b < blockCount; b++) {
    rects[4 * b] = positions[2 * b]! - extent[4 * b]!;
    rects[4 * b + 1] = positions[2 * b + 1]! - extent[4 * b + 1]!;
    rects[4 * b + 2] = positions[2 * b]! + size[2 * b]! + extent[4 * b + 2]!;
    rects[4 * b + 3] = positions[2 * b + 1]! + size[2 * b + 1]! + extent[4 * b + 3]!;
  }
  return rects;
}

/** The first pair of blocks whose extent rectangles overlap (sweeping by x), or null. */
export function firstOverlap(
  prepared: Prepared,
  positions: Float32Array,
): readonly [number, number] | null {
  const rects = rectangles(prepared, positions);
  const byLeft = Array.from({ length: prepared.blockCount }, (_, b) => b).sort(
    (a, b) => rects[4 * a]! - rects[4 * b]! || a - b,
  );
  let active: number[] = [];
  for (const b of byLeft) {
    active = active.filter((a) => rects[4 * a + 2]! > rects[4 * b]!);
    for (const a of active) {
      if (rects[4 * a + 1]! < rects[4 * b + 3]! && rects[4 * b + 1]! < rects[4 * a + 3]!) {
        return [a, b];
      }
    }
    active.push(b);
  }
  return null;
}

/** A port's position at `positions`. */
export function portAt(
  prepared: Prepared,
  positions: Float32Array,
  port: number,
): readonly [number, number] {
  const block = prepared.portBlock[port]!;
  return [
    positions[2 * block]! + prepared.portOffset[2 * port]!,
    positions[2 * block + 1]! + prepared.portOffset[2 * port + 1]!,
  ];
}

/** Whether every reader of `net` sits level with its driver. */
export function straight(prepared: Prepared, positions: Float32Array, net: number): boolean {
  const driver = prepared.netDriver[net]!;
  const { netStart, netPorts } = prepared.netlist;
  const y = portAt(prepared, positions, driver)[1];
  for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
    if (portAt(prepared, positions, netPorts[at]!)[1] !== y) return false;
  }
  return true;
}

/** The net labeled `label`. */
export function netNamed(netlist: Netlist, label: string): number {
  const net = netlist.netLabel?.indexOf(label) ?? -1;
  if (net < 0) throw new Error(`fixture: no net ${label}`);
  return net;
}

/**
 * The box of what a group's frame holds besides its members, per net: the net's route as the
 * router draws it at `positions` (segment ends, junctions, arrow tips) and its label, drawn above
 * the wire from half a grid step right of the route's anchor; 4 per net, NaN for a net that draws
 * nothing. With `parts` `'labels'`, only the label.
 */
export function netBoxes(
  prepared: Prepared,
  positions: Float32Array,
  mode: 'orthogonal' | 'straight' = 'orthogonal',
  parts: 'all' | 'labels' = 'all',
): Float64Array {
  const { netCount, metrics: m } = prepared;
  const ctx = contextOf({ prepared, positions }, { mode });
  const boxes = new Float64Array(4 * netCount).fill(Number.NaN);
  const labelLine = LINE * m.labelEm;
  for (let net = 0; net < netCount; net++) {
    const out = new Recorder();
    (mode === 'straight' ? routeStraight : routeOrthogonal)(ctx, net, out);
    const xs: number[] = [];
    const ys: number[] = [];
    if (parts === 'all') {
      for (const s of out.segments) {
        xs.push(s.ax, s.bx);
        ys.push(s.ay, s.by);
      }
      for (const [x, y] of [...out.junctions, ...out.arrows]) {
        xs.push(x!);
        ys.push(y!);
      }
    }
    const label = prepared.netlist.netLabel?.[net];
    if (out.anchorAt && label) {
      const [ax, ay] = out.anchorAt;
      const x0 = ax + 0.5 * m.grid;
      const y1 = ay - 0.25 * m.grid;
      xs.push(x0, x0 + textWidth(label, m.labelEm));
      ys.push(y1 - labelLine, y1);
    }
    if (xs.length === 0) continue;
    boxes.set([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 4 * net);
  }
  return boxes;
}

/**
 * Every group's frame as the scene draws it: its members' extent rectangles and the boxes of its
 * internal nets (`netBoxes`), padded by `groupPad`, with `groupHeader` on top; 4 per group.
 */
export function groupFrames(
  prepared: Prepared,
  positions: Float32Array,
  mode: 'orthogonal' | 'straight' = 'orthogonal',
): Float64Array {
  const { groupCount, groupStart, groupBlocks, netCount, netGroup, metrics: m } = prepared;
  const rects = rectangles(prepared, positions);
  const nets = netBoxes(prepared, positions, mode);
  const frames = new Float64Array(4 * groupCount);
  const grow = (group: number, box: ArrayLike<number>, at: number): void => {
    if (Number.isNaN(box[at]!)) return;
    frames[4 * group] = Math.min(frames[4 * group]!, box[at]!);
    frames[4 * group + 1] = Math.min(frames[4 * group + 1]!, box[at + 1]!);
    frames[4 * group + 2] = Math.max(frames[4 * group + 2]!, box[at + 2]!);
    frames[4 * group + 3] = Math.max(frames[4 * group + 3]!, box[at + 3]!);
  };
  for (let group = 0; group < groupCount; group++) {
    frames.set([Infinity, Infinity, -Infinity, -Infinity], 4 * group);
    for (let at = groupStart[group]!; at < groupStart[group + 1]!; at++) {
      grow(group, rects, 4 * groupBlocks[at]!);
    }
  }
  for (let net = 0; net < netCount; net++) {
    if (netGroup[net] !== NONE) grow(netGroup[net]!, nets, 4 * net);
  }
  for (let group = 0; group < groupCount; group++) {
    frames[4 * group]! -= m.groupPad;
    frames[4 * group + 1]! -= m.groupPad + m.groupHeader;
    frames[4 * group + 2]! += m.groupPad;
    frames[4 * group + 3]! += m.groupPad;
  }
  return frames;
}

/** The first two boxes (4 per box) closer than `gap` on both axes, or null. */
export function closePair(boxes: Float64Array, gap: number): readonly [number, number] | null {
  const count = boxes.length / 4;
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      const apart =
        boxes[4 * a + 2]! + gap <= boxes[4 * b]! ||
        boxes[4 * b + 2]! + gap <= boxes[4 * a]! ||
        boxes[4 * a + 3]! + gap <= boxes[4 * b + 1]! ||
        boxes[4 * b + 3]! + gap <= boxes[4 * a + 1]!;
      if (!apart) return [a, b];
    }
  }
  return null;
}

/** The first two boxes (4 per box) whose interiors overlap, or null. */
export function overlappingPair(
  a: Float64Array,
  b: Float64Array,
  skip: (i: number, j: number) => boolean = () => false,
): readonly [number, number] | null {
  for (let i = 0; i < a.length / 4; i++) {
    if (Number.isNaN(a[4 * i]!)) continue;
    for (let j = 0; j < b.length / 4; j++) {
      if (Number.isNaN(b[4 * j]!) || skip(i, j)) continue;
      if (
        a[4 * i]! < b[4 * j + 2]! &&
        b[4 * j]! < a[4 * i + 2]! &&
        a[4 * i + 1]! < b[4 * j + 3]! &&
        b[4 * j + 1]! < a[4 * i + 3]!
      ) {
        return [i, j];
      }
    }
  }
  return null;
}

/** The first block titled `title` at or after block `from`. */
export function blockTitled(netlist: Netlist, title: string, from = 0): number {
  const block = netlist.blockTitle?.indexOf(title, from) ?? -1;
  if (block < 0) throw new Error(`fixture: no block ${title}`);
  return block;
}
