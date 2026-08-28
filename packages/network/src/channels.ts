import { ITEM_EDGE_VISIBLE, ITEM_VERTEX_VISIBLE, type Uniforms } from './webgpu/uniforms.js';
import {
  effectiveRange,
  finiteExtent,
  linearNorm,
  validateChannelRange,
  type ChannelRange,
} from './range.js';

/** Canonical ordered channel metadata shared by Network consumers. */
export const CHANNEL_DEFINITIONS = Object.freeze([
  Object.freeze({ key: 'vertexColor', scope: 'vertex', map: 'colormap' }),
  Object.freeze({ key: 'vertexHeight', scope: 'vertex', map: 'height' }),
  Object.freeze({ key: 'vertexSize', scope: 'vertex', map: 'size' }),
  Object.freeze({ key: 'edgeColor', scope: 'edge', map: 'colormap' }),
  Object.freeze({ key: 'edgeDash', scope: 'edge', map: 'dash' }),
  Object.freeze({ key: 'vertexVisible', scope: 'vertex', map: 'visible' }),
  Object.freeze({ key: 'edgeVisible', scope: 'edge', map: 'visible' }),
] as const);

/** Static metadata for one supported channel. */
export type ChannelDefinition = (typeof CHANNEL_DEFINITIONS)[number];

/** Named per-vertex or per-edge data stream that can affect rendering. */
export type Channel = ChannelDefinition['key'];

/** Storage cardinality used when packing channel data. */
export type ChannelScope = ChannelDefinition['scope'];

/** Shader interpretation for a packed channel stream. */
export type ChannelMap = ChannelDefinition['map'];

/** Whether a channel map consumes an input domain and normalization scalars. */
export function channelNormalizes(map: ChannelMap): boolean {
  return map === 'colormap' || map === 'height' || map === 'size';
}

/** Storage slot assigned to one packed channel in the shared channel buffer. */
export interface ChannelSlot {
  /** Float-word offset from the beginning of the channel buffer. */
  readonly offset: number;
  /** Number of float values stored for this channel. */
  readonly count: number;
}

/** Fast lookup for validating and resolving channel metadata. */
const CHANNEL_BY_KEY = new Map<Channel, ChannelDefinition>(
  CHANNEL_DEFINITIONS.map((definition) => [definition.key, definition]),
);

/** Shader mode value for an inactive channel. */
const MODE_OFF = 0;

/** Shader mode value for a LUT-backed colormap channel. */
const MODE_COLORMAP = 1;

/**
 * Computes a dense storage layout for the currently bound channels.
 *
 * Channels are packed in stable {@link CHANNEL_DEFINITIONS} order so uniform offsets stay
 * deterministic across relayouts.
 */
export function packBound(
  bound: ReadonlySet<Channel>,
  vertexCount: number,
  edgeCount: number,
): { slot: Map<Channel, ChannelSlot>; words: number } {
  const slot = new Map<Channel, ChannelSlot>();
  let words = 0;
  for (const def of CHANNEL_DEFINITIONS) {
    if (!bound.has(def.key)) continue;
    const count = def.scope === 'vertex' ? vertexCount : edgeCount;
    slot.set(def.key, { offset: words, count });
    words += count;
  }
  return { slot, words };
}

/** Returns static metadata for a channel or throws on impossible input. */
function channelDef(channel: Channel): ChannelDefinition {
  const def = CHANNEL_BY_KEY.get(channel);
  if (!def) throw new Error(`unknown network channel ${String(channel)}`);
  return def;
}

/** Renderer callbacks used by the channel controller to own GPU storage. */
interface ChannelRenderer {
  /** Recreate channel storage and return the slot map for all bound channels. */
  relayout(
    bound: ReadonlySet<Channel>,
    vertexCount: number,
    edgeCount: number,
    values?: ReadonlyMap<Channel, Float32Array>,
  ): ReadonlyMap<Channel, ChannelSlot>;
  /** Upload values into an already assigned channel slot. */
  writeChannel(channel: Channel, values: Float32Array): void;
}

/** Topology state required to validate channel cardinality. */
interface ChannelDeps {
  /** True once a topology has been loaded and channels can be sized. */
  loaded(): boolean;
  /** Current vertex count for vertex-scoped channels. */
  vertexCount(): number;
  /** Current edge count for edge-scoped channels. */
  edgeCount(): number;
  /** Current screen-space dash period selected by display options. */
  dashPeriodPx(): number;
}

/** Runtime channel controller returned to the network API. */
export interface Channels {
  /** Bind or replace channel values. The array length must match the current topology. */
  set(
    channel: Channel,
    values: Float32Array,
    domain?: ChannelRange | null,
    range?: ChannelRange,
  ): void;
  /** Remove a channel and release its storage slot on the next relayout. */
  clear(channel: Channel): void;
  /** Clear all channels after topology replacement. */
  reset(): void;
  /** Override the input domain used by an active normalized channel. */
  setRange(channel: Channel, range: ChannelRange | null): void;
  /** Re-read the display dash period; a no-op while `edgeDash` is unbound. */
  refreshDashPeriod(): void;
  /** Return the last array bound to a channel, or null when unbound. */
  values(channel: Channel): Float32Array | null;
}

/**
 * Creates the stateful channel controller that synchronizes CPU values,
 * uniform normalization scalars, and renderer-owned GPU channel storage.
 */
export function createChannels(
  uniforms: Uniforms,
  renderer: ChannelRenderer,
  deps: ChannelDeps,
): Channels {
  const current = new Map<Channel, Float32Array>();
  const data = new Map<Channel, ChannelRange>();
  const domainOverride = new Map<Channel, ChannelRange>();
  const output = new Map<Channel, ChannelRange>();
  const bound = new Set<Channel>();

  function countFor(channel: Channel): number {
    return channelDef(channel).scope === 'vertex' ? deps.vertexCount() : deps.edgeCount();
  }

  function validateLength(channel: Channel, values: Float32Array): void {
    if (!deps.loaded()) {
      throw new Error('network topology must be loaded before binding channels');
    }
    const expected = countFor(channel);
    if (values.length !== expected) {
      throw new Error(`network channel ${channel} length ${values.length} != ${expected}`);
    }
  }

  function set(
    channel: Channel,
    values: Float32Array,
    domain?: ChannelRange | null,
    range?: ChannelRange,
  ): void {
    validateLength(channel, values);
    const def = channelDef(channel);
    const isNew = !bound.has(channel);
    const nextOutput = def.map === 'height' ? checkedRange(range ?? [0, 1], 'height range') : null;
    const owned = values.slice();
    const nextDomain = channelNormalizes(def.map) ? resolveDomain(def, owned, domain) : null;
    if (isNew) {
      const nextCurrent = new Map(current);
      nextCurrent.set(channel, owned);
      const nextBound = new Set(bound);
      nextBound.add(channel);
      const slots = renderer.relayout(nextBound, deps.vertexCount(), deps.edgeCount(), nextCurrent);
      writeOffsets(nextBound, slots);
      current.set(channel, owned);
      bound.add(channel);
    } else {
      renderer.writeChannel(channel, owned);
      current.set(channel, owned);
    }
    if (nextDomain) data.set(channel, nextDomain);
    if (nextOutput) output.set(channel, nextOutput);
    setMode(channel, true);
    writeScalars(channel);
  }

  function clear(channel: Channel): void {
    if (bound.has(channel)) {
      const nextCurrent = new Map(current);
      nextCurrent.delete(channel);
      const nextBound = new Set(bound);
      nextBound.delete(channel);
      const slots = renderer.relayout(nextBound, deps.vertexCount(), deps.edgeCount(), nextCurrent);
      writeOffsets(nextBound, slots);
    }
    setMode(channel, false);
    current.delete(channel);
    data.delete(channel);
    domainOverride.delete(channel);
    output.delete(channel);
    bound.delete(channel);
    writeOffset(channel, 0);
    writeScalars(channel);
  }

  function reset(): void {
    current.clear();
    data.clear();
    domainOverride.clear();
    output.clear();
    bound.clear();
    for (const def of CHANNEL_DEFINITIONS) {
      setMode(def.key, false);
      writeOffset(def.key, 0);
      writeScalars(def.key);
    }
  }

  function setRange(channel: Channel, range: ChannelRange | null): void {
    if (!channelNormalizes(channelDef(channel).map)) return;
    const previous = domainOverride.get(channel) ?? null;
    if (range) {
      const checked = checkedRange(range, `${channel} domain`);
      if (sameRange(previous, checked)) return;
      domainOverride.set(channel, checked);
    } else {
      if (!previous) return;
      domainOverride.delete(channel);
    }
    writeScalars(channel);
  }

  function writeOffsets(
    channels: ReadonlySet<Channel>,
    slots: ReadonlyMap<Channel, ChannelSlot>,
  ): void {
    for (const channel of channels) {
      const slot = slots.get(channel);
      if (!slot) throw new Error(`network channel ${channel} has no storage slot`);
    }
    for (const channel of channels) {
      const slot = slots.get(channel)!;
      writeOffset(channel, slot.offset);
    }
  }

  function writeOffset(channel: Channel, offset: number): void {
    switch (channel) {
      case 'vertexColor':
        uniforms.channel.vColorOffset = offset;
        break;
      case 'vertexHeight':
        uniforms.channel.vHeightOffset = offset;
        break;
      case 'vertexSize':
        uniforms.channel.vSizeOffset = offset;
        break;
      case 'edgeColor':
        uniforms.channel.eColorOffset = offset;
        break;
      case 'edgeDash':
        uniforms.channel.eDashOffset = offset;
        break;
      case 'vertexVisible':
        uniforms.channel.vVisibleOffset = offset;
        break;
      case 'edgeVisible':
        uniforms.channel.eVisibleOffset = offset;
        break;
      default:
        /* v8 ignore next -- compile-time exhaustive Channel guard. */
        channel satisfies never;
    }
  }

  function setMode(channel: Channel, on: boolean): void {
    switch (channel) {
      case 'vertexColor':
        uniforms.channel.vColorMode = on ? MODE_COLORMAP : MODE_OFF;
        break;
      case 'edgeColor':
        uniforms.channel.eColorMode = on ? MODE_COLORMAP : MODE_OFF;
        break;
      case 'vertexHeight':
        uniforms.channel.vHeightMode = on ? 1 : 0;
        break;
      case 'vertexSize':
        uniforms.channel.vSizeMode = on ? 1 : 0;
        break;
      case 'edgeDash':
        uniforms.geometry.dashPeriod = on ? deps.dashPeriodPx() : 0;
        break;
      case 'vertexVisible':
        uniforms.channel.itemFlags = toggleBit(uniforms.channel.itemFlags, ITEM_VERTEX_VISIBLE, on);
        break;
      case 'edgeVisible':
        uniforms.channel.itemFlags = toggleBit(uniforms.channel.itemFlags, ITEM_EDGE_VISIBLE, on);
        break;
      default:
        /* v8 ignore next -- compile-time exhaustive Channel guard. */
        channel satisfies never;
    }
  }

  function writeScalars(channel: Channel): void {
    const def = channelDef(channel);
    if (!channelNormalizes(def.map)) return;
    if (!bound.has(channel)) {
      writeNeutralScalars(channel);
      return;
    }
    const [lo, hi] = effectiveRange(data.get(channel), domainOverride.get(channel));
    switch (def.map) {
      case 'colormap': {
        const [min, scale] = linearNorm(lo, hi);
        if (channel === 'edgeColor') {
          uniforms.channel.eColorMin = min;
          uniforms.channel.eColorScale = scale;
        } else {
          uniforms.channel.vColorMin = min;
          uniforms.channel.vColorScale = scale;
        }
        break;
      }
      case 'height': {
        const [min, scale] = linearNorm(lo, hi);
        const [outMin, outMax] = output.get(channel) ?? [0, 1];
        uniforms.channel.heightCenter = min;
        uniforms.channel.heightScale = scale;
        uniforms.channel.heightOutMin = outMin;
        uniforms.channel.heightOutScale = outMax - outMin;
        break;
      }
      case 'size': {
        const [min, scale] = linearNorm(lo, hi);
        uniforms.channel.vSizeMin = min;
        uniforms.channel.vSizeScale = scale;
        break;
      }
      /* v8 ignore start -- channelNormalizes returns before raw maps reach this switch. */
      case 'dash':
      case 'visible':
        break;
      /* v8 ignore stop */
      default:
        /* v8 ignore next -- compile-time exhaustive channel map guard. */
        def satisfies never;
    }
  }

  function writeNeutralScalars(channel: Channel): void {
    switch (channel) {
      case 'vertexColor':
        uniforms.channel.vColorMin = 0;
        uniforms.channel.vColorScale = 0;
        break;
      case 'edgeColor':
        uniforms.channel.eColorMin = 0;
        uniforms.channel.eColorScale = 0;
        break;
      case 'vertexHeight':
        uniforms.channel.heightCenter = 0;
        uniforms.channel.heightScale = 0;
        uniforms.channel.heightOutMin = 0;
        uniforms.channel.heightOutScale = 0;
        break;
      case 'vertexSize':
        uniforms.channel.vSizeMin = 0;
        uniforms.channel.vSizeScale = 0;
        break;
      /* v8 ignore start -- raw channels return before neutral scalars are needed. */
      case 'edgeDash':
      case 'vertexVisible':
      case 'edgeVisible':
        break;
      /* v8 ignore stop */
      default:
        /* v8 ignore next -- compile-time exhaustive Channel guard. */
        channel satisfies never;
    }
  }

  return {
    set,
    clear,
    reset,
    setRange,
    refreshDashPeriod: () => setMode('edgeDash', bound.has('edgeDash')),
    values: (channel) => current.get(channel) ?? null,
  };
}

/** Set or clear one u32 flag while keeping JavaScript bit operations unsigned. */
function toggleBit(value: number, bit: number, on: boolean): number {
  return (on ? value | bit : value & ~bit) >>> 0;
}

/** Tests range equality without allocating. */
function sameRange(a: ChannelRange | null, b: ChannelRange): boolean {
  return a !== null && a[0] === b[0] && a[1] === b[1];
}

/** Resolves the channel input domain from an explicit range or value scans. */
function resolveDomain(
  def: ChannelDefinition,
  values: Float32Array,
  domain?: ChannelRange | null,
): ChannelRange {
  if (domain) return checkedRange(domain, `${def.key} domain`);
  if (def.map === 'height') return finiteExtent(values) ?? [0, 1];
  return [0, 1];
}

/** Copies a range tuple so callers cannot mutate stored normalization state. */
function copyRange(range: ChannelRange): ChannelRange {
  return [range[0], range[1]];
}

/** Validate and own a channel range before retaining it. */
function checkedRange(range: ChannelRange, name: string): ChannelRange {
  validateChannelRange(range, `network ${name}`);
  return copyRange(range);
}
