/**
 * CPU side of `struct Uniforms` in `shaders/common.wgsl`: one table of fields, the word offsets it
 * implies, and typed setters over the uniform mirror. `Px` values are CSS pixels; `viewport` is
 * in device pixels, so `viewport / backing_scale` is the CSS size.
 */

import type { RGBA } from '@latkit/model';

import type { ResolvedOptions } from '../options.js';
import { POINTER_NONE, SHADE_HOST_WORDS } from '../shade.js';
import {
  focusBases,
  layoutBases,
  Mirror,
  structureBases,
  UNIFORM_WORDS,
  type PartCounts,
} from './buffers.js';

/** Display flag: draw the dot grid. */
export const DISPLAY_GRID = 1;
/** Display flag: draw arrowheads where wires enter readers. */
export const DISPLAY_ARROWS = 2;
/** Display flag: draw junction dots where wires branch. */
export const DISPLAY_JUNCTIONS = 4;
/** Display flag: draw text. */
export const DISPLAY_LABELS = 8;
/** Display flag: motion is reduced; dashes stand still as chevrons, glows hold steady. */
export const DISPLAY_REDUCED = 16;

/** Status colors the uniform block holds. */
export const STATUS_COLORS = 4;
/** Port colors the uniform block holds. */
export const PORT_COLORS = 8;
/** Channel slot records the uniform block holds, one per GPU channel. */
export const CHANNEL_SLOTS = 9;

/** One `struct Uniforms` member: its WGSL name, WGSL type, and 32-bit word offset. */
export interface UniformField {
  readonly name: string;
  readonly type: string;
  readonly word: number;
}

/**
 * The uniform layout, member for member as `struct Uniforms` declares it. A unit test parses the
 * WGSL struct, lays it out by WGSL's alignment rules, and compares it with this table.
 */
export const UNIFORM_LAYOUT: readonly UniformField[] = Object.freeze([
  { name: 'viewport', type: 'vec2f', word: 0 },
  { name: 'backing_scale', type: 'f32', word: 2 },
  { name: 'time', type: 'f32', word: 3 },
  { name: 'center', type: 'vec2f', word: 4 },
  { name: 'zoom', type: 'f32', word: 6 },
  { name: 'grid_pitch', type: 'f32', word: 7 },
  { name: 'pointer_px', type: 'vec2f', word: 8 },
  { name: 'flags', type: 'u32', word: 10 },
  { name: 'flow_rate', type: 'f32', word: 11 },
  { name: 'block_count', type: 'u32', word: 12 },
  { name: 'port_count', type: 'u32', word: 13 },
  { name: 'net_count', type: 'u32', word: 14 },
  { name: 'group_count', type: 'u32', word: 15 },
  { name: 'port_base', type: 'u32', word: 16 },
  { name: 'net_base', type: 'u32', word: 17 },
  { name: 'group_base', type: 'u32', word: 18 },
  { name: 'anchor_base', type: 'u32', word: 19 },
  { name: 'focus_port', type: 'u32', word: 20 },
  { name: 'focus_net', type: 'u32', word: 21 },
  { name: 'focus_group', type: 'u32', word: 22 },
  { name: 'status_count', type: 'u32', word: 23 },
  { name: 'port_color_count', type: 'u32', word: 24 },
  { name: 'atlas_cols', type: 'u32', word: 25 },
  { name: 'atlas_font_px', type: 'f32', word: 26 },
  { name: 'atlas_sdf_px', type: 'f32', word: 27 },
  { name: 'atlas_size', type: 'vec2f', word: 28 },
  { name: 'atlas_cell', type: 'vec2f', word: 30 },
  { name: 'block_base_color', type: 'vec4f', word: 32 },
  { name: 'outline_color', type: 'vec4f', word: 36 },
  { name: 'net_base_color', type: 'vec4f', word: 40 },
  { name: 'text_color', type: 'vec4f', word: 44 },
  { name: 'grid_color', type: 'vec4f', word: 48 },
  { name: 'group_color', type: 'vec4f', word: 52 },
  { name: 'hover_color', type: 'vec4f', word: 56 },
  { name: 'selected_color', type: 'vec4f', word: 60 },
  { name: 'status_colors', type: `array<vec4f, ${STATUS_COLORS}>`, word: 64 },
  { name: 'port_colors', type: `array<vec4f, ${PORT_COLORS}>`, word: 80 },
  { name: 'channels', type: `array<vec4u, ${CHANNEL_SLOTS}>`, word: 112 },
  { name: 'host', type: `array<vec4f, ${SHADE_HOST_WORDS / 4}>`, word: 148 },
]);

/** Word offset of a layout member. */
function wordOf(name: string): number {
  const field = UNIFORM_LAYOUT.find((entry) => entry.name === name);
  if (!field) throw new Error(`diagram uniforms: no member named ${name}`);
  return field.word;
}

export const W_VIEWPORT = wordOf('viewport');
export const W_BACKING_SCALE = wordOf('backing_scale');
export const W_TIME = wordOf('time');
export const W_CENTER = wordOf('center');
export const W_ZOOM = wordOf('zoom');
export const W_GRID_PITCH = wordOf('grid_pitch');
export const W_POINTER_PX = wordOf('pointer_px');
export const W_FLAGS = wordOf('flags');
export const W_FLOW_RATE = wordOf('flow_rate');
export const W_BLOCK_COUNT = wordOf('block_count');
export const W_PORT_BASE = wordOf('port_base');
export const W_FOCUS_PORT = wordOf('focus_port');
export const W_STATUS_COUNT = wordOf('status_count');
export const W_PORT_COLOR_COUNT = wordOf('port_color_count');
export const W_ATLAS_COLS = wordOf('atlas_cols');
export const W_BLOCK_BASE_COLOR = wordOf('block_base_color');
export const W_STATUS_COLORS = wordOf('status_colors');
export const W_PORT_COLORS = wordOf('port_colors');
export const W_CHANNELS = wordOf('channels');
export const W_HOST = wordOf('host');

/** Seconds after which the shader clock wraps, keeping f32 time precise. */
const TIME_WRAP_S = 3600;

/** The atlas geometry the glyph pass samples by; an `Atlas` is one. */
export interface AtlasShape {
  readonly cols: number;
  readonly fontPx: number;
  readonly sdfPx: number;
  readonly width: number;
  readonly height: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
}

/** The options the uniform block carries colors for. */
export type ColorOptions = Pick<
  ResolvedOptions,
  | 'blockBaseColor'
  | 'outlineColor'
  | 'netBaseColor'
  | 'textColor'
  | 'gridColor'
  | 'groupColor'
  | 'hoverColor'
  | 'selectedColor'
  | 'portColors'
  | 'statusColors'
>;

/** Typed setters over the uniform mirror; the renderer uploads the whole block every frame. */
export interface Uniforms {
  /** The uniform block. */
  readonly mirror: Mirror;
  /** `DISPLAY_*` bits. */
  flags: number;
  /** Grid pitch in diagram units: `u.grid_pitch`. */
  gridPitch: number;
  /** Dash speed multiplier for `netFlow` nets. */
  flowRate: number;
  /** The shade's 64-float host block, a view into the uniform block; `Shade.tick` writes it. */
  readonly host: Float32Array<ArrayBuffer>;
  /** The frame: CSS size, backing pixels per CSS pixel, and the clock in milliseconds. */
  setFrame(width: number, height: number, backingScale: number, nowMs: number): void;
  /** The camera: the diagram point at the viewport center and CSS pixels per diagram unit. */
  setCamera(centerX: number, centerY: number, zoom: number): void;
  /** The pointer in canvas-local CSS px, `u.pointer_px`, or null when there is none. */
  setPointer(pointer: readonly [number, number] | null): void;
  /** Theme colors, port colors, and status colors, with their counts. */
  setColors(options: ColorOptions): void;
  /** Part counts and every base offset they imply; null before a load. */
  setCounts(counts: PartCounts | null): void;
  /** The atlas geometry the glyph pass samples by. */
  setAtlas(atlas: AtlasShape): void;
  /**
   * One channel slot's record: its word offset in the channels mirror, whether it is bound, and
   * the `(value - min) * scale` normalization of a colormap channel.
   */
  setChannel(slot: number, offset: number, on: boolean, min: number, scale: number): void;
}

/**
 * Create the uniform setters over `mirror`, the uniform block of a `Mirrors` set, or over a new
 * one; either way the block starts with no pointer and a backing scale of 1.
 */
export function createUniforms(
  mirror: Mirror = new Mirror('diagram uniforms', 'uniform', UNIFORM_WORDS),
): Uniforms {
  if (mirror.usage !== 'uniform' || mirror.words !== UNIFORM_WORDS) {
    throw new Error(`diagram uniforms need a uniform mirror of ${UNIFORM_WORDS} words`);
  }
  const { f32, u32 } = mirror;
  const host = new Float32Array(f32.buffer, W_HOST * 4, SHADE_HOST_WORDS);

  function rgba(word: number, color: RGBA): void {
    f32[word] = color[0];
    f32[word + 1] = color[1];
    f32[word + 2] = color[2];
    f32[word + 3] = color[3];
  }

  function palette(word: number, colors: readonly RGBA[], capacity: number): number {
    const count = Math.min(colors.length, capacity);
    for (let i = 0; i < capacity; i++) {
      if (i < count) rgba(word + 4 * i, colors[i]!);
      else f32.fill(0, word + 4 * i, word + 4 * i + 4);
    }
    return count;
  }

  const uniforms: Uniforms = {
    mirror,
    host,
    get flags() {
      return u32[W_FLAGS]!;
    },
    set flags(value) {
      u32[W_FLAGS] = value;
    },
    get gridPitch() {
      return f32[W_GRID_PITCH]!;
    },
    set gridPitch(value) {
      f32[W_GRID_PITCH] = value;
    },
    get flowRate() {
      return f32[W_FLOW_RATE]!;
    },
    set flowRate(value) {
      f32[W_FLOW_RATE] = value;
    },
    setFrame(width, height, backingScale, nowMs) {
      // Written as CSS size times the scale, so `viewport / backing_scale` is the exact CSS size
      // even while a resize quantizes the backing store up.
      f32[W_VIEWPORT] = width * backingScale;
      f32[W_VIEWPORT + 1] = height * backingScale;
      f32[W_BACKING_SCALE] = backingScale;
      f32[W_TIME] = (nowMs / 1000) % TIME_WRAP_S;
    },
    setCamera(centerX, centerY, zoom) {
      f32[W_CENTER] = centerX;
      f32[W_CENTER + 1] = centerY;
      f32[W_ZOOM] = zoom;
    },
    setPointer(pointer) {
      f32[W_POINTER_PX] = pointer ? pointer[0] : POINTER_NONE;
      f32[W_POINTER_PX + 1] = pointer ? pointer[1] : POINTER_NONE;
    },
    setColors(options) {
      rgba(W_BLOCK_BASE_COLOR, options.blockBaseColor);
      rgba(W_BLOCK_BASE_COLOR + 4, options.outlineColor);
      rgba(W_BLOCK_BASE_COLOR + 8, options.netBaseColor);
      rgba(W_BLOCK_BASE_COLOR + 12, options.textColor);
      rgba(W_BLOCK_BASE_COLOR + 16, options.gridColor);
      rgba(W_BLOCK_BASE_COLOR + 20, options.groupColor);
      rgba(W_BLOCK_BASE_COLOR + 24, options.hoverColor);
      rgba(W_BLOCK_BASE_COLOR + 28, options.selectedColor);
      u32[W_STATUS_COUNT] = palette(W_STATUS_COLORS, options.statusColors, STATUS_COLORS);
      u32[W_PORT_COLOR_COUNT] = palette(W_PORT_COLORS, options.portColors, PORT_COLORS);
    },
    setCounts(counts) {
      const sizes = counts ?? EMPTY;
      const structure = structureBases(sizes);
      const layout = layoutBases(sizes);
      const focus = focusBases(sizes);
      u32[W_BLOCK_COUNT] = sizes.blockCount;
      u32[W_BLOCK_COUNT + 1] = sizes.portCount;
      u32[W_BLOCK_COUNT + 2] = sizes.netCount;
      u32[W_BLOCK_COUNT + 3] = sizes.groupCount;
      u32[W_PORT_BASE] = structure.port;
      u32[W_PORT_BASE + 1] = structure.net;
      u32[W_PORT_BASE + 2] = layout.group;
      u32[W_PORT_BASE + 3] = layout.anchor;
      u32[W_FOCUS_PORT] = focus.port;
      u32[W_FOCUS_PORT + 1] = focus.net;
      u32[W_FOCUS_PORT + 2] = focus.group;
    },
    setAtlas(atlas) {
      u32[W_ATLAS_COLS] = atlas.cols;
      f32[W_ATLAS_COLS + 1] = atlas.fontPx;
      f32[W_ATLAS_COLS + 2] = atlas.sdfPx;
      f32[W_ATLAS_COLS + 3] = atlas.width;
      f32[W_ATLAS_COLS + 4] = atlas.height;
      f32[W_ATLAS_COLS + 5] = atlas.cellWidth;
      f32[W_ATLAS_COLS + 6] = atlas.cellHeight;
    },
    setChannel(slot, offset, on, min, scale) {
      const at = W_CHANNELS + 4 * slot;
      u32[at] = offset;
      u32[at + 1] = on ? 1 : 0;
      f32[at + 2] = min;
      f32[at + 3] = scale;
    },
  };
  uniforms.setFrame(0, 0, 1, 0);
  uniforms.setPointer(null);
  return uniforms;
}

/** The counts before any load. */
const EMPTY: PartCounts = { blockCount: 0, portCount: 0, netCount: 0, groupCount: 0 };
