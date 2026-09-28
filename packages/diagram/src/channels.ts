import { validateDomain, validateSeries, type Domain, type Series } from '@latkit/model';

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

/** One signal of a series a channel follows, one element per item of its scope. */
export interface SeriesBinding {
  readonly series: Series;
  readonly signal: number;
}

/** Whether channel values name a series to follow rather than holding the values. */
export function isSeriesBinding(values: unknown): values is SeriesBinding {
  return typeof values === 'object' && values !== null && 'series' in values;
}

/** Channel values, domains, and slot records for one controller. */
export interface Channels {
  /** Float words the slots take; what else the mirror holds starts here. */
  readonly words: number;
  /**
   * Size every slot for `counts`, clear every channel, write offsets; null (before a load, or
   * after a destroy) leaves no slots and gives the mirror's memory back.
   */
  reset(counts: Counts | null): void;
  /**
   * Validate for the loaded counts and bind, replacing what was bound. A series binding shows
   * nothing, its slot filled with NaN, until `moveTo` shows a frame, unless the channel follows
   * that signal already and keeps what it shows; a null `domain` follows the signal's recorded
   * range.
   *
   * @throws Error before a load, for a wrong length, or for series elements that do not fit;
   * RangeError for a signal the series lacks; TypeError for values of another kind, or a position
   * or visibility channel given a series; RangeError or TypeError for a bad domain. Nothing changes
   * when it throws.
   */
  set(
    channel: Channel,
    values: Float32Array | Float64Array | SeriesBinding,
    domain?: Domain | null,
  ): void;
  /** Unbind a channel; its slot stays allocated and turns off. False when nothing was bound. */
  clear(channel: Channel): boolean;
  /** Items of the channel's scope in the loaded netlist, or 0 before one. */
  items(channel: Channel): number;
  /** Grow the mirror to hold `words` float words, keeping what it holds. */
  reserve(words: number): void;
  /** Write float words `offset` words into the mirror. */
  writeWords(offset: number, values: Float32Array): void;
  /** Show a series-bound channel the values `offset` words into the mirror, read as `view`. */
  moveTo(channel: Channel, offset: number, view: Float32Array): void;
  /** Keep what a series-bound channel shows in its own slot, so the words it read can change. */
  hold(channel: Channel): void;
  /** Re-read the recorded range a series-bound channel's domain follows; false when none. */
  refreshRecorded(channel: Channel): boolean;
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
  /** Series-bound channels and the signal each follows. */
  const following = new Map<SlotChannel, SeriesBinding>();
  /** Series-bound channels whose domain follows the recorded range. */
  const recorded = new Set<SlotChannel>();
  /** The word a series-bound channel reads from, when not its own slot. */
  const shown = new Map<SlotChannel, number>();

  function writeRecord(channel: SlotChannel): void {
    const slot = SLOT[channel];
    const offset = shown.get(channel) ?? layout.offsets[slot]!;
    const snapshot = bound.get(channel);
    if (!snapshot) {
      uniforms.setChannel(slot, offset, false, 0, 0);
      return;
    }
    if (!CHANNELS[channel].normalized) {
      // Raw channels read through the identity so a generic read needs no branch.
      uniforms.setChannel(slot, offset, true, 0, 1);
      return;
    }
    const [min, max] = override.get(channel) ?? data.get(channel) ?? UNIT;
    uniforms.setChannel(slot, offset, true, min, 1 / Math.max(max - min, 1e-12));
  }

  /** The view of a channel's own slot in the mirror, as it is now. */
  function slotView(channel: SlotChannel, length: number): Float32Array {
    const offset = layout.offsets[SLOT[channel]]!;
    return mirror.f32.subarray(offset, offset + length);
  }

  /** Drop what a channel followed; its own slot is what it reads again. */
  function unfollow(channel: SlotChannel): boolean {
    shown.delete(channel);
    recorded.delete(channel);
    return following.delete(channel);
  }

  function reset(next: Counts | null): void {
    counts = next;
    layout = channelLayout(next ?? { blocks: 0, ports: 0, nets: 0 });
    bound.clear();
    data.clear();
    override.clear();
    following.clear();
    recorded.clear();
    shown.clear();
    // With no netlist the slots give their memory back.
    if (next) mirror.resize(layout.words);
    else mirror.release();
    for (const channel of SLOTS) writeRecord(channel);
  }

  function set(
    channel: Channel,
    values: Float32Array | Float64Array | SeriesBinding,
    domain?: Domain | null,
  ): void {
    if (isSeriesBinding(values)) {
      follow(channel, values, domain);
      return;
    }
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
    if (unfollow(channel) || !bound.has(channel))
      bound.set(channel, slotView(channel, values.length));
    if (def.normalized) {
      if (nextDomain) data.set(channel, nextDomain);
      else data.delete(channel);
    }
    writeRecord(channel);
  }

  function follow(channel: Channel, binding: SeriesBinding, domain?: Domain | null): void {
    const def = channelDefinition(channel);
    if (!counts) throw new Error('diagram netlist must be loaded before binding channels');
    // A position or visibility change re-lays the scene: those channels take arrays only.
    if (def.map === 'position' || def.map === 'visible') {
      throw new TypeError(`diagram channel ${channel} cannot follow a series`);
    }
    const { series, signal } = binding;
    validateSeries(series);
    if (!Number.isInteger(signal) || signal < 0 || signal >= series.signalCount) {
      throw new RangeError(
        `diagram channel ${channel} signal ${signal} out of [0, ${series.signalCount})`,
      );
    }
    const items = itemsOf(def.scope, counts);
    const last = series.elements ? (series.elements.at(-1) ?? -1) : series.elementCount - 1;
    if (series.elements ? last >= items : series.elementCount !== items) {
      throw new Error(`diagram channel ${channel} series elements do not fit ${items} items`);
    }
    const nextDomain = def.normalized
      ? domain
        ? checkedDomain(channel, domain)
        : recordedDomain(binding)
      : null;
    const slot = channel as SlotChannel;
    const previous = following.get(slot);
    if (previous?.series !== series || previous.signal !== signal) {
      unfollow(slot);
      const offset = layout.offsets[SLOT[slot]]!;
      mirror.f32.fill(NaN, offset, offset + items);
      mirror.touch(offset, offset + items);
      bound.set(slot, slotView(slot, items));
      following.set(slot, binding);
    }
    if (domain) recorded.delete(slot);
    else recorded.add(slot);
    if (nextDomain) data.set(slot, nextDomain);
    writeRecord(slot);
  }

  function clear(channel: Channel): boolean {
    channelDefinition(channel);
    if (!bound.has(channel) && !data.has(channel) && !override.has(channel)) return false;
    bound.delete(channel);
    data.delete(channel);
    override.delete(channel);
    if (channel !== 'blockPosition') {
      unfollow(channel);
      writeRecord(channel);
    }
    return true;
  }

  function reserve(words: number): void {
    if (words <= mirror.words) return;
    const grows = words > mirror.capacity;
    mirror.resize(words);
    if (!grows) return;
    // A grown mirror is a new store: the slots read from their own words move with it.
    for (const [channel, view] of bound) {
      if (channel === 'blockPosition' || shown.has(channel)) continue;
      bound.set(channel, slotView(channel, view.length));
    }
  }

  function moveTo(channel: Channel, offset: number, view: Float32Array): void {
    const slot = channel as SlotChannel;
    shown.set(slot, offset);
    bound.set(slot, view);
    writeRecord(slot);
  }

  function hold(channel: Channel): void {
    const slot = channel as SlotChannel;
    const view = bound.get(slot);
    if (!view || !shown.delete(slot)) return;
    const offset = layout.offsets[SLOT[slot]]!;
    mirror.f32.set(view, offset);
    mirror.touch(offset, offset + view.length);
    bound.set(slot, slotView(slot, view.length));
    writeRecord(slot);
  }

  function refreshRecorded(channel: Channel): boolean {
    const slot = channel as SlotChannel;
    const binding = following.get(slot);
    if (!binding || !recorded.has(slot)) return false;
    data.set(slot, recordedDomain(binding));
    writeRecord(slot);
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
    get words() {
      return layout.words;
    },
    reset,
    set,
    clear,
    setDomain,
    domain: domainOf,
    values: (channel) => bound.get(channel) ?? null,
    items: (channel) => (counts ? itemsOf(channelDefinition(channel).scope, counts) : 0),
    reserve,
    writeWords(offset, values) {
      mirror.f32.set(values, offset);
      mirror.touch(offset, offset + values.length);
    },
    moveTo,
    hold,
    refreshRecorded,
  };
}

/** The default input domain of a colormap channel. */
const UNIT: Domain = Object.freeze([0, 1] as const);

/** The recorded finite range of a series signal, or `[0, 1]` before anything finite is recorded. */
function recordedDomain({ series, signal }: SeriesBinding): Domain {
  const ranges = series.state.ranges;
  const lo = ranges?.[signal * 2];
  const hi = ranges?.[signal * 2 + 1];
  return lo !== undefined && hi !== undefined && Number.isFinite(lo) && Number.isFinite(hi)
    ? [lo, hi]
    : UNIT;
}

/** Items of one scope in a netlist of `counts`. */
function itemsOf(scope: ChannelDefinition['scope'], counts: Counts): number {
  return scope === 'block' ? counts.blocks : scope === 'port' ? counts.ports : counts.nets;
}

/** Validate and own a domain before retaining it. */
function checkedDomain(channel: Channel, domain: Domain): Domain {
  validateDomain(domain, `diagram ${channel} domain`);
  return Object.freeze([domain[0], domain[1]] as const);
}
