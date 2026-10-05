import {
  bitAt,
  failure,
  fieldDefinition,
  type Column,
  type Data,
  type FieldInput,
  type FieldsBlock,
  type ReadScope,
  type RowSelection,
  type SampleWindow,
} from '@latkit/model';
import { validateRgba, type RGBA } from '../colors/color.js';
import type { Colormap } from '../colors/colormap.js';
import type { ColormapName } from '../colors/catalog.js';
import type { GpuField, GpuPage } from '../fields/types.js';
import {
  fieldScale,
  scaleValue,
  type ColorScale,
  type Range,
  type ResolvedScale,
  type Scale,
  type ScaleDomain,
} from './scale.js';

/** A value per drawn row: one for every row, a field's, or a field's through a scale. */
export type Channel<T extends number | boolean = number> = T | FieldInput | Scale | null;
/** A color per drawn row: one for every row, or a field's through a colormap. */
export type ColorChannel = RGBA | FieldInput | ColorScale | null;

/**
 * How a channel reads a field: `raw` as it is, `color` through a colormap, or onto a range by a
 * scale over the field's extent.
 */
export type ChannelKind = 'raw' | 'color' | Range;
/** How a bound channel's field maps, its range resolved. */
export interface ChannelScale {
  readonly domain?: ScaleDomain;
  readonly range: Range;
  readonly clamp?: boolean;
}
/** A channel of one type's options, bound to a column of the type's fields read. */
export interface BoundChannel {
  /** The column it reads; absent for a constant or an unset channel. */
  readonly column?: string;
  readonly field?: FieldInput;
  /** The lane of a vector field. */
  readonly component: number;
  /** How the field maps; absent when it reads as it is. */
  readonly scale?: ChannelScale;
  /** Whether it reads a color: a position in its colormap, or -1 without a value. */
  readonly color?: boolean;
  readonly colormap?: Colormap | ColormapName;
  /** The color of rows the field leaves empty. */
  readonly missing?: RGBA;
  /** Every row's value without a field: a number, 0 or 1 for a boolean, or a color. */
  readonly constant?: number | RGBA;
}
/** A type's channels, and the fields they read: channels of one field share its column. */
export interface BoundChannels<K extends string> {
  readonly fields: Readonly<Record<string, FieldInput>>;
  readonly channels: Readonly<Record<K, BoundChannel>>;
}
/** A bound channel ready to read: its scale resolved, and the value of rows without one. */
export interface ChannelRead {
  readonly column?: string;
  readonly component: number;
  readonly scale?: ResolvedScale;
  /** Every row without a field, and rows without a value. */
  readonly fallback: number;
}

const COMPONENTS = 16;
function isField(value: object): value is Exclude<FieldInput, string> {
  return 'source' in value || ('index' in value && 'values' in value);
}
/** A field named without a scale: as it is, or through the kind's scale. */
function bare(field: FieldInput, kind: ChannelKind): BoundChannel {
  if (kind === 'raw') return { field, component: 0 };
  if (kind === 'color') return { field, component: 0, color: true, scale: { range: [0, 1] } };
  return { field, component: 0, scale: { range: kind } };
}
function bind(name: string, value: unknown, kind: ChannelKind): BoundChannel {
  const invalid = () => failure('invalid-input', 'Invalid ' + name);
  if (value === undefined || value === null)
    return kind === 'color' ? { component: 0, color: true } : { component: 0 };
  if (typeof value === 'string') {
    if (!value) throw invalid();
    return bare(value, kind);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (kind === 'color' || !Number.isFinite(+value)) throw invalid();
    return { component: 0, constant: +value };
  }
  if (Array.isArray(value)) {
    if (kind !== 'color') throw invalid();
    validateRgba(value, name);
    return { component: 0, color: true, constant: value };
  }
  if (typeof value !== 'object') throw invalid();
  if (isField(value)) return bare(value, kind);
  const scale = value as Scale & ColorScale;
  const component = scale.component ?? 0;
  if (!scale.field || !Number.isInteger(component) || component < 0 || component >= COMPONENTS)
    throw invalid();
  if (kind === 'color') {
    if (scale.missing) validateRgba(scale.missing, name + ' missing');
    return {
      field: scale.field,
      component,
      color: true,
      scale: { domain: scale.domain, range: [0, 1] },
      ...(scale.colormap ? { colormap: scale.colormap } : {}),
      ...(scale.missing ? { missing: scale.missing } : {}),
    };
  }
  const range = scale.range ?? (kind === 'raw' ? undefined : kind);
  return {
    field: scale.field,
    component,
    ...(range ? { scale: { domain: scale.domain, range, clamp: scale.clamp } } : {}),
  };
}
/**
 * Bind the channels `kinds` names in one type's options. Channels reading one field share its
 * column, named after the first of them.
 */
export function bindChannels<K extends string>(
  options: object,
  kinds: Readonly<Record<K, ChannelKind>>,
): BoundChannels<K> {
  const fields: Record<string, FieldInput> = {},
    columns = new Map<FieldInput, string>(),
    channels = {} as Record<K, BoundChannel>;
  for (const name of Object.keys(kinds) as K[]) {
    const bound = bind(name, (options as Record<string, unknown>)[name], kinds[name]);
    if (bound.field === undefined) channels[name] = bound;
    else {
      let column = columns.get(bound.field);
      if (column === undefined) {
        columns.set(bound.field, (column = name));
        fields[column] = bound.field;
      }
      channels[name] = { ...bound, column };
    }
  }
  return { fields, channels };
}
/**
 * A bound channel ready to read; a scale whose domain is still unknown reads the fallback. A color
 * reads -1 without a value, so a shader draws its constant color instead.
 */
export function channelRead(
  bound: BoundChannel,
  scale: ResolvedScale | null | undefined,
  fallback: number,
): ChannelRead {
  return {
    column: bound.column,
    component: bound.component,
    scale: bound.scale
      ? (scale ?? { domain: null, range: bound.scale.range, clamp: bound.scale.clamp ?? true })
      : undefined,
    fallback: bound.color ? -1 : typeof bound.constant === 'number' ? bound.constant : fallback,
  };
}
/**
 * A type's channels ready to read, each scaled one's domain resolved over the rows it reads, and
 * over `window` for a sampled field. Rows without a value read their channel's `fallbacks`, or 0.
 */
export async function readChannels<K extends string>(
  reader: ReadScope,
  request: {
    readonly source: Data;
    readonly from: string;
    readonly rows?: RowSelection;
    readonly window?: SampleWindow;
  },
  bound: BoundChannels<K>,
  fallbacks: Readonly<Partial<Record<K, number>>> = {} as Readonly<Partial<Record<K, number>>>,
): Promise<Record<K, ChannelRead>> {
  const { source, from, rows, window } = request,
    out = {} as Record<K, ChannelRead>;
  for (const name of Object.keys(bound.channels) as K[]) {
    const channel = bound.channels[name],
      field = channel.field;
    const scale =
      channel.scale && field !== undefined
        ? await fieldScale(reader, {
            ...channel.scale,
            source,
            from,
            rows,
            field,
            window: window && fieldDefinition(source, from, field)?.sampled ? window : undefined,
          })
        : undefined;
    out[name] = channelRead(channel, scale, fallbacks[name] ?? 0);
  }
  return out;
}
const NONE = 0xffffffff;
const float = new Float32Array(1),
  bits = new Uint32Array(float.buffer);
function word(value: number): number {
  float[0] = value;
  return bits[0];
}
/**
 * Write a channel's eight words at word `at`, as it reads a page's column or one uploaded field:
 * the field's slot and lane, how values map, and the fallback. `origin` replaces the upload origin
 * a raw value adds, for a view that rebases values itself.
 */
export function writeChannel(
  words: Uint32Array,
  at: number,
  channel: ChannelRead,
  source: GpuPage | GpuField | undefined,
  origin?: number,
): void {
  const field =
    source && 'columns' in source
      ? channel.column === undefined
        ? undefined
        : source.columns[channel.column]
      : source;
  // Mapping in the low two bits: 0 as it is, 1 linear, 2 the range midpoint, 3 the fallback.
  let slot = NONE,
    mode = 3,
    add = 0,
    lo = 0,
    inverse = 0,
    start = 0,
    span = 0;
  if (field) {
    if (field.kind !== 'value' || channel.component >= field.components)
      throw failure('invalid-input', 'A channel reads a scalar field, or one lane of a vector');
    slot = field.slot;
    const base = field.origin?.[channel.component] ?? 0,
      scale = channel.scale;
    if (!scale) {
      mode = 0;
      add = origin ?? base;
    } else if (scale.domain) {
      const [a, b] = scale.domain;
      mode = a === b ? 2 : 1;
      lo = a - base;
      inverse = a === b ? 0 : 1 / (b - a);
      start = scale.range[0];
      span = scale.range[1] - scale.range[0];
      if (![lo, inverse, start, span].every((v) => Number.isFinite(Math.fround(v))))
        throw failure('precision', 'Scale exceeds Float32 relative precision');
      if (scale.clamp) mode |= 4;
    }
  }
  words[at] = word(lo);
  words[at + 1] = word(inverse);
  words[at + 2] = word(start);
  words[at + 3] = word(span);
  words[at + 4] = slot;
  words[at + 5] = mode | (channel.component << 4);
  words[at + 6] = word(add);
  words[at + 7] = word(channel.fallback);
}

/** A cell's number at a row and frame: a numeric value, a boolean as 0 or 1, or a vector's lane. */
function lane(column: Column | undefined, row: number, frame: number, component: number): number {
  if (!column) return NaN;
  const strides = column as { readonly rowStride?: number; readonly frameStride?: number },
    at = column.offset + row * (strides.rowStride ?? 1) + frame * (strides.frameStride ?? 0);
  if (!bitAt(column.validity, at)) return NaN;
  if (column.kind === 'numeric') return column.values[at];
  if (column.kind === 'boolean') return bitAt(column.values, at) ? 1 : 0;
  if (column.kind === 'vector')
    return column.values.values[column.values.offset + at * column.size + component];
  return NaN;
}
/** A channel's value at a row, and frame, of a fields block: as a shader reads it. */
export function channelValue(
  channel: ChannelRead,
  block: FieldsBlock,
  row: number,
  frame = 0,
): number {
  const name = channel.column;
  if (name === undefined || !bitAt(block.presence[name], row)) return channel.fallback;
  const value = lane(block.columns[name], row, frame, channel.component);
  if (!Number.isFinite(value)) return channel.fallback;
  return channel.scale ? (scaleValue(value, channel.scale) ?? channel.fallback) : value;
}

/** The channel a field shader reads, after the field accessors. */
export const channelShader = /* wgsl */ `
/** One value per row: a field's lane, as it is or through a scale, or the fallback. */
struct LatkitChannel {
  /** Domain start less the upload origin, one over its span, the range start, and its span. */
  map: vec4f,
  slot: u32,
  /** Mapping in bits 0-1: as it is, linear, the midpoint, or the fallback; clamp in bit 2; the lane from bit 4. */
  mode: u32,
  /** What a value read as it is adds, such as its upload origin. */
  origin: f32,
  fallback: f32,
}
fn finiteValue(v: f32) -> bool { return (bitcast<u32>(v) & 0x7f800000u) != 0x7f800000u; }
fn channelNumber(c: LatkitChannel, row: u32, frame: u32) -> f32 {
  if (c.slot == 0xffffffffu || !fieldValid(c.slot, row, frame)) { return c.fallback; }
  var value = 0.0;
  if (latkitFields.fields[c.slot].kind == FIELD_BOOLEAN) { value = select(0.0, 1.0, fieldBool(c.slot, row, frame)); }
  else { value = fieldFloat(c.slot, row, frame, c.mode >> 4u); }
  let mapping = c.mode & 3u;
  if (!finiteValue(value) || mapping == 3u) { return c.fallback; }
  if (mapping == 0u) { return value + c.origin; }
  var t = 0.5;
  if (mapping == 1u) { t = (value - c.map.x) * c.map.y; }
  if ((c.mode & 4u) != 0u) { t = clamp(t, 0.0, 1.0); }
  return c.map.z + t * c.map.w;
}`;
/** A colormapped channel's color, or `constant` without a value; after the colormap shader. */
export const channelColorShader = /* wgsl */ `
fn channelColor(c: LatkitChannel, row: u32, frame: u32, constant: vec4f) -> vec4f {
  if (c.slot == 0xffffffffu) { return constant; }
  let t = channelNumber(c, row, frame);
  if (!(t >= 0.0)) { return constant; }
  return colormapColor(t);
}`;
