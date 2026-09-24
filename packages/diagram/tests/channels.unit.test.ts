import { describe, expect, it } from 'vitest';

import {
  CHANNEL_KEYS,
  CHANNELS,
  channelDefinition,
  channelLayout,
  createChannels,
  SLOT,
  type Channel,
  type SlotChannel,
} from '../src/channels.js';
import { Mirror } from '../src/webgpu/buffers.js';
import { createUniforms, W_CHANNELS } from '../src/webgpu/uniforms.js';

const COUNTS = { blocks: 3, ports: 7, nets: 2 };

/** A slot's uniform record: offset, on, min, scale. */
function record(uniforms: ReturnType<typeof createUniforms>, channel: SlotChannel) {
  const at = W_CHANNELS + 4 * SLOT[channel];
  const { u32, f32 } = uniforms.mirror;
  return { offset: u32[at], on: u32[at + 1], min: f32[at + 2], scale: f32[at + 3] };
}

function make(counts: typeof COUNTS | null = COUNTS) {
  const mirror = new Mirror('channels', 'storage');
  const uniforms = createUniforms();
  const channels = createChannels(mirror, uniforms);
  channels.reset(counts);
  mirror.clean();
  return { mirror, uniforms, channels };
}

describe('CHANNELS', () => {
  it('names every channel in canonical order with its metadata', () => {
    expect(CHANNEL_KEYS).toEqual([
      'blockPosition',
      'blockColor',
      'blockVisible',
      'blockStatus',
      'blockShade',
      'portStatus',
      'netColor',
      'netFlow',
      'netVisible',
      'netShade',
    ]);
    expect(CHANNELS.blockPosition).toEqual({
      scope: 'block',
      map: 'position',
      label: 'Block Position',
      normalized: false,
      components: 2,
    });
    const normalized = CHANNEL_KEYS.filter((key) => CHANNELS[key].normalized);
    expect(normalized).toEqual(['blockColor', 'netColor']);
    expect(Object.isFrozen(CHANNELS)).toBe(true);
    for (const key of CHANNEL_KEYS) expect(Object.isFrozen(CHANNELS[key])).toBe(true);
  });

  it('gives every channel but blockPosition a slot, in canonical order', () => {
    expect(Object.keys(SLOT)).toEqual(CHANNEL_KEYS.slice(1));
    expect(Object.values(SLOT)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects an unknown channel', () => {
    expect(() => channelDefinition('vertexColor' as Channel)).toThrow(
      'unknown diagram channel vertexColor',
    );
  });
});

describe('channelLayout', () => {
  it('sizes each slot by its scope', () => {
    const { offsets, words } = channelLayout(COUNTS);
    // blocks x4, port x1, nets x4
    expect(offsets).toEqual([0, 3, 6, 9, 12, 19, 21, 23, 25]);
    expect(words).toBe(4 * 3 + 7 + 4 * 2);
    expect(channelLayout({ blocks: 0, ports: 0, nets: 0 }).words).toBe(0);
  });
});

describe('createChannels', () => {
  it('writes every slot offset, off, on reset', () => {
    const { uniforms, mirror } = make();
    expect(mirror.words).toBe(27);
    const { offsets } = channelLayout(COUNTS);
    for (const channel of CHANNEL_KEYS.slice(1) as SlotChannel[]) {
      expect(record(uniforms, channel)).toEqual({
        offset: offsets[SLOT[channel]],
        on: 0,
        min: 0,
        scale: 0,
      });
    }
  });

  it('throws before a load and for a wrong length or type, changing nothing', () => {
    const detached = make(null);
    expect(() => detached.channels.set('netColor', new Float32Array(2))).toThrow(
      'diagram netlist must be loaded before binding channels',
    );
    const { channels, uniforms, mirror } = make();
    expect(() => channels.set('netColor', new Float32Array(3))).toThrow(
      'diagram channel netColor length 3 != 2',
    );
    expect(() => channels.set('blockPosition', new Float32Array(3))).toThrow(
      'diagram channel blockPosition length 3 != 6',
    );
    expect(() => channels.set('portStatus', [0, 0, 0, 0, 0, 0, 0] as never)).toThrow(TypeError);
    expect(() => channels.set('netColor', Float32Array.of(1, 2), [2, 1])).toThrow(RangeError);
    expect(channels.values('netColor')).toBeNull();
    expect(record(uniforms, 'netColor').on).toBe(0);
    expect(mirror.dirtyTo).toBe(0);
  });

  it('writes a slot channel into its mirror slot and turns it on', () => {
    const { channels, uniforms, mirror } = make();
    channels.set('portStatus', Float32Array.of(0, 1, 0, 0, 2, 0, 0));
    const offset = channelLayout(COUNTS).offsets[SLOT.portStatus]!;
    expect(offset).toBe(12);
    expect(Array.from(mirror.f32.subarray(offset, offset + 7))).toEqual([0, 1, 0, 0, 2, 0, 0]);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([12, 19]);
    expect(record(uniforms, 'portStatus')).toEqual({ offset: 12, on: 1, min: 0, scale: 1 });
    const values = channels.values('portStatus')!;
    expect(Array.from(values)).toEqual([0, 1, 0, 0, 2, 0, 0]);
    // The snapshot is the slot itself: a rebind refreshes it in place.
    channels.set('portStatus', Float32Array.of(1, 1, 1, 1, 1, 1, 1));
    expect(channels.values('portStatus')).toBe(values);
    expect(values[0]).toBe(1);
  });

  it('keeps blockPosition as a CPU snapshot only', () => {
    const { channels, mirror } = make();
    const positions = Float32Array.of(0, 0, 16, NaN, NaN, 32);
    channels.set('blockPosition', positions);
    expect(mirror.dirtyTo).toBe(0);
    const snapshot = channels.values('blockPosition')!;
    expect(snapshot).not.toBe(positions);
    expect(Array.from(snapshot)).toEqual([0, 0, 16, NaN, NaN, 32]);
    positions[0] = 99;
    expect(snapshot[0]).toBe(0);
    channels.clear('blockPosition');
    expect(channels.values('blockPosition')).toBeNull();
  });

  it('normalizes colormap channels through an explicit domain, else [0, 1]', () => {
    const { channels, uniforms } = make();
    channels.set('netColor', Float32Array.of(-1, 1));
    expect(channels.domain('netColor')).toEqual([0, 1]);
    expect(record(uniforms, 'netColor')).toMatchObject({ on: 1, min: 0, scale: 1 });

    channels.set('netColor', Float32Array.of(-1, 1), [-1, 1]);
    expect(channels.domain('netColor')).toEqual([-1, 1]);
    expect(record(uniforms, 'netColor')).toMatchObject({ min: -1, scale: 0.5 });

    // A rebind without a domain returns to [0, 1].
    channels.set('netColor', Float32Array.of(-1, 1));
    expect(channels.domain('netColor')).toEqual([0, 1]);
  });

  it('overrides a domain until cleared, and ignores domains on raw channels', () => {
    const { channels, uniforms } = make();
    channels.set('blockColor', Float32Array.of(1, 2, 3), [0, 10]);
    channels.setDomain('blockColor', [1, 3]);
    expect(channels.domain('blockColor')).toEqual([1, 3]);
    expect(record(uniforms, 'blockColor')).toMatchObject({ min: 1, scale: 0.5 });
    // A rebind keeps the override over its own domain.
    channels.set('blockColor', Float32Array.of(1, 2, 3), [0, 4]);
    expect(channels.domain('blockColor')).toEqual([1, 3]);
    channels.setDomain('blockColor', null);
    expect(channels.domain('blockColor')).toEqual([0, 4]);
    expect(record(uniforms, 'blockColor')).toMatchObject({ min: 0, scale: 0.25 });

    channels.set('netFlow', Float32Array.of(1, -1), [5, 6]);
    channels.setDomain('netFlow', [5, 6]);
    expect(channels.domain('netFlow')).toBeNull();
    expect(record(uniforms, 'netFlow')).toMatchObject({ on: 1, min: 0, scale: 1 });
    expect(() => channels.setDomain('netColor', [3, 1])).toThrow(RangeError);
  });

  it('keeps a zero-width domain finite', () => {
    const { channels, uniforms } = make();
    channels.set('netColor', Float32Array.of(2, 2), [2, 2]);
    expect(Number.isFinite(record(uniforms, 'netColor').scale)).toBe(true);
  });

  it('turns a slot off on clear, keeping its offset', () => {
    const { channels, uniforms } = make();
    channels.set('netVisible', Float32Array.of(0, 1));
    channels.clear('netVisible');
    expect(channels.values('netVisible')).toBeNull();
    expect(record(uniforms, 'netVisible')).toEqual({ offset: 23, on: 0, min: 0, scale: 0 });
    expect(channels.domain('netVisible')).toBeNull();
  });

  it('clears everything on reset and resizes the slots', () => {
    const { channels, uniforms, mirror } = make();
    channels.set('blockPosition', new Float32Array(6));
    channels.set('blockShade', Float32Array.of(1, 2, 3));
    channels.set('netColor', Float32Array.of(0, 1), [0, 2]);
    channels.reset({ blocks: 1, ports: 2, nets: 3 });
    for (const key of CHANNEL_KEYS) expect(channels.values(key)).toBeNull();
    expect(channels.domain('netColor')).toBeNull();
    expect(record(uniforms, 'netColor')).toEqual({ offset: 6, on: 0, min: 0, scale: 0 });
    expect(mirror.words).toBe(4 * 1 + 2 + 4 * 3);
    const version = mirror.version;
    channels.reset(null);
    expect(mirror.words).toBe(0);
    // With no netlist the slots give their memory back.
    expect(mirror.capacity).toBe(4);
    expect(mirror.version).toBeGreaterThan(version);
    expect(() => channels.set('blockShade', new Float32Array(0))).toThrow('must be loaded');
  });
});
