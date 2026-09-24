import type { Netlist } from '@latkit/model';
import { describe, expect, it } from 'vitest';

import { netLabelBox, textWidth } from '../src/geometry.js';
import { arrangeAll } from '../src/layout/arrange.js';
import { units } from '../src/layout/units.js';
import { PART_NET, PART_PORT, partId } from '../src/part.js';
import { FLOW_IN, NONE, prepare, SIDE_TOP } from '../src/prepare.js';
import { Routes } from '../src/route/index.js';
import { routeOrthogonal, routePreview } from '../src/route/orthogonal.js';
import { normalX, normalY, routeStraight } from '../src/route/straight.js';
import {
  layoutBases,
  Mirror,
  WIRE_ARROW,
  WIRE_EMPTY,
  WIRE_JUNCTION,
  WIRE_SEGMENT,
  WIRE_WORDS,
} from '../src/webgpu/buffers.js';
import {
  build,
  plant,
  random,
  randomNetlist,
  system,
  twoArea,
  type BlockSpec,
} from './fixtures/netlists.js';
import {
  columns,
  contextOf,
  extentRect,
  netPorts,
  overlap,
  pierces,
  plantColumns,
  portAt,
  Recorder,
  scatter,
  shelf,
  type Placed,
  type Segment,
} from './fixtures/route-scenes.js';

const G = 8;

/** TwoArea with TGOV1 over IEEET1 in the first column and GENROU in the second. */
function twoAreaPlaced(): Placed {
  return columns(twoArea(), [[1, 2], [0]]);
}

/** One driver with three readers at different heights in the next column. */
function fanOut(): Placed {
  return columns(
    build({
      blocks: [
        { title: 'SRC', ports: [{ name: 'y', flow: 'out' }] },
        { title: 'A', ports: [{ name: 'u', flow: 'in' }] },
        { title: 'B', ports: [{ name: 'u', flow: 'in' }] },
        { title: 'C', ports: [{ name: 'u', flow: 'in' }] },
      ],
      nets: [
        {
          label: 'y',
          ports: [
            [0, 'y'],
            [1, 'u'],
            [2, 'u'],
            [3, 'u'],
          ],
        },
      ],
    }),
    [[0], [1, 2, 3]],
  );
}

/**
 * A driver and `readers` readers stacked in the next column, the net listing reader `order(i)`
 * `i`-th; the driver's port sits half a row below reader `level`'s, so readers lie above and
 * below it and every branch but the end ones leaves the trunk in a T.
 */
function column(readers: number, order: (i: number) => number, level = readers >> 1): Placed {
  const blocks: BlockSpec[] = [{ title: 'SRC', ports: [{ name: 'y', flow: 'out' }] }];
  const ports: (readonly [number, string])[] = [[0, 'y']];
  for (let i = 0; i < readers; i++) {
    blocks.push({ ports: [{ name: 'u', flow: 'in' }] });
    ports.push([order(i) + 1, 'u']);
  }
  const prepared = prepare(build({ blocks, nets: [{ ports }] }), G);
  const positions = new Float32Array(2 * prepared.blockCount);
  const pitch = prepared.size[3]! + 2 * G;
  for (let b = 1; b <= readers; b++) {
    positions[2 * b] = 40 * G;
    positions[2 * b + 1] = (b - 1) * pitch;
  }
  positions[1] = level * pitch + pitch / 2 + prepared.portOffset[3]! - prepared.portOffset[1]!;
  return { prepared, positions };
}

/** Two blocks in a loop, the reader of `fb` directly left of its driver. */
function loop(): Placed {
  return columns(
    build({
      blocks: [
        {
          title: 'DRV',
          ports: [
            { name: 'u', flow: 'in' },
            { name: 'y', flow: 'out' },
          ],
        },
        {
          title: 'RDR',
          ports: [
            { name: 'u', flow: 'in' },
            { name: 'y', flow: 'out' },
          ],
        },
      ],
      nets: [
        {
          label: 'fb',
          ports: [
            [0, 'y'],
            [1, 'u'],
          ],
        },
        {
          label: 'fw',
          ports: [
            [1, 'y'],
            [0, 'u'],
          ],
        },
      ],
    }),
    [[1], [0]],
  );
}

/** What routing one net writes. */
function route(
  placed: Placed,
  net: number,
  options: Parameters<typeof contextOf>[1] = {},
): Recorder {
  const out = new Recorder();
  const ctx = contextOf(placed, options);
  (ctx.mode === 'straight' ? routeStraight : routeOrthogonal)(ctx, net, out);
  return out;
}

const key = (x: number, y: number): string => `${x},${y}`;

/** Ports of a net whose blocks are placed and shown. */
function shownPorts(placed: Placed, net: number, blockVisible?: Float32Array): number[] {
  return netPorts(placed.prepared, net).filter((port) => {
    const block = placed.prepared.portBlock[port]!;
    return !Number.isNaN(placed.positions[2 * block]!) && (!blockVisible || blockVisible[block]);
  });
}

/**
 * Check what every orthogonal route promises: axis-aligned grid segments of positive length that
 * join every shown port of the net into one piece, starting at the root.
 */
function expectWellFormed(
  placed: Placed,
  net: number,
  out: Recorder,
  blockVisible?: Float32Array,
): void {
  const ports = shownPorts(placed, net, blockVisible);
  if (ports.length < 2 || placed.prepared.netStyle[net] !== 0) {
    expect(out.segments).toHaveLength(0);
    return;
  }
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const add = (k: string): void => {
    if (!parent.has(k)) parent.set(k, k);
  };
  for (const s of out.segments) {
    expect(s.ax === s.bx || s.ay === s.by, `net ${net} diagonal`).toBe(true);
    expect(s.ax !== s.bx || s.ay !== s.by, `net ${net} empty segment`).toBe(true);
    for (const v of [s.ax, s.ay, s.bx, s.by]) {
      expect(Math.abs(v % G), `net ${net} off grid`).toBe(0);
    }
    add(key(s.ax, s.ay));
    add(key(s.bx, s.by));
    parent.set(find(key(s.ax, s.ay)), find(key(s.bx, s.by)));
  }
  const pieces = new Set<string>();
  for (const port of ports) {
    const [x, y] = portAt(placed, port);
    const k = key(x, y);
    expect(parent.has(k), `net ${net} misses port ${port}`).toBe(true);
    pieces.add(find(k));
  }
  expect(pieces.size, `net ${net} is in pieces`).toBe(1);
}

/** Whether any segment of a route runs through a block, and which. */
function pierced(placed: Placed, segments: readonly Segment[], blocks: Iterable<number>): string[] {
  const hits: string[] = [];
  for (const b of blocks) {
    const { positions, prepared } = placed;
    const x = positions[2 * b]!;
    const y = positions[2 * b + 1]!;
    const rect = [x, y, x + prepared.size[2 * b]!, y + prepared.size[2 * b + 1]!] as const;
    for (const s of segments) if (pierces(s, rect)) hits.push(`block ${b}: ${JSON.stringify(s)}`);
  }
  return hits;
}

function allBlocks(placed: Placed): number[] {
  const blocks: number[] = [];
  for (let b = 0; b < placed.prepared.blockCount; b++) {
    if (!Number.isNaN(placed.positions[2 * b]!)) blocks.push(b);
  }
  return blocks;
}

/** Every route of a placement, by net. */
function routeEvery(placed: Placed): Recorder[] {
  return Array.from({ length: placed.prepared.netCount }, (_, net) => route(placed, net));
}

/** Pairs of nets with collinear segments sharing a stretch. */
function overlaps(routes: readonly Recorder[]): string[] {
  const found: string[] = [];
  for (let a = 0; a < routes.length; a++) {
    for (let b = a + 1; b < routes.length; b++) {
      for (const sa of routes[a]!.segments) {
        for (const sb of routes[b]!.segments) {
          if (overlap(sa, sb) > 0) found.push(`${a}/${b}: ${JSON.stringify([sa, sb])}`);
        }
      }
    }
  }
  return found;
}

const scenes: readonly (readonly [string, () => Placed])[] = [
  ['TwoArea', twoAreaPlaced],
  ['steam plant', () => columns(plant('steam'), [[1, 2], [0]])],
  ['PSS plant', () => columns(plant('steamPss'), [[3], [1, 2], [0]])],
  ['renewable plant', () => columns(plant('renewable'), [[2], [1], [0]])],
  ['twelve plants on shelves', () => shelf(system(12), plantColumns(12), 3)],
  ['fan-out', fanOut],
  ['loop', loop],
];

describe('routeOrthogonal', () => {
  it.each(scenes)('draws %s on the grid, joining every port of each net', (_, scene) => {
    const placed = scene();
    for (let net = 0; net < placed.prepared.netCount; net++) {
      expectWellFormed(placed, net, route(placed, net));
    }
  });

  it.each(scenes)('runs no wire of %s through a block', (_, scene) => {
    const placed = scene();
    const routes = routeEvery(placed);
    const hits = routes.flatMap((out) => pierced(placed, out.segments, allBlocks(placed)));
    expect(hits).toEqual([]);
  });

  it.each(scenes)('keeps the nets of %s apart', (_, scene) => {
    expect(overlaps(routeEvery(scene()))).toEqual([]);
  });

  it('holds its shape on random netlists at random places', () => {
    for (const seed of [1, 2, 3]) {
      const placed = scatter(randomNetlist(80, seed), 9, 30 * G);
      for (let net = 0; net < placed.prepared.netCount; net++) {
        const out = route(placed, net);
        expectWellFormed(placed, net, out);
        // A wire may cross other blocks in a crowded scatter, never the ones it connects.
        const own = new Set(
          netPorts(placed.prepared, net).map((p) => placed.prepared.portBlock[p]!),
        );
        expect(pierced(placed, out.segments, own)).toEqual([]);
      }
    }
  });

  it('fans out through one trunk between the columns, with T-junctions', () => {
    const placed = fanOut();
    const out = route(placed, 0);
    const vertical = out.segments.filter((s) => s.ax === s.bx);
    const trunk = vertical[0]!.ax;
    expect(vertical.every((s) => s.ax === trunk)).toBe(true);
    const [srcX] = portAt(placed, 0);
    const [readerX] = portAt(placed, 1);
    expect(trunk).toBeGreaterThan(srcX);
    expect(trunk).toBeLessThan(readerX);
    const ys = [1, 2, 3].map((p) => portAt(placed, p)[1]);
    const top = Math.min(...ys, portAt(placed, 0)[1]);
    const bottom = Math.max(...ys, portAt(placed, 0)[1]);
    // B's branch leaves the trunk strictly inside its span: a T.
    expect(out.junctions).toContainEqual([trunk, portAt(placed, 2)[1]]);
    for (const [x, y] of out.junctions) {
      expect(x).toBe(trunk);
      expect(y).toBeGreaterThanOrEqual(top);
      expect(y).toBeLessThanOrEqual(bottom);
    }
    // Every branch runs straight from the trunk into its reader.
    for (const p of [1, 2, 3]) {
      const [x, y] = portAt(placed, p);
      expect(out.segments).toContainEqual(
        expect.objectContaining({ ax: trunk, ay: y, bx: x, by: y }),
      );
    }
  });

  it('draws one trunk for readers listed in any order, above and below the root', () => {
    const readers = 40;
    const sorted = column(readers, (i) => i);
    // The first reader listed stays first: among readers equally near, it sets the trunk's line.
    const next = random(5);
    const order = Array.from({ length: readers }, (_, i) => i);
    for (let i = readers - 1; i > 1; i--) {
      const j = 1 + Math.floor(next() * i);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const shuffled = column(readers, (i) => order[i]!);
    const drawn = (placed: Placed): string[] =>
      route(placed, 0)
        .segments.map((s) => `${s.ax},${s.ay},${s.bx},${s.by},${s.along}`)
        .sort();
    const out = route(shuffled, 0);
    expectWellFormed(shuffled, 0, out);
    const vertical = out.segments.filter((s) => s.ax === s.bx);
    expect(new Set(vertical.map((s) => s.ax)).size).toBe(1);
    expect(drawn(shuffled)).toEqual(drawn(sorted));
    // A T where each branch leaves the trunk, but at its two ends.
    expect(out.junctions).toHaveLength(readers - 1);
  });

  it('traces a trunk of thousands of readers without walking it for each', () => {
    const readers = 20_000;
    const placed = column(readers, (i) => i, 0);
    const ctx = { ...contextOf(placed), obstacles: () => {} };
    const out = new Recorder();
    const started = performance.now();
    routeOrthogonal(ctx, 0, out);
    const ms = performance.now() - started;
    console.log(`routed a trunk of ${readers} readers in ${ms.toFixed(1)} ms`);
    // Walking the trunk from its join for each reader took seconds here.
    expect(ms).toBeLessThan(500);
    expect(out.arrows).toHaveLength(readers);
    expect(out.junctions).toHaveLength(readers - 1);
  });

  it('jogs around a nearer reader to reach one further on at its height', () => {
    // SRC drives A in the next column and B two columns on, both inputs at one height: the
    // straight branch to B would run through A.
    const netlist = build({
      blocks: [
        { title: 'SRC', ports: [{ name: 'y', flow: 'out' }] },
        { title: 'A', ports: [{ name: 'u', flow: 'in' }] },
        { title: 'B', ports: [{ name: 'u', flow: 'in' }] },
      ],
      nets: [
        {
          ports: [
            [0, 'y'],
            [1, 'u'],
            [2, 'u'],
          ],
        },
      ],
    });
    const placed = columns(netlist, [[0], [1], [2]]);
    placed.positions[1] = placed.positions[1]! - 4 * G; // the driver sits higher
    const out = route(placed, 0);
    expectWellFormed(placed, 0, out);
    expect(pierced(placed, out.segments, [0, 1, 2])).toEqual([]);
    // B is entered straight from the left at its own height, from a jog past A.
    const [bx, by] = portAt(placed, 2);
    const into = out.segments.find((s) => s.bx === bx && s.by === by)!;
    expect(into.ay).toBe(by);
    expect(into.ax).toBeGreaterThan(extentRect(placed, 1)[2]);
  });

  it('keeps the fan-out trunk off the root run when every reader is level with the root', () => {
    const placed = fanOut();
    // Line A up with the driver: its branch is the root's run carried straight on.
    placed.positions[3] = placed.positions[1]! + portAt(placed, 0)[1] - portAt(placed, 1)[1];
    const out = route(placed, 0);
    const [sx, sy] = portAt(placed, 0);
    const [ax] = portAt(placed, 1);
    expect(out.segments).toContainEqual(expect.objectContaining({ ax: sx, ay: sy, by: sy }));
    const straight = out.segments.filter((s) => s.ay === sy && s.by === sy);
    expect(Math.max(...straight.map((s) => Math.max(s.ax, s.bx)))).toBe(ax);
  });

  it('turns back under both blocks for a reader directly left of its driver', () => {
    const placed = loop();
    const out = route(placed, 0);
    const [, , , drvBottom] = extentRect(placed, 0);
    const [rdrLeft, , , rdrBottom] = extentRect(placed, 1);
    const [, , drvRight] = extentRect(placed, 0);
    const lane = out.segments.find((s) => s.ay === s.by && s.ay > Math.max(drvBottom, rdrBottom));
    expect(lane).toBeDefined();
    expect(Math.min(lane!.ax, lane!.bx)).toBeLessThan(rdrLeft);
    expect(Math.max(lane!.ax, lane!.bx)).toBeGreaterThan(drvRight);
    // The wire leaves right, drops, runs left under both, climbs, and enters from the left.
    const [ux, uy] = portAt(placed, 2);
    const last = out.segments.find((s) => s.bx === ux && s.by === uy)!;
    expect(last.ay).toBe(uy);
    expect(last.ax).toBeLessThan(ux);
    expect(pierced(placed, out.segments, [0, 1])).toEqual([]);
  });

  it('turns back for a reader in the driver column, under both', () => {
    const placed = columns(twoArea(), [[0, 1, 2]]);
    const out = route(placed, 2); // speed: GENROU over TGOV1 over IEEET1
    expectWellFormed(placed, 2, out);
    const deepest = Math.max(...[0, 1, 2].map((b) => extentRect(placed, b)[3]));
    expect(out.segments.some((s) => s.ay === s.by && s.ay > deepest)).toBe(true);
    expect(pierced(placed, out.segments, [0, 1, 2])).toEqual([]);
  });

  it('routes the TwoArea unit like a hand-drawn diagram', () => {
    const placed = twoAreaPlaced();
    const [genrou, tgov1, ieeet1] = [0, 1, 2].map((b) => extentRect(placed, b));
    // pmech and efd jog between the columns.
    for (const net of [0, 1]) {
      for (const s of route(placed, net).segments.filter((s) => s.ax === s.bx)) {
        expect(s.ax).toBeGreaterThan(Math.max(tgov1![2], ieeet1![2]));
        expect(s.ax).toBeLessThan(genrou![0]);
      }
    }
    // speed feeds back under everything, climbs left of the first column, and branches to both.
    const speed = route(placed, 2);
    const bottom = Math.max(genrou![3], tgov1![3], ieeet1![3]);
    expect(speed.segments.some((s) => s.ay === s.by && s.ay > bottom)).toBe(true);
    const climbs = speed.segments.filter((s) => s.ax === s.bx && s.ax < tgov1![0]);
    expect(climbs.length).toBeGreaterThan(0);
    expect(speed.junctions.length).toBeGreaterThan(0);
    expect(speed.arrows.map(([x, y]) => key(x, y)).sort()).toEqual(
      [3, 5].map((p) => key(...portAt(placed, p))).sort(),
    );
  });

  it('nests the feedback wires of one block instead of overlapping them', () => {
    const placed = columns(plant('renewable'), [[2], [1], [0]]);
    const { prepared } = placed;
    // REGCA's four outputs feed back; each drops on its own line to its own lane.
    const feedback = [2, 3, 4, 5];
    const lanes = feedback.map((net) => {
      const out = route(placed, net);
      return Math.max(...out.segments.map((s) => Math.max(s.ay, s.by)));
    });
    expect(new Set(lanes).size).toBe(4);
    // The higher the port, the deeper its lane.
    const portY = feedback.map((net) => portAt(placed, prepared.netDriver[net]!)[1]);
    const byPort = feedback.map((_, i) => i).sort((a, b) => portY[a]! - portY[b]!);
    for (let i = 1; i < byPort.length; i++) {
      expect(lanes[byPort[i - 1]!]!).toBeGreaterThan(lanes[byPort[i]!]!);
    }
    for (const lane of lanes) expect(lane % G).toBe(0);
  });

  it('routes every plant of one shape alike, wherever it sits', () => {
    // Plants 4 to 7 repeat plants 0 to 3 eleven blocks on: every block index changes parity, so
    // a lane shift taken from indices would lower one instance's feedback and not the other's.
    const prepared = prepare(system(8), G);
    const placed: Placed = { prepared, positions: arrangeAll(prepared) };
    const u = units(prepared);
    expect(u.count).toBe(8);
    /** Every route inside a unit, relative to its first block's top-left. */
    const drawn = (unit: number): string[] => {
      const blocks = Array.from(u.blocks.subarray(u.start[unit]!, u.start[unit + 1]!));
      const ox = placed.positions[2 * blocks[0]!]!;
      const oy = placed.positions[2 * blocks[0]! + 1]!;
      const out: string[] = [];
      for (let net = 0; net < prepared.netCount; net++) {
        const ports = netPorts(prepared, net);
        if (!ports.every((port) => blocks.includes(prepared.portBlock[port]!))) continue;
        const r = route(placed, net);
        for (const s of r.segments) {
          out.push(`${s.ax - ox},${s.ay - oy} ${s.bx - ox},${s.by - oy} ${s.along}`);
        }
        for (const [x, y] of r.junctions) out.push(`junction ${x - ox},${y - oy}`);
        for (const [x, y, dx, dy] of r.arrows) out.push(`arrow ${x - ox},${y - oy} ${dx},${dy}`);
        if (r.anchorAt) out.push(`anchor ${r.anchorAt[0] - ox},${r.anchorAt[1] - oy}`);
      }
      return out;
    };
    for (let unit = 0; unit < 4; unit++) {
      const first = drawn(unit);
      // The classical plant is a lone machine with no wires.
      if (unit !== 3) expect(first.length).toBeGreaterThan(0);
      expect(drawn(unit + 4)).toEqual(first);
    }
  });

  it('puts an arrow at each in port, pointing into its block', () => {
    for (const [, scene] of scenes) {
      const placed = scene();
      const { prepared } = placed;
      for (let net = 0; net < prepared.netCount; net++) {
        const out = route(placed, net);
        const ports = shownPorts(placed, net);
        const inPorts = ports.filter((p) => prepared.netlist.portFlow[p] === FLOW_IN);
        if (ports.length < 2 || prepared.netStyle[net] !== 0) {
          expect(out.arrows).toEqual([]);
          continue;
        }
        expect(out.arrows).toHaveLength(inPorts.length);
        for (const p of inPorts) {
          const [x, y] = portAt(placed, p);
          const side = prepared.portSide[p]!;
          expect(out.arrows).toContainEqual([x, y, 0 - normalX(side), 0 - normalY(side)]);
        }
      }
    }
  });

  it('measures along from the root, continuing through every junction', () => {
    for (const [, scene] of scenes) {
      const placed = scene();
      for (let net = 0; net < placed.prepared.netCount; net++) {
        const out = route(placed, net);
        if (out.segments.length === 0) continue;
        const driver = placed.prepared.netDriver[net]!;
        const root = portAt(placed, driver === NONE ? netPorts(placed.prepared, net)[0]! : driver);
        const reached = new Map<string, number>();
        for (const s of out.segments) {
          reached.set(key(s.bx, s.by), s.along + Math.abs(s.bx - s.ax) + Math.abs(s.by - s.ay));
        }
        for (const s of out.segments) {
          if (s.ax === root[0] && s.ay === root[1]) {
            expect(s.along).toBe(0);
            continue;
          }
          expect(reached.get(key(s.ax, s.ay)), `net ${net} along`).toBeCloseTo(s.along, 3);
          expect(s.along).toBeGreaterThan(0);
        }
      }
    }
  });

  it('labels a net at the root stub end', () => {
    const placed = twoAreaPlaced();
    const [x, y] = portAt(placed, 4); // TGOV1 pmech drives net 0
    expect(route(placed, 0).anchorAt).toEqual([x + 2 * G, y]);
  });

  it('skips the ports of hidden blocks', () => {
    const placed = twoAreaPlaced();
    const blockVisible = Float32Array.of(1, 0, 1); // TGOV1 hidden
    expect(route(placed, 0, { blockVisible }).segments).toEqual([]); // pmech has one port left
    const speed = route(placed, 2, { blockVisible });
    const [hx, hy] = portAt(placed, 3);
    for (const s of speed.segments) {
      expect(key(s.ax, s.ay)).not.toBe(key(hx, hy));
      expect(key(s.bx, s.by)).not.toBe(key(hx, hy));
    }
    expect(speed.arrows).toHaveLength(1);
    expectWellFormed(placed, 2, speed, blockVisible);
  });

  it('joins the readers of a net whose driver is hidden', () => {
    const placed = twoAreaPlaced();
    const blockVisible = Float32Array.of(0, 1, 1); // GENROU hidden: speed has two readers left
    const out = route(placed, 2, { blockVisible });
    expect(out.segments.length).toBeGreaterThan(0);
    const reach = [3, 5].map((p) => key(...portAt(placed, p)));
    const ends = new Set(out.segments.flatMap((s) => [key(s.ax, s.ay), key(s.bx, s.by)]));
    for (const k of reach) expect(ends.has(k)).toBe(true);
    // Both readers are left of their column: the wire stays left of it.
    const left = extentRect(placed, 1)[0];
    for (const s of out.segments) expect(Math.max(s.ax, s.bx)).toBeLessThanOrEqual(left);
    expect(out.arrows).toHaveLength(2);
    expect(pierced(placed, out.segments, [1, 2])).toEqual([]);
    // The root is the first shown port, TGOV1's speed; its stub leaves to the left.
    const [x, y] = portAt(placed, 3);
    expect(out.anchorAt).toEqual([x - 2 * G, y]);
  });

  it('writes nothing for a tag net, a hidden net, or a lone port', () => {
    const tagged = columns({ ...twoArea(), netStyle: Uint8Array.of(0, 0, 1) }, [[1, 2], [0]]);
    const bus = route(tagged, 2);
    expect([bus.segments, bus.junctions, bus.arrows, bus.anchorAt]).toEqual([[], [], [], null]);
    const hidden = route(twoAreaPlaced(), 1, { netVisible: Float32Array.of(1, 0, 1) });
    expect(hidden.segments).toEqual([]);
    expect(hidden.anchorAt).toBeNull();
    const lone = columns(
      {
        blockCount: 1,
        portStart: Uint32Array.of(0, 1),
        portFlow: Uint8Array.of(1),
        netStart: Uint32Array.of(0, 1),
        netPorts: Uint32Array.of(0),
      },
      [[0]],
    );
    expect(route(lone, 0).segments).toEqual([]);
  });

  it('mirrors a flow that runs right to left', () => {
    // Flipped blocks: the driver's output on its left, the reader's input on its right.
    const netlist: Netlist = { ...twoArea(), portSide: Uint8Array.of(1, 1, 0, 1, 0, 1, 0) };
    const placed = columns(netlist, [[0], [1, 2]]); // GENROU left, TGOV1/IEEET1 right
    for (let net = 0; net < 3; net++) {
      const out = route(placed, net);
      expectWellFormed(placed, net, out);
      expect(pierced(placed, out.segments, allBlocks(placed))).toEqual([]);
    }
    // pmech leaves TGOV1 to the left and enters GENROU from the right.
    const pmech = route(placed, 0);
    const [gx, gy] = portAt(placed, 0);
    const into = pmech.segments.find((s) => s.bx === gx && s.by === gy)!;
    expect(into.ax).toBeGreaterThan(gx);
    expect(pmech.arrows).toEqual([[gx, gy, -1, 0]]);
  });

  it('enters top and bottom ports along their normals', () => {
    const netlist = build({
      blocks: [
        { title: 'SRC', ports: [{ name: 'y', flow: 'out' }] },
        { title: 'TOP', ports: [{ name: 'u', flow: 'in', side: SIDE_TOP }] },
        { title: 'BOT', ports: [{ name: 'u', flow: 'in', side: 3 }] },
      ],
      nets: [
        {
          ports: [
            [0, 'y'],
            [1, 'u'],
            [2, 'u'],
          ],
        },
      ],
    });
    for (const [label, cols] of [
      ['ahead', [[0], [1, 2]]],
      ['behind', [[1, 2], [0]]],
    ] as const) {
      const placed = columns(netlist, cols, { stack: 8 });
      const out = route(placed, 0);
      expectWellFormed(placed, 0, out);
      expect(pierced(placed, out.segments, allBlocks(placed)), label).toEqual([]);
      const [tx, ty] = portAt(placed, 1);
      const [bx, by] = portAt(placed, 2);
      expect(out.segments).toContainEqual(expect.objectContaining({ ax: tx, bx: tx, by: ty }));
      expect(out.segments).toContainEqual(expect.objectContaining({ ax: bx, bx: bx, by: by }));
      expect(out.arrows).toContainEqual([tx, ty, 0, 1]);
      expect(out.arrows).toContainEqual([bx, by, 0, -1]);
    }
  });

  it('keeps coordinates free of negative zero', () => {
    const netlist: Netlist = { ...twoArea(), portSide: Uint8Array.of(1, 1, 0, 1, 0, 1, 0) };
    const placed = columns(netlist, [[0], [1, 2]], { x: -64 });
    for (let net = 0; net < 3; net++) {
      for (const s of route(placed, net).segments) {
        for (const v of [s.ax, s.ay, s.bx, s.by]) expect(Object.is(v, -0)).toBe(false);
      }
    }
  });
});

describe('routeStraight', () => {
  it('draws one segment from the root to each port, arrows along them, no junctions', () => {
    const placed = twoAreaPlaced();
    const out = route(placed, 2, { mode: 'straight' });
    const root = portAt(placed, 2);
    expect(out.segments).toHaveLength(2);
    for (const [s, p] of [
      [out.segments[0]!, 3],
      [out.segments[1]!, 5],
    ] as const) {
      expect([s.ax, s.ay, s.along]).toEqual([...root, 0]);
      expect([s.bx, s.by]).toEqual([...portAt(placed, p)]);
    }
    expect(out.junctions).toEqual([]);
    expect(out.arrows).toHaveLength(2);
    for (const [x, y, dx, dy] of out.arrows) {
      expect(Math.hypot(dx, dy)).toBeCloseTo(1, 6);
      // The arrow points the way its wire runs: from the root toward the port.
      expect(dx * (x - root[0]) + dy * (y - root[1])).toBeGreaterThan(0);
    }
    expect(out.anchorAt).toEqual(root);
  });

  it('skips hidden ports and nets drawn as tags', () => {
    const placed = twoAreaPlaced();
    const out = route(placed, 2, { mode: 'straight', blockVisible: Float32Array.of(1, 1, 0) });
    expect(out.segments).toHaveLength(1);
    const tagged = columns({ ...twoArea(), netStyle: Uint8Array.of(1, 0, 0) }, [[1, 2], [0]]);
    expect(route(tagged, 0, { mode: 'straight' }).segments).toEqual([]);
  });
});

describe('routePreview', () => {
  const pairs = (points: Float32Array): (readonly [number, number])[] =>
    Array.from({ length: points.length / 2 }, (_, i) => [points[2 * i]!, points[2 * i + 1]!]);

  function expectOrthogonal(points: Float32Array): void {
    const at = pairs(points);
    for (let i = 1; i < at.length; i++) {
      const [ax, ay] = at[i - 1]!;
      const [bx, by] = at[i]!;
      expect(ax === bx || ay === by).toBe(true);
      expect(ax !== bx || ay !== by).toBe(true);
    }
  }

  it('leaves along the port side and bends once toward a point ahead', () => {
    const { prepared, positions } = twoAreaPlaced();
    const [px, py] = portAt({ prepared, positions }, 4);
    const points = routePreview(prepared, positions, 4, px + 100, py + 60, null);
    expect(pairs(points)).toEqual([
      [px, py],
      [px + 100, py],
      [px + 100, py + 60],
    ]);
  });

  it('runs the stub out first toward a point behind', () => {
    const { prepared, positions } = twoAreaPlaced();
    const [px, py] = portAt({ prepared, positions }, 4);
    const points = routePreview(prepared, positions, 4, px - 40, py + 30, null);
    expect(pairs(points)).toEqual([
      [px, py],
      [px + 2 * G, py],
      [px + 2 * G, py + 30],
      [px - 40, py + 30],
    ]);
  });

  it('leaves top and bottom ports vertically', () => {
    const placed = columns(
      build({ blocks: [{ ports: [{ name: 'b', flow: 'both' }] }], nets: [] }),
      [[0]],
    );
    const [px, py] = portAt(placed, 0);
    const up = routePreview(placed.prepared, placed.positions, 0, px + 50, py - 50, null);
    expect(pairs(up)).toEqual([
      [px, py],
      [px, py - 50],
      [px + 50, py - 50],
    ]);
    const down = routePreview(placed.prepared, placed.positions, 0, px + 50, py + 80, null);
    expect(pairs(down)[1]).toEqual([px, py - 2 * G]);
  });

  it('enters a target port the way a routed wire would', () => {
    const placed = twoAreaPlaced();
    const target = partId(PART_PORT, 1); // GENROU efd
    const points = routePreview(placed.prepared, placed.positions, 6, 0, 0, target);
    expectOrthogonal(points);
    const at = pairs(points);
    expect(at[0]).toEqual([...portAt(placed, 6)]);
    const [ex, ey] = portAt(placed, 1);
    expect(at[at.length - 1]).toEqual([ex, ey]);
    expect(at[at.length - 2]![1]).toBe(ey);
    expect(at[at.length - 2]![0]).toBeLessThan(ex);
    expect(at.length).toBeLessThanOrEqual(4);
  });

  it('turns back under the blocks into a target behind', () => {
    const placed = twoAreaPlaced();
    const points = routePreview(placed.prepared, placed.positions, 2, 0, 0, partId(PART_PORT, 3));
    expectOrthogonal(points);
    const at = pairs(points);
    expect(at[at.length - 1]).toEqual([...portAt(placed, 3)]);
    const bottom = Math.max(...[0, 1].map((b) => extentRect(placed, b)[3]));
    expect(at.some(([, y]) => y > bottom)).toBe(true);
  });

  it('ends at the point for a net target, and is empty for an unplaced port', () => {
    const placed = twoAreaPlaced();
    const points = routePreview(placed.prepared, placed.positions, 4, 300, 90, partId(PART_NET, 1));
    expect(pairs(points).at(-1)).toEqual([300, 90]);
    placed.positions[2] = Number.NaN;
    expect(routePreview(placed.prepared, placed.positions, 4, 300, 90, null)).toHaveLength(0);
  });
});

/** The entries of `count` wires from entry `start`: kind, net, and the four coordinates. */
function entries(mirror: Mirror, start: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const at = (start + i) * WIRE_WORDS;
    return {
      kind: mirror.u32[at + 5]!,
      net: mirror.u32[at + 4]!,
      a: [mirror.f32[at]!, mirror.f32[at + 1]!] as const,
      b: [mirror.f32[at + 2]!, mirror.f32[at + 3]!] as const,
      along: mirror.f32[at + 6]!,
    };
  });
}

function routes(placed: Placed) {
  const wires = new Mirror('wires', 'storage');
  const layout = new Mirror('layout', 'storage', layoutBases(placed.prepared).words);
  const r = new Routes(wires, layout);
  r.reset(placed.prepared);
  return { wires, layout, routes: r };
}

function drained(r: Routes): number[] {
  const nets: number[] = [];
  r.drain((net) => nets.push(net));
  return nets;
}

describe('Routes', () => {
  it('slots every net with headroom and writes its route there', () => {
    const placed = twoAreaPlaced();
    const { wires, routes: r } = routes(placed);
    r.routeAll(contextOf(placed));
    let expected = 0;
    for (let net = 0; net < 3; net++) {
      const { start, count } = r.slot(net);
      expect(start).toBe(expected);
      const next = net < 2 ? r.slot(net + 1).start : r.capacity;
      const room = next - start;
      expect(room).toBeGreaterThanOrEqual(Math.max(8, Math.ceil(count * 1.25)));
      const recorded = route(placed, net);
      const written = entries(wires, start, count);
      expect(written.filter((e) => e.kind === WIRE_SEGMENT)).toHaveLength(recorded.segments.length);
      expect(written.filter((e) => e.kind === WIRE_JUNCTION)).toHaveLength(
        recorded.junctions.length,
      );
      expect(written.filter((e) => e.kind === WIRE_ARROW)).toHaveLength(recorded.arrows.length);
      for (const e of written) expect(e.net).toBe(net);
      for (const e of entries(wires, start + count, room - count)) expect(e.kind).toBe(WIRE_EMPTY);
      expected = next;
    }
    expect(wires.words).toBe(r.capacity * WIRE_WORDS);
    expect(r.slotStart(1)).toBe(r.slot(1).start);
    expect(r.slotCount(1)).toBe(r.slot(1).count);
    expect(drained(r)).toEqual([0, 1, 2]);
    expect(drained(r)).toEqual([]);
  });

  it("writes each net's label anchor into the layout mirror", () => {
    const placed = columns({ ...twoArea(), netStyle: Uint8Array.of(0, 1, 0) }, [[1, 2], [0]]);
    const { layout, routes: r } = routes(placed);
    r.routeAll(contextOf(placed));
    const base = layoutBases(placed.prepared).anchor;
    const [x, y] = portAt(placed, 4);
    expect([layout.f32[base], layout.f32[base + 1]]).toEqual([x + 2 * G, y]);
    expect(Number.isNaN(layout.f32[base + 2]!)).toBe(true); // efd is drawn as tags
    expect(layout.dirtyFrom).toBeLessThanOrEqual(base);
    expect(layout.dirtyTo).toBeGreaterThanOrEqual(base + 6);
  });

  it('rewrites only the slot of a net that re-routes within it', () => {
    const placed = twoAreaPlaced();
    const { wires, layout, routes: r } = routes(placed);
    const ctx = contextOf(placed);
    r.routeAll(ctx);
    drained(r);
    const before = [0, 1, 2].map((net) => r.slot(net).start);
    const capacity = r.capacity;
    wires.clean();
    layout.clean();
    placed.positions[1] += 2 * G; // GENROU moves down: pmech and efd change
    r.reroute([0], ctx);
    expect([0, 1, 2].map((net) => r.slot(net).start)).toEqual(before);
    expect(r.capacity).toBe(capacity);
    const { start } = r.slot(0);
    expect(wires.dirtyFrom).toBeGreaterThanOrEqual(start * WIRE_WORDS);
    expect(wires.dirtyTo).toBeLessThanOrEqual(r.slot(1).start * WIRE_WORDS);
    const recorded = route(placed, 0);
    const written = entries(wires, start, r.slot(0).count).filter((e) => e.kind === WIRE_SEGMENT);
    expect(written.map((e) => [...e.a, ...e.b])).toEqual(
      recorded.segments.map((s) => [s.ax, s.ay, s.bx, s.by]),
    );
    expect(drained(r)).toEqual([0]);
  });

  it('clears what a shorter route no longer uses', () => {
    const placed = twoAreaPlaced();
    const { wires, routes: r } = routes(placed);
    const ctx = contextOf(placed);
    r.routeAll(ctx);
    const { start, count } = r.slot(0);
    // Line GENROU's pmech up with TGOV1's: one straight segment and an arrow.
    placed.positions[1] += portAt(placed, 4)[1] - portAt(placed, 0)[1];
    r.reroute(Uint32Array.of(0), ctx);
    const now = r.slot(0).count;
    expect(now).toBe(2);
    expect(now).toBeLessThan(count);
    for (const e of entries(wires, start + now, count - now)) expect(e.kind).toBe(WIRE_EMPTY);
  });

  it('repacks every slot when a route outgrows its own', () => {
    const placed = fanOut();
    const netlist = placed.prepared.netlist;
    // A second net after the fan-out, so the repack has a slot to move.
    const twoNets = columns(
      {
        ...netlist,
        blockCount: 5,
        portStart: Uint32Array.of(0, 1, 2, 3, 4, 6),
        portFlow: Uint8Array.of(1, 0, 0, 0, 1, 0),
        netStart: Uint32Array.of(0, 4, 6),
        netPorts: Uint32Array.of(0, 1, 2, 3, 4, 5),
        blockTitle: undefined,
        blockLabel: undefined,
        portLabel: undefined,
        netLabel: undefined,
        netStyle: undefined,
        portKind: undefined,
      },
      [
        [0, 4],
        [1, 2, 3],
      ],
    );
    const { wires, routes: r } = routes(twoNets);
    // The fan-out starts hidden: its slot holds the minimum.
    const hidden = contextOf(twoNets, { netVisible: Float32Array.of(0, 1) });
    r.routeAll(hidden);
    expect(r.slot(0)).toEqual({ start: 0, count: 0 });
    const secondBefore = r.slot(1);
    expect(secondBefore.start).toBe(8);
    const second = entries(wires, secondBefore.start, secondBefore.count);
    drained(r);
    const version = wires.version;
    wires.clean();

    r.reroute([0], contextOf(twoNets));
    const fan = route(twoNets, 0);
    const count = fan.segments.length + fan.junctions.length + fan.arrows.length;
    expect(count).toBeGreaterThan(8);
    expect(r.slot(0)).toEqual({ start: 0, count });
    const moved = r.slot(1);
    expect(moved.start).toBe(Math.max(8, count + Math.ceil(count / 4)));
    expect(entries(wires, moved.start, moved.count)).toEqual(second);
    expect(entries(wires, 0, count).every((e) => e.net === 0 && e.kind !== WIRE_EMPTY)).toBe(true);
    expect(r.capacity * WIRE_WORDS).toBe(wires.words);
    expect(
      wires.version > version || (wires.dirtyFrom === 0 && wires.dirtyTo === wires.words),
    ).toBe(true);
    expect(drained(r)).toEqual([0, 1]);
  });

  it('hides nets until they re-route, anchors and all', () => {
    const placed = twoAreaPlaced();
    const { wires, layout, routes: r } = routes(placed);
    const ctx = contextOf(placed);
    r.routeAll(ctx);
    drained(r);
    const { start, count } = r.slot(2);
    r.hide([2]);
    expect(r.slot(2)).toEqual({ start, count: 0 });
    for (const e of entries(wires, start, count)) expect(e.kind).toBe(WIRE_EMPTY);
    const base = layoutBases(placed.prepared).anchor;
    expect(Number.isNaN(layout.f32[base + 4]!)).toBe(true);
    expect(drained(r)).toEqual([2]);
    r.reroute([2], ctx);
    expect(r.slot(2)).toEqual({ start, count });
    expect(layout.f32[base + 4]).toBe(portAt(placed, 2)[0] + 2 * G);
  });

  it('switches to straight routes', () => {
    const placed = twoAreaPlaced();
    const { wires, routes: r } = routes(placed);
    r.routeAll(contextOf(placed, { mode: 'straight' }));
    const { start, count } = r.slot(2);
    const written = entries(wires, start, count);
    expect(written.filter((e) => e.kind === WIRE_SEGMENT)).toHaveLength(2);
    expect(written.filter((e) => e.kind === WIRE_JUNCTION)).toHaveLength(0);
  });

  it('binds nothing before a load and resets on a new netlist', () => {
    const wires = new Mirror('wires', 'storage');
    const layout = new Mirror('layout', 'storage');
    const r = new Routes(wires, layout);
    r.reset(null);
    expect(r.capacity).toBe(0);
    expect(r.slot(0)).toEqual({ start: 0, count: 0 });
    r.hide([0]);
    expect(drained(r)).toEqual([]);
    const placed = twoAreaPlaced();
    r.routeAll(contextOf(placed));
    expect(layout.words).toBeGreaterThanOrEqual(layoutBases(placed.prepared).words);
    expect(r.capacity).toBeGreaterThan(0);
    r.reset(null);
    expect(r.capacity).toBe(0);
    expect(wires.words).toBe(0);
  });

  it('routes a thousand blocks', () => {
    const plants = 400;
    const placed = shelf(system(plants), plantColumns(plants), 20);
    const { routes: r } = routes(placed);
    const started = performance.now();
    r.routeAll(contextOf(placed));
    const ms = performance.now() - started;
    console.log(
      `routed ${placed.prepared.netCount} nets of ${placed.prepared.blockCount} blocks in ` +
        `${ms.toFixed(0)} ms over brute-force obstacles`,
    );
    let entries = 0;
    for (let net = 0; net < placed.prepared.netCount; net++) entries += r.slot(net).count;
    expect(entries).toBeGreaterThan(placed.prepared.netCount);
    expect(r.capacity).toBeGreaterThanOrEqual(entries);
  });
});

describe('net labels', () => {
  const arranged: readonly (readonly [string, () => Netlist])[] = [
    ['steam plant', () => plant('steam')],
    ['PSS plant', () => plant('steamPss')],
    ['renewable plant', () => plant('renewable')],
    ['classical plant', () => plant('classical')],
    ['TwoArea unit', twoArea],
    ['eight plants', () => system(8)],
  ];

  it.each(arranged)('keeps every wire of the arranged %s off the labels', (name, netlist) => {
    const prepared = prepare(netlist(), G);
    const placed: Placed = { prepared, positions: arrangeAll(prepared) };
    const { wires, layout, routes: r } = routes(placed);
    r.routeAll(contextOf(placed));
    const base = layoutBases(prepared).anchor;
    const m = prepared.metrics;
    const labels = prepared.netlist.netLabel!;
    const segments = Array.from({ length: prepared.netCount }, (_, net): Segment[] => {
      const { start, count } = r.slot(net);
      return entries(wires, start, count)
        .filter((e) => e.kind === WIRE_SEGMENT)
        .map((e) => ({ ax: e.a[0], ay: e.a[1], bx: e.b[0], by: e.b[1], along: e.along }));
    });
    const crossed: string[] = [];
    let drawn = 0;
    for (let owner = 0; owner < prepared.netCount; owner++) {
      const ax = layout.f32[base + 2 * owner]!;
      const ay = layout.f32[base + 2 * owner + 1]!;
      if (!labels[owner] || Number.isNaN(ax)) continue;
      drawn++;
      const box = netLabelBox(m, ax, ay, textWidth(labels[owner], m.labelEm), [0, 0, 0, 0]);
      for (let net = 0; net < prepared.netCount; net++) {
        for (const s of segments[net]!) {
          // The run the label sits over, out of its anchor.
          const under =
            s.ay === ay && s.by === ay && Math.min(s.ax, s.bx) <= ax && ax <= Math.max(s.ax, s.bx);
          if (net === owner && under) continue;
          if (pierces(s, [box[0]!, box[1]!, box[2]!, box[3]!])) {
            crossed.push(`${labels[owner]} crossed by ${labels[net]}: ${JSON.stringify(s)}`);
          }
        }
      }
    }
    expect(crossed).toEqual([]);
    // A lone machine draws no wire and so no label; every other shape labels its wires.
    if (name !== 'classical plant') expect(drawn).toBeGreaterThan(0);
  });
});

describe('detached ports', () => {
  it('routes a net as if its detached port were off it', () => {
    const placed = twoAreaPlaced();
    const at = (out: Recorder, port: number): boolean => {
      const [x, y] = portAt(placed, port);
      return out.segments.some((s) => (s.ax === x && s.ay === y) || (s.bx === x && s.by === y));
    };
    const arrowAt = (out: Recorder, port: number): boolean => {
      const [x, y] = portAt(placed, port);
      return out.arrows.some(([ax, ay]) => ax === x && ay === y);
    };
    for (const mode of ['orthogonal', 'straight'] as const) {
      const router = mode === 'straight' ? routeStraight : routeOrthogonal;
      const whole = route(placed, 2, { mode });
      expect(at(whole, 5) && arrowAt(whole, 5)).toBe(true);
      const out = new Recorder();
      router({ ...contextOf(placed, { mode }), detached: 5 }, 2, out);
      expect(at(out, 5)).toBe(false);
      expect(arrowAt(out, 5)).toBe(false);
      expect(at(out, 2) && at(out, 3) && arrowAt(out, 3)).toBe(true);
      // `NONE` detaches nothing.
      const none = new Recorder();
      router({ ...contextOf(placed, { mode }), detached: NONE }, 2, none);
      expect(none.segments).toEqual(whole.segments);
    }
    // A net left with one port draws nothing.
    const lone = new Recorder();
    routeOrthogonal({ ...contextOf(placed), detached: 0 }, 0, lone);
    expect(lone.segments).toEqual([]);
    expect(lone.arrows).toEqual([]);
  });
});
