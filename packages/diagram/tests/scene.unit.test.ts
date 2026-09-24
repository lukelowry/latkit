import type { Netlist } from '@latkit/model';
import { describe, expect, it, vi } from 'vitest';

import { createChannels, type Channels } from '../src/channels.js';
import { ceilTo, textWidth } from '../src/geometry.js';
import { arrangeAll } from '../src/layout/arrange.js';
import { UNIT_GAP } from '../src/layout/pack.js';
import { Layouts } from '../src/layout/shapes.js';
import { units } from '../src/layout/units.js';
import { PART_BLOCK, PART_NET, partId } from '../src/part.js';
import { NONE, prepare, STYLE_WIRE, type Prepared } from '../src/prepare.js';
import { NUDGE_SETTLE_MS, Scene } from '../src/scene.js';
import { LINE } from '../src/text/metrics.js';
import {
  BLOCK_WORDS,
  createMirrors,
  layoutBases,
  structureBases,
  WIRE_ARROW,
  WIRE_EMPTY,
  WIRE_SEGMENT,
  WIRE_WORDS,
  type Mirrors,
} from '../src/webgpu/buffers.js';
import { createUniforms } from '../src/webgpu/uniforms.js';
import { closePair, firstOverlap, tile } from './fixtures/layout-netlists.js';
import {
  build,
  plant,
  scale,
  system,
  twoArea,
  type BlockSpec,
  type NetSpec,
} from './fixtures/netlists.js';

const G = 8;
const block = (index: number): number => partId(PART_BLOCK, index);

interface Harness {
  readonly mirrors: Mirrors;
  readonly channels: Channels;
  readonly scene: Scene;
}

function harness(): Harness {
  const mirrors = createMirrors();
  const channels = createChannels(mirrors.channels, createUniforms(mirrors.uniforms));
  return { mirrors, channels, scene: new Scene(mirrors, channels) };
}

function loaded(netlist: Netlist, now = 0): Harness {
  const h = harness();
  h.scene.load(netlist, G, true, now);
  return h;
}

/** One wire entry as the wire pass reads it. */
interface Entry {
  readonly kind: number;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

/** The entries in use in a net's slot. */
function entries(scene: Scene, net: number): Entry[] {
  const { start, count } = scene.routes.slot(net);
  const { f32, u32 } = scene.wires;
  const out: Entry[] = [];
  for (let entry = start; entry < start + count; entry++) {
    const at = entry * WIRE_WORDS;
    if (u32[at + 5] === WIRE_EMPTY) continue;
    expect(u32[at + 4]).toBe(net);
    out.push({
      kind: u32[at + 5]!,
      ax: f32[at]!,
      ay: f32[at + 1]!,
      bx: f32[at + 2]!,
      by: f32[at + 3]!,
    });
  }
  return out;
}

/** Every entry in use, as text, to compare whole routings. */
function routing(scene: Scene): string {
  const out: string[] = [];
  for (let net = 0; net < scene.prepared!.netCount; net++) {
    for (const e of entries(scene, net))
      out.push(`${net}:${e.kind}:${e.ax},${e.ay},${e.bx},${e.by}`);
  }
  return out.sort().join('\n');
}

/** A port's position where its block is drawn. */
function portAt(scene: Scene, port: number): readonly [number, number] {
  const p = scene.prepared!;
  const b = p.portBlock[port]!;
  return [
    scene.positions[2 * b]! + p.portOffset[2 * port]!,
    scene.positions[2 * b + 1]! + p.portOffset[2 * port + 1]!,
  ];
}

/** Whether a net's route runs to a port: a segment ends there. */
function reaches(scene: Scene, net: number, port: number): boolean {
  const [x, y] = portAt(scene, port);
  return entries(scene, net).some(
    (e) => e.kind === WIRE_SEGMENT && ((e.ax === x && e.ay === y) || (e.bx === x && e.by === y)),
  );
}

/** Whether a net draws an arrow at a port. */
function arrowAt(scene: Scene, net: number, port: number): boolean {
  const [x, y] = portAt(scene, port);
  return entries(scene, net).some((e) => e.kind === WIRE_ARROW && e.ax === x && e.ay === y);
}

/** A block's rectangle with its extents where it is drawn. */
function extentRect(scene: Scene, b: number): readonly [number, number, number, number] {
  const p = scene.prepared!;
  const x = scene.positions[2 * b]!;
  const y = scene.positions[2 * b + 1]!;
  const e = p.extent;
  return [
    x - e[4 * b]!,
    y - e[4 * b + 1]!,
    x + p.size[2 * b]! + e[4 * b + 2]!,
    y + p.size[2 * b + 1]! + e[4 * b + 3]!,
  ];
}

/** A block's center where it is drawn. */
function center(scene: Scene, b: number): readonly [number, number] {
  const p = scene.prepared!;
  return [
    scene.positions[2 * b]! + p.size[2 * b]! / 2,
    scene.positions[2 * b + 1]! + p.size[2 * b + 1]! / 2,
  ];
}

/**
 * The rectangle of the label drawn over a net's wire, as the text pass places it, or null when
 * none is drawn.
 */
function labelRect(scene: Scene, net: number): readonly [number, number, number, number] | null {
  const p = scene.prepared!;
  const text = p.netlist.netLabel?.[net];
  if (!text || p.netStyle[net] !== STYLE_WIRE || !scene.netVisible(net)) return null;
  const at = layoutBases(p).anchor + 2 * net;
  const x = scene.layout.f32[at]!;
  const y = scene.layout.f32[at + 1]!;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { grid, labelEm } = p.metrics;
  const left = x + 0.5 * grid;
  const bottom = y - 0.25 * grid;
  return [left, bottom - LINE * labelEm, left + textWidth(text, labelEm), bottom];
}

/** Whether rectangle `inner` lies inside `outer`. */
function contains(outer: readonly number[], inner: readonly number[]): boolean {
  return (
    inner[0]! >= outer[0]! &&
    inner[1]! >= outer[1]! &&
    inner[2]! <= outer[2]! &&
    inner[3]! <= outer[3]!
  );
}

/** A group's frame as the layout mirror holds it. */
function frame(scene: Scene, group: number): number[] {
  const at = layoutBases(scene.prepared!).group + 4 * group;
  return Array.from(scene.layout.f32.subarray(at, at + 4));
}

/** Every ghost the overlay would draw. */
function ghosts(scene: Scene): number[][] {
  const out: number[][] = [];
  scene.overlayGhosts((x0, y0, x1, y1, alpha) => out.push([x0, y0, x1, y1, alpha]));
  return out;
}

/** Ports of some nets, summed. */
function portsOf(p: Prepared, nets: readonly number[]): number {
  const { netStart } = p.netlist;
  return nets.reduce((sum, net) => sum + netStart[net + 1]! - netStart[net]!, 0);
}

/**
 * A reference block driving `readers` readers on one wide net (net 0), each reader also driving
 * the next one's `aux` input: net `i` joins reader `i - 1`'s output and reader `i`'s `aux`.
 * Reader `i` is block `i + 1`, with ports `in`, `aux`, `out`.
 */
function broadcast(readers: number): Netlist {
  const blocks: BlockSpec[] = [{ key: 'ref', title: 'REF', ports: [{ name: 'out', flow: 'out' }] }];
  const wide: (readonly [number, string])[] = [[0, 'out']];
  const chain: NetSpec[] = [];
  for (let i = 0; i < readers; i++) {
    blocks.push({
      key: `r${i}`,
      title: 'R',
      ports: [
        { name: 'in', flow: 'in' },
        { name: 'aux', flow: 'in' },
        { name: 'out', flow: 'out' },
      ],
    });
    wide.push([i + 1, 'in']);
    if (i > 0)
      chain.push({
        label: `c${i}`,
        ports: [
          [i, 'out'],
          [i + 1, 'aux'],
        ],
      });
  }
  return build({ blocks, nets: [{ label: 'ref', ports: wide }, ...chain] });
}

/** Wired nets of two or more ports: the nets that draw. */
function drawnNets(p: Prepared): number[] {
  const { netStart } = p.netlist;
  const out: number[] = [];
  for (let net = 0; net < p.netCount; net++) {
    if (p.netStyle[net] === STYLE_WIRE && netStart[net + 1]! - netStart[net]! >= 2) out.push(net);
  }
  return out;
}

/** `netlist` with one more block, one `in` port reading `net`, keyed `key`. */
function withReader(netlist: Netlist, net: number, key: string): Netlist {
  const blocks = netlist.blockCount;
  const ports = netlist.portStart[blocks]!;
  const end = netlist.netStart[net + 1]!;
  const kind = netlist.portKind?.[netlist.netPorts[netlist.netStart[net]!]!] ?? 0;
  return {
    ...netlist,
    blockCount: blocks + 1,
    blockKey: [...netlist.blockKey!, key],
    blockTitle: netlist.blockTitle && [...netlist.blockTitle, 'IEEEST'],
    blockLabel: netlist.blockLabel && [...netlist.blockLabel, key],
    portStart: Uint32Array.from([...netlist.portStart, ports + 1]),
    portFlow: Uint8Array.from([...netlist.portFlow, 0]),
    portKind: netlist.portKind && Uint8Array.from([...netlist.portKind, kind]),
    portSide: netlist.portSide && Uint8Array.from([...netlist.portSide, 0]),
    portLabel: netlist.portLabel && [...netlist.portLabel, 'input'],
    netStart: netlist.netStart.map((start, n) => (n > net ? start + 1 : start)),
    netPorts: Uint32Array.from([
      ...netlist.netPorts.subarray(0, end),
      ports,
      ...netlist.netPorts.subarray(end),
    ]),
    blockGroup: netlist.blockGroup && Uint32Array.from([...netlist.blockGroup, NONE]),
  };
}

/** TwoArea with its blocks listed as `order` (new block `i` is old block `order[i]`). */
function reordered(order: readonly number[]): Netlist {
  const netlist = twoArea();
  const old = netlist.portStart;
  const portStart = new Uint32Array(order.length + 1);
  const portOf = new Uint32Array(old[netlist.blockCount]!);
  const flow: number[] = [];
  const labels: string[] = [];
  order.forEach((was, i) => {
    portStart[i + 1] = portStart[i]! + old[was + 1]! - old[was]!;
    for (let port = old[was]!; port < old[was + 1]!; port++) {
      portOf[port] = portStart[i]! + port - old[was]!;
      flow.push(netlist.portFlow[port]!);
      labels.push(netlist.portLabel![port]!);
    }
  });
  return {
    ...netlist,
    blockKey: order.map((was) => netlist.blockKey![was]!),
    blockTitle: order.map((was) => netlist.blockTitle![was]!),
    portStart,
    portFlow: Uint8Array.from(flow),
    portLabel: labels,
    netPorts: netlist.netPorts.map((port) => portOf[port]!),
  };
}

/** The top-left a unit is anchored at: where its blocks' extents start, on the grid. */
function anchorOf(scene: Scene, blocks: readonly number[]): readonly [number, number] {
  const p = scene.prepared!;
  let x = Infinity;
  let y = Infinity;
  for (const b of blocks) {
    x = Math.min(x, scene.positions[2 * b]! - ceilTo(p.extent[4 * b]!, G));
    y = Math.min(y, scene.positions[2 * b + 1]! - ceilTo(p.extent[4 * b + 1]!, G));
  }
  return [x, y];
}

describe('Scene.load', () => {
  it('arranges a first load, writes the structure and layout, and routes every net', () => {
    const h = harness();
    const netlist = plant('steam');
    const settled = h.scene.settled;
    const survivors = h.scene.load(netlist, G, true, 0);
    const p = h.scene.prepared!;
    expect(Array.from(survivors)).toEqual([NONE, NONE, NONE]);
    expect(Array.from(h.scene.positions)).toEqual(Array.from(arrangeAll(prepare(netlist, G))));
    for (const v of h.scene.positions) expect(v % G).toBe(0);
    expect(h.mirrors.structure.words).toBe(structureBases(p).words);
    expect(h.mirrors.structure.f32[BLOCK_WORDS]).toBe(p.size[2]);
    expect(h.mirrors.structure.f32[BLOCK_WORDS + 1]).toBe(p.size[3]);
    expect(h.mirrors.layout.words).toBe(layoutBases(p).words);
    expect(h.scene.settled).toBeGreaterThan(settled);
    for (const net of drawnNets(p)) {
      const { netStart, netPorts } = p.netlist;
      for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
        expect(reaches(h.scene, net, netPorts[at]!)).toBe(true);
      }
    }
    // The bus is a tag net: its tags are drawn by the port pass, not routed.
    const bus = p.netCount - 1;
    expect(p.netStyle[bus]).toBe(1);
    expect(entries(h.scene, bus)).toEqual([]);
    expect(h.scene.routes.capacity * WIRE_WORDS).toBe(h.mirrors.wires.words);
  });

  it('clears every channel but the placements of surviving keys, since indices change', () => {
    const h = loaded(twoArea());
    h.channels.set('blockVisible', Float32Array.of(0, 1, 1));
    h.channels.set('blockPosition', new Float32Array(6).fill(5));
    h.scene.load(plant('steam'), G, true, 0);
    expect(h.channels.values('blockVisible')).toBeNull();
    expect(h.scene.blockVisible(0)).toBe(true);
    // The plant's blocks carry TwoArea's keys: each keeps its placement.
    expect(Array.from(h.channels.values('blockPosition')!)).toEqual([5, 5, 5, 5, 5, 5]);
    const { blockKey: _keys, ...bare } = plant('steam');
    h.scene.load(bare, G, true, 0);
    expect(h.channels.values('blockPosition')).toBeNull();
  });

  it('keeps a moved block where it was placed across an edit, and places new blocks', () => {
    const h = loaded(twoArea());
    h.scene.drag(Uint32Array.of(1), 0, 0);
    h.scene.drag(Uint32Array.of(1), 4 * G, 15 * G);
    const moved = h.scene.commitDrag()!;
    const auto = h.scene.positions.slice();
    // An edit adds a reader: every key survives, and TGOV1 stays where the drag put it.
    h.scene.load(withReader(twoArea(), 2, 'Ieeest/1_1_ieeest'), G, true, 1);
    expect(Array.from(h.scene.positions.subarray(2, 4))).toEqual(Array.from(moved.positions));
    expect(Array.from(h.scene.positions.subarray(0, 2))).toEqual(Array.from(auto.subarray(0, 2)));
    const placement = h.channels.values('blockPosition')!;
    expect(Array.from(placement.subarray(2, 4))).toEqual(Array.from(moved.positions));
    for (const i of [0, 1, 4, 5, 6, 7]) expect(Number.isNaN(placement[i])).toBe(true);
    expect(Number.isFinite(h.scene.positions[6]!)).toBe(true);
    expect(reaches(h.scene, 0, 4)).toBe(true);

    // Placements follow keys, not indices.
    const order = [1, 2, 0];
    h.scene.load(reordered(order), G, true, 2);
    expect(Array.from(h.scene.positions.subarray(0, 2))).toEqual(Array.from(moved.positions));
    const again = h.channels.values('blockPosition')!;
    expect(Array.from(again.subarray(0, 2))).toEqual(Array.from(moved.positions));
    expect(Number.isNaN(again[2]) && Number.isNaN(again[4])).toBe(true);
  });

  it('carries no placement channel when none was bound', () => {
    const h = loaded(twoArea());
    h.scene.load(withReader(twoArea(), 2, 'Ieeest/1_1_ieeest'), G, true, 1);
    expect(h.channels.values('blockPosition')).toBeNull();
  });

  it('keeps the automatic positions of surviving keys and places new blocks clear of the rest', () => {
    const h = loaded(system(2));
    const before = h.scene.positions.slice();
    const survivors = h.scene.load(system(3), G, true, 1);
    const p = h.scene.prepared!;
    expect(Array.from(survivors)).toEqual([0, 1, 2, 3, 4, 5, 6, NONE, NONE, NONE]);
    expect(Array.from(h.scene.positions.subarray(0, 14))).toEqual(Array.from(before));
    expect(firstOverlap(p, h.scene.positions)).toBeNull();
    for (const v of h.scene.positions) expect(Number.isFinite(v)).toBe(true);
  });

  it('keeps the frame of a plant a reload adds a unit gap from every other frame', () => {
    const h = loaded(system(12));
    h.scene.load(system(13), G, true, 1);
    const p = h.scene.prepared!;
    expect(p.groupCount).toBe(13);
    const frames = new Float64Array(4 * p.groupCount);
    for (let group = 0; group < p.groupCount; group++) frames.set(frame(h.scene, group), 4 * group);
    expect(closePair(frames, UNIT_GAP * G)).toBeNull();
  });

  it('places a new reader beside its driver without overlap', () => {
    const h = loaded(twoArea());
    const before = h.scene.positions.slice();
    const survivors = h.scene.load(withReader(twoArea(), 2, 'Ieeest/1_1_ieeest'), G, true, 1);
    const p = h.scene.prepared!;
    expect(Array.from(survivors)).toEqual([0, 1, 2, NONE]);
    expect(Array.from(h.scene.positions.subarray(0, 6))).toEqual(Array.from(before));
    // GENROU drives speed; the new block lands right of it.
    expect(h.scene.positions[6]!).toBeGreaterThan(before[0]! + p.size[0]!);
    expect(firstOverlap(p, h.scene.positions)).toBeNull();
    expect(reaches(h.scene, 2, 7)).toBe(true);
  });

  it('follows keys, not indices, when blocks change order', () => {
    const h = loaded(twoArea());
    const before = h.scene.positions.slice();
    const order = [1, 2, 0];
    const survivors = h.scene.load(reordered(order), G, true, 1);
    expect(Array.from(survivors)).toEqual(order);
    order.forEach((was, b) => {
      expect(h.scene.positions[2 * b]).toBe(before[2 * was]);
      expect(h.scene.positions[2 * b + 1]).toBe(before[2 * was + 1]);
    });
    expect(ghosts(h.scene)).toEqual([]);
  });

  it('starts over without keys, leaving no ghosts', () => {
    const { blockKey: _keys, ...bare } = twoArea();
    const h = loaded(bare);
    const next = { ...bare, blockTitle: ['GENROU', 'TGOV1', 'EXCITER'] };
    const survivors = h.scene.load(next, G, true, 1);
    expect(Array.from(survivors)).toEqual([NONE, NONE, NONE]);
    expect(Array.from(h.scene.positions)).toEqual(Array.from(arrangeAll(prepare(next, G))));
    expect(ghosts(h.scene)).toEqual([]);
  });

  it('leaves ghosts of removed blocks that fade out over animationMs', () => {
    const h = loaded(system(3));
    const p = h.scene.prepared!;
    const removed = [7, 8, 9].map((b) => [
      h.scene.positions[2 * b]!,
      h.scene.positions[2 * b + 1]!,
      h.scene.positions[2 * b]! + p.size[2 * b]!,
      h.scene.positions[2 * b + 1]! + p.size[2 * b + 1]!,
      1,
    ]);
    h.scene.load(system(2), G, true, 1000);
    expect(ghosts(h.scene)).toEqual(removed);
    expect(h.scene.animating).toBe(true);
    expect(h.scene.tick(1150)).toBe(true);
    for (const ghost of ghosts(h.scene)) expect(ghost[4]).toBeCloseTo(0.5, 5);
    expect(h.scene.tick(1300)).toBe(false);
    expect(ghosts(h.scene)).toEqual([]);
    expect(h.scene.animating).toBe(false);
  });

  it('leaves no ghosts under reduced motion or with no animation time', () => {
    const h = loaded(system(3));
    h.scene.load(system(2), G, false, 0);
    expect(h.scene.motion).toBe(false);
    expect(ghosts(h.scene)).toEqual([]);
    h.scene.load(system(3), G, true, 0);
    h.scene.animationMs = 0;
    h.scene.load(system(2), G, true, 0);
    expect(ghosts(h.scene)).toEqual([]);
  });

  it('leaves the pick index of wires and group frames for the first pick', () => {
    const h = harness();
    const slot = vi.spyOn(h.scene, 'slot');
    h.scene.load(system(4), G, true, 0);
    expect(slot).not.toHaveBeenCalled();
    const p = h.scene.prepared!;
    const net = drawnNets(p)[0]!;
    const s = entries(h.scene, net).find((e) => e.kind === WIRE_SEGMENT)!;
    const ids = h.scene.picker.pick((s.ax + s.bx) / 2, (s.ay + s.by) / 2, 1);
    expect(ids).toContain(partId(PART_NET, net));
    expect(slot).toHaveBeenCalled();
    const [x0, y0] = frame(h.scene, 0);
    expect(h.scene.picker.pick(x0! + 1, y0! + 1, 0)).toEqual([partId(3, 0)]);
  });

  it('loads the 36k-block scale netlist', () => {
    const netlist = scale();
    const h = harness();
    const start = performance.now();
    h.scene.load(netlist, G, true, 0);
    const ms = performance.now() - start;
    console.log(`Scene.load of ${netlist.blockCount} blocks: ${ms.toFixed(0)} ms`);
    expect(h.scene.positions.every(Number.isFinite)).toBe(true);
    expect(h.scene.routes.capacity).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5000);
  });
});

describe('Scene.clear', () => {
  it('forgets the netlist and everything derived from it, and gives memory back', () => {
    const h = loaded(system(12));
    // Ghosts of the removed plant, a nudge hold, a tween, a drag, and a detached port in flight.
    h.scene.load(system(11), G, true, 0);
    const p = h.scene.prepared!;
    const [cx, cy] = center(h.scene, 0);
    expect(h.scene.picker.pick(cx, cy, 0)).toContain(block(0));
    h.scene.liveRoutePorts = 1;
    h.scene.nudge(Uint32Array.of(2), G, 0);
    h.scene.arrange(null, true, 0);
    h.scene.drag(Uint32Array.of(1), 0, 0);
    h.scene.drag(Uint32Array.of(1), G, G);
    h.scene.detach(p.netlist.netPorts[1]!);
    expect(h.scene.animating).toBe(true);
    const versions = [h.mirrors.structure, h.mirrors.layout, h.mirrors.wires].map((m) => m.version);

    h.scene.clear();
    expect(h.scene.prepared).toBeNull();
    expect(h.scene.animating).toBe(false);
    expect(h.scene.positions).toHaveLength(0);
    expect(h.scene.bounds()).toBeNull();
    expect(h.scene.boundsOf([{ kind: 'block', index: 0 }])).toBeNull();
    expect(h.scene.routes.capacity).toBe(0);
    expect(h.scene.routes.slotCount(0)).toBe(0);
    expect(ghosts(h.scene)).toEqual([]);
    expect(h.scene.picker.pick(cx, cy, 10)).toEqual([]);
    expect(Array.from(h.scene.picker.marquee(-1e6, -1e6, 1e6, 1e6))).toEqual([]);
    expect(h.scene.commitDrag()).toBeNull();
    expect(h.scene.arrange(null, false, 0)).toEqual(new Float32Array(0));
    expect(h.scene.nudge(Uint32Array.of(0), G, 0).blocks).toHaveLength(0);
    expect(h.scene.tick(1000)).toBe(false);
    [h.mirrors.structure, h.mirrors.layout, h.mirrors.wires].forEach((mirror, i) => {
      expect(mirror.words).toBe(0);
      expect(mirror.capacity).toBeLessThanOrEqual(4);
      expect(mirror.version).toBeGreaterThan(versions[i]!);
    });
    const drained: number[] = [];
    h.scene.drain(
      (b) => drained.push(b),
      (n) => drained.push(n),
    );
    expect(drained).toEqual([]);

    // A cleared scene loads as a fresh one: nothing survives, everything is arranged.
    h.scene.clear();
    const survivors = h.scene.load(twoArea(), G, true, 0);
    expect(Array.from(survivors)).toEqual([NONE, NONE, NONE]);
    expect(Array.from(h.scene.positions)).toEqual(Array.from(arrangeAll(prepare(twoArea(), G))));
    expect(ghosts(h.scene)).toEqual([]);
    expect(reaches(h.scene, 2, 5)).toBe(true);
    expect(h.scene.picker.pick(...center(h.scene, 1), 0)).toContain(block(1));
  });
});

describe('Scene placement', () => {
  it('shows finite placements and hands NaN pairs back to the automatic position', () => {
    const h = loaded(twoArea());
    const auto = h.scene.positions.slice();
    const settled = h.scene.settled;
    const placement = new Float32Array(6).fill(Number.NaN);
    placement[2] = 800;
    placement[3] = 400;
    h.channels.set('blockPosition', placement);
    h.scene.placementChanged();
    expect(Array.from(h.scene.positions)).toEqual([auto[0], auto[1], 800, 400, auto[4], auto[5]]);
    expect(h.scene.settled).toBeGreaterThan(settled);
    // TGOV1's pmech wire follows it; the picker finds it where it is drawn.
    expect(reaches(h.scene, 0, 4)).toBe(true);
    expect(h.scene.picker.pick(...center(h.scene, 1), 0)).toContain(block(1));
    const oldCenter = [auto[2]! + 8, auto[3]! + 8] as const;
    expect(h.scene.picker.pick(...oldCenter, 0)).not.toContain(block(1));

    // A pair with one NaN is no placement.
    placement[2] = Number.NaN;
    placement[3] = 5;
    h.channels.set('blockPosition', placement);
    h.scene.placementChanged();
    expect(Array.from(h.scene.positions)).toEqual(Array.from(auto));
    expect(h.scene.picker.pick(...center(h.scene, 1), 0)).toContain(block(1));

    placement[2] = 16;
    placement[3] = 640;
    h.channels.set('blockPosition', placement);
    h.scene.placementChanged();
    h.channels.clear('blockPosition');
    h.scene.placementChanged();
    expect(Array.from(h.scene.positions)).toEqual(Array.from(auto));
  });

  it('moves group frames with their members', () => {
    const h = loaded(plant('steam'));
    const before = frame(h.scene, 0);
    const placement = new Float32Array(6).fill(Number.NaN);
    placement[0] = 2000;
    placement[1] = 1000;
    h.channels.set('blockPosition', placement);
    h.scene.placementChanged();
    const after = frame(h.scene, 0);
    expect(after[2]).toBeGreaterThan(2000 + h.scene.prepared!.size[0]!);
    expect(after[3]).toBeGreaterThan(1000);
    expect(after[0]).toBe(before[0]);
    // The picker finds the group inside its grown frame.
    expect(h.scene.picker.pick(1500, 500, 0)).toContain(partId(3, 0));
  });
});

describe('Scene drags', () => {
  it('is safe to end a drag that never started', () => {
    const h = loaded(twoArea());
    const before = h.scene.positions.slice();
    h.scene.drag(null, 0, 0);
    expect(h.scene.commitDrag()).toBeNull();
    expect(Array.from(h.scene.positions)).toEqual(Array.from(before));
  });

  it('moves dragged blocks live and commits them as placements, snapped', () => {
    const h = loaded(twoArea());
    const auto = h.scene.positions.slice();
    const blocks = Uint32Array.of(1);
    h.scene.drag(blocks, 0, 0);
    expect(Array.from(h.scene.positions)).toEqual(Array.from(auto));
    h.scene.drag(blocks, 3 * G, 5 * G);
    expect(h.scene.positions[2]).toBe(auto[2]! + 3 * G);
    expect(h.scene.positions[3]).toBe(auto[3]! + 5 * G);
    expect(reaches(h.scene, 0, 4)).toBe(true);
    expect(reaches(h.scene, 2, 3)).toBe(true);
    // Picks and the router's obstacle query see the dragged block where it is drawn.
    expect(h.scene.picker.pick(...center(h.scene, 1), 0)).toContain(block(1));
    const [cx, cy] = center(h.scene, 1);
    const found: number[] = [];
    h.scene.picker.obstacles(cx, cy - 1, cx, cy + 1, (b) => found.push(b));
    expect(found).toEqual([1]);

    const settled = h.scene.settled;
    const moved = h.scene.commitDrag()!;
    expect(Array.from(moved.blocks)).toEqual([1]);
    expect(Array.from(moved.positions)).toEqual([auto[2]! + 3 * G, auto[3]! + 5 * G]);
    for (const v of moved.positions) expect(v % G).toBe(0);
    const placement = h.channels.values('blockPosition')!;
    expect(Array.from(placement.subarray(2, 4))).toEqual(Array.from(moved.positions));
    expect(Number.isNaN(placement[0])).toBe(true);
    expect(Number.isNaN(placement[4])).toBe(true);
    // Still shown there, now as a placement; the drag is over.
    expect(Array.from(h.scene.positions.subarray(2, 4))).toEqual(Array.from(moved.positions));
    expect(h.scene.settled).toBeGreaterThan(settled);
    expect(h.scene.commitDrag()).toBeNull();
    expect(h.scene.picker.pick(...center(h.scene, 1), 0)).toContain(block(1));
  });

  it('returns cancelled blocks and their wires to where they were', () => {
    const h = loaded(twoArea());
    const auto = h.scene.positions.slice();
    const wires = routing(h.scene);
    const blocks = Uint32Array.of(1, 2);
    h.scene.drag(blocks, 0, 0);
    h.scene.drag(blocks, 2 * G, 2 * G);
    expect(routing(h.scene)).not.toBe(wires);
    h.scene.drag(null, 0, 0);
    expect(Array.from(h.scene.positions)).toEqual(Array.from(auto));
    expect(routing(h.scene)).toBe(wires);
    expect(h.channels.values('blockPosition')).toBeNull();
  });

  it('drags from a placement, and a new block set ends the old drag', () => {
    const h = loaded(twoArea());
    const auto = h.scene.positions.slice();
    h.scene.drag(Uint32Array.of(0), G, G);
    h.scene.drag(Uint32Array.of(2), 2 * G, 0);
    expect(h.scene.positions[0]).toBe(auto[0]);
    expect(h.scene.positions[4]).toBe(auto[4]! + 2 * G);
    const moved = h.scene.commitDrag()!;
    expect(Array.from(moved.blocks)).toEqual([2]);
    h.scene.drag(Uint32Array.of(2), G, G);
    expect(h.scene.positions[4]).toBe(auto[4]! + 3 * G);
  });

  it('nudges blocks as placements', () => {
    const h = loaded(twoArea());
    const auto = h.scene.positions.slice();
    const moved = h.scene.nudge(Uint32Array.of(0, 0, 7), G, -G);
    expect(Array.from(moved.blocks)).toEqual([0]);
    expect(Array.from(moved.positions)).toEqual([auto[0]! + G, auto[1]! - G]);
    expect(Array.from(h.scene.positions.subarray(0, 2))).toEqual(Array.from(moved.positions));
    expect(Array.from(h.channels.values('blockPosition')!.subarray(0, 2))).toEqual(
      Array.from(moved.positions),
    );
    const again = h.scene.nudge(Uint32Array.of(0), G, 0);
    expect(Array.from(again.positions)).toEqual([auto[0]! + 2 * G, auto[1]! - G]);
    expect(reaches(h.scene, 0, 0)).toBe(true);
  });

  it('keeps a drag of many blocks in the pick index, routing around it live', () => {
    const h = loaded(system(40));
    const p = h.scene.prepared!;
    expect(p.blockCount).toBeGreaterThan(64);
    // Every block but one: the router must see the dragged ones where they are drawn.
    const dragged = Uint32Array.from({ length: p.blockCount - 1 }, (_, b) => b + 1);
    h.scene.drag(dragged, 0, 0);
    h.scene.drag(dragged, 40 * G, 12 * G);
    for (let b = 0; b < p.blockCount; b++) {
      expect(h.scene.picker.pick(...center(h.scene, b), 0)).toContain(block(b));
    }
    const [cx, cy] = center(h.scene, 5);
    const found: number[] = [];
    h.scene.picker.obstacles(cx, cy - 1, cx, cy + 1, (b) => found.push(b));
    expect(found).toContain(5);
    for (const net of drawnNets(p)) {
      const { netStart, netPorts } = p.netlist;
      for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
        expect(reaches(h.scene, net, netPorts[at]!)).toBe(true);
      }
    }
    h.scene.drag(null, 0, 0);
    for (let b = 0; b < p.blockCount; b++) {
      expect(h.scene.picker.pick(...center(h.scene, b), 0)).toContain(block(b));
    }
  });

  it('hides the nets of a drag over its port budget and routes them at the end', () => {
    const h = loaded(system(40));
    const p = h.scene.prepared!;
    const nets = drawnNets(p);
    h.scene.liveRoutePorts = portsOf(p, nets) - 1;
    const all = Uint32Array.from({ length: p.blockCount }, (_, b) => b);
    h.scene.drag(all, 0, 0);
    expect(nets.every((net) => h.scene.routes.slotCount(net) > 0)).toBe(true);
    h.scene.drag(all, G, 0);
    expect(nets.every((net) => h.scene.routes.slotCount(net) === 0)).toBe(true);
    h.scene.drag(all, 2 * G, G);
    expect(nets.every((net) => h.scene.routes.slotCount(net) === 0)).toBe(true);
    for (let b = 0; b < p.blockCount; b += 11) {
      expect(h.scene.picker.pick(...center(h.scene, b), 0)).toContain(block(b));
    }
    h.scene.commitDrag();
    expect(nets.every((net) => h.scene.routes.slotCount(net) > 0)).toBe(true);
    const { netStart, netPorts } = p.netlist;
    for (const net of nets) {
      expect(reaches(h.scene, net, netPorts[netStart[net]!]!)).toBe(true);
    }

    // At the budget, the same drag routes live.
    h.scene.liveRoutePorts = portsOf(p, nets);
    h.scene.drag(all, 0, 0);
    h.scene.drag(all, G, 0);
    expect(nets.every((net) => h.scene.routes.slotCount(net) > 0)).toBe(true);
    h.scene.drag(null, 0, 0);
  });

  it('budgets ports, not nets: three nets, one of them wide, hide while a block on them moves', () => {
    const h = loaded(broadcast(30));
    const p = h.scene.prepared!;
    const wide = 0;
    // Block 5 reads the wide net and nets 4 and 5 of two ports each: three nets, 35 ports.
    const touched = [wide, 4, 5];
    expect(portsOf(p, touched)).toBe(35);
    const reader = Uint32Array.of(5);
    h.scene.liveRoutePorts = 34;
    h.scene.drag(reader, 0, 0);
    h.scene.drag(reader, 2 * G, G);
    for (const net of touched) expect(h.scene.routes.slotCount(net)).toBe(0);
    expect(h.scene.routes.slotCount(6)).toBeGreaterThan(0);
    h.scene.commitDrag();
    expect(h.scene.routes.slotCount(wide)).toBeGreaterThan(0);
    for (let port = 0; port < p.portCount; port++) {
      if (p.portNet[port] === wide) expect(reaches(h.scene, wide, port)).toBe(true);
    }
    h.scene.liveRoutePorts = 35;
    h.scene.drag(reader, 0, 0);
    h.scene.drag(reader, 0, 2 * G);
    expect(h.scene.routes.slotCount(wide)).toBeGreaterThan(0);
    expect(reaches(h.scene, wide, p.netlist.portStart[5]!)).toBe(true);
    h.scene.drag(null, 0, 0);
  });

  it('hides a net wider than liveNetPorts alone while the small nets on the block route live', () => {
    const h = loaded(broadcast(30));
    const p = h.scene.prepared!;
    const wide = 0;
    const reader = Uint32Array.of(5);
    h.scene.liveNetPorts = 30;
    h.scene.drag(reader, 0, 0);
    expect(h.scene.routes.slotCount(wide)).toBeGreaterThan(0);
    h.scene.drag(reader, 2 * G, G);
    expect(h.scene.routes.slotCount(wide)).toBe(0);
    // Nets 4 and 5 follow the block: its aux input and its output.
    expect(reaches(h.scene, 4, p.netlist.portStart[5]! + 1)).toBe(true);
    expect(reaches(h.scene, 5, p.netlist.portStart[5]! + 2)).toBe(true);
    h.scene.commitDrag();
    for (let port = 0; port < p.portCount; port++) {
      if (p.portNet[port] === wide) expect(reaches(h.scene, wide, port)).toBe(true);
    }
    h.scene.liveNetPorts = 31;
    h.scene.drag(reader, 0, 0);
    h.scene.drag(reader, 0, 2 * G);
    expect(reaches(h.scene, wide, p.netlist.portStart[5]!)).toBe(true);
    h.scene.drag(null, 0, 0);
  });

  it('holds a wide net hidden through a burst of nudges and routes it once they stop', () => {
    const h = loaded(broadcast(30));
    const p = h.scene.prepared!;
    const wide = 0;
    h.scene.liveRoutePorts = 30;
    h.scene.nudge(Uint32Array.of(5), G, 0);
    expect(h.scene.routes.slotCount(wide)).toBe(0);
    expect(h.scene.animating).toBe(true);
    // The first tick starts the quiet time; a nudge within it carries the burst on.
    expect(h.scene.tick(1000)).toBe(true);
    expect(h.scene.tick(1000 + NUDGE_SETTLE_MS - 1)).toBe(true);
    h.scene.nudge(Uint32Array.of(5), G, 0);
    expect(h.scene.tick(1000 + NUDGE_SETTLE_MS + 10)).toBe(true);
    expect(h.scene.routes.slotCount(wide)).toBe(0);
    expect(h.scene.tick(1000 + 2 * NUDGE_SETTLE_MS)).toBe(true);
    expect(h.scene.routes.slotCount(wide)).toBe(0);
    expect(h.scene.tick(1000 + 2 * NUDGE_SETTLE_MS + 10)).toBe(false);
    expect(h.scene.routes.slotCount(wide)).toBeGreaterThan(0);
    for (let port = 0; port < p.portCount; port++) {
      if (p.portNet[port] === wide) expect(reaches(h.scene, wide, port)).toBe(true);
    }
    // Within the budget a nudge routes at once and holds nothing.
    h.scene.liveRoutePorts = 35;
    h.scene.nudge(Uint32Array.of(5), G, 0);
    expect(h.scene.routes.slotCount(wide)).toBeGreaterThan(0);
    expect(h.scene.animating).toBe(false);
    expect(reaches(h.scene, wide, p.netlist.portStart[5]!)).toBe(true);
  });
});

describe('Scene.arrange', () => {
  it('eases blocks to the new arrangement with cubic in-out and lands it', () => {
    const h = loaded(twoArea());
    h.scene.load(withReader(twoArea(), 2, 'Ieeest/1_1_ieeest'), G, true, 0);
    const p = h.scene.prepared!;
    const from = h.scene.positions.slice();
    const settled = h.scene.settled;
    const auto = h.scene.arrange(null, true, 1000);
    expect(Array.from(auto)).toEqual(Array.from(arrangeAll(p)));
    const moving = Array.from({ length: 2 * p.blockCount }, (_, i) => i).filter(
      (i) => from[i] !== auto[i],
    );
    expect(moving.length).toBeGreaterThan(0);
    expect(h.scene.animating).toBe(true);

    expect(h.scene.tick(1000)).toBe(true);
    expect(Array.from(h.scene.positions)).toEqual(Array.from(from));
    // A quarter of the way in time is 4 * 0.25^3 = 1/16 of the way in space.
    expect(h.scene.tick(1075)).toBe(true);
    for (const i of moving) {
      expect(h.scene.positions[i]).toBeCloseTo(from[i]! + (auto[i]! - from[i]!) / 16, 3);
    }
    expect(h.scene.settled).toBe(settled);
    expect(h.scene.tick(1300)).toBe(false);
    expect(Array.from(h.scene.positions)).toEqual(Array.from(auto));
    expect(h.scene.settled).toBeGreaterThan(settled);
    expect(firstOverlap(p, h.scene.positions)).toBeNull();
    expect(reaches(h.scene, 2, 7)).toBe(true);
    for (let b = 0; b < p.blockCount; b++) {
      expect(h.scene.picker.pick(...center(h.scene, b), 0)).toContain(block(b));
    }
  });

  it('moves at once under reduced motion, and leaves placements alone', () => {
    const h = loaded(twoArea());
    h.scene.load(withReader(twoArea(), 2, 'Ieeest/1_1_ieeest'), G, true, 0);
    const placement = new Float32Array(8).fill(Number.NaN);
    placement[0] = -400;
    placement[1] = -400;
    h.channels.set('blockPosition', placement);
    h.scene.placementChanged();
    h.scene.motion = false;
    const auto = h.scene.arrange(null, true, 0);
    expect(h.scene.animating).toBe(false);
    expect(Array.from(h.scene.positions.subarray(0, 2))).toEqual([-400, -400]);
    expect(Array.from(h.scene.positions.subarray(2))).toEqual(Array.from(auto.subarray(2)));
    expect(Array.from(h.channels.values('blockPosition')!)).toEqual(Array.from(placement));
    // Writing NaN hands the block to the fresh layout.
    h.channels.set('blockPosition', new Float32Array(8).fill(Number.NaN));
    h.scene.placementChanged();
    expect(Array.from(h.scene.positions)).toEqual(Array.from(auto));
  });

  it('re-lays out only the touched units, each anchored at its automatic top-left', () => {
    const base = tile(twoArea(), 2);
    const h = loaded(base);
    h.scene.load(withReader(base, 2, 'Ieeest/new'), G, true, 0);
    const p = h.scene.prepared!;
    const all = units(p);
    const unitOf = (b: number): number[] =>
      Array.from(all.blocks.subarray(all.start[all.unitOf[b]!]!, all.start[all.unitOf[b]! + 1]!));
    const first = unitOf(0);
    const second = unitOf(3);
    expect(first).toEqual([0, 1, 2, 6]);
    const anchor = anchorOf(h.scene, first);
    const other = second.map((b) => [h.scene.positions[2 * b], h.scene.positions[2 * b + 1]]);
    const auto = h.scene.arrange(Uint32Array.of(6), false, 0);
    expect(anchorOf(h.scene, first)).toEqual(anchor);
    expect(second.map((b) => [h.scene.positions[2 * b], h.scene.positions[2 * b + 1]])).toEqual(
      other,
    );
    expect(Array.from(auto)).toEqual(Array.from(h.scene.positions));
    // The re-laid unit has the shape a fresh layout of it alone has.
    // The same net labels as the tiled unit (`#0` suffixes): label widths shape the layout.
    const alone = arrangeAll(prepare(withReader(tile(twoArea(), 1), 2, 'Ieeest/new'), G));
    first.forEach((b, i) => {
      expect(h.scene.positions[2 * b]! - h.scene.positions[0]!).toBe(alone[2 * i]! - alone[0]!);
      expect(h.scene.positions[2 * b + 1]! - h.scene.positions[1]!).toBe(
        alone[2 * i + 1]! - alone[1]!,
      );
    });
  });

  it('hides nets during a tween over its port budget and routes them once it lands', () => {
    const h = loaded(system(40));
    // The same plants at a coarser grid keep their old spots until arranged.
    h.scene.load(system(40), 10, true, 0);
    const p = h.scene.prepared!;
    const nets = drawnNets(p);
    h.scene.liveRoutePorts = 20;
    h.scene.arrange(null, true, 0);
    const hidden = nets.filter((net) => h.scene.routes.slotCount(net) === 0).length;
    expect(hidden).toBeGreaterThan(nets.length / 2);
    expect(h.scene.tick(150)).toBe(true);
    expect(nets.filter((net) => h.scene.routes.slotCount(net) === 0).length).toBe(hidden);
    expect(h.scene.tick(300)).toBe(false);
    expect(nets.every((net) => h.scene.routes.slotCount(net) > 0)).toBe(true);
    for (let b = 0; b < p.blockCount; b += 7) {
      expect(h.scene.picker.pick(...center(h.scene, b), 0)).toContain(block(b));
    }

    // Within the budget, a tween routes every frame.
    h.scene.load(system(40), G, true, 0);
    h.scene.liveRoutePorts = portsOf(p, nets);
    h.scene.arrange(null, true, 0);
    h.scene.tick(150);
    expect(drawnNets(h.scene.prepared!).every((net) => h.scene.routes.slotCount(net) > 0)).toBe(
      true,
    );
    h.scene.tick(300);
  });

  it('hides only a wide net during a tween, routing and indexing the rest every frame', () => {
    const h = loaded(broadcast(30));
    // The same blocks at a coarser grid keep their old spots until arranged.
    h.scene.load(broadcast(30), 10, true, 0);
    const p = h.scene.prepared!;
    const wide = 0;
    h.scene.liveNetPorts = 30;
    h.scene.arrange(null, true, 0);
    expect(h.scene.routes.slotCount(wide)).toBe(0);
    expect(h.scene.tick(150)).toBe(true);
    expect(h.scene.routes.slotCount(wide)).toBe(0);
    // Mid-way, the chain nets reach their ports where they are drawn, and picks find blocks there.
    for (let net = 1; net < p.netCount; net++) {
      const { netStart, netPorts } = p.netlist;
      for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
        expect(reaches(h.scene, net, netPorts[at]!)).toBe(true);
      }
    }
    for (let b = 0; b < p.blockCount; b += 5) {
      expect(h.scene.picker.pick(...center(h.scene, b), 0)).toContain(block(b));
    }
    expect(h.scene.tick(300)).toBe(false);
    for (let port = 0; port < p.portCount; port++) {
      if (p.portNet[port] === wide) expect(reaches(h.scene, wide, port)).toBe(true);
    }
  });

  it('returns an empty array before a load', () => {
    expect(harness().scene.arrange(null, false, 0)).toEqual(new Float32Array(0));
  });
});

describe('Scene visibility', () => {
  it('routes around hidden blocks and nets and restores them', () => {
    const h = loaded(twoArea());
    const wires = routing(h.scene);
    h.channels.set('blockVisible', Float32Array.of(0, 1, 1));
    h.scene.visibilityChanged();
    expect(entries(h.scene, 0)).toEqual([]);
    expect(reaches(h.scene, 2, 3)).toBe(true);
    expect(reaches(h.scene, 2, 5)).toBe(true);
    expect(reaches(h.scene, 2, 2)).toBe(false);
    expect(h.scene.picker.pick(...center(h.scene, 0), 0)).not.toContain(block(0));

    h.channels.set('netVisible', Float32Array.of(1, 0, 1));
    h.scene.visibilityChanged();
    expect(entries(h.scene, 1)).toEqual([]);

    h.channels.clear('blockVisible');
    h.channels.clear('netVisible');
    h.scene.visibilityChanged();
    expect(routing(h.scene)).toBe(wires);
  });

  it('frames only shown members, and no group when none shows', () => {
    const h = loaded(plant('steam'));
    const whole = frame(h.scene, 0);
    h.channels.set('blockVisible', Float32Array.of(1, 0, 1));
    h.scene.visibilityChanged();
    expect(frame(h.scene, 0)).not.toEqual(whole);
    h.channels.set('blockVisible', Float32Array.of(0, 0, 0));
    h.scene.visibilityChanged();
    expect(frame(h.scene, 0).every(Number.isNaN)).toBe(true);
    expect(h.scene.picker.pick(whole[0]! + 4, whole[1]! + 4, 0)).toEqual([]);
    h.channels.clear('blockVisible');
    h.scene.visibilityChanged();
    expect(frame(h.scene, 0)).toEqual(whole);
  });
});

describe('Scene groups', () => {
  it('frames a group around its members and the wires and labels inside it, header on top', () => {
    for (const kind of ['steam', 'steamPss', 'renewable'] as const) {
      const h = loaded(plant(kind));
      const p = h.scene.prepared!;
      const { groupPad, groupHeader } = p.metrics;
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      const add = (x: number, y: number): void => {
        box[0] = Math.min(box[0]!, x);
        box[1] = Math.min(box[1]!, y);
        box[2] = Math.max(box[2]!, x);
        box[3] = Math.max(box[3]!, y);
      };
      let memberBottom = -Infinity;
      for (let b = 0; b < p.blockCount; b++) {
        const [x0, y0, x1, y1] = extentRect(h.scene, b);
        add(x0, y0);
        add(x1, y1);
        memberBottom = Math.max(memberBottom, y1);
      }
      let wireBottom = -Infinity;
      for (let net = 0; net < p.netCount; net++) {
        for (const e of entries(h.scene, net)) {
          const points = e.kind === WIRE_SEGMENT ? [e.ax, e.ay, e.bx, e.by] : [e.ax, e.ay];
          for (let i = 0; i < points.length; i += 2) {
            add(points[i]!, points[i + 1]!);
            wireBottom = Math.max(wireBottom, points[i + 1]!);
          }
        }
        const label = labelRect(h.scene, net);
        if (label) {
          add(label[0], label[1]);
          add(label[2], label[3]);
        }
      }
      // The feedback lanes run under the members; the frame holds them.
      expect(wireBottom).toBeGreaterThan(memberBottom);
      const want = [
        box[0]! - groupPad,
        box[1]! - groupPad - groupHeader,
        box[2]! + groupPad,
        box[3]! + groupPad,
      ];
      // Frames are float32; label widths need not be.
      frame(h.scene, 0).forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 3));
    }
  });

  it('encloses the labels of its internal nets, however long, while they show', () => {
    const h = loaded(plant('steam', 'a_plant_named_at_quite_some_length_for_its_labels'));
    const p = h.scene.prepared!;
    const labelled = drawnNets(p).filter((net) => labelRect(h.scene, net) !== null);
    expect(labelled.length).toBe(3);
    const whole = frame(h.scene, 0);
    for (const net of labelled) expect(contains(whole, labelRect(h.scene, net)!)).toBe(true);
    // GENROU's speed label runs right past everything else in the plant.
    const speed = labelled.find((net) => p.netDriver[net] === 3)!;
    let right = -Infinity;
    for (let b = 0; b < p.blockCount; b++) right = Math.max(right, extentRect(h.scene, b)[2]);
    for (const e of entries(h.scene, speed)) right = Math.max(right, e.ax, e.bx);
    expect(labelRect(h.scene, speed)![2]).toBeGreaterThan(right);
    expect(whole[2]).toBeCloseTo(labelRect(h.scene, speed)![2] + p.metrics.groupPad, 3);

    // A hidden net draws no label, and its frame lets go of it.
    const visible = new Float32Array(p.netCount).fill(1);
    visible[speed] = 0;
    h.channels.set('netVisible', visible);
    h.scene.visibilityChanged();
    expect(frame(h.scene, 0)[2]).toBeLessThan(whole[2]!);
    h.channels.clear('netVisible');
    h.scene.visibilityChanged();
    expect(frame(h.scene, 0)).toEqual(whole);
  });

  it('follows its internal wires when they re-route', () => {
    const h = loaded(plant('steam'));
    const whole = frame(h.scene, 0);
    // Hiding the speed net takes its lane out of the frame.
    h.channels.set('netVisible', Float32Array.of(1, 1, 0, 1));
    h.scene.visibilityChanged();
    expect(frame(h.scene, 0)[3]).toBeLessThan(whole[3]!);
    h.channels.clear('netVisible');
    h.scene.visibilityChanged();
    expect(frame(h.scene, 0)).toEqual(whole);
  });
});

describe('Scene.detach', () => {
  it('routes a picked-up wire as if its port were off the net, then restores it', () => {
    const h = loaded(twoArea());
    const wires = routing(h.scene);
    h.scene.drain(
      () => {},
      () => {},
    );
    h.scene.detach(5);
    expect(reaches(h.scene, 2, 5)).toBe(false);
    expect(arrowAt(h.scene, 2, 5)).toBe(false);
    expect(reaches(h.scene, 2, 2)).toBe(true);
    expect(reaches(h.scene, 2, 3)).toBe(true);
    expect(arrowAt(h.scene, 2, 3)).toBe(true);
    const nets: number[] = [];
    h.scene.drain(
      () => {},
      (net) => nets.push(net),
    );
    expect(nets).toEqual([2]);
    // Moves keep the port detached until it is restored.
    h.scene.drag(Uint32Array.of(2), G, 0);
    expect(reaches(h.scene, 2, 5)).toBe(false);
    h.scene.drag(null, 0, 0);
    h.scene.detach(null);
    expect(routing(h.scene)).toBe(wires);
    h.scene.detach(0);
    expect(entries(h.scene, 0)).toEqual([]);
    h.scene.detach(99);
    expect(routing(h.scene)).toBe(wires);
  });
});

describe('Scene routing and grid', () => {
  it('re-routes everything straight and back', () => {
    const h = loaded(twoArea());
    const wires = routing(h.scene);
    h.scene.setRouting('straight');
    const speed = entries(h.scene, 2).filter((e) => e.kind === WIRE_SEGMENT);
    expect(speed).toHaveLength(2);
    const root = portAt(h.scene, 2);
    for (const s of speed) expect([s.ax, s.ay]).toEqual([...root]);
    h.scene.setRouting('orthogonal');
    expect(routing(h.scene)).toBe(wires);
  });

  it('routes every plant of one shape alike, as the layout measured it', () => {
    // Plants 4 to 7 repeat plants 0 to 3 eleven blocks on, every block index of another parity.
    const h = loaded(system(8));
    const p = h.scene.prepared!;
    const u = units(p);
    const drawn = (unit: number): string => {
      const blocks = Array.from(u.blocks.subarray(u.start[unit]!, u.start[unit + 1]!));
      const [ox, oy] = [h.scene.positions[2 * blocks[0]!]!, h.scene.positions[2 * blocks[0]! + 1]!];
      const out: string[] = [];
      for (let net = 0; net < p.netCount; net++) {
        if (!blocks.includes(p.portBlock[p.netDriver[net]!] ?? NONE)) continue;
        for (const e of entries(h.scene, net)) {
          // Only a segment's `b` is a point: an arrow's is its direction, a junction's unused.
          const [bx, by] = e.kind === WIRE_SEGMENT ? [e.bx - ox, e.by - oy] : [e.bx, e.by];
          out.push(`${e.kind}:${e.ax - ox},${e.ay - oy},${bx},${by}`);
        }
      }
      return out.join('\n');
    };
    for (let unit = 0; unit < 4; unit++) expect(drawn(unit + 4)).toBe(drawn(unit));
    // Each plant's frame reaches down to its unit's rectangle's bottom, short only of the grid
    // step the layout rounds up to: the layout reserves nothing below that a plant does not draw.
    const lay = new Layouts(p);
    for (let unit = 0; unit < u.count; unit++) {
      const layout = lay.of(u.blocks, u.start[unit]!, u.start[unit + 1]!);
      const first = lay.order[0]!;
      const bottom = h.scene.positions[2 * first + 1]! - layout.positions[1]! + layout.height;
      const spare = bottom - frame(h.scene, unit)[3]!;
      expect(spare).toBeGreaterThanOrEqual(0);
      expect(spare).toBeLessThan(G);
    }
  });

  it('re-prepares and re-arranges at a new grid, keeping placements', () => {
    const h = loaded(twoArea());
    const placement = new Float32Array(6).fill(Number.NaN);
    placement[4] = 1000;
    placement[5] = 1000;
    h.channels.set('blockPosition', placement);
    h.scene.placementChanged();
    const settled = h.scene.settled;
    h.scene.setGrid(10);
    const p = h.scene.prepared!;
    expect(p.metrics.grid).toBe(10);
    const auto = arrangeAll(prepare(twoArea(), 10));
    expect(Array.from(h.scene.positions.subarray(0, 4))).toEqual(Array.from(auto.subarray(0, 4)));
    expect(Array.from(h.scene.positions.subarray(4))).toEqual([1000, 1000]);
    expect(h.mirrors.structure.f32[0]).toBe(p.size[0]);
    expect(h.scene.settled).toBeGreaterThan(settled);
    expect(reaches(h.scene, 1, 6)).toBe(true);
  });
});

describe('Scene bounds', () => {
  it('holds every shown block with extents, group frames, and wires', () => {
    const h = loaded(system(4));
    const p = h.scene.prepared!;
    const bounds = h.scene.bounds()!;
    const inside = (x: number, y: number): boolean =>
      x >= bounds[0] && y >= bounds[1] && x <= bounds[2] && y <= bounds[3];
    for (let b = 0; b < p.blockCount; b++) {
      const [x0, y0, x1, y1] = extentRect(h.scene, b);
      expect(inside(x0, y0) && inside(x1, y1)).toBe(true);
    }
    let frames = [Infinity, Infinity, -Infinity, -Infinity];
    for (let g = 0; g < p.groupCount; g++) {
      const [x0, y0, x1, y1] = frame(h.scene, g);
      frames = [
        Math.min(frames[0]!, x0!),
        Math.min(frames[1]!, y0!),
        Math.max(frames[2]!, x1!),
        Math.max(frames[3]!, y1!),
      ];
    }
    // Every block and wire here is inside a frame, so the frames are the bounds.
    expect([...bounds]).toEqual(frames);

    h.channels.set(
      'blockVisible',
      Float32Array.from({ length: p.blockCount }, (_, b) => (b < 3 ? 1 : 0)),
    );
    h.scene.visibilityChanged();
    expect([...h.scene.bounds()!]).toEqual(frame(h.scene, 0));
  });

  it('holds the labels of nets in no group, while they show', () => {
    // TwoArea has no groups; GENROU's speed label runs right of every block and wire.
    const h = loaded(twoArea());
    const p = h.scene.prepared!;
    const bounds = h.scene.bounds()!;
    for (let net = 0; net < p.netCount; net++) {
      const label = labelRect(h.scene, net);
      expect(label).not.toBeNull();
      expect(contains(bounds, label!)).toBe(true);
    }
    let right = -Infinity;
    for (let b = 0; b < p.blockCount; b++) right = Math.max(right, extentRect(h.scene, b)[2]);
    for (let net = 0; net < p.netCount; net++) {
      for (const e of entries(h.scene, net)) right = Math.max(right, e.ax, e.bx);
    }
    expect(bounds[2]).toBe(labelRect(h.scene, 2)![2]);
    expect(bounds[2]).toBeGreaterThan(right);
    h.channels.set('netVisible', Float32Array.of(1, 1, 0));
    h.scene.visibilityChanged();
    expect(h.scene.bounds()![2]).toBeLessThan(bounds[2]);
  });

  it('is null before a load and for an empty netlist', () => {
    const h = harness();
    expect(h.scene.bounds()).toBeNull();
    expect(h.scene.boundsOf([{ kind: 'block', index: 0 }])).toBeNull();
    h.scene.load(
      {
        blockCount: 0,
        portStart: Uint32Array.of(0),
        portFlow: new Uint8Array(0),
        netStart: Uint32Array.of(0),
        netPorts: new Uint32Array(0),
      },
      G,
      true,
      0,
    );
    expect(h.scene.bounds()).toBeNull();
    expect(Array.from(h.scene.positions)).toEqual([]);
  });

  it('bounds parts: blocks with extents, ports, nets with their wires, group frames', () => {
    const h = loaded(plant('steam'));
    const p = h.scene.prepared!;
    expect(h.scene.boundsOf([{ kind: 'block', index: 1 }])).toEqual(extentRect(h.scene, 1));
    const [px, py] = portAt(h.scene, 1);
    const half = p.metrics.portSize / 2;
    expect(h.scene.boundsOf([{ kind: 'port', index: 1 }])).toEqual([
      px - half,
      py - half,
      px + half,
      py + half,
    ]);
    const net = h.scene.boundsOf([{ kind: 'net', index: 2 }])!;
    for (const e of entries(h.scene, 2)) {
      expect(e.ax >= net[0] && e.ax <= net[2] && e.ay >= net[1] && e.ay <= net[3]).toBe(true);
    }
    expect([...h.scene.boundsOf([{ kind: 'group', index: 0 }])!]).toEqual(frame(h.scene, 0));
    const [a, b] = [extentRect(h.scene, 1), extentRect(h.scene, 2)];
    expect(
      h.scene.boundsOf([
        { kind: 'block', index: 1 },
        { kind: 'block', index: 2 },
      ]),
    ).toEqual([
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3]),
    ]);
    expect(
      h.scene.boundsOf([
        { kind: 'block', index: 9 },
        { kind: 'net', index: -1 },
        { kind: 'group', index: 1.5 },
      ]),
    ).toBeNull();
    h.channels.set('blockVisible', Float32Array.of(1, 0, 1));
    h.scene.visibilityChanged();
    expect(h.scene.boundsOf([{ kind: 'block', index: 1 }])).toBeNull();
  });
});

describe('Scene.drain', () => {
  it('reports everything after a load, then only what moved and re-routed', () => {
    const h = loaded(twoArea());
    const blocks: number[] = [];
    const nets: number[] = [];
    const drain = (): void => {
      blocks.length = 0;
      nets.length = 0;
      h.scene.drain(
        (b) => blocks.push(b),
        (n) => nets.push(n),
      );
    };
    drain();
    expect(blocks).toEqual([0, 1, 2]);
    expect(nets).toEqual([0, 1, 2]);
    drain();
    expect(blocks).toEqual([]);
    expect(nets).toEqual([]);
    h.scene.nudge(Uint32Array.of(1), G, 0);
    drain();
    expect(blocks).toEqual([1]);
    // TGOV1 is on pmech and speed; a route outgrowing its slot repacks, moving every slot.
    expect(nets).toEqual(expect.arrayContaining([0, 2]));
    drain();
    expect(blocks).toEqual([]);
    expect(nets).toEqual([]);
    h.scene.detach(3);
    drain();
    expect(blocks).toEqual([]);
    expect(nets).toContain(2);
  });
});

describe('Scene picking', () => {
  it('finds every block where it is drawn after random moves', () => {
    const h = loaded(system(12));
    const p = h.scene.prepared!;
    let seed = 7;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const placement = new Float32Array(2 * p.blockCount).fill(Number.NaN);
    for (let round = 0; round < 12; round++) {
      const b = Math.floor(next() * p.blockCount);
      if (round % 3 === 0) {
        placement[2 * b] = Math.round(next() * 400) * G;
        placement[2 * b + 1] = Math.round(next() * 400) * G;
        h.channels.set('blockPosition', placement);
        h.scene.placementChanged();
      } else if (round % 3 === 1) {
        const blocks = Uint32Array.of(b);
        h.scene.drag(blocks, 0, 0);
        h.scene.drag(blocks, Math.round(next() * 40 - 20) * G, Math.round(next() * 40 - 20) * G);
        const moved = h.scene.commitDrag()!;
        placement[2 * b] = moved.positions[0]!;
        placement[2 * b + 1] = moved.positions[1]!;
      } else {
        h.scene.nudge(Uint32Array.of(b), G, G);
        placement.set(h.channels.values('blockPosition')!);
      }
      for (let other = 0; other < p.blockCount; other++) {
        const [cx, cy] = center(h.scene, other);
        const ids = h.scene.picker.pick(cx, cy, 0);
        // Another block may lie on top; a block is found unless one overlaps it there.
        const hit = ids.find((id) => id < 2 ** 30);
        expect(hit).toBeDefined();
      }
      for (const net of drawnNets(p)) {
        const { netStart, netPorts } = p.netlist;
        for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
          expect(reaches(h.scene, net, netPorts[at]!)).toBe(true);
        }
      }
    }
    // The net index follows re-routes too: every drawn net is found on its first segment.
    for (const net of drawnNets(p)) {
      const s = entries(h.scene, net).find((e) => e.kind === WIRE_SEGMENT)!;
      const ids = h.scene.picker.pick((s.ax + s.bx) / 2, (s.ay + s.by) / 2, 1);
      expect(ids.some((id) => Math.floor(id / 2 ** 30) === PART_NET)).toBe(true);
    }
  });
});
