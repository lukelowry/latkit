import { extent, validateDomain, type Domain } from '@latkit/model';

import {
  ITEM_EDGE_SHADE,
  ITEM_EDGE_VISIBLE,
  ITEM_VERTEX_SHADE,
  ITEM_VERTEX_VISIBLE,
  type Uniforms,
} from './webgpu/uniforms.js';
import { effectiveDomain, linearNorm } from './normalize.js';

/** Static metadata for one channel: its storage scope, shader map, display label, and whether it takes a domain. */
export interface ChannelDefinition {
  /** Storage cardinality: one value per vertex or per edge. */
  readonly scope: 'vertex' | 'edge';
  /** Shader interpretation of the packed stream. */
  readonly map: 'colormap' | 'height' | 'size' | 'dash' | 'visible' | 'shade' | 'position';
  /** Display label a picker or legend shows. */
  readonly label: string;
  /** Whether values pass through an input domain; `dash`, `visible`, `shade`, and `position` are raw. */
  readonly normalized: boolean;
  /** Float words per item: every channel is a scalar except `position`, an interleaved `x, y` pair. */
  readonly components: 1 | 2;
}

const definitions = {
  vertexColor: {
    scope: 'vertex',
    map: 'colormap',
    label: 'Vertex Color',
    normalized: true,
    components: 1,
  },
  vertexHeight: {
    scope: 'vertex',
    map: 'height',
    label: 'Vertex Height',
    normalized: true,
    components: 1,
  },
  vertexSize: {
    scope: 'vertex',
    map: 'size',
    label: 'Vertex Size',
    normalized: true,
    components: 1,
  },
  edgeColor: {
    scope: 'edge',
    map: 'colormap',
    label: 'Edge Color',
    normalized: true,
    components: 1,
  },
  edgeDash: { scope: 'edge', map: 'dash', label: 'Edge Dash', normalized: false, components: 1 },
  vertexVisible: {
    scope: 'vertex',
    map: 'visible',
    label: 'Vertex Visible',
    normalized: false,
    components: 1,
  },
  edgeVisible: {
    scope: 'edge',
    map: 'visible',
    label: 'Edge Visible',
    normalized: false,
    components: 1,
  },
  vertexShade: {
    scope: 'vertex',
    map: 'shade',
    label: 'Vertex Shade',
    normalized: false,
    components: 1,
  },
  edgeShade: { scope: 'edge', map: 'shade', label: 'Edge Shade', normalized: false, components: 1 },
  vertexPosition: {
    scope: 'vertex',
    map: 'position',
    label: 'Vertex Position',
    normalized: false,
    components: 2,
  },
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

/** Where every channel lives in the one storage buffer a topology allocates. */
export interface ChannelLayout {
  /** Float-word offset of each channel from the beginning of the channel buffer. */
  readonly offsets: Readonly<Record<Channel, number>>;
  /** Total float words: every channel's slot, whether bound or not. */
  readonly words: number;
}

/** Shader mode value for an inactive channel. */
const MODE_OFF = 0;

/** Shader mode value for a LUT-backed colormap channel. */
const MODE_COLORMAP = 1;

/**
 * The static storage layout for a topology: every channel owns a slot in canonical
 * {@link CHANNELS} order, so binding a channel is one upload and never a relayout.
 */
export function channelLayout(vertexCount: number, edgeCount: number): ChannelLayout {
  const offsets = {} as Record<Channel, number>;
  let words = 0;
  for (const key of CHANNEL_KEYS) {
    const def = CHANNELS[key];
    offsets[key] = words;
    words += (def.scope === 'vertex' ? vertexCount : edgeCount) * def.components;
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
  if (!def) throw new Error(`unknown network channel ${String(channel)}`);
  return def;
}

/** The renderer surface the channel controller uploads into. */
export interface ChannelRenderer {
  /** Upload values into the channel's slot of the bound topology's storage. */
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
  /** Current radius multiplier range for the size channel selected by display options. */
  sizeRange(): Domain;
  /** The renderer holding the topology's channel storage, or null while detached. */
  renderer(): ChannelRenderer | null;
}

/** Runtime channel controller returned to the network API. */
export interface Channels {
  /** Bind or replace channel values. The array length must match the current topology. */
  set(channel: Channel, values: Float32Array, domain?: Domain | null): void;
  /** Unbind a channel; its slot stays allocated and its mode turns off. */
  clear(channel: Channel): void;
  /**
   * Clear every channel after topology replacement, write the new static offsets, and seed
   * `vertexPosition` with the layout the topology carries. Positions are the one channel that is
   * always bound while a topology is loaded: the shaders read vertex placement from nowhere else.
   */
  reset(positions: Float32Array | null): void;
  /** Override the input domain used by an active normalized channel. */
  setDomain(channel: Channel, domain: Domain | null): void;
  /** The input domain a bound normalized channel is using, or null. */
  domain(channel: Channel): Domain | null;
  /** Re-read the display dash period; a no-op while `edgeDash` is unbound. */
  refreshDashPeriod(): void;
  /** Re-read the display height range; a no-op while `vertexHeight` is unbound. */
  refreshHeightRange(): void;
  /** Re-read the display size range; a no-op while `vertexSize` is unbound. */
  refreshSizeRange(): void;
  /** Return the retained snapshot bound to a channel, or null when unbound. */
  values(channel: Channel): Float32Array | null;
  /** Upload every bound snapshot into a renderer that has just bound the topology. */
  upload(renderer: ChannelRenderer): void;
}

/**
 * Creates the stateful channel controller that synchronizes CPU snapshots,
 * uniform normalization scalars, and renderer-owned GPU channel storage.
 */
export function createChannels(uniforms: Uniforms, deps: ChannelDeps): Channels {
  const current = new Map<Channel, Float32Array>();
  const data = new Map<Channel, Domain>();
  const domainOverride = new Map<Channel, Domain>();

  function countFor(channel: Channel): number {
    const def = channelDefinition(channel);
    return (def.scope === 'vertex' ? deps.vertexCount() : deps.edgeCount()) * def.components;
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
    const nextDomain = def.normalized ? resolveDomain(channel, def, values, domain) : null;
    // The GPU upload copies synchronously, so the caller's array feeds it directly; the CPU
    // snapshot is refreshed only once the upload succeeded, so a failure leaves nothing changed.
    deps.renderer()?.writeChannel(channel, values);
    const snapshot = current.get(channel);
    // Re-binds refresh the snapshot in place so animated updates never allocate.
    if (snapshot) snapshot.set(values);
    else current.set(channel, values.slice());
    if (nextDomain) data.set(channel, nextDomain);
    setMode(channel, true);
    writeScalars(channel);
  }

  function clear(channel: Channel): void {
    setMode(channel, false);
    current.delete(channel);
    data.delete(channel);
    domainOverride.delete(channel);
    writeScalars(channel);
  }

  function reset(positions: Float32Array | null): void {
    current.clear();
    data.clear();
    domainOverride.clear();
    const layout = deps.loaded()
      ? channelLayout(deps.vertexCount(), deps.edgeCount())
      : channelLayout(0, 0);
    for (const key of CHANNEL_KEYS) {
      setMode(key, false);
      writeOffset(key, layout.offsets[key]);
      writeScalars(key);
    }
    if (positions) set('vertexPosition', positions);
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
    if (!current.has(channel) || !channelDefinition(channel).normalized) return null;
    return effectiveDomain(data.get(channel), domainOverride.get(channel));
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
      case 'vertexShade':
        uniforms.channel.vShadeOffset = offset;
        break;
      case 'edgeShade':
        uniforms.channel.eShadeOffset = offset;
        break;
      case 'vertexPosition':
        uniforms.channel.vPositionOffset = offset;
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
        uniforms.geometry.eDashPeriodPx = on ? deps.dashPeriodPx() : 0;
        break;
      case 'vertexVisible':
        uniforms.channel.itemFlags = toggleBit(uniforms.channel.itemFlags, ITEM_VERTEX_VISIBLE, on);
        break;
      case 'edgeVisible':
        uniforms.channel.itemFlags = toggleBit(uniforms.channel.itemFlags, ITEM_EDGE_VISIBLE, on);
        break;
      case 'vertexShade':
        uniforms.channel.itemFlags = toggleBit(uniforms.channel.itemFlags, ITEM_VERTEX_SHADE, on);
        break;
      case 'edgeShade':
        uniforms.channel.itemFlags = toggleBit(uniforms.channel.itemFlags, ITEM_EDGE_SHADE, on);
        break;
      case 'vertexPosition':
        // Always read while a topology is loaded; the slot offset is its only addressing.
        break;
      default:
        /* v8 ignore next -- compile-time exhaustive Channel guard. */
        channel satisfies never;
    }
  }

  function writeScalars(channel: Channel): void {
    const def = channelDefinition(channel);
    if (!def.normalized) return;
    if (!current.has(channel)) {
      writeNeutralScalars(channel as NormalizedChannel);
      return;
    }
    const [lo, hi] = effectiveDomain(data.get(channel), domainOverride.get(channel));
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
        uniforms.channel.vHeightMin = min;
        uniforms.channel.vHeightScale = scale;
        uniforms.channel.vHeightOutMin = outMin;
        uniforms.channel.vHeightOutSpan = outMax - outMin;
        break;
      }
      case 'size': {
        const [min, scale] = linearNorm(lo, hi);
        const [outMin, outMax] = deps.sizeRange();
        uniforms.channel.vSizeMin = min;
        uniforms.channel.vSizeScale = scale;
        uniforms.channel.vSizeOutMin = outMin;
        uniforms.channel.vSizeOutSpan = outMax - outMin;
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
        uniforms.channel.vHeightMin = 0;
        uniforms.channel.vHeightScale = 0;
        uniforms.channel.vHeightOutMin = 0;
        uniforms.channel.vHeightOutSpan = 0;
        break;
      case 'vertexSize': {
        // The output range stays live so picking pads by the same multiplier cap the shader uses.
        const [outMin, outMax] = deps.sizeRange();
        uniforms.channel.vSizeMin = 0;
        uniforms.channel.vSizeScale = 0;
        uniforms.channel.vSizeOutMin = outMin;
        uniforms.channel.vSizeOutSpan = outMax - outMin;
        break;
      }
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
    refreshDashPeriod: () => setMode('edgeDash', current.has('edgeDash')),
    refreshHeightRange: () => {
      if (current.has('vertexHeight')) writeScalars('vertexHeight');
    },
    refreshSizeRange: () => writeScalars('vertexSize'),
    values: (channel) => current.get(channel) ?? null,
    upload(renderer) {
      for (const [channel, values] of current) renderer.writeChannel(channel, values);
    },
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
  if (def.map === 'height') return extent(values) ?? [0, 1];
  return [0, 1];
}

/** Validate and own a domain before retaining it. */
function checkedDomain(domain: Domain, name: string): Domain {
  validateDomain(domain, `network ${name}`);
  return [domain[0], domain[1]];
}
