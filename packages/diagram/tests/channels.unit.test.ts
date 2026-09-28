import { describe, expect, it } from 'vitest';
import { createChannels } from '@latkit/gpu';
import { Series } from '@latkit/model';

import {
  CHANNELS,
  channelRecord,
  SLOT,
  SLOTTED,
  type Channel,
  type Scope,
  type SlotChannel,
} from '../src/channels.js';
import { Mirror } from '../src/webgpu/buffers.js';
import { createUniforms, W_CHANNELS } from '../src/webgpu/uniforms.js';

const COUNTS = { block: 3, port: 7, net: 2 };

/** A slot's uniform record: offset, on, min, scale. */
function record(uniforms: ReturnType<typeof createUniforms>, channel: SlotChannel) {
  const at = W_CHANNELS + 4 * SLOT[channel];
  const { u32, f32 } = uniforms.mirror;
  return { offset: u32[at], on: u32[at + 1], min: f32[at + 2], scale: f32[at + 3] };
}

/** The diagram's GPU channels as the controller builds them, over a channels mirror. */
function make(counts: typeof COUNTS | null = COUNTS) {
  const mirror = new Mirror('channels', 'storage');
  const uniforms = createUniforms();
  const channels = createChannels<SlotChannel, Scope>({
    name: 'diagram',
    structure: 'netlist',
    channels: SLOTTED,
    store: () => mirror,
    record: channelRecord(uniforms),
    shown: () => {},
    error: () => {},
  });
  channels.load(counts);
  mirror.resize(channels.words);
  mirror.clean();
  return { mirror, uniforms, channels };
}

describe('CHANNELS', () => {
  it('names every channel in canonical order with its metadata', () => {
    expect(Object.keys(CHANNELS)).toEqual([
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
      series: false,
    });
    const keys = Object.keys(CHANNELS) as Channel[];
    expect(keys.filter((key) => CHANNELS[key].normalized)).toEqual(['blockColor', 'netColor']);
    expect(keys.filter((key) => !CHANNELS[key].series)).toEqual([
      'blockPosition',
      'blockVisible',
      'netVisible',
    ]);
    expect(Object.isFrozen(CHANNELS)).toBe(true);
    for (const key of keys) expect(Object.isFrozen(CHANNELS[key])).toBe(true);
  });

  it('gives every channel but blockPosition a GPU slot and a uniform record, in canonical order', () => {
    expect(Object.keys(SLOTTED)).toEqual(Object.keys(CHANNELS).slice(1));
    expect(Object.keys(SLOT)).toEqual(Object.keys(SLOTTED));
    expect(Object.values(SLOT)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(SLOTTED.netColor).toBe(CHANNELS.netColor);
    expect(Object.isFrozen(SLOTTED)).toBe(true);
  });
});

describe('diagram channel records', () => {
  it('writes every slot offset, off, on a load', () => {
    const { uniforms, mirror } = make();
    // blocks x4, port x1, nets x4
    expect(mirror.words).toBe(4 * 3 + 7 + 4 * 2);
    const offsets = [0, 3, 6, 9, 12, 19, 21, 23, 25];
    for (const channel of Object.keys(SLOT) as SlotChannel[]) {
      expect(record(uniforms, channel)).toEqual({
        offset: offsets[SLOT[channel]],
        on: 0,
        min: 0,
        scale: 0,
      });
    }
  });

  it('writes a channel into its mirror slot, marks it for upload, and turns it on', () => {
    const { channels, uniforms, mirror } = make();
    channels.set('portStatus', Float32Array.of(0, 1, 0, 0, 2, 0, 0));
    expect(Array.from(mirror.f32.subarray(12, 19))).toEqual([0, 1, 0, 0, 2, 0, 0]);
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([12, 19]);
    // Raw channels read through the identity so a generic read needs no branch.
    expect(record(uniforms, 'portStatus')).toEqual({ offset: 12, on: 1, min: 0, scale: 1 });
  });

  it('normalizes colormap channels through their domain, else [0, 1]', () => {
    const { channels, uniforms } = make();
    channels.set('netColor', Float32Array.of(-1, 1));
    expect(record(uniforms, 'netColor')).toMatchObject({ on: 1, min: 0, scale: 1 });
    channels.set('netColor', Float32Array.of(-1, 1), [-1, 1]);
    expect(record(uniforms, 'netColor')).toMatchObject({ min: -1, scale: 0.5 });
  });

  it('refuses a series for a visibility channel, whose change re-lays the scene', () => {
    const { channels } = make();
    const series = Series.create({
      signals: ['x'],
      elementCount: 3,
      time: Float64Array.of(0),
      values: Float64Array.of(1, 2, 3),
    });
    expect(() => channels.set('blockVisible', { series, signal: 0 })).toThrow(
      new TypeError('diagram channel blockVisible cannot follow a series'),
    );
    expect(() => channels.set('blockColor', { series, signal: 0 })).not.toThrow();
    expect(() => make(null).channels.set('netColor', new Float32Array(2))).toThrow(
      'diagram netlist must be loaded before binding channels',
    );
  });
});

describe('Mirror as a channel store', () => {
  it('grows to hold what it is asked, keeping its words, and marks what it writes', () => {
    const mirror = new Mirror('channels', 'storage', 4);
    mirror.writeWords(1, Float32Array.of(7, 8));
    mirror.clean();
    mirror.reserve(2);
    expect(mirror.words).toBe(4);
    mirror.reserve(4000);
    expect(mirror.words).toBe(4000);
    expect(Array.from(mirror.f32.subarray(1, 3))).toEqual([7, 8]);
    mirror.clean();
    mirror.writeWords(3000, Float32Array.of(1));
    expect([mirror.dirtyFrom, mirror.dirtyTo]).toEqual([3000, 3001]);
  });
});
