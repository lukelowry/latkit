/**
 * The network's channels: the registry of per-vertex and per-edge value streams, and how a
 * channel's record reaches the uniforms its shaders read. `@latkit/gpu`'s `createChannels` binds
 * them: slots, series, and domains.
 */

import { extent, type Domain } from '@latkit/model';

import {
  ITEM_EDGE_SHADE,
  ITEM_EDGE_VISIBLE,
  ITEM_VERTEX_SHADE,
  ITEM_VERTEX_VISIBLE,
  type Uniforms,
} from './webgpu/uniforms.js';

/** Static metadata for one channel: its storage scope, shader map, label, and what it takes. */
interface ChannelDefinition {
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
  /** Whether it can follow one signal of a series: every channel but `vertexPosition`. */
  readonly series: boolean;
}

const definitions = {
  vertexColor: {
    scope: 'vertex',
    map: 'colormap',
    label: 'Vertex Color',
    normalized: true,
    components: 1,
    series: true,
  },
  vertexHeight: {
    scope: 'vertex',
    map: 'height',
    label: 'Vertex Height',
    normalized: true,
    components: 1,
    series: true,
  },
  vertexSize: {
    scope: 'vertex',
    map: 'size',
    label: 'Vertex Size',
    normalized: true,
    components: 1,
    series: true,
  },
  edgeColor: {
    scope: 'edge',
    map: 'colormap',
    label: 'Edge Color',
    normalized: true,
    components: 1,
    series: true,
  },
  edgeDash: {
    scope: 'edge',
    map: 'dash',
    label: 'Edge Dash',
    normalized: false,
    components: 1,
    series: true,
  },
  vertexVisible: {
    scope: 'vertex',
    map: 'visible',
    label: 'Vertex Visible',
    normalized: false,
    components: 1,
    series: true,
  },
  edgeVisible: {
    scope: 'edge',
    map: 'visible',
    label: 'Edge Visible',
    normalized: false,
    components: 1,
    series: true,
  },
  vertexShade: {
    scope: 'vertex',
    map: 'shade',
    label: 'Vertex Shade',
    normalized: false,
    components: 1,
    series: true,
  },
  edgeShade: {
    scope: 'edge',
    map: 'shade',
    label: 'Edge Shade',
    normalized: false,
    components: 1,
    series: true,
  },
  vertexPosition: {
    scope: 'vertex',
    map: 'position',
    label: 'Vertex Position',
    normalized: false,
    components: 2,
    series: false,
  },
} as const satisfies Record<string, ChannelDefinition>;

for (const definition of Object.values(definitions)) Object.freeze(definition);

/** Every rendering channel in canonical order, with its static metadata. */
export const CHANNELS: Readonly<typeof definitions> = Object.freeze(definitions);

/** Named per-vertex or per-edge data stream that can affect rendering. */
export type Channel = keyof typeof CHANNELS;

/** Shader mode value for an inactive channel. */
const MODE_OFF = 0;

/** Shader mode value for a LUT-backed colormap channel. */
const MODE_COLORMAP = 1;

/**
 * How a channel's record reaches the uniforms: the word its values start at, whether it is bound,
 * the `(value - min) * scale` its values map through, and what the display options add: the dash
 * period, and the height and size output ranges.
 */
export function channelRecord(
  uniforms: Uniforms,
  display: {
    dashPeriodPx(): number;
    heightRange(): Domain;
    sizeRange(): Domain;
  },
): (channel: Channel, offset: number, bound: boolean, min: number, scale: number) => void {
  return (channel, offset, bound, min, scale) => {
    const record = uniforms.channel;
    switch (channel) {
      case 'vertexColor':
        record.vColorOffset = offset;
        record.vColorMode = bound ? MODE_COLORMAP : MODE_OFF;
        record.vColorMin = min;
        record.vColorScale = scale;
        break;
      case 'edgeColor':
        record.eColorOffset = offset;
        record.eColorMode = bound ? MODE_COLORMAP : MODE_OFF;
        record.eColorMin = min;
        record.eColorScale = scale;
        break;
      case 'vertexHeight': {
        const [outMin, outMax] = bound ? display.heightRange() : [0, 0];
        record.vHeightOffset = offset;
        record.vHeightMode = bound ? 1 : 0;
        record.vHeightMin = min;
        record.vHeightScale = scale;
        record.vHeightOutMin = outMin;
        record.vHeightOutSpan = outMax - outMin;
        break;
      }
      case 'vertexSize': {
        // The output range stays live so picking pads by the same multiplier cap the shader uses.
        const [outMin, outMax] = display.sizeRange();
        record.vSizeOffset = offset;
        record.vSizeMode = bound ? 1 : 0;
        record.vSizeMin = min;
        record.vSizeScale = scale;
        record.vSizeOutMin = outMin;
        record.vSizeOutSpan = outMax - outMin;
        break;
      }
      case 'edgeDash':
        record.eDashOffset = offset;
        uniforms.geometry.eDashPeriodPx = bound ? display.dashPeriodPx() : 0;
        break;
      case 'vertexVisible':
        record.vVisibleOffset = offset;
        record.itemFlags = toggleBit(record.itemFlags, ITEM_VERTEX_VISIBLE, bound);
        break;
      case 'edgeVisible':
        record.eVisibleOffset = offset;
        record.itemFlags = toggleBit(record.itemFlags, ITEM_EDGE_VISIBLE, bound);
        break;
      case 'vertexShade':
        record.vShadeOffset = offset;
        record.itemFlags = toggleBit(record.itemFlags, ITEM_VERTEX_SHADE, bound);
        break;
      case 'edgeShade':
        record.eShadeOffset = offset;
        record.itemFlags = toggleBit(record.itemFlags, ITEM_EDGE_SHADE, bound);
        break;
      case 'vertexPosition':
        // Always read while a topology is loaded; the slot offset is its only addressing.
        record.vPositionOffset = offset;
        break;
      default:
        /* v8 ignore next -- compile-time exhaustive Channel guard. */
        channel satisfies never;
    }
  };
}

/** The domain values bound without one map through: a height's own extent, else `[0, 1]`. */
export function initialDomain(channel: Channel, values: Float32Array | Float64Array): Domain {
  return channel === 'vertexHeight' ? (extent(values) ?? [0, 1]) : [0, 1];
}

/** Set or clear one u32 flag while keeping JavaScript bit operations unsigned. */
function toggleBit(value: number, bit: number, on: boolean): number {
  return (on ? value | bit : value & ~bit) >>> 0;
}
