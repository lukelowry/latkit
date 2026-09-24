import { describe, expect, it } from 'vitest';

import { textWidth } from '../src/geometry.js';
import { PART_BLOCK, PART_GROUP, PART_NET, PART_PORT, partId } from '../src/part.js';
import { Picker } from '../src/pick/picker.js';
import { NONE, SIDE_TOP } from '../src/prepare.js';
import { LINE } from '../src/text/metrics.js';
import { FakeSource } from './fixtures/pick-source.js';
import { build, plant, random, randomNetlist, twoArea } from './fixtures/netlists.js';

const port = (index: number): number => partId(PART_PORT, index);
const block = (index: number): number => partId(PART_BLOCK, index);
const net = (index: number): number => partId(PART_NET, index);
const group = (index: number): number => partId(PART_GROUP, index);

/**
 * The TwoArea unit placed by hand: TGOV1 (1) at (0, 0), IEEET1 (2) at (0, 96), GENROU (0) at
 * (200, 48), with orthogonal routes written as the router would. The routes' coordinates assume
 * the first column is narrower than 160; tests that depend on a block's width read it from the
 * prepared sizes.
 *
 * Ports: GENROU 0 pmech (200, 64), 1 efd (200, 80), 2 speed (right edge, 72); TGOV1 3 speed
 * (0, 24), 4 pmech (right edge, 24); IEEET1 5 speed (0, 120), 6 efd (right edge, 120).
 */
function twoAreaScene(): { source: FakeSource; picker: Picker } {
  const source = new FakeSource(twoArea());
  source.place(0, 200, 48);
  source.place(1, 0, 0);
  source.place(2, 0, 96);
  source.route(0, [
    ['segment', 112, 24, 160, 24],
    ['segment', 160, 24, 160, 64],
    ['segment', 160, 64, 200, 64],
    ['arrow', 200, 64, 1, 0],
  ]);
  source.route(1, [
    ['segment', 96, 120, 176, 120],
    ['segment', 176, 120, 176, 80],
    ['segment', 176, 80, 200, 80],
    ['arrow', 200, 80, 1, 0],
  ]);
  source.route(2, [
    ['segment', 312, 72, 328, 72],
    ['segment', 328, 72, 328, 160],
    ['segment', 328, 160, -16, 160],
    ['segment', -16, 160, -16, 24],
    ['segment', -16, 24, 0, 24],
    ['junction', -16, 120],
    ['segment', -16, 120, 0, 120],
    ['arrow', 0, 24, 1, 0],
    ['arrow', 0, 120, 1, 0],
  ]);
  const picker = new Picker(source);
  picker.rebuild();
  return { source, picker };
}

/**
 * Blocks for the compatibility rules. Ports: D1 0 o (out), 1 i (in); D2 2 o (out); R1 3 a (in),
 * 4 b (in); R2 5 a (in); K 6 x (in, kind 1), 7 y (out, kind 1); B1 8, B2 9, B3 10 bus (both,
 * kind 1). Nets: 0 D1.o drives R1.a; 1 R2.a + R1.b with no driver; 2 a bus tag net B1 + B2.
 */
function rulesScene(): { source: FakeSource; picker: Picker } {
  const source = new FakeSource(
    build({
      blocks: [
        {
          title: 'D1',
          ports: [
            { name: 'o', flow: 'out' },
            { name: 'i', flow: 'in' },
          ],
        },
        { title: 'D2', ports: [{ name: 'o', flow: 'out' }] },
        {
          title: 'R1',
          ports: [
            { name: 'a', flow: 'in' },
            { name: 'b', flow: 'in' },
          ],
        },
        { title: 'R2', ports: [{ name: 'a', flow: 'in' }] },
        {
          title: 'K',
          ports: [
            { name: 'x', flow: 'in', kind: 1 },
            { name: 'y', flow: 'out', kind: 1 },
          ],
        },
        { title: 'B1', ports: [{ name: 'bus', flow: 'both', kind: 1 }] },
        { title: 'B2', ports: [{ name: 'bus', flow: 'both', kind: 1 }] },
        { title: 'B3', ports: [{ name: 'bus', flow: 'both', kind: 1 }] },
      ],
      nets: [
        {
          ports: [
            [0, 'o'],
            [2, 'a'],
          ],
        },
        {
          ports: [
            [3, 'a'],
            [2, 'b'],
          ],
        },
        {
          label: 'bus_1',
          style: 1,
          ports: [
            [5, 'bus'],
            [6, 'bus'],
          ],
        },
      ],
    }),
  );
  source.row([0, 1, 2, 3, 4, 5, 6, 7], 0, 0, 200);
  source.route(0, [source.between(0, 3)]);
  source.route(1, [source.between(5, 4)]);
  const picker = new Picker(source);
  picker.rebuild();
  return { source, picker };
}

describe('Picker.pick', () => {
  it('orders port, block, net, group', () => {
    const { picker } = twoAreaScene();
    expect(picker.pick(200, 64, 4)).toEqual([port(0), block(0), net(0)]);
    expect(picker.pick(160, 40, 4)).toEqual([net(0)]);
    expect(picker.pick(250, 70, 4)).toEqual([block(0)]);
    expect(picker.pick(600, 600, 4)).toEqual([]);
  });

  it('keeps the nearest part of each kind', () => {
    const { picker } = twoAreaScene();
    expect(picker.pick(200, 70, 10)[0]).toBe(port(0));
    expect(picker.pick(200, 75, 10)[0]).toBe(port(1));
    // Equidistant ports go to the lower index.
    expect(picker.pick(200, 72, 10)[0]).toBe(port(0));
    // 8 from net 0's horizontal run, 11.3 from net 1's corner.
    expect(picker.pick(168, 72, 12)).toEqual([net(0)]);
  });

  it('hits a port within max(radius, portSize) and a net within radius', () => {
    const { picker } = twoAreaScene();
    // portSize is one grid (8): a zero radius still reaches a port 5 away, but no wire.
    expect(picker.pick(205, 64, 0)).toEqual([port(0), block(0)]);
    expect(picker.pick(204, 60, 0)).toEqual([port(0), block(0)]);
    expect(picker.pick(196, 66, 0)).toEqual([port(0)]);
    // On the wire, 10 from the port.
    expect(picker.pick(190, 64, 0)).toEqual([net(0)]);
    expect(picker.pick(170, 70, 0)).toEqual([]);
    expect(picker.pick(170, 70, 6)).toEqual([net(0)]);
    // Junctions and arrows count as points of their net.
    expect(picker.pick(-20, 120, 5)).toEqual([net(2)]);
  });

  it('skips hidden blocks, their ports, and hidden nets', () => {
    const { source, picker } = twoAreaScene();
    source.hiddenBlocks.add(0);
    expect(picker.pick(200, 64, 4)).toEqual([net(0)]);
    source.hiddenBlocks.clear();
    source.hiddenNets.add(0);
    expect(picker.pick(200, 64, 4)).toEqual([port(0), block(0)]);
    expect(picker.pick(160, 40, 4)).toEqual([]);
  });

  it('hits a block label strip, a port tag pill, and a group frame', () => {
    const source = new FakeSource(plant('steam'));
    const p = source.prepared!;
    const m = p.metrics;
    source.row([0, 1, 2], 0, 0, 400);
    source.frame(0, -40, -60, 1200, 200);
    const picker = new Picker(source);
    picker.rebuild();

    const [w, h] = [p.size[0]!, p.size[1]!];
    const labelBottom = h + m.labelGap + LINE * m.labelEm;
    const labelHalf = Math.max(w, textWidth('1_1_genrou', m.labelEm)) / 2;
    expect(picker.pick(w / 2, h + m.labelGap + 1, 0)).toEqual([block(0), group(0)]);
    expect(picker.pick(w / 2 + labelHalf - 0.5, h + 2, 0)).toEqual([block(0), group(0)]);
    expect(picker.pick(w / 2, labelBottom + 1, 0)).toEqual([group(0)]);

    // GENROU's bus is a top port on the bus tag net: a pill above it.
    const bus = 0;
    expect(p.portSide[bus]).toBe(SIDE_TOP);
    expect(p.tagLength[bus]).toBeGreaterThan(0);
    const [px, py] = source.port(bus);
    const pillY = py - m.tagGap - m.tagHeight / 2;
    expect(picker.pick(px, pillY, 0)).toEqual([port(bus), group(0)]);
    expect(picker.pick(px + p.tagLength[bus]! / 2 - 0.5, pillY, 0)).toEqual([port(bus), group(0)]);
    expect(picker.pick(px + p.tagLength[bus]! / 2 + 0.5, pillY, 0)).toEqual([group(0)]);

    // No member shows: NaN bounds, no group.
    source.frame(0, NaN, NaN, NaN, NaN);
    picker.rebuild();
    expect(picker.pick(-20, -20, 0)).toEqual([]);
  });

  it('never picks the pill of a hidden tag net, only the port marker', () => {
    const source = new FakeSource(plant('steam'));
    const p = source.prepared!;
    const m = p.metrics;
    source.row([0, 1, 2], 0, 0, 400);
    const picker = new Picker(source);
    picker.rebuild();
    const bus = 0;
    const [px, py] = source.port(bus);
    // Inside the pill above the port, beyond the marker's reach.
    const pillY = py - m.tagGap - m.tagHeight / 2;
    expect(py - pillY).toBeGreaterThan(m.portSize);
    expect(picker.pick(px, pillY, 0)).toEqual([port(bus)]);
    source.hiddenNets.add(p.portNet[bus]!);
    expect(picker.pick(px, pillY, 0)).toEqual([]);
    expect(picker.pick(px, py, 0)).toEqual([port(bus), block(0)]);
  });

  it('agrees with a linear scan over a random netlist', () => {
    const source = new FakeSource(randomNetlist(400, 3));
    const p = source.prepared!;
    const m = p.metrics;
    const next = random(11);
    for (let b = 0; b < p.blockCount; b++) {
      source.place(b, Math.round(next() * 250) * 8, Math.round(next() * 250) * 8);
    }
    const picker = new Picker(source);
    picker.rebuild();
    const labels = p.netlist.blockLabel!;
    for (let probe = 0; probe < 400; probe++) {
      const x = next() * 2100;
      const y = next() * 2100;
      const radius = next() * 20;
      const got = picker.pick(x, y, radius);

      let bestPort = -1;
      let bestD = Infinity;
      for (let q = 0; q < p.portCount; q++) {
        const [px, py] = source.port(q);
        const d = Math.hypot(x - px, y - py);
        if (d <= Math.max(radius, m.portSize) && d < bestD) {
          bestPort = q;
          bestD = d;
        }
      }
      const containing = new Set<number>();
      for (let b = 0; b < p.blockCount; b++) {
        const bx = source.layout.f32[2 * b]!;
        const by = source.layout.f32[2 * b + 1]!;
        const [w, h] = [p.size[2 * b]!, p.size[2 * b + 1]!];
        const half = Math.max(w, textWidth(labels[b]!, m.labelEm)) / 2;
        const inRect = x >= bx && x <= bx + w && y >= by && y <= by + h;
        const inStrip =
          Math.abs(x - (bx + w / 2)) <= half &&
          y >= by + h &&
          y <= by + h + m.labelGap + LINE * m.labelEm;
        if (inRect || inStrip) containing.add(b);
      }

      const kinds = got.map((id) => Math.floor(id / 2 ** 30));
      expect(got.includes(port(bestPort))).toBe(bestPort >= 0);
      const picked = kinds.indexOf(PART_BLOCK);
      expect(picked >= 0).toBe(containing.size > 0);
      if (picked >= 0) expect(containing.has(got[picked]! % 2 ** 30)).toBe(true);
    }
  });
});

describe('Picker.marquee and obstacles', () => {
  it('selects visible blocks whose rectangles intersect, ascending', () => {
    const { source, picker } = twoAreaScene();
    const p = source.prepared!;
    // The first column's right edge; GENROU starts at x = 200.
    const right = Math.max(p.size[2]!, p.size[4]!);
    expect(right).toBeLessThan(190);
    expect(Array.from(picker.marquee(0, 0, 120, 60))).toEqual([1]);
    expect(Array.from(picker.marquee(120, 60, 0, 0))).toEqual([1]);
    expect(Array.from(picker.marquee(-50, -50, 500, 500))).toEqual([0, 1, 2]);
    expect(Array.from(picker.marquee(right + 2, 0, 190, 200))).toEqual([]);
    source.hiddenBlocks.add(1);
    expect(Array.from(picker.marquee(-50, -50, 500, 500))).toEqual([0, 2]);
  });

  it('visits blocks whose extent rectangles intersect a box', () => {
    const { source: twoAreaSource, picker } = twoAreaScene();
    const hits = (x0: number, y0: number, x1: number, y1: number): number[] => {
      const out: number[] = [];
      picker.obstacles(x0, y0, x1, y1, (b) => out.push(b));
      return out.sort();
    };
    expect(hits(100, 40, 210, 50)).toEqual([0, 1]);
    expect(hits(twoAreaSource.prepared!.size[2]! + 2, 0, 190, 40)).toEqual([]);

    // A label reaches below the rectangle; the extent counts, the port reach does not.
    const source = new FakeSource(plant('steam'));
    const p = source.prepared!;
    source.row([0, 1, 2], 0, 0, 400);
    const labelled = new Picker(source);
    labelled.rebuild();
    const h = p.size[1]!;
    const out: number[] = [];
    labelled.obstacles(10, h + p.extent[3]! - 1, 20, h + p.extent[3]! - 0.5, (b) => out.push(b));
    expect(out).toEqual([0]);
    out.length = 0;
    labelled.obstacles(10, h + p.extent[3]! + 1, 20, h + p.extent[3]! + 2, (b) => out.push(b));
    expect(out).toEqual([]);
  });

  it('meets extent interiors only, as the router asks: a run along an edge crosses nothing', () => {
    const { source, picker } = twoAreaScene();
    const hits = (x0: number, y0: number, x1: number, y1: number): number[] => {
      const out: number[] = [];
      picker.obstacles(x0, y0, x1, y1, (b) => out.push(b));
      return out.sort();
    };
    // TGOV1 spans (0, 0) to (w, 48); GENROU's left edge is at x = 200.
    const w = source.prepared!.size[2]!;
    expect(hits(w, 0, w, 48)).toEqual([]);
    expect(hits(w - 1, 0, w - 1, 48)).toEqual([1]);
    expect(hits(0, 48, 100, 48)).toEqual([]);
    expect(hits(0, 47, 100, 47)).toEqual([1]);
    expect(hits(200, 0, 200, 200)).toEqual([]);
    expect(hits(56, 24, 56, 24)).toEqual([1]);
    expect(hits(w, 0, 200, 48)).toEqual([]);
  });

  it('survives a query nested inside an obstacle visit', () => {
    const { picker } = twoAreaScene();
    const outer: number[] = [];
    const inner: number[][] = [];
    picker.obstacles(-50, -50, 500, 500, (b) => {
      outer.push(b);
      const nested: number[] = [];
      picker.obstacles(190, 40, 320, 100, (c) => nested.push(c));
      inner.push(nested);
    });
    expect(outer.sort()).toEqual([0, 1, 2]);
    expect(inner).toEqual([[0], [0], [0]]);
  });
});

describe('Picker incremental updates', () => {
  it('moves a block', () => {
    const { source, picker } = twoAreaScene();
    source.place(1, 500, 500);
    picker.moved(1);
    expect(picker.pick(550, 520, 0)).toEqual([block(1)]);
    expect(picker.pick(50, 20, 0)).toEqual([]);
    expect(Array.from(picker.marquee(490, 490, 510, 510))).toEqual([1]);
  });

  it('tests dragged blocks linearly and re-indexes them when the drag ends', () => {
    const { source, picker } = twoAreaScene();
    picker.setMoving(Uint32Array.of(2));
    // A drag writes positions without telling the picker.
    source.place(2, 800, 800);
    picker.moved(2);
    expect(picker.pick(840, 820, 0)).toEqual([block(2)]);
    expect(picker.pick(40, 110, 0)).toEqual([]);
    expect(Array.from(picker.marquee(790, 790, 810, 810))).toEqual([2]);
    const out: number[] = [];
    picker.obstacles(790, 790, 810, 810, (b) => out.push(b));
    expect(out).toEqual([2]);
    source.place(2, 1000, 1000);
    expect(picker.pick(1040, 1020, 0)).toEqual([block(2)]);

    picker.setMoving(null);
    expect(picker.pick(1040, 1020, 0)).toEqual([block(2)]);
    expect(picker.pick(840, 820, 0)).toEqual([]);
    expect(Array.from(picker.marquee(990, 990, 1010, 1010))).toEqual([2]);
  });

  it('tests the frames of dragged groups linearly', () => {
    const source = new FakeSource(plant('steam'));
    source.row([0, 1, 2], 0, 0, 400);
    source.frame(0, -40, -60, 1200, 200);
    const picker = new Picker(source);
    picker.rebuild();
    picker.setMoving(Uint32Array.of(0, 1, 2));
    source.row([0, 1, 2], 5000, 0, 400);
    source.frame(0, 4960, -60, 6200, 200);
    expect(picker.pick(4970, 150, 0)).toEqual([group(0)]);
    expect(picker.pick(-30, 150, 0)).toEqual([]);
    picker.setMoving(null);
    expect(picker.pick(4970, 150, 0)).toEqual([group(0)]);
    expect(picker.pick(-30, 150, 0)).toEqual([]);
  });

  it('refreshes a group frame after a member moves', () => {
    const source = new FakeSource(plant('steam'));
    source.row([0, 1, 2], 0, 0, 400);
    source.frame(0, -40, -60, 1200, 200);
    const picker = new Picker(source);
    picker.rebuild();
    source.place(2, 800, 600);
    source.frame(0, -40, -60, 1200, 800);
    picker.moved(2);
    expect(picker.pick(-30, 700, 0)).toEqual([group(0)]);
  });

  it('re-indexes a re-routed net, even over entries another net gave up', () => {
    for (const order of [
      [1, 0],
      [0, 1],
    ]) {
      const { source, picker } = twoAreaScene();
      // Net 0 moves to a new slot; net 1 takes net 0's old entries, leaving stale copies of its
      // own route behind in its old slot.
      source.route(0, [['segment', 400, 300, 600, 300]], 40);
      source.route(1, [['segment', 1000, 1000, 1100, 1000]], 0, 4);
      for (const n of order) picker.rerouted(n);
      expect(picker.pick(500, 300, 2)).toEqual([net(0)]);
      expect(picker.pick(1050, 1000, 2)).toEqual([net(1)]);
      expect(picker.pick(160, 40, 2)).toEqual([]);
      expect(picker.pick(176, 100, 2)).toEqual([]);
      expect(picker.pick(328, 100, 2)).toEqual([net(2)]);
    }
  });

  it('rebuilds lazily: obstacles build only the block grid, a pick builds the rest', () => {
    const { source } = twoAreaScene();
    let slots = 0;
    const slot = source.slot.bind(source);
    source.slot = (n: number) => {
      slots++;
      return slot(n);
    };
    const picker = new Picker(source);
    picker.rebuild();
    expect(slots).toBe(0);
    const found: number[] = [];
    picker.obstacles(100, 40, 210, 50, (b) => found.push(b));
    expect(found.sort()).toEqual([0, 1]);
    expect(slots).toBe(0);
    // Re-routes while the wire grid waits for its rebuild cost nothing.
    picker.rerouted(0);
    expect(slots).toBe(0);
    expect(picker.pick(160, 40, 4)).toEqual([net(0)]);
    expect(slots).toBe(3);
    picker.pick(160, 40, 4);
    expect(slots).toBe(3);
  });

  it('answers from the source as it is when a rebuild is pending', () => {
    const { source, picker } = twoAreaScene();
    expect(picker.pick(250, 70, 0)).toEqual([block(0)]);
    picker.rebuild();
    // Moves and re-routes made while the rebuild is pending, told or not, are all seen.
    source.place(0, 600, 600);
    picker.moved(0);
    source.place(1, 900, 900);
    source.route(0, [['segment', 400, 300, 500, 300]], 40);
    picker.rerouted(0);
    source.frame(0, 2000, 2000, 2100, 2100);
    expect(picker.pick(650, 620, 0)).toEqual([block(0)]);
    expect(picker.pick(250, 70, 0)).toEqual([]);
    expect(picker.pick(950, 920, 0)).toEqual([block(1)]);
    expect(picker.pick(450, 300, 2)).toEqual([net(0)]);
    expect(picker.pick(160, 40, 2)).toEqual([]);
    expect(Array.from(picker.marquee(890, 890, 910, 910))).toEqual([1]);
    // After the rebuild, incremental updates carry on.
    source.place(1, 0, 0);
    picker.moved(1);
    expect(picker.pick(50, 20, 0)).toEqual([block(1)]);
  });

  it('re-indexes a group frame it is told changed', () => {
    const source = new FakeSource(plant('steam'));
    source.row([0, 1, 2], 0, 0, 400);
    source.frame(0, -40, -60, 1200, 200);
    const picker = new Picker(source);
    picker.rebuild();
    expect(picker.pick(-30, 150, 0)).toEqual([group(0)]);
    source.frame(0, 3000, 3000, 3100, 3100);
    picker.framed(0);
    expect(picker.pick(-30, 150, 0)).toEqual([]);
    expect(picker.pick(3050, 3050, 0)).toEqual([group(0)]);
    // Out-of-range groups are ignored.
    picker.framed(7);
    picker.framed(-1);
  });

  it('rebuilds itself when the source loads another netlist', () => {
    const { source, picker } = twoAreaScene();
    source.load(randomNetlist(5, 2));
    source.row([0, 1, 2, 3, 4], 1000, 1000, 200);
    expect(picker.pick(1010, 1010, 0)).toEqual([block(0)]);
    expect(picker.pick(250, 70, 0)).toEqual([]);
    source.prepared = null;
    expect(picker.pick(1010, 1010, 0)).toEqual([]);
    expect(Array.from(picker.marquee(-1e4, -1e4, 1e4, 1e4))).toEqual([]);
    expect(picker.compatible(0, NONE)).toEqual([]);
    expect(picker.target(0, NONE, 0, 0, 10)).toBeNull();
    picker.moved(0);
    picker.rerouted(0);
    picker.setMoving(Uint32Array.of(0));
  });
});

describe('Picker compatibility', () => {
  it('lets an unwired driver reach free readers and driverless nets', () => {
    const { picker } = rulesScene();
    expect(picker.compatible(2, NONE)).toEqual([port(1), port(4), port(5), net(1)]);
  });

  it('lets an unwired reader reach any one driver of its kind', () => {
    const { picker } = rulesScene();
    expect(picker.compatible(1, NONE)).toEqual([
      port(0),
      port(2),
      port(3),
      port(4),
      port(5),
      net(0),
      net(1),
    ]);
  });

  it('removes the replaced port before applying the union rule', () => {
    const { picker } = rulesScene();
    // Picking up R1.a's wire: the fixed end is the driver D1.o.
    expect(picker.compatible(0, 3)).toEqual([port(1), port(4), port(5), net(1)]);
    // Replacing the driver frees the net for another driver.
    expect(picker.compatible(3, 0)).toEqual([port(1), port(2), port(4), port(5), net(1)]);
    expect(picker.compatible(3, NONE)).toEqual([port(1), port(4), port(5), net(1)]);
  });

  it('matches kinds and never offers a tag net as a net', () => {
    const { picker } = rulesScene();
    expect(picker.compatible(10, NONE)).toEqual([port(6), port(7), port(8), port(9)]);
    expect(picker.compatible(7, NONE)).toEqual([port(6), port(8), port(9), port(10)]);
  });

  it('skips hidden ports and nets, and rejects a port that is not one', () => {
    const { source, picker } = rulesScene();
    source.hiddenBlocks.add(3);
    source.hiddenNets.add(1);
    expect(picker.compatible(2, NONE)).toEqual([port(1), port(4)]);
    expect(picker.compatible(99, NONE)).toEqual([]);
    expect(picker.compatible(-1, NONE)).toEqual([]);
  });

  it('targets the nearest compatible port, else a compatible net', () => {
    const { source, picker } = rulesScene();
    const [ix, iy] = source.port(1);
    const [ox, oy] = source.port(0);
    // D1.o (incompatible for D2.o) is nearer than D1.i, which still wins.
    const mid = (ox + ix) / 2;
    expect(picker.target(2, NONE, mid + 1, (oy + iy) / 2, 200)).toBe(port(1));
    // From D1.i the nearer D1.o is compatible.
    expect(picker.target(1, NONE, mid + 1, (oy + iy) / 2, 200)).toBe(port(0));

    // Over the middle of net 1's wire: the net, when no compatible port is near.
    const [ax, ay] = source.port(5);
    const [bx, by] = source.port(4);
    const [cx, cy] = [(ax + bx) / 2, (ay + by) / 2];
    expect(picker.target(2, NONE, cx, cy, 4)).toBe(net(1));
    // Net 0 has a driver: nothing for another driver over its wire.
    const [dx, dy] = source.port(3);
    expect(picker.target(2, NONE, (ox + dx) / 2, (oy + dy) / 2, 4)).toBeNull();
    // Nothing near.
    expect(picker.target(2, NONE, -500, -500, 4)).toBeNull();
    expect(picker.target(99, NONE, cx, cy, 4)).toBeNull();
    // The replaced port is not a target, even under the pointer.
    const [rx, ry] = source.port(3);
    expect(picker.target(0, 3, rx, ry, 4)).not.toBe(port(3));
  });
});
