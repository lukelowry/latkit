import type { Netlist } from '@latkit/model';
import { describe, expect, it } from 'vitest';

import { ceilTo, textWidth } from '../src/geometry.js';
import { arrangeAll, arrangeUnits } from '../src/layout/arrange.js';
import { arrange } from '../src/layout/index.js';
import { layerUnit } from '../src/layout/layered.js';
import { Occupancy } from '../src/layout/occupancy.js';
import { packUnits, placeNew, UNIT_GAP } from '../src/layout/pack.js';
import { laneShifts, Layouts, Shaper, shapeOf } from '../src/layout/shapes.js';
import { units } from '../src/layout/units.js';
import { OPTIONS } from '../src/options.js';
import { prepare, type Prepared } from '../src/prepare.js';
import { ascii } from './fixtures/layout-ascii.js';
import {
  blockTitled,
  closePair,
  firstOverlap,
  groupFrames,
  netBoxes,
  netNamed,
  overlappingPair,
  portAt,
  rectangles,
  steamIn,
  straight,
  tile,
} from './fixtures/layout-netlists.js';
import {
  build,
  CLASSES,
  empty,
  plant,
  randomNetlist,
  scale,
  system,
  twoArea,
  type BlockSpec,
  type NetSpec,
} from './fixtures/netlists.js';

const G = 8;

/** A netlist prepared at the default grid and arranged. */
function laid(netlist: Netlist, grid = G): { p: Prepared; positions: Float32Array } {
  const p = prepare(netlist, grid);
  return { p, positions: arrangeAll(p) };
}

/** Block `b`'s left and right edges at `positions`. */
function span(p: Prepared, positions: Float32Array, b: number): readonly [number, number] {
  return [positions[2 * b]!, positions[2 * b]! + p.size[2 * b]!];
}

/** A unit's positions (2 per block of `order`) as every block's, NaN outside the unit. */
function unitPositions(p: Prepared, order: Uint32Array, positions: Float32Array): Float32Array {
  const at = new Float32Array(2 * p.blockCount).fill(Number.NaN);
  order.forEach((b, i) => at.set([positions[2 * i]!, positions[2 * i + 1]!], 2 * b));
  return at;
}

/** Every value in `values` a multiple of `grid`. */
function onGrid(values: Float32Array, grid: number): boolean {
  return values.every((v) => Math.abs(v / grid - Math.round(v / grid)) < 1e-9);
}

/** The blocks of a steam plant plus the specs a test appends, as `build` takes them. */
function steamSpec(): { blocks: BlockSpec[]; nets: NetSpec[] } {
  return {
    blocks: [
      { key: 'genrou', title: 'GENROU', group: 0, ports: CLASSES.GENROU },
      { key: 'tgov1', title: 'TGOV1', group: 0, ports: CLASSES.TGOV1 },
      { key: 'ieeet1', title: 'IEEET1', group: 0, ports: CLASSES.IEEET1 },
    ],
    nets: [
      {
        label: 'pmech',
        ports: [
          [1, 'pmech'],
          [0, 'pmech'],
        ],
      },
      {
        label: 'efd',
        ports: [
          [2, 'efd'],
          [0, 'efd'],
        ],
      },
      {
        label: 'speed',
        ports: [
          [0, 'speed'],
          [1, 'speed'],
          [2, 'speed'],
        ],
      },
    ],
  };
}

describe('units', () => {
  it('makes one unit per group, ordered by lowest block', () => {
    const p = prepare(system(3), G);
    const u = units(p);
    expect(u.count).toBe(3);
    // steam 3 blocks, steamPss 4, renewable 3.
    expect(Array.from(u.start)).toEqual([0, 3, 7, 10]);
    expect(Array.from(u.blocks)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(u.unitOf)).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
  });

  it('joins ungrouped blocks over wires, never over tags or into groups', () => {
    const netlist = build({
      blocks: [
        {
          title: 'A',
          ports: [
            { name: 'o', flow: 'out' },
            { name: 't', flow: 'both' },
          ],
        },
        { title: 'B', ports: [{ name: 'i', flow: 'in' }] },
        { title: 'C', ports: [{ name: 'i', flow: 'in' }] },
        { title: 'D', group: 0, ports: [{ name: 'o', flow: 'out' }] },
        { title: 'E', ports: [{ name: 't', flow: 'both' }] },
        { title: 'F', group: 0, ports: [] },
      ],
      nets: [
        {
          ports: [
            [0, 'o'],
            [1, 'i'],
          ],
        },
        {
          ports: [
            [3, 'o'],
            [2, 'i'],
          ],
        },
        {
          style: 1,
          ports: [
            [0, 't'],
            [4, 't'],
          ],
        },
      ],
      groups: ['g'],
    });
    const u = units(prepare(netlist, G));
    expect(u.count).toBe(4);
    expect(Array.from(u.start)).toEqual([0, 2, 3, 5, 6]);
    expect(Array.from(u.blocks)).toEqual([0, 1, 2, 3, 5, 4]);
    expect(Array.from(u.unitOf)).toEqual([0, 0, 1, 2, 3, 2]);
  });

  it('takes a wired component as one unit and the empty netlist as none', () => {
    expect(Array.from(units(prepare(twoArea(), G)).start)).toEqual([0, 3]);
    const none = units(prepare(empty(), G));
    expect(none.count).toBe(0);
    expect(Array.from(none.start)).toEqual([0]);
  });
});

describe('shapeOf', () => {
  it('orders a unit by title, then index', () => {
    const p = prepare(plant('steam'), G);
    expect(Array.from(shapeOf(p, Uint32Array.of(0, 1, 2)).order)).toEqual([0, 2, 1]);
    const untitled = prepare({ ...twoArea(), blockTitle: undefined }, G);
    expect(Array.from(shapeOf(untitled, Uint32Array.of(0, 1, 2)).order)).toEqual([0, 1, 2]);
  });

  it('keys plants of one kind alike and different kinds apart', () => {
    const p = prepare(system(8), G);
    const u = units(p);
    const shaper = new Shaper(p);
    const ids = Array.from({ length: u.count }, (_, unit) =>
      shaper.shape(u.blocks, u.start[unit]!, u.start[unit + 1]!),
    );
    expect(ids).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(shaper.count).toBe(4);
    // The ids follow the keys, and a shaper orders a unit as `shapeOf` does.
    const keys = Array.from(
      { length: u.count },
      (_, unit) => shapeOf(p, u.blocks.subarray(u.start[unit]!, u.start[unit + 1]!)).key,
    );
    for (let i = 0; i < 4; i++) expect(keys[i + 4]).toBe(keys[i]);
    expect(new Set(keys).size).toBe(4);
    shaper.shape(u.blocks, u.start[2]!, u.start[3]!);
    expect(Array.from(shaper.order.subarray(0, shaper.size))).toEqual(
      Array.from(shapeOf(p, u.blocks.subarray(u.start[2]!, u.start[3]!)).order),
    );
  });

  it('keys units apart by the labels their ports root', () => {
    const renamed = (prefix: string): Netlist => {
      const netlist = plant('steam');
      return { ...netlist, netLabel: netlist.netLabel!.map((l) => l.replace('1_1_', prefix)) };
    };
    const all = Uint32Array.of(0, 1, 2);
    const key = (netlist: Netlist): string => shapeOf(prepare(netlist, G), all).key;
    // Labels of one width keep a shape; wider ones, which lay out wider, do not.
    expect(key(renamed('9_9_'))).toBe(key(plant('steam')));
    expect(key(renamed('1234_1_'))).not.toBe(key(plant('steam')));
  });

  it('keys a plant alike whatever order it lists its blocks in', () => {
    const a = prepare(steamIn(['GENROU', 'TGOV1', 'IEEET1']), G);
    const b = prepare(steamIn(['TGOV1', 'IEEET1', 'GENROU']), G);
    const all = Uint32Array.of(0, 1, 2);
    expect(shapeOf(a, all).key).toBe(shapeOf(b, all).key);
    const pa = arrangeAll(a);
    const pb = arrangeAll(b);
    for (const title of ['GENROU', 'TGOV1', 'IEEET1']) {
      const ia = blockTitled(a.netlist, title);
      const ib = blockTitled(b.netlist, title);
      expect([pb[2 * ib], pb[2 * ib + 1]]).toEqual([pa[2 * ia], pa[2 * ia + 1]]);
    }
  });

  it('ignores a wire driven from outside the unit', () => {
    const reader = { title: 'Y', group: 1, ports: [{ name: 'i', flow: 'in' as const }] };
    const wired = prepare(
      build({
        blocks: [{ title: 'X', group: 0, ports: [{ name: 'o', flow: 'out' }] }, reader],
        nets: [
          {
            ports: [
              [0, 'o'],
              [1, 'i'],
            ],
          },
        ],
        groups: ['a', 'b'],
      }),
      G,
    );
    const alone = prepare(build({ blocks: [reader], nets: [], groups: ['a', 'b'] }), G);
    expect(shapeOf(wired, Uint32Array.of(1)).key).toBe(shapeOf(alone, Uint32Array.of(0)).key);
  });
});

describe('laneShifts', () => {
  it('shifts every other block of a unit in canonical order, alike for one shape', () => {
    const p = prepare(system(8), G);
    const u = units(p);
    const shifts = laneShifts(p);
    const ofUnit = (unit: number): number[] => {
      const { order } = shapeOf(p, u.blocks.subarray(u.start[unit]!, u.start[unit + 1]!));
      return Array.from(order, (b) => shifts[b]!);
    };
    for (let unit = 0; unit < u.count; unit++) {
      expect(ofUnit(unit)).toEqual(Array.from(ofUnit(unit), (_, i) => i & 1));
      if (unit >= 4) expect(ofUnit(unit)).toEqual(ofUnit(unit - 4));
    }
    // A plant shifts alike whatever order it lists its blocks in.
    const a = prepare(steamIn(['GENROU', 'TGOV1', 'IEEET1']), G);
    const b = prepare(steamIn(['TGOV1', 'IEEET1', 'GENROU']), G);
    for (const title of ['GENROU', 'TGOV1', 'IEEET1']) {
      expect(laneShifts(b)[blockTitled(b.netlist, title)]).toBe(
        laneShifts(a)[blockTitled(a.netlist, title)],
      );
    }
    expect(laneShifts(prepare(empty(), G))).toEqual(new Uint8Array(0));
  });
});

describe('layerUnit', () => {
  it('lays the steam plant out as controllers feeding the machine, pmech straight', () => {
    const { p, positions } = laid(plant('steam'));
    const machine = blockTitled(p.netlist, 'GENROU');
    const governor = blockTitled(p.netlist, 'TGOV1');
    const exciter = blockTitled(p.netlist, 'IEEET1');
    expect(span(p, positions, governor)[1]).toBeLessThan(span(p, positions, machine)[0]);
    expect(span(p, positions, exciter)[1]).toBeLessThan(span(p, positions, machine)[0]);
    // The governor stacks over the exciter, as the machine's pmech input sits over its efd.
    expect(positions[2 * governor + 1]).toBeLessThan(positions[2 * exciter + 1]!);
    // GENROU's pmech and efd inputs are one pitch apart and their drivers cannot stack that
    // close, so exactly one of the two runs straight: pmech, the one already level.
    expect(straight(p, positions, netNamed(p.netlist, '1_1_pmech'))).toBe(true);
    expect(straight(p, positions, netNamed(p.netlist, '1_1_efd'))).toBe(false);
  });

  it('lays the renewable plant out as REPCA, REECB, REGCA', () => {
    const { p, positions } = laid(plant('renewable'));
    const [repca, reecb, regca] = ['REPCA', 'REECB', 'REGCA'].map((t) => blockTitled(p.netlist, t));
    expect(span(p, positions, repca!)[1]).toBeLessThan(span(p, positions, reecb!)[0]);
    expect(span(p, positions, reecb!)[1]).toBeLessThan(span(p, positions, regca!)[0]);
    // Each pair of one-to-one commands can run one wire straight.
    const level = (a: string, b: string): boolean =>
      straight(p, positions, netNamed(p.netlist, a)) ||
      straight(p, positions, netNamed(p.netlist, b));
    expect(level('1_1_ipcmd', '1_1_iqcmd')).toBe(true);
    expect(level('1_1_pext', '1_1_qext')).toBe(true);
  });

  it('puts the stabilizer ahead of the exciter it feeds', () => {
    const { p, positions } = laid(plant('steamPss'));
    const [machine, governor, exciter, stabilizer] = ['GENROU', 'TGOV1', 'IEEET1', 'IEEEST'].map(
      (t) => blockTitled(p.netlist, t),
    );
    expect(span(p, positions, stabilizer!)[1]).toBeLessThan(span(p, positions, exciter!)[0]);
    expect(span(p, positions, exciter!)[1]).toBeLessThan(span(p, positions, machine!)[0]);
    expect(span(p, positions, governor!)[1]).toBeLessThan(span(p, positions, machine!)[0]);
    // The governor shares the exciter's column, next to the machine it drives.
    expect(positions[2 * governor!]! + p.size[2 * governor!]! / 2).toBe(
      positions[2 * exciter!]! + p.size[2 * exciter!]! / 2,
    );
    const nets = ['1_1_pmech', '1_1_efd', '1_1_vs'].map((l) => netNamed(p.netlist, l));
    expect(nets.filter((net) => straight(p, positions, net)).length).toBe(2);
  });

  it('lays the TwoArea unit out as DIAGRAM.md draws it', () => {
    const { p, positions } = laid(twoArea());
    expect(span(p, positions, 1)[1]).toBeLessThan(span(p, positions, 0)[0]);
    expect(span(p, positions, 2)[1]).toBeLessThan(span(p, positions, 0)[0]);
    expect(straight(p, positions, 0)).toBe(true);
  });

  it('holds its group frame, wires and labels included, inside the unit', () => {
    for (const kind of ['steam', 'steamPss', 'renewable', 'classical'] as const) {
      const p = prepare(plant(kind), G);
      const order = shapeOf(p, units(p).blocks).order;
      const { positions, width, height } = layerUnit(p, order);
      const at = unitPositions(p, order, positions);
      const frame = groupFrames(p, at);
      expect(frame[0]).toBeGreaterThanOrEqual(0);
      expect(frame[1]).toBeGreaterThanOrEqual(0);
      expect(frame[2]).toBeLessThanOrEqual(width);
      expect(frame[3]).toBeLessThanOrEqual(height);
      expect(width % G).toBe(0);
      expect(height % G).toBe(0);
      expect(onGrid(positions, G)).toBe(true);
      // A plant that loops back runs a lane under its blocks. Every plant of its shape runs it
      // there, so the unit ends at the lane and its group's padding, with nothing to spare.
      const rects = rectangles(p, at);
      const wires = netBoxes(p, at);
      let blocks = -Infinity;
      let lowest = -Infinity;
      for (let b = 0; b < p.blockCount; b++) blocks = Math.max(blocks, rects[4 * b + 3]!);
      for (let net = 0; net < p.netCount; net++) {
        if (!Number.isNaN(wires[4 * net]!)) lowest = Math.max(lowest, wires[4 * net + 3]!);
      }
      if (kind === 'classical') continue;
      expect(lowest).toBeGreaterThan(blocks);
      expect(lowest + p.metrics.groupPad).toBe(height);
    }
  });

  it('holds the wires and labels of an ungrouped unit inside it', () => {
    for (const netlist of [twoArea(), randomNetlist(40, 3), randomNetlist(120, 5)]) {
      const p = prepare(netlist, G);
      const u = units(p);
      for (let unit = 0; unit < u.count; unit++) {
        const order = shapeOf(p, u.blocks.subarray(u.start[unit]!, u.start[unit + 1]!)).order;
        const { positions, width, height } = layerUnit(p, order);
        const wires = netBoxes(p, unitPositions(p, order, positions));
        for (let net = 0; net < p.netCount; net++) {
          if (Number.isNaN(wires[4 * net]!)) continue;
          expect(wires[4 * net]).toBeGreaterThanOrEqual(0);
          expect(wires[4 * net + 1]).toBeGreaterThanOrEqual(0);
          expect(wires[4 * net + 2]).toBeLessThanOrEqual(width);
          expect(wires[4 * net + 3]).toBeLessThanOrEqual(height);
        }
      }
    }
  });

  it('opens a column gap wide enough for the labels of the wires leaving it', () => {
    /** A netlist with every wire's label `extra` longer. */
    const longer = (netlist: Netlist, extra: string): Netlist => ({
      ...netlist,
      netLabel: netlist.netLabel!.map((label) => label + extra),
    });
    const long = '_governor_mechanical_power';
    for (const netlist of [plant('steam'), plant('steamPss'), plant('renewable'), twoArea()]) {
      for (const labeled of [netlist, longer(netlist, long)]) {
        const { p, positions } = laid(labeled);
        // A label never reaches into a block but the one its wire leaves.
        const hit = overlappingPair(
          netBoxes(p, positions, 'orthogonal', 'labels'),
          rectangles(p, positions),
          (net, block) => p.portBlock[p.netDriver[net]!] === block,
        );
        expect(hit).toBeNull();
      }
    }
    // The governor's pmech label clears the machine by a stub, itself, and a grid.
    const { p, positions } = laid(longer(plant('steam'), long));
    const governor = blockTitled(p.netlist, 'TGOV1');
    const machine = blockTitled(p.netlist, 'GENROU');
    const label = textWidth(
      p.netlist.netLabel![netNamed(p.netlist, `1_1_pmech${long}`)]!,
      p.metrics.labelEm,
    );
    const gap = positions[2 * machine]! - p.extent[4 * machine]! - span(p, positions, governor)[1];
    expect(gap).toBeGreaterThanOrEqual(p.metrics.stub + label + G);
  });

  it('lays an undirected unit out as a tree from its busiest block', () => {
    const both = { name: 't', flow: 'both' as const };
    const netlist = build({
      blocks: [
        { title: 'LEAF', ports: [both] },
        {
          title: 'HUB',
          ports: [
            { ...both, name: 'a' },
            { ...both, name: 'b' },
            { ...both, name: 'c' },
          ],
        },
        { title: 'LEAF', ports: [both] },
        { title: 'LEAF', ports: [both] },
      ],
      nets: [
        {
          ports: [
            [1, 'a'],
            [0, 't'],
          ],
        },
        {
          ports: [
            [2, 't'],
            [1, 'b'],
          ],
        },
        {
          ports: [
            [1, 'c'],
            [3, 't'],
          ],
        },
      ],
    });
    const { p, positions } = laid(netlist);
    for (const leaf of [0, 2, 3]) {
      expect(span(p, positions, 1)[1]).toBeLessThan(span(p, positions, leaf)[0]);
      expect(positions[2 * leaf]).toBe(positions[0]);
    }
    expect(firstOverlap(p, positions)).toBeNull();
  });

  it('holds the lane of a wire that loops into its own block', () => {
    const netlist = build({
      blocks: [
        {
          title: 'LOOP',
          ports: [
            { name: 'i', flow: 'in' },
            { name: 'o', flow: 'out' },
          ],
        },
      ],
      nets: [
        {
          label: 'loop',
          ports: [
            [0, 'o'],
            [0, 'i'],
          ],
        },
      ],
    });
    const p = prepare(netlist, G);
    const { positions, width, height } = layerUnit(p, Uint32Array.of(0));
    const wire = netBoxes(p, positions);
    // The U-turn runs under the block and back, its label over the stub, all inside.
    expect(wire[3]!).toBeGreaterThan(positions[1]! + p.size[1]!);
    expect(wire[0]).toBeGreaterThanOrEqual(0);
    expect(wire[1]).toBeGreaterThanOrEqual(0);
    expect(wire[2]).toBeLessThanOrEqual(width);
    // The unit ends at its lane: every instance of its shape routes the lane there.
    expect(wire[3]).toBe(height);
  });

  it('lays out nothing for an empty order', () => {
    const p = prepare(empty(), G);
    expect(layerUnit(p, new Uint32Array(0))).toEqual({
      positions: new Float32Array(0),
      width: 0,
      height: 0,
      margin: [0, 0, 0, 0],
    });
  });
});

describe('arrangeAll and arrange', () => {
  it('is deterministic', () => {
    for (const netlist of [system(20), randomNetlist(200, 4), tile(twoArea(), 5)]) {
      expect(arrange(netlist)).toEqual(arrange(netlist));
    }
  });

  it('never overlaps extents', () => {
    for (const netlist of [
      tile(twoArea(), 40),
      tile(plant('renewable'), 10),
      system(40),
      system(60, ['steam', 'renewable', 'classical', 'steamPss', 'steam']),
      randomNetlist(500, 1),
      randomNetlist(500, 2),
      randomNetlist(500, 7),
    ]) {
      const { p, positions } = laid(netlist);
      expect(firstOverlap(p, positions)).toBeNull();
    }
  });

  it('puts every top-left on the grid at any pitch', () => {
    for (const grid of [4, 6, 8, 10, 12.5]) {
      for (const netlist of [system(12), randomNetlist(100, 3)]) {
        const { p, positions } = laid(netlist, grid);
        expect(onGrid(positions, grid)).toBe(true);
        expect(firstOverlap(p, positions)).toBeNull();
      }
    }
  });

  it('lays out every instance of one shape identically', () => {
    const { p, positions } = laid(system(12));
    const u = units(p);
    const relative = (unit: number): number[] => {
      const first = u.blocks[u.start[unit]!]!;
      const out: number[] = [];
      for (let at = u.start[unit]!; at < u.start[unit + 1]!; at++) {
        const b = u.blocks[at]!;
        out.push(positions[2 * b]! - positions[2 * first]!);
        out.push(positions[2 * b + 1]! - positions[2 * first + 1]!);
      }
      return out;
    };
    for (let unit = 4; unit < u.count; unit++) expect(relative(unit)).toEqual(relative(unit % 4));
  });

  it('packs units into rows near 16:10', () => {
    const { p, positions } = laid(system(200));
    const rects = rectangles(p, positions);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let b = 0; b < p.blockCount; b++) {
      x0 = Math.min(x0, rects[4 * b]!);
      y0 = Math.min(y0, rects[4 * b + 1]!);
      x1 = Math.max(x1, rects[4 * b + 2]!);
      y1 = Math.max(y1, rects[4 * b + 3]!);
    }
    const ratio = (x1 - x0) / (y1 - y0);
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(2.2);
  });

  it('validates what it is given', () => {
    for (const gridPitch of [0, -8, Number.NaN, Infinity]) {
      expect(() => arrange(twoArea(), { gridPitch })).toThrow(
        new RangeError('diagram arrange gridPitch must be a finite number greater than 0'),
      );
    }
    expect(() => arrange(twoArea(), { gridPitch: '8' as unknown as number })).toThrow(RangeError);
    expect(() => arrange({ ...twoArea(), portFlow: Uint8Array.of(0, 0, 1) })).toThrow(Error);
    expect(arrange(empty())).toEqual(new Float32Array(0));
  });

  it('defaults to the diagram grid', () => {
    expect(arrange(system(4))).toEqual(
      arrange(system(4), { gridPitch: OPTIONS.gridPitch.default }),
    );
    expect(arrange(system(4), { gridPitch: 10 })).not.toEqual(arrange(system(4)));
  });

  it('keeps every pair of group frames a unit gap apart', () => {
    const mixes = [
      system(64),
      system(60, ['steam', 'renewable', 'classical', 'steamPss', 'steam'], 23),
    ];
    for (const grid of [8, 10]) {
      for (const netlist of mixes) {
        const { p, positions } = laid(netlist, grid);
        for (const mode of ['orthogonal', 'straight'] as const) {
          expect(closePair(groupFrames(p, positions, mode), UNIT_GAP * grid)).toBeNull();
        }
      }
    }
  });

  it('shares one layout per shape', () => {
    // Plants 36 on have two-digit prefixes and wider labels: other shapes.
    const p = prepare(system(36), G);
    const u = units(p);
    const lay = new Layouts(p);
    const layouts = Array.from({ length: u.count }, (_, unit) =>
      lay.of(u.blocks, u.start[unit]!, u.start[unit + 1]!),
    );
    for (let unit = 4; unit < u.count; unit++) expect(layouts[unit]).toBe(layouts[unit % 4]);
  });

  it('arranges the EastWest scale quickly', () => {
    const p = prepare(scale(), G);
    const started = performance.now();
    const positions = arrangeAll(p);
    const elapsed = performance.now() - started;
    console.log(`arranged ${p.blockCount} blocks in ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(1500);
    expect(onGrid(positions, G)).toBe(true);
    expect(firstOverlap(p, positions)).toBeNull();
  });
});

describe('packUnits', () => {
  it('packs nothing into nothing', () => {
    expect(packUnits(new Float32Array(0), new Float32Array(0), 48)).toEqual(new Float32Array(0));
  });

  it('shelves rectangles in order without overlap', () => {
    const count = 60;
    const widths = Float32Array.from({ length: count }, (_, i) => 8 * (10 + ((i * 7) % 23)));
    const heights = Float32Array.from({ length: count }, (_, i) => 8 * (6 + ((i * 5) % 17)));
    const gap = 48;
    const at = packUnits(widths, heights, gap);
    expect(onGrid(at, 8)).toBe(true);
    for (let i = 1; i < count; i++) {
      // Row-major: a unit is right of its predecessor, or starts a lower row at the left.
      if (at[2 * i + 1] === at[2 * i - 1]) {
        expect(at[2 * i]).toBe(at[2 * i - 2]! + widths[i - 1]! + gap);
      } else {
        expect(at[2 * i]).toBe(0);
        expect(at[2 * i + 1]).toBeGreaterThan(at[2 * i - 1]!);
      }
      for (let j = 0; j < i; j++) {
        const apart =
          at[2 * i]! >= at[2 * j]! + widths[j]! + gap ||
          at[2 * j]! >= at[2 * i]! + widths[i]! + gap ||
          at[2 * i + 1]! >= at[2 * j + 1]! + heights[j]! + gap ||
          at[2 * j + 1]! >= at[2 * i + 1]! + heights[i]! + gap;
        expect(apart).toBe(true);
      }
    }
  });

  it('aims for 16:10 and gives an oversized unit its own row', () => {
    const squares = packUnits(new Float32Array(100).fill(80), new Float32Array(100).fill(80), 16);
    let right = 0;
    let bottom = 0;
    for (let i = 0; i < 100; i++) {
      right = Math.max(right, squares[2 * i]! + 80);
      bottom = Math.max(bottom, squares[2 * i + 1]! + 80);
    }
    expect(right / bottom).toBeGreaterThan(1.3);
    expect(right / bottom).toBeLessThan(2);

    const wide = packUnits(Float32Array.of(80, 4000, 80), Float32Array.of(80, 80, 80), 16);
    expect(Array.from(wide)).toEqual([0, 0, 0, 96, 0, 192]);
  });
});

describe('placeNew', () => {
  /** The positions of `before` carried into `after` by key, NaN for new blocks. */
  function carried(before: Prepared, positions: Float32Array, after: Prepared): Float32Array {
    const out = new Float32Array(2 * after.blockCount).fill(Number.NaN);
    for (const [key, b] of after.keys!) {
      const old = before.keys!.get(key);
      if (old === undefined) continue;
      out[2 * b] = positions[2 * old]!;
      out[2 * b + 1] = positions[2 * old + 1]!;
    }
    return out;
  }

  it('puts a new reader right of its driver, level with it', () => {
    const before = laid(twoArea());
    const netlist: Netlist = {
      ...twoArea(),
      blockCount: 4,
      blockKey: [...twoArea().blockKey!, 'scope'],
      blockTitle: [...twoArea().blockTitle!, 'SCOPE'],
      portStart: Uint32Array.of(0, 3, 5, 7, 8),
      portFlow: Uint8Array.of(0, 0, 1, 0, 1, 0, 1, 0),
      portLabel: [...twoArea().portLabel!, 'u'],
      netStart: Uint32Array.of(0, 2, 5, 8),
      netPorts: Uint32Array.of(4, 0, 6, 1, 7, 2, 3, 5),
    };
    const p = prepare(netlist, G);
    const positions = carried(before.p, before.positions, p);
    placeNew(p, positions, positions.slice());
    const exciterRight = span(p, positions, 2)[1];
    expect(positions[6]).toBe(exciterRight + 8 * G);
    expect(portAt(p, positions, 7)[1]).toBe(portAt(p, positions, 6)[1]);
    expect(firstOverlap(p, positions)).toBeNull();
    expect(Array.from(positions.subarray(0, 6))).toEqual(Array.from(before.positions));
  });

  it('slides a new block down past what occupies its spot', () => {
    const spec = steamSpec();
    // In the plant's group: a block joining a unit, not a unit of its own.
    spec.blocks.push({ key: 'ref', title: 'REF', group: 0, ports: [{ name: 'y', flow: 'out' }] });
    spec.nets.push({
      ports: [
        [3, 'y'],
        [1, 'pref'],
      ],
    });
    const p = prepare(build({ ...spec, groups: ['plant'] }), G);
    const positions = arrangeAll(prepare(build({ ...steamSpec(), groups: ['plant'] }), G));
    const all = new Float32Array(8).fill(Number.NaN);
    all.set(positions);
    // A free spot: left of TGOV1, its output level with pref.
    const free = all.slice();
    placeNew(p, free, free.slice());
    // Ports: GENROU 0-3, TGOV1 4-6 (pref 5), IEEET1 7-13, REF 14.
    expect(span(p, free, 3)[1]).toBeLessThanOrEqual(free[2]! - 8 * G);
    expect(portAt(p, free, 14)[1]).toBe(portAt(p, free, 5)[1]);
    // Occupy that spot with the machine: the new block slides below it.
    const occupied = all.slice();
    occupied[0] = free[6]!;
    occupied[1] = free[7]!;
    const slid = all.slice();
    placeNew(p, slid, occupied);
    expect(slid[6]).toBe(free[6]);
    expect(slid[7]!).toBeGreaterThan(free[7]!);
    const shown = occupied.slice();
    shown[6] = slid[6]!;
    shown[7] = slid[7]!;
    const rects = rectangles(p, shown);
    for (let b = 0; b < 3; b++) {
      const apart =
        rects[14]! <= rects[4 * b]! ||
        rects[4 * b + 2]! <= rects[12]! ||
        rects[15]! <= rects[4 * b + 1]! ||
        rects[4 * b + 3]! <= rects[13]!;
      expect(apart).toBe(true);
    }
  });

  it('lays a wholly new unit out whole, below everything', () => {
    // Plant 4 of five is a steam plant, blocks 11 to 13.
    const before = laid(system(4));
    const p = prepare(system(5), G);
    const positions = carried(before.p, before.positions, p);
    placeNew(p, positions, positions.slice());
    expect(firstOverlap(p, positions)).toBeNull();
    const rects = rectangles(before.p, before.positions);
    let bottom = -Infinity;
    for (let b = 0; b < before.p.blockCount; b++) bottom = Math.max(bottom, rects[4 * b + 3]!);
    const fresh = [11, 12, 13];
    for (const b of fresh) expect(positions[2 * b + 1]).toBeGreaterThan(bottom);
    // The same shape as a full arrangement lays it out.
    const full = arrangeAll(p);
    for (const b of fresh) {
      expect(positions[2 * b]! - positions[22]!).toBe(full[2 * b]! - full[22]!);
      expect(positions[2 * b + 1]! - positions[23]!).toBe(full[2 * b + 1]! - full[23]!);
    }
  });

  it('keeps a plant a reload adds a unit gap from every frame, as a packing would', () => {
    for (const grid of [8, 10]) {
      const before = laid(system(12), grid);
      // Plant 12 is new and wired to nothing: it shelves below the frames, not the blocks.
      const p = prepare(system(13), grid);
      const positions = carried(before.p, before.positions, p);
      placeNew(p, positions, positions.slice());
      expect(onGrid(positions, grid)).toBe(true);
      expect(firstOverlap(p, positions)).toBeNull();
      for (const mode of ['orthogonal', 'straight'] as const) {
        expect(closePair(groupFrames(p, positions, mode), UNIT_GAP * grid)).toBeNull();
      }
    }
  });

  it('puts a new unit level beside the frame of the plant it drives, a unit gap clear', () => {
    const spec = steamSpec();
    // Ungrouped: a unit of its own, wired into the plant's governor.
    spec.blocks.push({ key: 'ref', title: 'REF', ports: [{ name: 'y', flow: 'out' }] });
    spec.nets.push({
      ports: [
        [3, 'y'],
        [1, 'pref'],
      ],
    });
    const p = prepare(build({ ...spec, groups: ['plant'] }), G);
    const positions = new Float32Array(8).fill(Number.NaN);
    positions.set(arrangeAll(prepare(build({ ...steamSpec(), groups: ['plant'] }), G)));
    placeNew(p, positions, positions.slice());
    // Ports: GENROU 0-3, TGOV1 4-6 (pref 5), IEEET1 7-13, REF 14.
    expect(portAt(p, positions, 14)[1]).toBe(portAt(p, positions, 5)[1]);
    const plant = groupFrames(p, positions);
    const right = positions[6]! + p.size[6]! + p.extent[14]!;
    expect(right + UNIT_GAP * G).toBeLessThanOrEqual(plant[0]!);
    // No further than the gap and the grid step it rounds to.
    expect(right + (UNIT_GAP + 1) * G).toBeGreaterThan(plant[0]!);
    expect(onGrid(positions, G)).toBe(true);
  });

  it('puts an unwired newcomer to a group under the group', () => {
    const spec = steamSpec();
    spec.blocks.push({ key: 'note', title: 'NOTE', group: 0, ports: [] });
    const p = prepare(build({ ...spec, groups: ['plant'] }), G);
    const positions = new Float32Array(8).fill(Number.NaN);
    positions.set(arrangeAll(prepare(build({ ...steamSpec(), groups: ['plant'] }), G)));
    placeNew(p, positions, positions.slice());
    const rects = rectangles(p, positions);
    for (const b of [0, 1, 2]) expect(rects[13]!).toBeGreaterThan(rects[4 * b + 3]!);
    expect(firstOverlap(p, positions)).toBeNull();
    expect(onGrid(positions, G)).toBe(true);
  });

  it('changes nothing when nothing is new', () => {
    const { p, positions } = laid(system(4));
    const copy = positions.slice();
    placeNew(p, copy, copy.slice());
    expect(copy).toEqual(positions);
  });

  it('places beside survivors drawn absurdly far out', () => {
    const p = prepare(randomNetlist(6, 2), G);
    const auto = arrangeAll(p);
    for (const far of [1e20, -1e20, 3e38]) {
      for (const axis of [0, 1]) {
        const positions = auto.slice();
        positions[2] = Number.NaN;
        positions[3] = Number.NaN;
        const occupied = positions.slice();
        occupied[axis] = far;
        // Cell coordinates past 2^53 once looped forever; now they clamp.
        placeNew(p, positions, occupied);
        expect(Number.isFinite(positions[2]!) && Number.isFinite(positions[3]!)).toBe(true);
        const shown = occupied.slice();
        shown[2] = positions[2]!;
        shown[3] = positions[3]!;
        const near = Array.from({ length: p.blockCount }, (_, b) => b).filter(
          (b) => Math.abs(shown[2 * b]!) < 1e9 && Math.abs(shown[2 * b + 1]!) < 1e9,
        );
        const rects = rectangles(p, shown);
        for (const b of near) {
          if (b === 1) continue;
          const apart =
            rects[6]! <= rects[4 * b]! ||
            rects[4 * b + 2]! <= rects[4]! ||
            rects[7]! <= rects[4 * b + 1]! ||
            rects[4 * b + 3]! <= rects[5]!;
          expect(apart).toBe(true);
        }
      }
    }
  });
});

describe('Occupancy', () => {
  it('finds rectangles far out without looping forever', () => {
    const room = new Occupancy(64);
    room.add(0, 1e20, 0, 1e20 + 100, 50);
    room.add(1, -1e20, -1e20, -1e20 + 10, -1e20 + 10);
    room.add(2, 0, 0, 10, 10);
    expect(room.hits(9, 1e20, 10, 1e20 + 1, 20)).toBe(false);
    expect(room.hits(9, 1e20 - 1e5, 10, 1e20 + 1e5, 20)).toBe(true);
    expect(room.hits(0, 1e20 - 1e5, 10, 1e20 + 1e5, 20)).toBe(false);
    expect(room.hits(9, -2e20, -2e20, -1e19, -1e19)).toBe(true);
    expect(room.hits(9, 5, 5, 6, 6)).toBe(true);
    expect(room.hits(9, 10, 0, 20, 10)).toBe(false);
  });

  it('tests a rectangle or a query too wide for cells against everything', () => {
    const room = new Occupancy(8);
    room.add(0, -1e6, 0, 1e6, 8);
    room.add(1, 100, 100, 108, 108);
    expect(room.hits(9, 500, 4, 501, 5)).toBe(true);
    expect(room.hits(9, -1e7, 90, 1e7, 110)).toBe(true);
    expect(room.hits(9, -1e7, 20, 1e7, 30)).toBe(false);
    const seen: number[] = [];
    room.visit(-1e7, 0, 1e7, 200, (owner) => seen.push(owner));
    expect(seen.sort()).toEqual([0, 1]);
  });

  it('visits each rectangle a box meets once, strictly', () => {
    const room = new Occupancy(8);
    room.add(4, 0, 0, 40, 40);
    room.add(5, 40, 0, 80, 40);
    const seen: number[] = [];
    room.visit(10, 10, 30, 30, (owner) => seen.push(owner));
    expect(seen).toEqual([4]);
    seen.length = 0;
    // A line along the shared edge meets neither interior; one through both meets both.
    room.visit(40, 0, 40, 40, (owner) => seen.push(owner));
    expect(seen).toEqual([]);
    room.visit(0, 20, 80, 20, (owner) => seen.push(owner));
    expect(seen.sort()).toEqual([4, 5]);
  });
});

describe('arrangeUnits', () => {
  it('leaves an arranged unit where it is', () => {
    const { p, positions } = laid(system(6));
    const copy = positions.slice();
    arrangeUnits(p, copy, Uint32Array.of(3, 12, 999));
    expect(copy).toEqual(positions);
  });

  it('re-lays out a unit anchored at its current top-left', () => {
    const { p, positions } = laid(system(6));
    const u = units(p);
    const members = Array.from(u.blocks.subarray(u.start[1]!, u.start[2]!));
    const moved = positions.slice();
    // Scatter the unit's blocks; the unit's top-left is where their extents, on the grid, start.
    members.forEach((b, i) => {
      moved[2 * b] = 2000 + 96 * i;
      moved[2 * b + 1] = 1200 - 64 * i;
    });
    const anchor = (at: Float32Array): readonly [number, number] => [
      Math.min(...members.map((b) => at[2 * b]! - ceilTo(p.extent[4 * b]!, G))),
      Math.min(...members.map((b) => at[2 * b + 1]! - ceilTo(p.extent[4 * b + 1]!, G))),
    ];
    const before = anchor(moved);
    arrangeUnits(p, moved, Uint32Array.of(members[2]!));
    expect(anchor(moved)).toEqual(before);
    // The unit's own layout, translated.
    const first = members[0]!;
    for (const b of members) {
      expect(moved[2 * b]! - moved[2 * first]!).toBe(positions[2 * b]! - positions[2 * first]!);
      expect(moved[2 * b + 1]! - moved[2 * first + 1]!).toBe(
        positions[2 * b + 1]! - positions[2 * first + 1]!,
      );
    }
    // Other units stay.
    for (let b = 0; b < p.blockCount; b++) {
      if (u.unitOf[b] === 1) continue;
      expect([moved[2 * b], moved[2 * b + 1]]).toEqual([positions[2 * b], positions[2 * b + 1]]);
    }
  });

  it('keeps a re-laid unit a unit gap from every other frame, sliding it down to clear one', () => {
    const { p, positions } = laid(system(6));
    const u = units(p);
    const members = Array.from(u.blocks.subarray(u.start[1]!, u.start[2]!));
    const frames = groupFrames(p, positions);
    // Move plant 1 two grid steps into plant 5's frame, on the bottom row: room lies below it.
    const moved = positions.slice();
    const dx = Math.round((frames[20]! - frames[4]!) / G) * G;
    const dy = Math.round((frames[21]! - frames[5]!) / G) * G + 2 * G;
    for (const b of members) {
      moved[2 * b] = positions[2 * b]! + dx;
      moved[2 * b + 1] = positions[2 * b + 1]! + dy;
    }
    arrangeUnits(p, moved, Uint32Array.of(members[0]!));
    expect(closePair(groupFrames(p, moved), UNIT_GAP * G)).toBeNull();
    expect(onGrid(moved, G)).toBe(true);
    // It slid straight down from its anchor, laid out as before; no other unit moved.
    const first = members[0]!;
    expect(moved[2 * first]).toBe(positions[2 * first]! + dx);
    expect(moved[2 * first + 1]!).toBeGreaterThan(positions[2 * first + 1]! + dy);
    for (const b of members) {
      expect(moved[2 * b]! - moved[2 * first]!).toBe(positions[2 * b]! - positions[2 * first]!);
      expect(moved[2 * b + 1]! - moved[2 * first + 1]!).toBe(
        positions[2 * b + 1]! - positions[2 * first + 1]!,
      );
    }
    for (let b = 0; b < p.blockCount; b++) {
      if (u.unitOf[b] === 1) continue;
      expect([moved[2 * b], moved[2 * b + 1]]).toEqual([positions[2 * b], positions[2 * b + 1]]);
    }
    // Moved into plant 0 on the top row, it finds no room within 64 pitches: it shelves below
    // every frame.
    const top = positions.slice();
    const tx = Math.round((frames[0]! - frames[4]!) / G) * G + 2 * G;
    for (const b of members) top[2 * b] = positions[2 * b]! + tx;
    arrangeUnits(p, top, Uint32Array.of(members[0]!));
    const after = groupFrames(p, top);
    expect(closePair(after, UNIT_GAP * G)).toBeNull();
    for (let group = 0; group < p.groupCount; group++) {
      if (group !== 1) expect(after[5]!).toBeGreaterThanOrEqual(frames[4 * group + 3]!);
    }
  });

  it('shelves a unit with no position below everything else', () => {
    const { p, positions } = laid(system(6));
    const u = units(p);
    const copy = positions.slice();
    for (let at = u.start[2]!; at < u.start[3]!; at++) {
      copy[2 * u.blocks[at]!] = Number.NaN;
      copy[2 * u.blocks[at]! + 1] = Number.NaN;
    }
    arrangeUnits(p, copy, Uint32Array.of(u.blocks[u.start[2]!]!));
    expect(firstOverlap(p, copy)).toBeNull();
    expect(onGrid(copy, G)).toBe(true);
  });
});

describe('layout rendering', () => {
  it('draws plants for the eye', () => {
    for (const kind of ['steam', 'renewable', 'steamPss'] as const) {
      const { p, positions } = laid(plant(kind));
      const text = ascii(p, positions);
      console.log(`${kind}:\n${text}\n`);
      for (const title of p.netlist.blockTitle!) expect(text).toContain(title);
    }
  });
});
