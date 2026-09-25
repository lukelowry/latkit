import { validateDomain, type Domain } from '@latkit/model';

import type { Mirror } from './webgpu/buffers.js';
import type { Uniforms } from './webgpu/uniforms.js';

/**
 * Static metadata for one channel: its storage scope, how it maps, its label, and whether it takes
 * a domain.
 */
export interface ChannelDefinition {
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
}

const definitions = {
  blockPosition: {
    scope: 'block',
    map: 'position',
    label: 'Block Position',
    normalized: false,
    components: 2,
  },
  blockColor: {
    scope: 'block',
    map: 'colormap',
    label: 'Block Color',
    normalized: true,
    components: 1,
  },
  blockVisible: {
    scope: 'block',
    map: 'visible',
    label: 'Block Visible',
    normalized: false,
    components: 1,
  },
  blockStatus: {
    scope: 'block',
    map: 'status',
    label: 'Block Status',
    normalized: false,
    components: 1,
  },
  blockShade: {
    scope: 'block',
    map: 'shade',
    label: 'Block Shade',
    normalized: false,
    components: 1,
  },
  portStatus: {
    scope: 'port',
    map: 'status',
    label: 'Port Status',
    normalized: false,
    components: 1,
  },
  netColor: { scope: 'net', map: 'colormap', label: 'Net Color', normalized: true, components: 1 },
  netFlow: { scope: 'net', map: 'flow', label: 'Net Flow', normalized: false, components: 1 },
  netVisible: {
    scope: 'net',
    map: 'visible',
    label: 'Net Visible',
    normalized: false,
    components: 1,
  },
  netShade: { scope: 'net', map: 'shade', label: 'Net Shade', normalized: false, components: 1 },
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

/** Channels in canonical order. */
export const CHANNEL_KEYS = Object.freeze(Object.keys(CHANNELS) as Channel[]);

/** The channels the GPU reads: every one but `blockPosition`, which the scene resolves. */
export type SlotChannel = Exclude<Channel, 'blockPosition'>;

/** GPU slot index of each channel except blockPosition, in canonical order (0..8). */
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

/** The slot channels by slot index. */
const SLOTS = Object.freeze(Object.keys(SLOT) as SlotChannel[]);

/** Item counts a loaded netlist sizes every slot by. */
export interface Counts {
  readonly blocks: number;
  readonly ports: number;
  readonly nets: number;
}

/** Where every GPU channel lives in the channels mirror. */
export interface ChannelLayout {
  /** Word offset of each slot, by slot index. */
  readonly offsets: readonly number[];
  /** Total words: every slot, bound or not. */
  readonly words: number;
}

/**
 * The static storage layout for a netlist: every GPU channel owns a slot in `SLOT` order, so
 * binding one is one write and never a relayout.
 */
export function channelLayout(counts: Counts): ChannelLayout {
  const offsets: number[] = [];
  let words = 0;
  for (const channel of SLOTS) {
    offsets.push(words);
    words += itemsOf(CHANNELS[channel].scope, counts);
  }
  return { offsets, words };
}

/**
 * The static metadata for a channel.
 *
 * @throws Error when `channel` names no channel.
 */
export function channelDefinition(channel: Channel): ChannelDefinition {
  const def = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel] : undefined;
  if (!def) throw new Error(`unknown diagram channel ${String(channel)}`);
  return def;
}

/** Channel values, domains, and slot records for one controller. */
export interface Channels {
  /**
   * Size every slot for `counts`, clear every channel, write offsets; null (before a load, or
   * after a destroy) leaves no slots and gives the mirror's memory back.
   */
  reset(counts: Counts | null): void;
  /**
   * Validate the length for the loaded counts and bind, replacing what was bound.
   *
   * @throws Error before a load or for a wrong length; RangeError or TypeError for a bad domain.
   * Nothing changes when it throws.
   */
  set(channel: Channel, values: Float32Array | Float64Array, domain?: Domain | null): void;
  /** Unbind a channel; its slot stays allocated and turns off. False when nothing was bound. */
  clear(channel: Channel): boolean;
  /**
   * Override the input domain of a normalized channel, or return to its own with `null`; a raw
   * channel ignores it.
   *
   * @throws RangeError or TypeError for a bad domain.
   */
  setDomain(channel: Channel, domain: Domain | null): void;
  /** The input domain a bound normalized channel is using, or null. */
  domain(channel: Channel): Domain | null;
  /** The retained snapshot, or null when unbound. */
  values(channel: Channel): Float32Array | null;
}

/**
 * Channel values live in the `channels` mirror; per-slot offset/on/min/scale in the uniforms.
 *
 * @remarks
 * A slot channel's snapshot is a view of its slot in the mirror, so a bind is one copy and the
 * CPU reads what the GPU draws. `blockPosition` keeps only a CPU snapshot; the scene resolves it.
 */
export function createChannels(mirror: Mirror, uniforms: Uniforms): Channels {
  let counts: Counts | null = null;
  let layout: ChannelLayout = channelLayout({ blocks: 0, ports: 0, nets: 0 });
  const bound = new Map<Channel, Float32Array>();
  const data = new Map<Channel, Domain>();
  const override = new Map<Channel, Domain>();

  function writeRecord(channel: SlotChannel): void {
    const slot = SLOT[channel];
    const snapshot = bound.get(channel);
    if (!snapshot) {
      uniforms.setChannel(slot, layout.offsets[slot]!, false, 0, 0);
      return;
    }
    if (!CHANNELS[channel].normalized) {
      // Raw channels read through the identity so a generic read needs no branch.
      uniforms.setChannel(slot, layout.offsets[slot]!, true, 0, 1);
      return;
    }
    const [min, max] = override.get(channel) ?? data.get(channel) ?? UNIT;
    uniforms.setChannel(slot, layout.offsets[slot]!, true, min, 1 / Math.max(max - min, 1e-12));
  }

  function reset(next: Counts | null): void {
    counts = next;
    layout = channelLayout(next ?? { blocks: 0, ports: 0, nets: 0 });
    bound.clear();
    data.clear();
    override.clear();
    // With no netlist the slots give their memory back.
    if (next) mirror.resize(layout.words);
    else mirror.release();
    for (const channel of SLOTS) writeRecord(channel);
  }

  function set(
    channel: Channel,
    values: Float32Array | Float64Array,
    domain?: Domain | null,
  ): void {
    const def = channelDefinition(channel);
    if (!counts) throw new Error('diagram netlist must be loaded before binding channels');
    const tag = Object.prototype.toString.call(values);
    if (tag !== '[object Float32Array]' && tag !== '[object Float64Array]') {
      throw new TypeError(
        `diagram channel ${channel} values must be a Float32Array or Float64Array`,
      );
    }
    const expected = itemsOf(def.scope, counts) * def.components;
    if (values.length !== expected) {
      throw new Error(`diagram channel ${channel} length ${values.length} != ${expected}`);
    }
    const nextDomain = def.normalized && domain ? checkedDomain(channel, domain) : null;

    if (channel === 'blockPosition') {
      const snapshot = bound.get(channel);
      if (snapshot) snapshot.set(values);
      else bound.set(channel, Float32Array.from(values));
      return;
    }
    const offset = layout.offsets[SLOT[channel]]!;
    mirror.f32.set(values, offset);
    mirror.touch(offset, offset + values.length);
    if (!bound.has(channel))
      bound.set(channel, mirror.f32.subarray(offset, offset + values.length));
    if (def.normalized) {
      if (nextDomain) data.set(channel, nextDomain);
      else data.delete(channel);
    }
    writeRecord(channel);
  }

  function clear(channel: Channel): boolean {
    channelDefinition(channel);
    if (!bound.has(channel) && !data.has(channel) && !override.has(channel)) return false;
    bound.delete(channel);
    data.delete(channel);
    override.delete(channel);
    if (channel !== 'blockPosition') writeRecord(channel);
    return true;
  }

  function setDomain(channel: Channel, domain: Domain | null): void {
    if (!channelDefinition(channel).normalized) return;
    if (domain) override.set(channel, checkedDomain(channel, domain));
    else override.delete(channel);
    writeRecord(channel as SlotChannel);
  }

  function domainOf(channel: Channel): Domain | null {
    if (!bound.has(channel) || !channelDefinition(channel).normalized) return null;
    return override.get(channel) ?? data.get(channel) ?? UNIT;
  }

  reset(null);
  return {
    reset,
    set,
    clear,
    setDomain,
    domain: domainOf,
    values: (channel) => bound.get(channel) ?? null,
  };
}

/** The default input domain of a colormap channel. */
const UNIT: Domain = Object.freeze([0, 1] as const);

/** Items of one scope in a netlist of `counts`. */
function itemsOf(scope: ChannelDefinition['scope'], counts: Counts): number {
  return scope === 'block' ? counts.blocks : scope === 'port' ? counts.ports : counts.nets;
}

/** Validate and own a domain before retaining it. */
function checkedDomain(channel: Channel, domain: Domain): Domain {
  validateDomain(domain, `diagram ${channel} domain`);
  return Object.freeze([domain[0], domain[1]] as const);
}
