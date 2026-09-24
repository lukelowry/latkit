import { validateNetlist, type Netlist } from '@latkit/model';
import { describe, expect, it } from 'vitest';

import {
  BAND_BOTTOM,
  BAND_TOP,
  NONE,
  prepare,
  sameNetlist,
  SIDE_BOTTOM,
  SIDE_LEFT,
  SIDE_RIGHT,
  SIDE_TOP,
} from '../src/prepare.js';
import { build, empty, plant, randomNetlist, twoArea } from './fixtures/netlists.js';
import { randomBlocks } from './fixtures/text-netlists.js';

const G = 8;

describe('prepare', () => {
  it('sizes the TwoArea unit on the grid', () => {
    const p = prepare(twoArea(), G);
    // Each title clears the widest side label beside it by inset + textGap: GENROU's 43.2-wide
    // title and 'pmech'/'speed' (30) need 43.2 + 2 * (30 + 6 + 8) = 131.2 -> 144; TGOV1's 36-wide
    // title 124 -> 128; IEEET1's title and 'speed' 131.2 -> 144.
    expect(Array.from(p.size)).toEqual([144, 48, 128, 48, 144, 48]);
    for (const value of p.size) expect(value % (2 * G)).toBe(0);
    expect(Array.from(p.portOffset)).toEqual([
      0, 16, 0, 32, 144, 24, /* tgov1 */ 0, 24, 128, 24, /* ieeet1 */ 0, 24, 144, 24,
    ]);
    for (const value of p.portOffset) expect(value % G).toBe(0);
    expect(Array.from(p.extent)).toEqual(new Array(12).fill(0));
    expect(p.metrics.grid).toBe(G);
  });

  it('counts and inverts the netlist', () => {
    const p = prepare(twoArea(), G);
    expect([p.blockCount, p.portCount, p.netCount, p.groupCount]).toEqual([3, 7, 3, 0]);
    expect(Array.from(p.portBlock)).toEqual([0, 0, 0, 1, 1, 2, 2]);
    expect(Array.from(p.portNet)).toEqual([0, 1, 2, 2, 0, 2, 1]);
    expect(Array.from(p.netDriver)).toEqual([4, 6, 2]);
    expect(Array.from(p.blockNetStart)).toEqual([0, 3, 5, 7]);
    expect(Array.from(p.blockNets)).toEqual([0, 1, 2, 2, 0, 2, 1]);
  });

  it('resolves defaults', () => {
    const p = prepare(twoArea(), G);
    expect(Array.from(p.portSide)).toEqual([0, 0, 1, 0, 1, 0, 1]);
    expect(Array.from(p.portKind)).toEqual(new Array(7).fill(0));
    expect(Array.from(p.netStyle)).toEqual([0, 0, 0]);
    expect(Array.from(p.blockGroup)).toEqual([NONE, NONE, NONE]);
    expect(Array.from(p.netGroup)).toEqual([NONE, NONE, NONE]);
    expect(Array.from(p.groupStart)).toEqual([0]);
    expect(p.groupBlocks.length).toBe(0);
    expect(Array.from(p.tagLength)).toEqual(new Array(7).fill(0));

    const undirected = prepare(
      {
        blockCount: 1,
        portStart: Uint32Array.of(0, 3),
        portFlow: Uint8Array.of(2, 0, 1),
        netStart: Uint32Array.of(0),
        netPorts: new Uint32Array(0),
      },
      G,
    );
    expect(Array.from(undirected.portSide)).toEqual([SIDE_TOP, SIDE_LEFT, SIDE_RIGHT]);
  });

  it('borrows the columns a netlist supplies', () => {
    const netlist = { ...twoArea(), portKind: Uint8Array.of(0, 1, 2, 2, 0, 2, 1) };
    expect(prepare(netlist, G).portKind).toBe(netlist.portKind);
  });

  it('lists each net of a block once, in port order', () => {
    const p = prepare(
      {
        blockCount: 2,
        portStart: Uint32Array.of(0, 3, 4),
        portFlow: Uint8Array.of(2, 2, 2, 2),
        netStart: Uint32Array.of(0, 3),
        netPorts: Uint32Array.of(0, 2, 3),
      },
      G,
    );
    expect(Array.from(p.blockNetStart)).toEqual([0, 1, 2]);
    expect(Array.from(p.blockNets)).toEqual([0, 0]);
    expect(Array.from(p.portNet)).toEqual([0, NONE, 0, 0]);
    expect(Array.from(p.netDriver)).toEqual([NONE]);
  });

  it('builds group tables and the group each net stays within', () => {
    const grouped = prepare(
      { ...twoArea(), groupCount: 2, blockGroup: Uint32Array.of(1, NONE, 1) },
      G,
    );
    expect(Array.from(grouped.groupStart)).toEqual([0, 0, 2]);
    expect(Array.from(grouped.groupBlocks)).toEqual([0, 2]);
    // pmech touches ungrouped TGOV1, efd stays in group 1, speed touches TGOV1.
    expect(Array.from(grouped.netGroup)).toEqual([NONE, 1, NONE]);

    const whole = prepare({ ...twoArea(), groupCount: 1, blockGroup: Uint32Array.of(0, 0, 0) }, G);
    expect(Array.from(whole.groupBlocks)).toEqual([0, 1, 2]);
    expect(Array.from(whole.netGroup)).toEqual([0, 0, 0]);
  });

  it('maps keys to blocks', () => {
    expect(prepare(twoArea(), G).keys).toEqual(
      new Map([
        ['Genrou/1_1_genrou', 0],
        ['Tgov1/1_1_tgov1', 1],
        ['Ieeet1/1_1_ieeet1', 2],
      ]),
    );
    const { blockKey: _, ...unkeyed } = twoArea();
    expect(prepare(unkeyed, G).keys).toBeNull();
  });

  it('sizes tags and the extents they reach', () => {
    // speed drawn as tags: 0.5g gap + 2 * 0.5g pad + 9 columns * 0.6 * 10 = 66 -> 72.
    const p = prepare({ ...twoArea(), netStyle: Uint8Array.of(0, 0, 1) }, G);
    expect(Array.from(p.tagLength)).toEqual([0, 0, 72, 72, 0, 72, 0]);
    expect(Array.from(p.extent)).toEqual([0, 0, 72, 0, 72, 0, 0, 0, 72, 0, 0, 0]);
    for (const value of p.tagLength) expect(value % G).toBe(0);

    // An unlabeled tag net still gets a pill: 12 -> 16.
    const { netLabel: _, ...unlabeled } = twoArea();
    expect(prepare({ ...unlabeled, netStyle: Uint8Array.of(0, 0, 1) }, G).tagLength[2]).toBe(16);
  });

  it('reaches above and around a top tag', () => {
    const netlist: Netlist = {
      ...twoArea(),
      netStyle: Uint8Array.of(0, 0, 1),
      portSide: Uint8Array.of(0, 0, 1, 0, 1, SIDE_TOP, 1),
    };
    const p = prepare(netlist, G);
    // IEEET1: its title clears 'efd' (18) beside it: 43.2 + 2 * (18 + 14) = 107.2 -> 112. The
    // labeled top port takes a 16-tall band; the side region under it is two pitches.
    expect([p.size[4], p.size[5]]).toEqual([112, 48]);
    expect([p.portOffset[10], p.portOffset[11]]).toEqual([56, 0]);
    expect([p.portOffset[12], p.portOffset[13]]).toEqual([112, 32]);
    // A 72-long pill centered on x = 56 overhangs neither side; it rises tagHeight + tagGap.
    expect(Array.from(p.extent.subarray(8, 12))).toEqual([0, 20, 0, 0]);

    const narrow = prepare(
      {
        blockCount: 1,
        portStart: Uint32Array.of(0, 1),
        portFlow: Uint8Array.of(2),
        netStart: Uint32Array.of(0, 1),
        netPorts: Uint32Array.of(0),
        netStyle: Uint8Array.of(1),
        netLabel: ['a_very_long_bus_name'],
      },
      G,
    );
    // 4 + 8 + 20 * 6 = 132 -> 136, centered on x = 24 of a 48-wide block: 44 over each side.
    expect(narrow.tagLength[0]).toBe(136);
    expect(Array.from(narrow.extent)).toEqual([44, 20, 44, 0]);
  });

  it('leaves room under a block for its label', () => {
    const labels = ['1_1_genrou', 'x'.repeat(24), ''];
    const p = prepare({ ...twoArea(), blockLabel: labels }, G);
    // 0.5g gap + 1.25 * labelEm line; a 144-wide label overhangs TGOV1's 128 by 8 each side.
    expect(Array.from(p.extent)).toEqual([0, 0, 0, 16.5, 8, 0, 8, 16.5, 0, 0, 0, 0]);
  });

  it('keeps every size on the pitch and every offset on the grid at any pitch', () => {
    const netlists = [
      { ...twoArea(), netStyle: Uint8Array.of(1, 0, 0) },
      plant('steamPss'),
      plant('classical'),
      plant('renewable'),
      randomNetlist(200, 3),
      randomBlocks(300, 5),
    ];
    const off: string[] = [];
    const check = (values: Float32Array, quantum: number, what: string) => {
      values.forEach((value, i) => {
        if (value % quantum !== 0) off.push(`${what} ${i}: ${value}`);
      });
    };
    for (const grid of [4, 6, 8, 10, 12]) {
      netlists.forEach((netlist, n) => {
        const p = prepare(netlist, grid);
        check(p.size, 2 * grid, `netlist ${n} @${grid} size`);
        check(p.portOffset, grid, `netlist ${n} @${grid} offset`);
        check(p.tagLength, grid, `netlist ${n} @${grid} tag`);
      });
    }
    expect(off).toEqual([]);
  });

  it('reserves a band inside a top or bottom edge whose ports have labels', () => {
    const ports = [
      { name: 't', flow: 'both', side: SIDE_TOP },
      { name: 'b', flow: 'both', side: SIDE_BOTTOM },
      { name: 'a', flow: 'in' },
      { name: 'c', flow: 'in' },
    ] as const;
    const banded = build({ blocks: [{ title: 'BLK', ports }], nets: [] });
    const p = prepare(banded, G);
    // Two 16-tall bands around a three-pitch side region: 16 + 48 + 16.
    expect([p.size[0], p.size[1]]).toEqual([64, 80]);
    expect(p.bands[0]).toBe(BAND_TOP | BAND_BOTTOM);
    // Top and bottom ports on the edges; side ports centered in the side region [16, 64].
    expect(Array.from(p.portOffset)).toEqual([32, 0, 32, 80, 0, 32, 0, 48]);

    // Unlabeled top and bottom ports take no band: the block keeps its three pitches.
    const bare = { ...banded, portLabel: ['', '', 'a', 'c'] };
    const q = prepare(bare, G);
    expect(q.bands[0]).toBe(0);
    expect([q.size[0], q.size[1]]).toEqual([64, 48]);
    expect(Array.from(q.portOffset)).toEqual([32, 0, 32, 48, 0, 16, 0, 32]);

    // A top band over a block that needs little leaves a two-pitch side region, room for the
    // title with a gap above and below: the block stays three pitches tall.
    const small = build({
      blocks: [{ title: 'BLK', ports: [ports[0], ports[2], { name: 'o', flow: 'out' }] }],
      nets: [],
    });
    const s = prepare(small, G);
    expect(s.bands[0]).toBe(BAND_TOP);
    expect([s.size[0], s.size[1]]).toEqual([64, 48]);
    expect(Array.from(s.portOffset)).toEqual([32, 0, 0, 32, 64, 32]);
  });

  it('flags a band exactly where a top or bottom port has a label', () => {
    const netlist = randomBlocks(300, 6);
    const p = prepare(netlist, G);
    const seen = new Set<number>();
    for (let block = 0; block < p.blockCount; block++) {
      let expected = 0;
      for (let port = netlist.portStart[block]!; port < netlist.portStart[block + 1]!; port++) {
        if (!netlist.portLabel![port]) continue;
        if (p.portSide[port] === SIDE_TOP) expected |= BAND_TOP;
        if (p.portSide[port] === SIDE_BOTTOM) expected |= BAND_BOTTOM;
      }
      expect(p.bands[block]).toBe(expected);
      const [h, top, bottom] = [
        p.size[2 * block + 1]!,
        expected & 1 ? 16 : 0,
        expected & 2 ? 16 : 0,
      ];
      // The side region between the bands stays a whole number of pitches.
      expect((h - top - bottom) % (2 * G)).toBe(0);
      seen.add(expected);
    }
    expect(seen).toEqual(new Set([0, BAND_TOP, BAND_BOTTOM, BAND_TOP | BAND_BOTTOM]));
    expect(Array.from(prepare(twoArea(), G).bands)).toEqual([0, 0, 0]);
  });

  it('spaces top and bottom ports so their labels and tag pills keep a gap', () => {
    const top = (name: string) => ({ name, flow: 'both', side: SIDE_TOP }) as const;
    const labeled = prepare(
      build({ blocks: [{ ports: [top('alpha'), top('beta'), top('gamma')] }], nets: [] }),
      G,
    );
    // 'alpha' and 'gamma' are 30 wide: steps of ceil(30 + 8) -> 48, and the end labels stay
    // `inset` inside the corners: 96 + 30 + 12 = 138 -> 144.
    expect(labeled.size[0]).toBe(144);
    expect([0, 2, 4].map((i) => labeled.portOffset[i])).toEqual([24, 72, 120]);

    const unlabeled = prepare(
      {
        ...build({ blocks: [{ ports: [top('a'), top('b'), top('c')] }], nets: [] }),
        portLabel: ['', '', ''],
      },
      G,
    );
    // Without text the ports stay a pitch apart, with a pitch beyond each end: four pitches.
    expect(unlabeled.size[0]).toBe(64);
    expect([0, 2, 4].map((i) => unlabeled.portOffset[i])).toEqual([16, 32, 48]);

    const tagged = prepare(
      {
        ...build({
          blocks: [{ ports: [top('a'), top('b')] }],
          nets: [
            { label: 'bus_1', style: 1, ports: [[0, 'a']] },
            { label: 'bus_2', style: 1, ports: [[0, 'b']] },
          ],
        }),
        portLabel: ['', ''],
      },
      G,
    );
    // Two 48-long pills: steps of ceil(48 + 8) -> 64.
    expect(Array.from(tagged.tagLength)).toEqual([48, 48]);
    expect(tagged.portOffset[2]! - tagged.portOffset[0]!).toBe(64);
  });

  it('widens a title only for the side labels on rows near its middle', () => {
    const left = ['a_very_long_name', 'b', 'c', 'd', 'e'].map((name) => {
      return { name, flow: 'in' } as const;
    });
    const p = prepare(
      build({
        blocks: [{ title: 'TITLE', ports: [...left, { name: 'o', flow: 'out' }] }],
        nets: [],
      }),
      G,
    );
    // The long label sits two rows from the middle: only 'b', 'c', 'd' and 'o' (6 wide) are
    // beside the title, so it needs 36 + 2 * (6 + 14) = 76; the long label and 'o' need
    // 96 + 6 + 48 = 150 -> 160 anyway, not 36 + 2 * (96 + 14) = 256.
    expect([p.size[0], p.size[1]]).toEqual([160, 96]);
  });

  it('prepares the empty netlist', () => {
    const p = prepare(empty(), G);
    expect([p.blockCount, p.portCount, p.netCount, p.groupCount]).toEqual([0, 0, 0, 0]);
    expect(p.size.length).toBe(0);
    expect(Array.from(p.blockNetStart)).toEqual([0]);
  });

  it('takes the fixture as a valid netlist', () => {
    expect(() => validateNetlist(twoArea())).not.toThrow();
    expect(() => validateNetlist(empty())).not.toThrow();
    expect(() => validateNetlist(randomBlocks(300, 5))).not.toThrow();
  });
});

describe('sameNetlist', () => {
  it('compares content, not identity', () => {
    const a = twoArea();
    expect(sameNetlist(a, a)).toBe(true);
    expect(sameNetlist(a, twoArea())).toBe(true);
    expect(sameNetlist(empty(), empty())).toBe(true);
  });

  it('tells apart any changed column, label, or count', () => {
    const base = twoArea();
    const changed: readonly Partial<Netlist>[] = [
      { blockTitle: ['GENROU', 'TGOV1', 'IEEEST'] },
      { blockKey: undefined },
      { portFlow: Uint8Array.of(0, 0, 1, 0, 1, 0, 2) },
      { netPorts: Uint32Array.of(4, 0, 6, 1, 2, 5, 3) },
      { portSide: Uint8Array.of(0, 0, 1, 0, 1, 0, 1) },
      { netStyle: Uint8Array.of(0, 0, 0) },
      { groupCount: 1 },
      { netLabel: ['1_1_pmech', '1_1_efd', '1_2_speed'] },
      { portLabel: ['pmech', 'efd', 'speed', 'speed', 'pmech', 'speed'] },
    ];
    for (const patch of changed) {
      expect(sameNetlist(base, { ...base, ...patch }), JSON.stringify(Object.keys(patch))).toBe(
        false,
      );
    }
    expect(sameNetlist(base, { ...base, groupCount: 0 })).toBe(true);
  });
});
