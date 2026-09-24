import { describe, expect, it } from 'vitest';

import { build, plant, randomNetlist, twoArea } from './fixtures/netlists.js';
import { bulk, randomBlocks, rowLayout } from './fixtures/text-netlists.js';
import { fakeRasterizer } from './fixtures/text-rasterizer.js';
import { textWidth } from '../src/geometry.js';
import {
  BAND_BOTTOM,
  BAND_TOP,
  prepare,
  SIDE_BOTTOM,
  SIDE_TOP,
  type Prepared,
} from '../src/prepare.js';
import { Atlas } from '../src/text/atlas.js';
import { GLYPH_CAP, Labels, textRuns, type Runs } from '../src/text/labels.js';
import { ADVANCE, LINE } from '../src/text/metrics.js';
import {
  ANCHOR_BLOCK,
  ANCHOR_GROUP,
  ANCHOR_NET,
  ANCHOR_PORT,
  GLYPH_WIDE,
  GLYPH_WORDS,
  Mirror,
  ROLE_GROUP,
  ROLE_LABEL,
  ROLE_NET,
  ROLE_PORT,
  ROLE_TAG,
  ROLE_TITLE,
} from '../src/webgpu/buffers.js';

/** One run as a plain record. */
function run(runs: Runs, i: number) {
  return {
    anchor: runs.anchor[i]!,
    index: runs.index[i]!,
    role: runs.role[i]!,
    x: runs.offset[2 * i]!,
    y: runs.offset[2 * i + 1]!,
    em: runs.em[i]!,
    width: runs.width[i]!,
    text: runs.text[i]!,
  };
}

/** Every run of one role. */
function byRole(runs: Runs, role: number) {
  const out = [];
  for (let i = 0; i < runs.count; i++) if (runs.role[i] === role) out.push(run(runs, i));
  return out;
}

/** The graphemes of run `i`. */
function graphemesOf(runs: Runs, i: number): string[] {
  const t = runs.textId[i]!;
  return Array.from(runs.glyphs.subarray(runs.glyphStart[t]!, runs.glyphStart[t + 1]!), (g) => {
    return runs.graphemes[g]!;
  });
}

/** Glyphs every run in view would write: its graphemes that are not whitespace. */
function inked(runs: Runs, keep: (i: number) => boolean = () => true): number {
  let total = 0;
  for (let i = 0; i < runs.count; i++) {
    if (keep(i)) total += graphemesOf(runs, i).filter((g) => g.trim() !== '').length;
  }
  return total;
}

/** One glyph instance as a plain record. */
function glyph(mirror: Mirror, i: number) {
  const at = i * GLYPH_WORDS;
  return {
    anchor: mirror.u32[at]!,
    index: mirror.u32[at + 1]!,
    x: mirror.f32[at + 2]!,
    y: mirror.f32[at + 3]!,
    em: mirror.f32[at + 4]!,
    cell: mirror.u32[at + 5]!,
    role: mirror.u32[at + 6]!,
  };
}

/** Every glyph's `anchor/index/role` key, once. */
function keys(mirror: Mirror, count: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < count; i++) {
    const g = glyph(mirror, i);
    out.add(`${g.anchor}/${g.index}/${g.role}`);
  }
  return out;
}

/** `texts` behind a proxy that counts reads of its entries. */
function counted(texts: readonly string[], reads: { count: number }): readonly string[] {
  return new Proxy(texts, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads.count++;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

/** Labels over a prepared netlist with blocks in a row and a fake rasterizer. */
function setup(prepared: Prepared) {
  const layout = rowLayout(prepared);
  const glyphs = new Mirror('glyphs', 'storage');
  const raster = fakeRasterizer();
  const atlas = new Atlas(raster, 'mono');
  const labels = new Labels(glyphs, atlas);
  labels.reset(prepared);
  return { layout, glyphs, raster, atlas, labels };
}

const EVERYWHERE = [-1e5, -1e5, 1e5, 1e5] as const;

describe('textRuns', () => {
  it('centers titles in their blocks and puts port labels inside the edge', () => {
    const prepared = prepare(twoArea(), 8);
    const runs = textRuns(prepared);
    expect(runs.count).toBe(3 + 7 + 3);
    expect(Array.from(runs.role)).toEqual([0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4]);

    const titles = byRole(runs, ROLE_TITLE);
    expect(titles.map((t) => t.text)).toEqual(['GENROU', 'TGOV1', 'IEEET1']);
    // GENROU is 144 x 48; its title is 6 columns of 7.2 at em 12, one 15-unit line.
    expect(prepared.size.subarray(0, 2)).toEqual(Float32Array.of(144, 48));
    expect(titles[0]).toMatchObject({ anchor: ANCHOR_BLOCK, index: 0, em: 12 });
    expect(titles[0]!.width).toBeCloseTo(43.2, 5);
    expect(titles[0]!.x).toBeCloseTo(50.4, 5);
    expect(titles[0]!.y).toBeCloseTo(16.5, 5);
    for (const t of titles) {
      const w = prepared.size[2 * t.index]!;
      const h = prepared.size[2 * t.index + 1]!;
      expect(t.x).toBeCloseTo((w - t.width) / 2, 5);
      expect(t.y).toBeCloseTo((h - LINE * 12) / 2, 5);
    }

    const ports = byRole(runs, ROLE_PORT);
    expect(ports.map((p) => p.text)).toEqual(twoArea().portLabel);
    ports.forEach((p, port) => {
      const block = prepared.portBlock[port]!;
      const py = prepared.portOffset[2 * port + 1]!;
      expect(p).toMatchObject({ anchor: ANCHOR_BLOCK, index: block, em: 10 });
      expect(p.width).toBeCloseTo(p.text.length * ADVANCE * 10, 5);
      expect(p.y).toBeCloseTo(py - (LINE * 10) / 2, 5);
      if (prepared.portSide[port] === 0) expect(p.x).toBeCloseTo(6, 5);
      else expect(p.x + p.width).toBeCloseTo(prepared.size[2 * block]! - 6, 5);
    });
    // GENROU's speed output label ends 6 units inside its right edge, 14.4 clear of the title.
    expect(ports[2]!.x).toBeCloseTo(144 - 6 - 30, 5);
    expect(ports[2]!.x - (titles[0]!.x + titles[0]!.width)).toBeCloseTo(14.4, 5);

    const nets = byRole(runs, ROLE_NET);
    expect(nets.map((n) => [n.anchor, n.index, n.text])).toEqual([
      [ANCHOR_NET, 0, '1_1_pmech'],
      [ANCHOR_NET, 1, '1_1_efd'],
      [ANCHOR_NET, 2, '1_1_speed'],
    ]);
    for (const n of nets) {
      expect(n.x).toBeCloseTo(4, 5);
      expect(n.y + LINE * 10).toBeCloseTo(-2, 5);
    }
  });

  it('places block labels, top tags, and group labels of a plant', () => {
    const prepared = prepare(plant('steam'), 8);
    const runs = textRuns(prepared);

    const labels = byRole(runs, ROLE_LABEL);
    expect(labels.map((l) => l.text)).toEqual(['1_1_genrou', '1_1_tgov1', '1_1_ieeet1']);
    for (const l of labels) {
      const w = prepared.size[2 * l.index]!;
      expect(l).toMatchObject({ anchor: ANCHOR_BLOCK, em: 10 });
      expect(l.x).toBeCloseTo((w - l.width) / 2, 5);
      expect(l.y).toBeCloseTo(prepared.size[2 * l.index + 1]! + 4, 5);
    }

    // The bus is a tag net on the GENROU and IEEET1 bus ports, which sit on top.
    const tags = byRole(runs, ROLE_TAG);
    expect(tags.map((t) => [t.anchor, t.text])).toEqual([
      [ANCHOR_PORT, 'bus_1'],
      [ANCHOR_PORT, 'bus_1'],
    ]);
    for (const t of tags) {
      expect(prepared.portSide[t.index]).toBe(2);
      expect(t.x).toBeCloseTo(-t.width / 2, 5);
      // Centered in a 16-unit pill that starts 4 above the port.
      expect(t.y + (LINE * 10) / 2).toBeCloseTo(-(4 + 8), 5);
    }
    // A tag net draws no net label.
    expect(byRole(runs, ROLE_NET).map((n) => n.text)).toEqual([
      '1_1_pmech',
      '1_1_efd',
      '1_1_speed',
    ]);

    expect(byRole(runs, ROLE_GROUP)).toEqual([
      {
        anchor: ANCHOR_GROUP,
        index: 0,
        role: ROLE_GROUP,
        x: 8,
        y: 6,
        em: 12,
        width: expect.closeTo(9 * 7.2, 5) as number,
        text: 'plant 1_1',
      },
    ]);
  });

  it('places side and bottom tags, and drops a label below bottom tags', () => {
    const prepared = prepare(
      build({
        blocks: [
          {
            title: 'A',
            label: 'under',
            ports: [
              { name: 'l', flow: 'in' },
              { name: 'r', flow: 'out' },
              { name: 'b', flow: 'both', side: 3 },
              { name: 't', flow: 'both', side: 2 },
            ],
          },
          { title: 'B', ports: [{ name: 'x', flow: 'both' }] },
        ],
        nets: [
          { label: 'LEFT', style: 1, ports: [[0, 'l']] },
          { label: 'R', style: 1, ports: [[0, 'r']] },
          { label: 'BOT', style: 1, ports: [[0, 'b']] },
          {
            label: 'wire',
            ports: [
              [0, 't'],
              [1, 'x'],
            ],
          },
          { style: 1, ports: [] },
        ],
      }),
      8,
    );
    const runs = textRuns(prepared);
    const h = prepared.size[1]!;
    const line = LINE * 10;
    const tags = byRole(runs, ROLE_TAG);
    expect(tags.map((t) => [t.index, t.text])).toEqual([
      [0, 'LEFT'],
      [1, 'R'],
      [2, 'BOT'],
    ]);
    expect(tags[0]!.x + tags[0]!.width).toBeCloseTo(-8, 5);
    expect(tags[0]!.y).toBeCloseTo(-line / 2, 5);
    expect(tags[1]!.x).toBeCloseTo(8, 5);
    expect(tags[2]!.x).toBeCloseTo(-tags[2]!.width / 2, 5);
    expect(tags[2]!.y + line / 2).toBeCloseTo(4 + 8, 5);

    // The bottom port label starts at its 16-tall band's inner edge; the top one ends at its own.
    const ports = byRole(runs, ROLE_PORT);
    const px = (port: number) => prepared.portOffset[2 * port]!;
    expect(ports[2]!.x).toBeCloseTo(px(2) - ports[2]!.width / 2, 5);
    expect(ports[2]!.y).toBeCloseTo(h - 16, 5);
    expect(ports[3]!.x).toBeCloseTo(px(3) - ports[3]!.width / 2, 5);
    expect(ports[3]!.y + line).toBeCloseTo(16, 5);
    // The side ports and the title sit in the side region between the bands.
    const py = (port: number) => prepared.portOffset[2 * port + 1]!;
    expect(py(0)).toBe((16 + h - 16) / 2);
    expect(ports[0]!.y + line / 2).toBeCloseTo(py(0), 5);
    const [title] = byRole(runs, ROLE_TITLE);
    expect(title!.y + (LINE * 12) / 2).toBeCloseTo(h / 2, 5);

    // The label clears the bottom tag pill, landing inside the extent prepare reserved.
    const [label] = byRole(runs, ROLE_LABEL);
    expect(label!.y).toBeCloseTo(h + 16 + 4 + 4, 5);
    expect(label!.y + line).toBeCloseTo(h + prepared.extent[3]!, 5);
    expect(byRole(runs, ROLE_NET).map((n) => n.text)).toEqual(['wire']);
  });

  it('segments graphemes once per distinct text, wide ones taking two columns', () => {
    const prepared = prepare(
      build({
        blocks: [
          { title: '漢a', label: 'é!', ports: [{ name: 'speed', flow: 'in' }] },
          { title: 'x', ports: [{ name: 'speed', flow: 'in' }] },
        ],
        nets: [],
      }),
      8,
    );
    const runs = textRuns(prepared);
    const titles = byRole(runs, ROLE_TITLE);
    expect(titles[0]!.width).toBeCloseTo(3 * ADVANCE * 12, 5);
    expect(graphemesOf(runs, 0)).toEqual(['漢', 'a']);
    const wide = runs.glyphs[runs.glyphStart[runs.textId[0]!]!]!;
    expect(runs.wide[wide]).toBe(1);
    // A combining mark joins its base: two graphemes, two columns.
    expect(graphemesOf(runs, 2)).toEqual(['é', '!']);
    expect(runs.width[2]).toBeCloseTo(2 * ADVANCE * 10, 5);
    // Both port labels say speed: one text, one grapheme sequence.
    expect(runs.text[3]).toBe('speed');
    expect(runs.textId[3]).toBe(runs.textId[4]);
    expect(runs.glyphStart.length).toBe(new Set(runs.text).size + 1);
  });

  it('measures no run wider than prepare did', () => {
    const prepared = prepare(randomBlocks(200, 9), 8);
    const runs = textRuns(prepared);
    let narrower = 0;
    for (let i = 0; i < runs.count; i++) {
      // Widths are float32, so allow its rounding.
      const measured = textWidth(runs.text[i]!, runs.em[i]!);
      expect(runs.width[i]!).toBeLessThanOrEqual(measured + 1e-4);
      if (runs.width[i]! < measured - 1e-4) narrower++;
    }
    // A combining mark is a column to prepare but joins its base in a run.
    expect(narrower).toBeGreaterThan(0);
  });

  it('makes no runs for an empty or unlabeled netlist', () => {
    const prepared = prepare(
      { ...twoArea(), blockTitle: undefined, portLabel: undefined, netLabel: undefined },
      8,
    );
    expect(textRuns(prepared).count).toBe(0);
  });
});

/** A text run's line box `[x0, y0, x1, y1]` in its block's frame, with its role. */
interface Box {
  readonly role: number;
  readonly text: string;
  readonly box: readonly [number, number, number, number];
}

/** Every run that belongs to a block (its title, label, port labels, and tags), by block. */
function blockBoxes(prepared: Prepared, runs: Runs): Box[][] {
  const out: Box[][] = Array.from({ length: prepared.blockCount }, () => []);
  for (let i = 0; i < runs.count; i++) {
    const anchor = runs.anchor[i]!;
    const index = runs.index[i]!;
    let block: number;
    let x = runs.offset[2 * i]!;
    let y = runs.offset[2 * i + 1]!;
    if (anchor === ANCHOR_BLOCK) block = index;
    else if (anchor === ANCHOR_PORT) {
      block = prepared.portBlock[index]!;
      x += prepared.portOffset[2 * index]!;
      y += prepared.portOffset[2 * index + 1]!;
    } else continue;
    const box = [x, y, x + runs.width[i]!, y + LINE * runs.em[i]!] as const;
    out[block]!.push({ role: runs.role[i]!, text: runs.text[i]!, box });
  }
  return out;
}

/** How far apart two boxes are along the axis that separates them most; negative when they meet. */
function clearance(a: Box['box'], b: Box['box']): number {
  return Math.max(b[0] - a[2], a[0] - b[2], b[1] - a[3], a[1] - b[3]);
}

describe('block text layout', () => {
  const netlists = {
    twoArea: twoArea(),
    steam: plant('steam'),
    steamPss: plant('steamPss'),
    classical: plant('classical'),
    renewable: plant('renewable'),
    random: randomNetlist(300, 7),
    everySide: randomBlocks(400, 11),
    everySideAgain: randomBlocks(400, 12),
  };

  it('keeps every two text runs of one block from meeting', () => {
    const met: string[] = [];
    for (const [name, netlist] of Object.entries(netlists)) {
      for (const grid of [4, 8, 12]) {
        const prepared = prepare(netlist, grid);
        blockBoxes(prepared, textRuns(prepared)).forEach((boxes, block) => {
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i]!;
              const b = boxes[j]!;
              if (clearance(a.box, b.box) < -1e-6) {
                met.push(`${name} @${grid} block ${block}: ${a.text} / ${b.text}`);
              }
            }
          }
        });
      }
    }
    expect(met).toEqual([]);
  });

  it('keeps each title a text gap clear of the rest of its block, all inside the block', () => {
    const wrong: string[] = [];
    for (const [name, netlist] of Object.entries(netlists)) {
      for (const grid of [4, 8, 12]) {
        const prepared = prepare(netlist, grid);
        const gap = prepared.metrics.textGap;
        blockBoxes(prepared, textRuns(prepared)).forEach((boxes, block) => {
          const w = prepared.size[2 * block]!;
          const h = prepared.size[2 * block + 1]!;
          for (const a of boxes) {
            if (a.role !== ROLE_TITLE && a.role !== ROLE_PORT) continue;
            const where = `${name} @${grid} block ${block}: ${a.text}`;
            const [x0, y0, x1, y1] = a.box;
            // A block's title and port labels stay inside it.
            if (x0 < -1e-6 || y0 < -1e-6 || x1 > w + 1e-6 || y1 > h + 1e-6) {
              wrong.push(`${where} outside ${w} x ${h}`);
            }
            if (a.role !== ROLE_TITLE) continue;
            for (const b of boxes) {
              if (b !== a && clearance(a.box, b.box) < gap - 1e-6) {
                wrong.push(`${where} near ${b.text}`);
              }
            }
          }
        });
      }
    }
    expect(wrong).toEqual([]);
  });

  it('puts top and bottom labels in their bands, and side ports and the title between', () => {
    const prepared = prepare(netlists.everySide, 8);
    const { band, pitch } = prepared.metrics;
    const line = LINE * prepared.metrics.labelEm;
    const runs = textRuns(prepared);
    const region = (block: number): readonly [number, number] => {
      const bands = prepared.bands[block]!;
      const h = prepared.size[2 * block + 1]!;
      return [bands & BAND_TOP ? band : 0, h - (bands & BAND_BOTTOM ? band : 0)];
    };

    // Port label runs come in port order, one per labeled port.
    const labels = prepared.netlist.portLabel!;
    const labeled = Array.from({ length: prepared.portCount }, (_, port) => port).filter(
      (port) => labels[port],
    );
    const ports = byRole(runs, ROLE_PORT);
    expect(ports.length).toBe(labeled.length);
    const banded = [0, 0];
    labeled.forEach((port, i) => {
      const block = prepared.portBlock[port]!;
      const h = prepared.size[2 * block + 1]!;
      const y = prepared.portOffset[2 * port + 1]!;
      const [top, bottom] = region(block);
      const run = ports[i]!;
      expect(run.index).toBe(block);
      switch (prepared.portSide[port]) {
        case SIDE_TOP:
          banded[0]!++;
          expect(top).toBe(band);
          expect(run.y).toBeGreaterThanOrEqual(0);
          expect(run.y + line).toBeCloseTo(band, 5);
          break;
        case SIDE_BOTTOM:
          banded[1]!++;
          expect(bottom).toBe(h - band);
          expect(run.y).toBeCloseTo(h - band, 5);
          expect(run.y + line).toBeLessThanOrEqual(h);
          break;
        default:
          // Side ports sit in the side region, at least a pitch from its ends.
          expect(y).toBeGreaterThanOrEqual(top + pitch);
          expect(y).toBeLessThanOrEqual(bottom - pitch);
          expect(run.y + line / 2).toBeCloseTo(y, 5);
      }
    });
    expect(banded[0]).toBeGreaterThan(0);
    expect(banded[1]).toBeGreaterThan(0);

    const titles = byRole(runs, ROLE_TITLE);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      const [top, bottom] = region(title.index);
      expect(title.y + (LINE * title.em) / 2).toBeCloseTo((top + bottom) / 2, 5);
    }
  });
});

describe('Labels', () => {
  it('writes one instance per inked grapheme, its quad offset by the cell margin', () => {
    const prepared = prepare(plant('steam'), 8);
    const { layout, glyphs, atlas, labels } = setup(prepared);
    const runs = textRuns(prepared);
    const count = labels.update(EVERYWHERE, 1, layout, true, false);
    // The group label's space writes no instance.
    expect(count).toBe(inked(runs));
    expect(labels.count).toBe(count);
    expect(glyphs.words).toBe(count * GLYPH_WORDS);
    expect([glyphs.dirtyFrom, glyphs.dirtyTo]).toEqual([0, count * GLYPH_WORDS]);

    const title = run(runs, 0);
    for (let i = 0; i < 6; i++) {
      const g = glyph(glyphs, i);
      expect(g).toMatchObject({ anchor: ANCHOR_BLOCK, index: 0, em: 12, role: ROLE_TITLE });
      expect(g.cell).toBe(atlas.cell('GENROU'[i]!));
      // A 0.9 em cell centered on a 0.6 em advance: 0.15 em (1.8) of margin each side.
      expect(g.x).toBeCloseTo(title.x + 7.2 * i - 1.8, 4);
      expect(g.y).toBeCloseTo(title.y - 1.8, 4);
    }
  });

  it('advances two columns past a wide glyph and marks its cell wide', () => {
    const prepared = prepare(build({ blocks: [{ title: '漢a', ports: [] }], nets: [] }), 8);
    const { layout, glyphs, labels } = setup(prepared);
    const title = run(textRuns(prepared), 0);
    expect(labels.update(EVERYWHERE, 1, layout, true, false)).toBe(2);
    const wide = glyph(glyphs, 0);
    expect(wide.cell & GLYPH_WIDE).not.toBe(0);
    // A two-cell quad centered on a two-column advance: twice the margin.
    expect(wide.x).toBeCloseTo(title.x - 3.6, 4);
    const next = glyph(glyphs, 1);
    expect(next.cell & GLYPH_WIDE).toBe(0);
    expect(next.x).toBeCloseTo(title.x + 2 * 7.2 - 1.8, 4);
  });

  it('keeps runs whose line meets the window and anchors that have a position', () => {
    const prepared = prepare(twoArea(), 8);
    const { layout, glyphs, labels } = setup(prepared);
    // Net 1 has no anchor (no route); net 2's sits at x = 800, far outside.
    layout.f32[prepared.blockCount * 2 + 2] = Number.NaN;
    layout.f32[prepared.blockCount * 2 + 3] = Number.NaN;
    const count = labels.update([0, 0, 100, 100], 1, layout, true, false);
    // The window is [-50, -50, 150, 150]: GENROU (x 0) and net 0's anchor (0, -20) only.
    expect([...keys(glyphs, count)].sort()).toEqual(
      [
        `${ANCHOR_BLOCK}/0/${ROLE_TITLE}`,
        `${ANCHOR_BLOCK}/0/${ROLE_PORT}`,
        `${ANCHOR_NET}/0/${ROLE_NET}`,
      ].sort(),
    );
  });

  it('builds runs on the first update with a legible role and keeps them until a reset', () => {
    const base = plant('steam');
    const reads = { count: 0 };
    const netlist = {
      ...base,
      blockTitle: counted(base.blockTitle!, reads),
      portLabel: counted(base.portLabel!, reads),
    };
    const prepared = prepare(netlist, 8);
    const expected = inked(textRuns(prepared));
    reads.count = 0;
    // Binding reads no text, and neither does a view too small to read.
    const { layout, labels } = setup(prepared);
    expect(reads.count).toBe(0);
    expect(labels.update(EVERYWHERE, 0.3, layout, true, false)).toBe(0);
    expect(labels.update(EVERYWHERE, 1, layout, false, false)).toBe(0);
    expect(reads.count).toBe(0);
    // The first legible view builds the runs once; later views reuse them.
    expect(labels.update(EVERYWHERE, 1, layout, true, false)).toBe(expected);
    const built = reads.count;
    expect(built).toBeGreaterThan(0);
    expect(labels.update([0, 0, 100, 100], 2, layout, true, true)).toBeGreaterThan(0);
    expect(labels.update(EVERYWHERE, 0.3, layout, true, false)).toBe(0);
    expect(labels.update(EVERYWHERE, 1, layout, true, true)).toBe(expected);
    expect(reads.count).toBe(built);
    // A reset forgets them in constant time; the next legible view builds them again.
    labels.reset(prepared);
    expect(reads.count).toBe(built);
    expect(labels.update(EVERYWHERE, 1, layout, true, false)).toBe(expected);
    expect(reads.count).toBe(2 * built);
  });

  it('writes the same glyphs whether or not an illegible view came first', () => {
    const prepared = prepare(plant('renewable'), 8);
    const direct = setup(prepared);
    const count = direct.labels.update(EVERYWHERE, 1, direct.layout, true, false);
    const late = setup(prepared);
    expect(late.labels.update(EVERYWHERE, 0.2, late.layout, true, false)).toBe(0);
    expect(late.labels.update(EVERYWHERE, 1, late.layout, true, false)).toBe(count);
    const words = count * GLYPH_WORDS;
    expect(Array.from(late.glyphs.u32.subarray(0, words))).toEqual(
      Array.from(direct.glyphs.u32.subarray(0, words)),
    );
  });

  it('regenerates only when the view leaves its window, forced, or rebound', () => {
    const prepared = prepare(twoArea(), 8);
    const { layout, glyphs, labels } = setup(prepared);
    const all = labels.update([0, -100, 800, 500], 1, layout, true, false);
    glyphs.clean();
    // Inside the covered window [-400, -400, 1200, 800]: nothing is rewritten.
    expect(labels.update([300, -300, 1100, 300], 1, layout, true, false)).toBe(all);
    expect(labels.update([0, -100, 800, 500], 1.1, layout, true, false)).toBe(all);
    expect(glyphs.dirtyTo).toBe(0);
    // Past the window's right edge.
    expect(labels.update([500, -100, 1300, 500], 1, layout, true, false)).toBeLessThan(all);
    expect(glyphs.dirtyTo).toBeGreaterThan(0);
    glyphs.clean();
    labels.update([500, -100, 1300, 500], 1, layout, true, false);
    expect(glyphs.dirtyTo).toBe(0);
    labels.update([500, -100, 1300, 500], 1, layout, true, true);
    expect(glyphs.dirtyTo).toBeGreaterThan(0);
    glyphs.clean();
    labels.reset(prepared);
    expect(labels.count).toBe(0);
    labels.update([500, -100, 1300, 500], 1, layout, true, false);
    expect(glyphs.dirtyTo).toBeGreaterThan(0);
  });

  it('empties without labels, without runs, or without a usable view', () => {
    const prepared = prepare(twoArea(), 8);
    const { layout, glyphs, labels } = setup(prepared);
    const all = labels.update(EVERYWHERE, 1, layout, true, false);
    expect(all).toBeGreaterThan(0);
    expect(labels.update(EVERYWHERE, 1, layout, false, false)).toBe(0);
    expect(labels.count).toBe(0);
    expect(glyphs.words).toBe(0);
    glyphs.clean();
    expect(labels.update(EVERYWHERE, 1, layout, true, false)).toBe(all);
    expect(glyphs.dirtyTo).toBe(all * GLYPH_WORDS);
    expect(labels.update([0, 0, Number.NaN, 1], 1, layout, true, false)).toBe(0);
    expect(labels.update(EVERYWHERE, 0, layout, true, false)).toBe(0);
    expect(labels.update(EVERYWHERE, 1, layout, true, false)).toBe(all);
    const version = glyphs.version;
    labels.reset(null);
    // With no netlist the glyphs mirror gives its memory back.
    expect([glyphs.words, glyphs.capacity]).toEqual([0, 4]);
    expect(glyphs.version).toBeGreaterThan(version);
    expect(labels.update(EVERYWHERE, 1, layout, true, false)).toBe(0);
  });

  it('gives glyphs only to roles legible at the zoom, regenerating as one crosses', () => {
    const prepared = prepare(plant('steam'), 8);
    const { layout, glyphs, labels } = setup(prepared);
    const runs = textRuns(prepared);
    const big = (i: number) => runs.role[i] === ROLE_TITLE || runs.role[i] === ROLE_GROUP;
    // Titles and groups are 12 units, the rest 10: at zoom 0.4 only 12 * 0.4 = 4.8 >= 4.5.
    const titles = labels.update(EVERYWHERE, 0.4, layout, true, false);
    expect(titles).toBe(inked(runs, big));
    expect(new Set(Array.from({ length: titles }, (_, i) => glyph(glyphs, i).role))).toEqual(
      new Set([ROLE_TITLE, ROLE_GROUP]),
    );
    expect(labels.update(EVERYWHERE, 0.3, layout, true, false)).toBe(0);
    expect(labels.update(EVERYWHERE, 0.4, layout, true, false)).toBe(titles);
    expect(labels.update(EVERYWHERE, 0.45, layout, true, false)).toBe(inked(runs));
  });

  it('regenerates with fresh cells after the atlas changes fonts', () => {
    const prepared = prepare(twoArea(), 8);
    const { layout, glyphs, raster, atlas, labels } = setup(prepared);
    const all = labels.update(EVERYWHERE, 1, layout, true, false);
    const draws = raster.draws.length;
    expect(draws).toBe(new Set(textRuns(prepared).text.join('')).size);
    atlas.setFont('serif');
    glyphs.clean();
    expect(labels.update(EVERYWHERE, 1, layout, true, false)).toBe(all);
    expect(glyphs.dirtyTo).toBeGreaterThan(0);
    expect(raster.draws.length).toBe(2 * draws);
    expect(raster.draws.at(-1)!.font).toBe('40px serif');
    expect(glyph(glyphs, 0).cell).toBe(atlas.cell('G'));
  });

  it('writes nothing for blank cells when there is no rasterizer', () => {
    const prepared = prepare(twoArea(), 8);
    const layout = rowLayout(prepared);
    const glyphs = new Mirror('glyphs', 'storage');
    const labels = new Labels(glyphs, new Atlas(null, 'mono'));
    labels.reset(prepared);
    expect(labels.update(EVERYWHERE, 1, layout, true, false)).toBe(0);
  });

  it('drops net labels first when the window holds more than the cap', () => {
    // 2000 port labels of 100 and 1000 net labels of 100: 302k glyphs, 202k without nets.
    const prepared = prepare(
      bulk(2000, { title: 'T', port: 'p'.repeat(100), net: 'n'.repeat(100), nets: 1000 }),
      8,
    );
    const { layout, glyphs, labels } = setup(prepared);
    // Everything at the origin, so every run is in the window.
    layout.f32.fill(0);
    const count = labels.update(EVERYWHERE, 1, layout, true, false);
    expect(count).toBe(2000 + 200_000);
    const roles = new Set(Array.from({ length: count }, (_, i) => glyph(glyphs, i).role));
    expect(roles).toEqual(new Set([ROLE_TITLE, ROLE_PORT]));
  });

  it('drops roles in order until the rest fits', () => {
    // Nets 100k, ports 200k, labels 100k, titles 2k: dropping nets and ports leaves 102k.
    const prepared = prepare(
      bulk(2000, {
        title: 'T',
        label: 'l'.repeat(50),
        port: 'p'.repeat(100),
        net: 'n'.repeat(100),
        nets: 1000,
      }),
      8,
    );
    const { layout, glyphs, labels } = setup(prepared);
    // Everything at the origin, so every run is in the window.
    layout.f32.fill(0);
    const count = labels.update(EVERYWHERE, 1, layout, true, false);
    expect(count).toBe(2000 + 100_000);
    const roles = new Set(Array.from({ length: count }, (_, i) => glyph(glyphs, i).role));
    expect(roles).toEqual(new Set([ROLE_TITLE, ROLE_LABEL]));
  });

  it('truncates titles at the cap rather than dropping them', () => {
    const prepared = prepare(bulk(2700, { title: 't'.repeat(100), port: '', net: '', nets: 0 }), 8);
    const { layout, glyphs, labels } = setup(prepared);
    // Everything at the origin, so every run is in the window.
    layout.f32.fill(0);
    expect(labels.update(EVERYWHERE, 1, layout, true, false)).toBe(GLYPH_CAP);
    expect(glyphs.words).toBe(GLYPH_CAP * GLYPH_WORDS);
    expect(glyph(glyphs, GLYPH_CAP - 1).role).toBe(ROLE_TITLE);
  });
});
