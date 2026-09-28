/**
 * The diagram's channels: the registry of per-block, per-port, and per-net value streams, and how
 * a GPU channel's record reaches the uniforms its shaders read. `@latkit/gpu`'s `createChannels`
 * binds the GPU channels; `blockPosition` is the scene's placement.
 */

import type { Uniforms } from './webgpu/uniforms.js';

/**
 * Static metadata for one channel: its storage scope, how it maps, its label, and what it takes.
 */
interface ChannelDefinition {
  /** Storage cardinality: one value per block, per port, or per net. */
  readonly scope: 'block' | 'port' | 'net';
  /** What the values do. */
  readonly map: 'position' | 'colormap' | 'visible' | 'status' | 'shade' | 'flow';
  /** Display label a picker or legend shows. */
  readonly label: string;
  /** Whether values pass through an input domain; only the colormap channels do. */
  readonly normalized: boolean;
  /** Float words per item: every channel is a scalar except `blockPosition`, an `x, y` pair. */
  readonly components: 1 | 2;
  /**
   * Whether it can follow one signal of a series: every channel but the position and visibility
   * ones, whose change re-lays the scene.
   */
  readonly series: boolean;
}

const definitions = {
  blockPosition: {
    scope: 'block',
    map: 'position',
    label: 'Block Position',
    normalized: false,
    components: 2,
    series: false,
  },
  blockColor: {
    scope: 'block',
    map: 'colormap',
    label: 'Block Color',
    normalized: true,
    components: 1,
    series: true,
  },
  blockVisible: {
    scope: 'block',
    map: 'visible',
    label: 'Block Visible',
    normalized: false,
    components: 1,
    series: false,
  },
  blockStatus: {
    scope: 'block',
    map: 'status',
    label: 'Block Status',
    normalized: false,
    components: 1,
    series: true,
  },
  blockShade: {
    scope: 'block',
    map: 'shade',
    label: 'Block Shade',
    normalized: false,
    components: 1,
    series: true,
  },
  portStatus: {
    scope: 'port',
    map: 'status',
    label: 'Port Status',
    normalized: false,
    components: 1,
    series: true,
  },
  netColor: {
    scope: 'net',
    map: 'colormap',
    label: 'Net Color',
    normalized: true,
    components: 1,
    series: true,
  },
  netFlow: {
    scope: 'net',
    map: 'flow',
    label: 'Net Flow',
    normalized: false,
    components: 1,
    series: true,
  },
  netVisible: {
    scope: 'net',
    map: 'visible',
    label: 'Net Visible',
    normalized: false,
    components: 1,
    series: false,
  },
  netShade: {
    scope: 'net',
    map: 'shade',
    label: 'Net Shade',
    normalized: false,
    components: 1,
    series: true,
  },
} as const satisfies Record<string, ChannelDefinition>;

for (const definition of Object.values(definitions)) Object.freeze(definition);

/**
 * Every channel in canonical order, with its static metadata.
 *
 * @remarks
 * `blockPosition` places blocks: `x, y` top-left corners, a NaN pair handing a block back to its
 * automatic position. `blockVisible` and `netVisible` show only values above zero. `blockStatus`
 * and `portStatus` take integers: `0` is none, `k > 0` rings the item in status color `k`.
 * `netFlow` is a signed dash speed: `0` still, negative marching toward the driver. The shade
 * channels reach a `Shade` as `Fragment.value`. `blockColor` and `netColor` normalize through
 * their domain, `[0, 1]` unless one is given, onto the colormap. NaN is no value: a color,
 * status, or flow channel draws an item whose value is NaN as it would unbound.
 */
export const CHANNELS: Readonly<typeof definitions> = Object.freeze(definitions);

/** Named per-block, per-port, or per-net data stream that affects the diagram. */
export type Channel = keyof typeof CHANNELS;

/** The channels the GPU reads: every one but `blockPosition`, which the scene resolves. */
export type SlotChannel = Exclude<Channel, 'blockPosition'>;

/** The items a channel holds a value per. */
export type Scope = (typeof CHANNELS)[Channel]['scope'];

/** The GPU channels in slot order, as the channels bind them. */
export const SLOTTED: Readonly<Record<SlotChannel, (typeof CHANNELS)[SlotChannel]>> = (() => {
  const { blockPosition: _, ...slotted } = CHANNELS;
  return Object.freeze(slotted);
})();

/** Uniform record index of each GPU channel, in canonical order (0..8). */
export const SLOT: Readonly<Record<SlotChannel, number>> = Object.freeze({
  blockColor: 0,
  blockVisible: 1,
  blockStatus: 2,
  blockShade: 3,
  portStatus: 4,
  netColor: 5,
  netFlow: 6,
  netVisible: 7,
  netShade: 8,
});

/** How a GPU channel's record reaches its slot record in the uniforms. */
export function channelRecord(
  uniforms: Uniforms,
): (channel: SlotChannel, offset: number, bound: boolean, min: number, scale: number) => void {
  return (channel, offset, bound, min, scale) =>
    uniforms.setChannel(SLOT[channel], offset, bound, min, scale);
}
