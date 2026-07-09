import type { Uniforms } from './webgpu/uniforms.js';
import { effectiveRange, finiteExtent, linearNorm, type ChannelRange } from './range.js';

/** Named per-vertex or per-edge data stream that can affect rendering. */
export type Channel = 'vertexColor' | 'vertexHeight' | 'vertexSize' | 'edgeColor' | 'edgeDash';

/** Storage cardinality used when packing channel data. */
type ChannelScope = 'vertex' | 'edge';

/** Shader interpretation for a packed channel stream. */
type ChannelMap = 'colormap' | 'height' | 'size' | 'dash';

/** Static metadata for one supported channel key. */
interface ChannelDef {
  /** Public channel name. */
  readonly key: Channel;
  /** Whether the channel contains one value per vertex or edge. */
  readonly scope: ChannelScope;
  /** Rendering behavior driven by the channel values. */
  readonly map: ChannelMap;
}

/** Storage slot assigned to one packed channel in the shared channel buffer. */
export interface ChannelSlot {
  /** Float-word offset from the beginning of the channel buffer. */
  readonly offset: number;
  /** Number of float values stored for this channel. */
  readonly count: number;
}

/** Ordered channel layout; this order is the packing ABI for channel offsets. */
const CHANNELS: readonly ChannelDef[] = [
  { key: 'vertexColor', scope: 'vertex', map: 'colormap' },
  { key: 'vertexHeight', scope: 'vertex', map: 'height' },
  { key: 'vertexSize', scope: 'vertex', map: 'size' },
  { key: 'edgeColor', scope: 'edge', map: 'colormap' },
  { key: 'edgeDash', scope: 'edge', map: 'dash' },
];

/** Fast lookup for validating and resolving channel metadata. */
const CHANNEL_BY_KEY = new Map<Channel, ChannelDef>(CHANNELS.map((def) => [def.key, def]));

/** Default screen-space dash period used when edgeDash is enabled. */
const DASH_PERIOD_PX = 12;

/** Shader mode value for an inactive channel. */
const MODE_OFF = 0;

/** Shader mode value for a LUT-backed colormap channel. */
const MODE_COLORMAP = 1;

/**
 * Computes a dense storage layout for the currently bound channels.
 *
 * Channels are packed in stable {@link CHANNELS} order so uniform offsets stay
 * deterministic across relayouts.
 */
export function packBound(
  bound: ReadonlySet<Channel>,
  vertexCount: number,
  edgeCount: number,
): { slot: Map<Channel, ChannelSlot>; words: number } {
  const slot = new Map<Channel, ChannelSlot>();
  let words = 0;
  for (const def of CHANNELS) {
    if (!bound.has(def.key)) continue;
    const count = def.scope === 'vertex' ? vertexCount : edgeCount;
    slot.set(def.key, { offset: words, count });
    words += count;
  }
  return { slot, words };
}

/** Returns static metadata for a channel or throws on impossible input. */
function channelDef(channel: Channel): ChannelDef {
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
  /** Override the input domain used by an active non-dash channel. */
  setRange(channel: Channel, range: ChannelRange | null): void;
  /** Return the last array bound to a channel, or null when unbound. */
  values(channel: Channel): Float32Array | null;
  /** Return the measured input domain for a channel, or null when unavailable. */
  dataRange(channel: Channel): ChannelRange | null;
  /** Return the output range used by a height channel, or null for other channels. */
  outputRange(channel: Channel): ChannelRange | null;
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
    current.set(channel, values);
    if (def.map !== 'dash') {
      data.set(channel, resolveDomain(def, values, domain));
      if (def.map === 'height') output.set(channel, copyRange(range ?? [0, 1]));
    }
    if (isNew) {
      bound.add(channel);
      reflow(); // relayout re-uploads every bound channel, this one included
    } else {
      renderer.writeChannel(channel, values);
    }
    setMode(channel, true);
    writeScalars(channel);
  }

  function clear(channel: Channel): void {
    setMode(channel, false);
    current.delete(channel);
    data.delete(channel);
    domainOverride.delete(channel);
    output.delete(channel);
    const wasBound = bound.delete(channel);
    writeOffset(channel, 0);
    writeScalars(channel);
    if (wasBound) reflow();
  }

  function reset(): void {
    current.clear();
    data.clear();
    domainOverride.clear();
    output.clear();
    bound.clear();
    for (const def of CHANNELS) {
      setMode(def.key, false);
      writeOffset(def.key, 0);
      writeScalars(def.key);
    }
  }

  function setRange(channel: Channel, range: ChannelRange | null): void {
    if (channelDef(channel).map === 'dash') return;
    const previous = domainOverride.get(channel) ?? null;
    if (range) {
      if (sameRange(previous, range)) return;
      domainOverride.set(channel, copyRange(range));
    } else {
      if (!previous) return;
      domainOverride.delete(channel);
    }
    writeScalars(channel);
  }

  function reflow(): void {
    const slots = renderer.relayout(bound, deps.vertexCount(), deps.edgeCount());
    for (const channel of bound) {
      const slot = slots.get(channel);
      if (!slot) throw new Error(`network channel ${channel} has no storage slot`);
      writeOffset(channel, slot.offset);
    }
    for (const channel of bound) {
      renderer.writeChannel(channel, current.get(channel)!);
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
        uniforms.geometry.dashPeriod = on ? DASH_PERIOD_PX : 0;
        break;
      default:
        /* v8 ignore next -- compile-time exhaustive Channel guard. */
        channel satisfies never;
    }
  }

  function writeScalars(channel: Channel): void {
    const def = channelDef(channel);
    if (def.map === 'dash') return;
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
      default:
        /* v8 ignore next -- compile-time exhaustive channel map guard. */
        def.map satisfies never;
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
      /* v8 ignore start -- writeScalars returns before dash channels need neutral scalars. */
      case 'edgeDash':
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
    values: (channel) => current.get(channel) ?? null,
    dataRange: (channel) => data.get(channel) ?? null,
    outputRange: (channel) => output.get(channel) ?? null,
  };
}

/** Tests range equality without allocating. */
function sameRange(a: ChannelRange | null, b: ChannelRange): boolean {
  return a !== null && a[0] === b[0] && a[1] === b[1];
}

/** Resolves the channel input domain from an explicit range or value scans. */
function resolveDomain(
  def: ChannelDef,
  values: Float32Array,
  domain?: ChannelRange | null,
): ChannelRange {
  if (domain) return copyRange(domain);
  if (def.map === 'height') return finiteExtent(values) ?? [0, 1];
  return [0, 1];
}

/** Copies a range tuple so callers cannot mutate stored normalization state. */
function copyRange(range: ChannelRange): ChannelRange {
  return [range[0], range[1]];
}
