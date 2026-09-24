import { describe, expect, it } from 'vitest';

import { NONE, prepare } from '../src/prepare.js';
import {
  BLOCK_TITLED,
  BLOCK_WORDS,
  createMirrors,
  DIRTY_MERGE_GAP,
  DIRTY_RANGE_LIMIT,
  focusBases,
  layoutBases,
  Mirror,
  NET_WORDS,
  packPort,
  PORT_FLOW_MASK,
  PORT_KIND_SHIFT,
  PORT_SIDE_SHIFT,
  PORT_TAG,
  PORT_WORDS,
  structureBases,
  UNIFORM_WORDS,
  writeStructure,
} from '../src/webgpu/buffers.js';
import { twoArea } from './fixtures/netlists.js';

describe('Mirror', () => {
  it('starts with at least four words of backing store, all of it dirty', () => {
    const empty = new Mirror('empty', 'storage');
    expect(empty.words).toBe(0);
    expect(empty.capacity).toBe(4);
    expect([empty.dirtyFrom, empty.dirtyTo]).toEqual([0, 0]);
    const sized = new Mirror('sized', 'uniform', 10);
    expect([sized.label, sized.usage, sized.words, sized.capacity]).toEqual([
      'sized',
      'uniform',
      10,
      10,
    ]);
    expect([sized.dirtyFrom, sized.dirtyTo]).toEqual([0, 10]);
    expect(sized.f32.buffer).toBe(sized.u32.buffer);
  });

  it('grows by half again, keeping contents and bumping the version', () => {
    const mirror = new Mirror('grow', 'storage', 8);
    mirror.u32.set([1, 2, 3, 4, 5, 6, 7, 8]);
    mirror.clean();
    const before = mirror.u32;
    mirror.resize(9);
    expect(mirror.version).toBe(1);
    expect(mirror.capacity).toBe(12);
    expect(mirror.u32).not.toBe(before);
    expect(Array.from(mirror.u32.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(mirror.f32.buffer).toBe(mirror.u32.buffer);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([0, 9]);
    mirror.resize(40);
    expect(mirror.capacity).toBe(40);
    expect(mirror.version).toBe(2);
  });

  it('resizes within capacity without a new version', () => {
    const mirror = new Mirror('shrink', 'storage', 16);
    mirror.clean();
    mirror.resize(4);
    mirror.resize(12);
    expect(mirror.version).toBe(0);
    expect(mirror.words).toBe(12);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([0, 0]);
    mirror.touch(10, 16);
    mirror.resize(11);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([10, 11]);
  });

  it('gives its memory back on release, under a new version, with nothing dirty', () => {
    const mirror = new Mirror('release', 'storage', 4096);
    mirror.touch(10, 20);
    mirror.touch(3000, 3100);
    const before = mirror.u32;
    mirror.release();
    expect(mirror.words).toBe(0);
    expect(mirror.capacity).toBe(4);
    expect(mirror.version).toBe(1);
    expect(mirror.u32).not.toBe(before);
    expect(mirror.f32.buffer).toBe(mirror.u32.buffer);
    expect(mirror.dirtyCount).toBe(0);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([0, 0]);
    // It grows again from nothing.
    mirror.resize(10);
    expect([mirror.words, mirror.version, mirror.dirtyFrom, mirror.dirtyTo]).toEqual([
      10, 2, 0, 10,
    ]);
  });

  it('merges touched ranges within the words in use', () => {
    const mirror = new Mirror('touch', 'storage', 100);
    mirror.clean();
    mirror.touch(10, 20);
    mirror.touch(40, 50);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([10, 50]);
    mirror.touch(5, 6);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([5, 50]);
    mirror.touch(90, 500);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([5, 100]);
    mirror.clean();
    mirror.touch(7, 7);
    mirror.touch(-5, 3);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([0, 3]);
    mirror.touchAll();
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([0, 100]);
  });

  it('keeps writes farther apart than the merge gap as ranges of their own', () => {
    const mirror = new Mirror('scattered', 'storage', 100_000);
    mirror.clean();
    mirror.touch(50_000, 50_002);
    mirror.touch(10, 12);
    mirror.touch(90_000, 90_004);
    expect(ranges(mirror)).toEqual([
      [10, 12],
      [50_000, 50_002],
      [90_000, 90_004],
    ]);
    // The union still spans them all.
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([10, 90_004]);

    // Within the gap of one range, a write joins it; a write bridging two joins both.
    mirror.touch(12 + DIRTY_MERGE_GAP - 1, 12 + DIRTY_MERGE_GAP);
    expect(ranges(mirror)[0]).toEqual([10, 12 + DIRTY_MERGE_GAP]);
    mirror.touch(40_000, 60_000);
    expect(ranges(mirror)).toEqual([
      [10, 12 + DIRTY_MERGE_GAP],
      [40_000, 60_000],
      [90_000, 90_004],
    ]);
    mirror.touch(60_000 + DIRTY_MERGE_GAP - 1, 89_000);
    expect(ranges(mirror)).toEqual([
      [10, 12 + DIRTY_MERGE_GAP],
      [40_000, 90_004],
    ]);
    // A gap of exactly the merge gap stays apart.
    mirror.touch(90_004 + DIRTY_MERGE_GAP, 90_005 + DIRTY_MERGE_GAP);
    expect(mirror.dirtyCount).toBe(3);
    mirror.clean();
    expect([mirror.dirtyCount, mirror.dirtyFrom, mirror.dirtyTo]).toEqual([0, 0, 0]);
  });

  it('folds into one span past the range limit', () => {
    const step = 2 * DIRTY_MERGE_GAP;
    const mirror = new Mirror('limit', 'storage', step * (DIRTY_RANGE_LIMIT + 1));
    mirror.clean();
    // Written back to front, so every range lands in front of the others.
    for (let i = DIRTY_RANGE_LIMIT - 1; i >= 0; i--) mirror.touch(i * step, i * step + 1);
    expect(ranges(mirror)).toEqual(
      Array.from({ length: DIRTY_RANGE_LIMIT }, (_, i) => [i * step, i * step + 1]),
    );
    mirror.touch(mirror.words - 2, mirror.words);
    expect(ranges(mirror)).toEqual([[0, mirror.words]]);
  });

  it('drops dirty ranges a shrink cuts off and clips the one it cuts through', () => {
    const mirror = new Mirror('shrink ranges', 'storage', 10_000);
    mirror.clean();
    mirror.touch(0, 4);
    mirror.touch(5000, 5010);
    mirror.touch(9000, 9004);
    mirror.resize(5004);
    expect(ranges(mirror)).toEqual([
      [0, 4],
      [5000, 5004],
    ]);
    mirror.resize(5000);
    expect(ranges(mirror)).toEqual([[0, 4]]);
    mirror.resize(0);
    expect([mirror.dirtyCount, mirror.dirtyFrom, mirror.dirtyTo]).toEqual([0, 0, 0]);
    // Growing past capacity dirties everything as one range.
    mirror.resize(20_000);
    expect(ranges(mirror)).toEqual([[0, 20_000]]);
  });
});

/** A mirror's dirty ranges as `[from, to]` pairs. */
function ranges(mirror: Mirror): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < mirror.dirtyCount; i++) {
    out.push([mirror.dirtyRanges[2 * i]!, mirror.dirtyRanges[2 * i + 1]!]);
  }
  return out;
}

describe('createMirrors', () => {
  it('creates the uniform block and seven empty storage mirrors', () => {
    const mirrors = createMirrors();
    expect(mirrors.uniforms.usage).toBe('uniform');
    expect(mirrors.uniforms.words).toBe(UNIFORM_WORDS);
    const storage = [
      mirrors.structure,
      mirrors.layout,
      mirrors.channels,
      mirrors.focus,
      mirrors.wires,
      mirrors.glyphs,
      mirrors.overlay,
    ];
    for (const mirror of storage) {
      expect(mirror.usage).toBe('storage');
      expect(mirror.words).toBe(0);
    }
    expect(new Set((Object.values(mirrors) as Mirror[]).map((mirror) => mirror.label)).size).toBe(
      8,
    );
  });
});

describe('bases', () => {
  const counts = { blockCount: 3, portCount: 7, netCount: 2, groupCount: 1 };

  it('lays out the structure mirror as blocks, ports, nets', () => {
    expect(structureBases(counts)).toEqual({
      port: 3 * BLOCK_WORDS,
      net: 3 * BLOCK_WORDS + 7 * PORT_WORDS,
      words: 3 * BLOCK_WORDS + 7 * PORT_WORDS + 2 * NET_WORDS,
    });
  });

  it('lays out the layout mirror as positions, group bounds, net anchors', () => {
    expect(layoutBases(counts)).toEqual({ group: 6, anchor: 10, words: 14 });
  });

  it('lays out the focus mirror as blocks, ports, nets, groups', () => {
    expect(focusBases(counts)).toEqual({ port: 3, net: 10, group: 12, words: 13 });
  });
});

describe('structure records', () => {
  it('packs a port word', () => {
    const packed = packPort(2, 3, 0xab, true);
    expect(packed & PORT_FLOW_MASK).toBe(2);
    expect((packed >>> PORT_SIDE_SHIFT) & 0x3).toBe(3);
    expect((packed >>> PORT_KIND_SHIFT) & 0xff).toBe(0xab);
    expect(packed & PORT_TAG).toBe(PORT_TAG);
    expect(packPort(1, 0, 0, false)).toBe(1);
  });

  it('writes blocks, ports, and nets where the shaders read them', () => {
    const prepared = prepare(
      {
        ...twoArea(),
        blockTitle: ['GENROU', '', 'IEEET1'],
        netStyle: Uint8Array.of(0, 0, 1),
        groupCount: 1,
        blockGroup: Uint32Array.of(0, NONE, 0),
      },
      8,
    );
    const mirror = new Mirror('structure', 'storage');
    mirror.clean();
    writeStructure(mirror, prepared);
    const { f32, u32 } = mirror;
    const bases = structureBases(prepared);
    expect(mirror.words).toBe(bases.words);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([0, bases.words]);

    // Blocks: w, h, group, flags.
    // Sizes come from prepare; this checks only where they land.
    expect([f32[0], f32[1], u32[2], u32[3]]).toEqual([
      prepared.size[0],
      prepared.size[1],
      0,
      BLOCK_TITLED,
    ]);
    expect([u32[BLOCK_WORDS + 2], u32[BLOCK_WORDS + 3]]).toEqual([NONE, 0]);

    // Port 2 (GENROU speed, out, right, on the tag net 2).
    const at = bases.port + 2 * PORT_WORDS;
    expect(u32[at]).toBe(0);
    expect([f32[at + 1], f32[at + 2]]).toEqual([prepared.portOffset[4], prepared.portOffset[5]]);
    expect(f32[at + 1]).toBe(prepared.size[0]);
    expect(u32[at + 3]).toBe(packPort(1, 1, 0, true));
    expect(u32[at + 4]).toBe(2);
    expect(f32[at + 5]).toBe(prepared.tagLength[2]);
    // Port 0 (GENROU pmech, in, left, wired).
    expect(u32[bases.port + 3]).toBe(packPort(0, 0, 0, false));

    // Nets: driver, group, style, port count.
    expect(Array.from(u32.subarray(bases.net, bases.net + 3 * NET_WORDS))).toEqual([
      4,
      NONE,
      0,
      2,
      /* efd */ 6,
      0,
      0,
      2,
      /* speed */ 2,
      NONE,
      1,
      3,
    ]);
  });
});
