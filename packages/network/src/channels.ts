import { ITEM_EDGE_VISIBLE, ITEM_VERTEX_VISIBLE, type Uniforms } from './webgpu/uniforms.js';
import { type Domain, effectiveRange, finiteExtent, linearNorm, validateDomain } from './range.js';

/** Static metadata for one channel: its storage scope, shader map, display label, and whether it takes a domain. */
export interface ChannelDefinition {
  /** Storage cardinality: one value per vertex or per edge. */
  readonly scope: 'vertex' | 'edge';
  /** Shader interpretation of the packed stream. */
  readonly map: 'colormap' | 'height' | 'size' | 'dash' | 'visible';
  /** Display label a picker or legend shows. */
  readonly label: string;
  /** Whether values pass through an input domain; `dash` and `visible` are raw. */
  readonly normalized: boolean;
}

const definitions = {
  vertexColor: { scope: 'vertex', map: 'colormap', label: 'Vertex Color', normalized: true },
  vertexHeight: { scope: 'vertex', map: 'height', label: 'Vertex Height', normalized: true },
  vertexSize: { scope: 'vertex', map: 'size', label: 'Vertex Size', normalized: true },
  edgeColor: { scope: 'edge', map: 'colormap', label: 'Edge Color', normalized: true },
  edgeDash: { scope: 'edge', map: 'dash', label: 'Edge Dash', normalized: false },
  vertexVisible: { scope: 'vertex', map: 'visible', label: 'Vertex Visible', normalized: false },
  edgeVisible: { scope: 'edge', map: 'visible', label: 'Edge Visible', normalized: false },
} as const satisfies Record<string, ChannelDefinition>;

for (const definition of Object.values(definitions)) Object.freeze(definition);

/** Every rendering channel in canonical order, with its static metadata. */
export const CHANNELS: Readonly<typeof definitions> = Object.freeze(definitions);

/** Named per-vertex or per-edge data stream that can affect rendering. */
export type Channel = keyof typeof CHANNELS;

/** Channels in canonical packing order. */
export const CHANNEL_KEYS = Object.freeze(Object.keys(CHANNELS) as Channel[]);

/** Channels whose values pass through an input domain and normalization scalars. */
export type NormalizedChannel = {
  [Key in Channel]: (typeof CHANNELS)[Key]['normalized'] extends true ? Key : never;
}[Channel];

/** Storage slot assigned to one packed channel in the shared channel buffer. */
export interface ChannelSlot {
  /** Float-word offset from the beginning of the channel buffer. */
  readonly offset: number;
  /** Number of float values stored for this channel. */
  readonly count: number;
}

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
  for (const key of CHANNEL_KEYS) {
    if (!bound.has(key)) continue;
    const count = CHANNELS[key].scope === 'vertex' ? vertexCount : edgeCount;
    slot.set(key, { offset: words, count });
    words += count;
  }
  return { slot, words };
}

/**
 * The static metadata for a channel.
 *
 * @throws Error when `channel` names no channel.
 */
export function channelDefinition(channel: Channel): ChannelDefinition {
  const def = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel] : undefined;
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

/** Topology and display state the channel controller reads. */
interface ChannelDeps {
  /** True once a topology has been loaded and channels can be sized. */
  loaded(): boolean;
  /** Current vertex count for vertex-scoped channels. */
  vertexCount(): number;
  /** Current edge count for edge-scoped channels. */
  edgeCount(): number;
  /** Current screen-space dash period selected by display options. */
  dashPeriodPx(): number;
  /** Current output range for the height channel selected by display options. */
  heightRange(): Domain;
}

/** Runtime channel controller returned to the network API. */
export interface Channels {
  /** Bind or replace channel values. The array length must match the current topology. */
  set(channel: Channel, values: Float32Array, domain?: Domain | null): void;
  /** Remove a channel and release its storage slot on the next relayout. */
  clear(channel: Channel): void;
  /** Clear all channels after topology replacement. */
  reset(): void;
  /** Override the input domain used by an active normalized channel. */
  setDomain(channel: Channel, domain: Domain | null): void;
  /** The input domain a bound normalized channel is using, or null. */
  domain(channel: Channel): Domain | null;
  /** Re-read the display dash period; a no-op while `edgeDash` is unbound. */
  refreshDashPeriod(): void;
  /** Re-read the display height range; a no-op while `vertexHeight` is unbound. */
  refreshHeightRange(): void;
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
  const data = new Map<Channel, Domain>();
  const domainOverride = new Map<Channel, Domain>();
  const bound = new Set<Channel>();

  function countFor(channel: Channel): number {
    return channelDefinition(channel).scope === 'vertex' ? deps.vertexCount() : deps.edgeCount();
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

  function set(channel: Channel, values: Float32Array, domain?: Domain | null): void {
    validateLength(channel, values);
    const def = channelDefinition(channel);
    const isNew = !bound.has(channel);
    const nextDomain = def.normalized ? resolveDomain(channel, def, values, domain) : null;
    // The GPU upload copies synchronously, so the caller's array feeds it
    // directly; the CPU snapshot is refreshed only once the upload succeeded.
    if (isNew) {
      const nextCurrent = new Map(current);
      nextCurrent.set(channel, values);
      const nextBound = new Set(bound);
      nextBound.add(channel);
      const slots = renderer.relayout(nextBound, deps.vertexCount(), deps.edgeCount(), nextCurrent);
      writeOffsets(nextBound, slots);
      // Own a snapshot so later caller mutation cannot alter bound state.
      current.set(channel, values.slice());
      bound.add(channel);
    } else {
      renderer.writeChannel(channel, values);
      // Re-binds refresh the snapshot in place so animated updates never allocate.
      current.get(channel)!.set(values);
    }
    if (nextDomain) data.set(channel, nextDomain);
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
    bound.delete(channel);
    writeOffset(channel, 0);
    writeScalars(channel);
  }

  function reset(): void {
    current.clear();
    data.clear();
    domainOverride.clear();
    bound.clear();
    for (const key of CHANNEL_KEYS) {
      setMode(key, false);
      writeOffset(key, 0);
      writeScalars(key);
    }
  }

  function setDomain(channel: Channel, domain: Domain | null): void {
    if (!channelDefinition(channel).normalized) return;
    const previous = domainOverride.get(channel) ?? null;
    if (domain) {
      const checked = checkedDomain(domain, `${channel} domain`);
      if (sameRange(previous, checked)) return;
      domainOverride.set(channel, checked);
    } else {
      if (!previous) return;
      domainOverride.delete(channel);
    }
    writeScalars(channel);
  }

  function domain(channel: Channel): Domain | null {
    if (!bound.has(channel) || !channelDefinition(channel).normalized) return null;
    return effectiveRange(data.get(channel), domainOverride.get(channel));
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
    const def = channelDefinition(channel);
    if (!def.normalized) return;
    if (!bound.has(channel)) {
      writeNeutralScalars(channel as NormalizedChannel);
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
        const [outMin, outMax] = deps.heightRange();
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
        /* v8 ignore next -- raw maps returned above. */
        break;
    }
  }

  function writeNeutralScalars(channel: NormalizedChannel): void {
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
      default:
        /* v8 ignore next -- compile-time exhaustive Channel guard. */
        channel satisfies never;
    }
  }

  return {
    set,
    clear,
    reset,
    setDomain,
    domain,
    refreshDashPeriod: () => setMode('edgeDash', bound.has('edgeDash')),
    refreshHeightRange: () => {
      if (bound.has('vertexHeight')) writeScalars('vertexHeight');
    },
    values: (channel) => current.get(channel) ?? null,
  };
}

/** Set or clear one u32 flag while keeping JavaScript bit operations unsigned. */
function toggleBit(value: number, bit: number, on: boolean): number {
  return (on ? value | bit : value & ~bit) >>> 0;
}

/** Tests range equality without allocating. */
function sameRange(a: Domain | null, b: Domain): boolean {
  return a !== null && a[0] === b[0] && a[1] === b[1];
}

/** Resolves the channel input domain from an explicit range or value scans. */
function resolveDomain(
  channel: Channel,
  def: ChannelDefinition,
  values: Float32Array,
  domain?: Domain | null,
): Domain {
  if (domain) return checkedDomain(domain, `${channel} domain`);
  if (def.map === 'height') return finiteExtent(values) ?? [0, 1];
  return [0, 1];
}

/** Validate and own a domain before retaining it. */
function checkedDomain(domain: Domain, name: string): Domain {
  validateDomain(domain, `network ${name}`);
  return [domain[0], domain[1]];
}
