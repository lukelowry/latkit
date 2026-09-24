import type { Netlist } from '@latkit/model';
import { describe, expect, it } from 'vitest';

import { Focus } from '../src/focus.js';
import { PART_BLOCK, PART_GROUP, PART_NET, PART_PORT, partId } from '../src/part.js';
import { NONE, prepare, type Prepared } from '../src/prepare.js';
import {
  FOCUS_COMPATIBLE,
  FOCUS_DRAGGING,
  FOCUS_HOVER,
  FOCUS_SELECTED,
  FOCUS_TARGET,
  focusBases,
  Mirror,
} from '../src/webgpu/buffers.js';
import { build, system, twoArea } from './fixtures/netlists.js';

const block = (index: number): number => partId(PART_BLOCK, index);
const port = (index: number): number => partId(PART_PORT, index);
const net = (index: number): number => partId(PART_NET, index);
const group = (index: number): number => partId(PART_GROUP, index);

function setup(netlist: Netlist = system(2)): {
  readonly mirror: Mirror;
  readonly focus: Focus;
  readonly p: Prepared;
} {
  const mirror = new Mirror('diagram focus', 'storage');
  const focus = new Focus(mirror);
  const p = prepare(netlist, 8);
  focus.reset(p);
  return { mirror, focus, p };
}

/** The focus word of a part id. */
function wordOf(p: Prepared, id: number): number {
  const bases = focusBases(p);
  const kind = Math.floor(id / 2 ** 30);
  const index = id % 2 ** 30;
  return [0, bases.port, bases.net, bases.group][kind]! + index;
}

function flags(mirror: Mirror, p: Prepared, id: number): number {
  return mirror.u32[wordOf(p, id)]!;
}

/** The words set, as `word: flags`. */
function set(mirror: Mirror): Record<number, number> {
  const out: Record<number, number> = {};
  for (let w = 0; w < mirror.words; w++) if (mirror.u32[w] !== 0) out[w] = mirror.u32[w]!;
  return out;
}

function dirty(mirror: Mirror): readonly [number, number] | null {
  return mirror.dirtyFrom < mirror.dirtyTo ? [mirror.dirtyFrom, mirror.dirtyTo] : null;
}

describe('Focus.reset', () => {
  it('sizes the mirror for every part and clears everything', () => {
    const { mirror, focus, p } = setup();
    expect(mirror.words).toBe(focusBases(p).words);
    focus.select([block(1), port(2)]);
    focus.setHover(net(0));
    focus.setGlow([port(3)], port(3));
    focus.setDragging(Uint32Array.of(1));
    mirror.clean();
    focus.reset(p);
    expect(set(mirror)).toEqual({});
    expect(dirty(mirror)).toEqual([0, mirror.words]);
    expect(focus.hover).toBeNull();
    expect(focus.selection.size).toBe(0);
    expect(focus.glowing).toBe(false);
    const version = mirror.version;
    focus.reset(null);
    expect(mirror.words).toBe(0);
    // With no netlist the mirror gives its memory back.
    expect(mirror.capacity).toBe(4);
    expect(mirror.version).toBeGreaterThan(version);
    expect(focus.select([block(0)])).toBe(false);
  });
});

describe('Focus.setHover', () => {
  it('moves the hover flag between parts of every kind, touching only its words', () => {
    const { mirror, focus, p } = setup();
    expect(focus.setHover(block(1))).toBe(true);
    expect(focus.hover).toBe(block(1));
    expect(set(mirror)).toEqual({ 1: FOCUS_HOVER });
    expect(focus.setHover(block(1))).toBe(false);
    for (const id of [port(4), net(2), group(1)]) {
      mirror.clean();
      expect(focus.setHover(id)).toBe(true);
      expect(set(mirror)).toEqual({ [wordOf(p, id)]: FOCUS_HOVER });
    }
    mirror.clean();
    expect(focus.setHover(null)).toBe(true);
    expect(set(mirror)).toEqual({});
    expect(dirty(mirror)).toEqual([wordOf(p, group(1)), wordOf(p, group(1)) + 1]);
    expect(focus.setHover(null)).toBe(false);
  });

  it('hovers nothing for an id that names no part', () => {
    const { mirror, focus, p } = setup();
    focus.setHover(block(0));
    expect(focus.setHover(block(p.blockCount))).toBe(true);
    expect(focus.hover).toBeNull();
    expect(focus.setHover(partId(4, 0))).toBe(false);
    expect(focus.setHover(group(p.groupCount))).toBe(false);
    expect(focus.setHover(1.5)).toBe(false);
    expect(set(mirror)).toEqual({});
  });
});

describe('Focus selection', () => {
  it('replaces the selection with valid ids once each, in order', () => {
    const { mirror, focus, p } = setup();
    expect(focus.select([block(0), port(3), block(0), block(99), net(1)])).toBe(true);
    expect([...focus.selection]).toEqual([block(0), port(3), net(1)]);
    expect(set(mirror)).toEqual({
      [wordOf(p, block(0))]: FOCUS_SELECTED,
      [wordOf(p, port(3))]: FOCUS_SELECTED,
      [wordOf(p, net(1))]: FOCUS_SELECTED,
    });
    mirror.clean();
    expect(focus.select([block(0), port(3), net(1)])).toBe(false);
    expect(dirty(mirror)).toBeNull();
    // Order is part of the selection: it is the order `select` events report.
    expect(focus.select([net(1), block(0), port(3)])).toBe(true);
    expect(dirty(mirror)).toBeNull();
    expect(focus.select([port(3)])).toBe(true);
    expect(set(mirror)).toEqual({ [wordOf(p, port(3))]: FOCUS_SELECTED });
    expect(focus.select([])).toBe(true);
    expect(set(mirror)).toEqual({});
    expect(focus.select([])).toBe(false);
  });

  it('toggles a part in and out of the selection', () => {
    const { mirror, focus } = setup();
    focus.toggle(block(2));
    focus.toggle(block(4));
    expect([...focus.selection]).toEqual([block(2), block(4)]);
    focus.toggle(block(2));
    expect([...focus.selection]).toEqual([block(4)]);
    expect(set(mirror)).toEqual({ 4: FOCUS_SELECTED });
    focus.toggle(block(999));
    expect([...focus.selection]).toEqual([block(4)]);
  });

  it('reports the selection as parts and its blocks in order', () => {
    const { focus } = setup();
    focus.select([port(1), block(2), group(0), block(0), net(3)]);
    expect(focus.parts()).toEqual([
      { kind: 'port', index: 1 },
      { kind: 'block', index: 2 },
      { kind: 'group', index: 0 },
      { kind: 'block', index: 0 },
      { kind: 'net', index: 3 },
    ]);
    expect(Array.from(focus.selectedBlocks())).toEqual([2, 0]);
  });
});

describe('Focus flags', () => {
  it('keeps each flag bit to its owner on a shared word', () => {
    const { mirror, focus, p } = setup();
    focus.select([block(1)]);
    focus.setHover(block(1));
    focus.setDragging(Uint32Array.of(1, 2));
    expect(flags(mirror, p, block(1))).toBe(FOCUS_SELECTED | FOCUS_HOVER | FOCUS_DRAGGING);
    expect(flags(mirror, p, block(2))).toBe(FOCUS_DRAGGING);
    focus.setHover(null);
    expect(flags(mirror, p, block(1))).toBe(FOCUS_SELECTED | FOCUS_DRAGGING);
    mirror.clean();
    // Block 2 keeps dragging: its word is not touched.
    focus.setDragging(Uint32Array.of(2, 3));
    expect(dirty(mirror)).toEqual([1, 4]);
    expect(set(mirror)).toEqual({ 1: FOCUS_SELECTED, 2: FOCUS_DRAGGING, 3: FOCUS_DRAGGING });
    focus.setDragging(null);
    expect(set(mirror)).toEqual({ 1: FOCUS_SELECTED });
  });

  it('glows compatible targets and marks the one a wire would land on', () => {
    const { mirror, focus, p } = setup();
    const compatible = [port(1), port(2), net(0), block(99)];
    focus.setGlow(compatible, port(2));
    expect(focus.glowing).toBe(true);
    expect(flags(mirror, p, port(1))).toBe(FOCUS_COMPATIBLE);
    expect(flags(mirror, p, port(2))).toBe(FOCUS_COMPATIBLE | FOCUS_TARGET);
    expect(flags(mirror, p, net(0))).toBe(FOCUS_COMPATIBLE);
    // A new target over the same glow touches only the two target words.
    mirror.clean();
    focus.setGlow(compatible, port(1));
    expect(dirty(mirror)).toEqual([wordOf(p, port(1)), wordOf(p, port(2)) + 1]);
    expect(flags(mirror, p, port(1))).toBe(FOCUS_COMPATIBLE | FOCUS_TARGET);
    expect(flags(mirror, p, port(2))).toBe(FOCUS_COMPATIBLE);
    focus.setGlow(compatible, null);
    expect(flags(mirror, p, port(1))).toBe(FOCUS_COMPATIBLE);
    // Another glow replaces this one.
    focus.setGlow([net(0), net(1)], net(1));
    expect(set(mirror)).toEqual({
      [wordOf(p, net(0))]: FOCUS_COMPATIBLE,
      [wordOf(p, net(1))]: FOCUS_COMPATIBLE | FOCUS_TARGET,
    });
    focus.setGlow(null, null);
    expect(focus.glowing).toBe(false);
    expect(set(mirror)).toEqual({});
  });
});

describe('Focus.remap', () => {
  it('maps blocks, ports, and nets through the survivors and clears hover', () => {
    const { mirror, focus, p: prev } = setup(twoArea());
    // TGOV1 then GENROU, which lost its speed port; IEEET1 is gone and a new block reads speed.
    const next = prepare(
      build({
        blocks: [
          {
            key: 'Tgov1/1_1_tgov1',
            ports: [
              { name: 'speed', flow: 'in' },
              { name: 'pmech', flow: 'out' },
            ],
          },
          {
            key: 'Genrou/1_1_genrou',
            ports: [
              { name: 'pmech', flow: 'in' },
              { name: 'efd', flow: 'in' },
            ],
          },
          { key: 'New/1', ports: [{ name: 'y', flow: 'out' }] },
        ],
        nets: [
          {
            ports: [
              [0, 'pmech'],
              [1, 'pmech'],
            ],
          },
          {
            ports: [
              [2, 'y'],
              [0, 'speed'],
            ],
          },
        ],
      }),
      8,
    );
    const survivors = Uint32Array.of(1, 0, NONE);
    focus.select([block(2), block(0), port(4), port(2), net(2), net(1)]);
    focus.setHover(block(0));
    focus.setGlow([port(3)], null);
    focus.remap(prev, next, survivors);
    // IEEET1 and GENROU's speed port are gone; speed survives through TGOV1's speed port; efd
    // had only IEEET1's port and GENROU's, which survives unwired, so it is gone too.
    expect([...focus.selection]).toEqual([block(1), port(1), net(1)]);
    expect(focus.hover).toBeNull();
    expect(focus.glowing).toBe(false);
    expect(mirror.words).toBe(focusBases(next).words);
    expect(set(mirror)).toEqual({
      [wordOf(next, block(1))]: FOCUS_SELECTED,
      [wordOf(next, port(1))]: FOCUS_SELECTED,
      [wordOf(next, net(1))]: FOCUS_SELECTED,
    });
  });

  it('maps groups through any surviving member', () => {
    const { focus, p: prev } = setup(system(3));
    const next = prepare(system(2), 8);
    // New blocks 0..2 carry old 7..9 (group 2); 3..6 carry old 3..6 (group 1); old group 0 is gone.
    const survivors = Uint32Array.of(7, 8, 9, 3, 4, 5, 6);
    focus.select([group(2), group(0), group(1), block(8)]);
    focus.remap(prev, next, survivors);
    expect([...focus.selection]).toEqual([group(0), group(1), block(1)]);
  });

  it('keeps nothing when the focus was already reset to the new netlist', () => {
    const { focus, p: prev } = setup(twoArea());
    const next = prepare(twoArea(), 8);
    focus.select([block(0)]);
    focus.reset(next);
    focus.remap(prev, next, Uint32Array.of(0, 1, 2));
    expect(focus.selection.size).toBe(0);
  });
});
