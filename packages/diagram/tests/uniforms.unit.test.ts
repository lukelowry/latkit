import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SLOT } from '../src/channels.js';
import { DEFAULT_OPTIONS, OPTIONS } from '../src/options.js';
import { PART_BLOCK, PART_GROUP, PART_NET, PART_PORT } from '../src/part.js';
import * as prepareModule from '../src/prepare.js';
import { POINTER_NONE, SHADE_HOST_WORDS } from '../src/shade.js';
import { SHADER_VISUALS, VISUAL, wgslName } from '../src/visual.js';
import * as buffers from '../src/webgpu/buffers.js';
import {
  CHANNEL_SLOTS,
  createUniforms,
  DISPLAY_ARROWS,
  DISPLAY_EDIT,
  DISPLAY_GRID,
  DISPLAY_JUNCTIONS,
  DISPLAY_LABELS,
  DISPLAY_REDUCED,
  PORT_COLORS,
  STATUS_COLORS,
  UNIFORM_LAYOUT,
  W_GRID_PITCH,
  W_HOST,
  W_POINTER_PX,
} from '../src/webgpu/uniforms.js';
import { twoArea } from './fixtures/netlists.js';

const common = readFileSync(new URL('../src/webgpu/shaders/common.wgsl', import.meta.url), 'utf8');

/** WGSL size and alignment in bytes of the member types `struct Uniforms` uses. */
function wgslLayout(type: string): { readonly size: number; readonly align: number } {
  const array = /^array<(\w+),\s*(\d+)>$/.exec(type);
  if (array) {
    const element = wgslLayout(array[1]!);
    // Uniform-space arrays stride at a multiple of 16.
    const stride = Math.ceil(element.size / 16) * 16;
    return { size: stride * Number(array[2]), align: 16 };
  }
  switch (type) {
    case 'f32':
    case 'u32':
    case 'i32':
      return { size: 4, align: 4 };
    case 'vec2f':
    case 'vec2u':
      return { size: 8, align: 8 };
    case 'vec4f':
    case 'vec4u':
      return { size: 16, align: 16 };
    default:
      throw new Error(`no layout for WGSL type ${type}`);
  }
}

/** The members of `struct Uniforms` with the word offsets WGSL assigns, and its size. */
function parseUniforms(source: string): {
  readonly fields: { name: string; type: string; word: number }[];
  readonly bytes: number;
} {
  const start = source.indexOf('struct Uniforms {');
  const body = source.slice(start, source.indexOf('\n}', start));
  const members = [...body.matchAll(/^\s+(\w+)\s*:\s*(array<[^>]+>|\w+)\s*,/gm)];
  let cursor = 0;
  let align = 1;
  const fields = members.map(([, name, type]) => {
    const layout = wgslLayout(type!.replace(/\s+/g, ' '));
    cursor = Math.ceil(cursor / layout.align) * layout.align;
    const field = { name: name!, type: type!.replace(/\s+/g, ' '), word: cursor / 4 };
    cursor += layout.size;
    align = Math.max(align, layout.align);
    return field;
  });
  return { fields, bytes: Math.ceil(cursor / Math.max(align, 16)) * Math.max(align, 16) };
}

/** Every module-scope `const` in a WGSL source, evaluated. */
function wgslConstants(source: string): Map<string, number> {
  const constants = new Map<string, number>();
  for (const [, name, literal] of source.matchAll(/^const (\w+): \w+ = ([^;]+);/gm)) {
    const text = literal!.trim().replace(/u$/, '');
    constants.set(name!, text.startsWith('0x') ? Number.parseInt(text, 16) : Number(text));
  }
  return constants;
}

describe('struct Uniforms', () => {
  it('lays out in WGSL exactly as the TypeScript table says', () => {
    const { fields, bytes } = parseUniforms(common);
    expect(fields).toEqual(UNIFORM_LAYOUT.map(({ name, type, word }) => ({ name, type, word })));
    expect(bytes).toBe(buffers.UNIFORM_WORDS * 4);
    expect(UNIFORM_LAYOUT.at(-1)!.word + SHADE_HOST_WORDS).toBe(buffers.UNIFORM_WORDS);
  });

  it('holds as many palette and slot entries as the TypeScript side writes', () => {
    expect(STATUS_COLORS).toBe(OPTIONS.statusColors.max);
    expect(PORT_COLORS).toBe(OPTIONS.portColors.max);
    expect(CHANNEL_SLOTS).toBe(Object.keys(SLOT).length);
  });
});

describe('WGSL constants', () => {
  const expected = new Map<string, number>([
    ['NONE', prepareModule.NONE],
    ['POINTER_NONE', POINTER_NONE],
    ['PART_BLOCK', PART_BLOCK],
    ['PART_PORT', PART_PORT],
    ['PART_NET', PART_NET],
    ['PART_GROUP', PART_GROUP],
    ['FLOW_IN', prepareModule.FLOW_IN],
    ['FLOW_OUT', prepareModule.FLOW_OUT],
    ['FLOW_BOTH', prepareModule.FLOW_BOTH],
    ['SIDE_LEFT', prepareModule.SIDE_LEFT],
    ['SIDE_RIGHT', prepareModule.SIDE_RIGHT],
    ['SIDE_TOP', prepareModule.SIDE_TOP],
    ['SIDE_BOTTOM', prepareModule.SIDE_BOTTOM],
    ['STYLE_WIRE', prepareModule.STYLE_WIRE],
    ['STYLE_TAG', prepareModule.STYLE_TAG],
    ['DISPLAY_GRID', DISPLAY_GRID],
    ['DISPLAY_ARROWS', DISPLAY_ARROWS],
    ['DISPLAY_JUNCTIONS', DISPLAY_JUNCTIONS],
    ['DISPLAY_LABELS', DISPLAY_LABELS],
    ['DISPLAY_REDUCED', DISPLAY_REDUCED],
    ['DISPLAY_EDIT', DISPLAY_EDIT],
    ...Object.entries(SLOT).map(
      ([channel, slot]) => [`SLOT_${wgslName(channel)}`, slot] as [string, number],
    ),
    ...SHADER_VISUALS.map((key) => [wgslName(key), VISUAL[key]] as [string, number]),
  ]);
  for (const name of [
    'BLOCK_WORDS',
    'BLOCK_TITLED',
    'PORT_WORDS',
    'PORT_FLOW_MASK',
    'PORT_SIDE_SHIFT',
    'PORT_KIND_SHIFT',
    'PORT_TAG',
    'NET_WORDS',
    'FOCUS_HOVER',
    'FOCUS_SELECTED',
    'FOCUS_COMPATIBLE',
    'FOCUS_TARGET',
    'FOCUS_DRAGGING',
    'WIRE_WORDS',
    'WIRE_EMPTY',
    'WIRE_SEGMENT',
    'WIRE_JUNCTION',
    'WIRE_ARROW',
    'GLYPH_WORDS',
    'ANCHOR_BLOCK',
    'ANCHOR_PORT',
    'ANCHOR_NET',
    'ANCHOR_GROUP',
    'ROLE_TITLE',
    'ROLE_LABEL',
    'ROLE_PORT',
    'ROLE_TAG',
    'ROLE_NET',
    'ROLE_GROUP',
    'GLYPH_WIDE',
    'OVERLAY_WORDS',
    'OVERLAY_ALONG',
    'OVERLAY_MARQUEE',
    'OVERLAY_PREVIEW',
    'OVERLAY_GHOST',
  ] as const) {
    expected.set(name, buffers[name]);
  }

  it('equal the TypeScript constants, one for one', () => {
    const actual = wgslConstants(common);
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
  });

  it('are named after their TypeScript keys', () => {
    expect(wgslName('blockColor')).toBe('BLOCK_COLOR');
    expect(wgslName('wireHalfWidthPx')).toBe('WIRE_HALF_WIDTH_PX');
  });
});

describe('createUniforms', () => {
  const word = (name: string) => UNIFORM_LAYOUT.find((field) => field.name === name)!.word;

  it('starts with no pointer and a unit backing scale', () => {
    const uniforms = createUniforms();
    const { f32 } = uniforms.mirror;
    expect(uniforms.mirror.words).toBe(buffers.UNIFORM_WORDS);
    expect(f32[word('pointer_px')]).toBe(POINTER_NONE);
    expect(f32[word('pointer_px') + 1]).toBe(POINTER_NONE);
    expect(f32[word('backing_scale')]).toBe(1);
  });

  it("wraps a mirror set's uniform block, and only a uniform block", () => {
    const mirrors = buffers.createMirrors();
    expect(createUniforms(mirrors.uniforms).mirror).toBe(mirrors.uniforms);
    expect(() => createUniforms(mirrors.layout)).toThrow('uniform mirror of 212 words');
  });

  it('writes the frame, the camera, and the pointer', () => {
    const uniforms = createUniforms();
    const { f32 } = uniforms.mirror;
    uniforms.setFrame(800, 600, 2, 3_601_500);
    expect([f32[word('viewport')], f32[word('viewport') + 1]]).toEqual([1600, 1200]);
    expect(f32[word('backing_scale')]).toBe(2);
    expect(f32[word('time')]).toBeCloseTo(1.5, 5);
    uniforms.setCamera(10, -20, 1.5);
    expect([f32[word('center')], f32[word('center') + 1], f32[word('zoom')]]).toEqual([
      10, -20, 1.5,
    ]);
    uniforms.setPointer([12, 34]);
    expect([f32[W_POINTER_PX], f32[W_POINTER_PX + 1]]).toEqual([12, 34]);
    uniforms.setPointer(null);
    expect(f32[word('pointer_px')]).toBe(POINTER_NONE);
  });

  it('keeps flags, grid pitch, and flow rate as properties over their words', () => {
    const uniforms = createUniforms();
    uniforms.flags = DISPLAY_GRID | DISPLAY_EDIT;
    uniforms.gridPitch = 8;
    uniforms.flowRate = 0.5;
    expect(uniforms.mirror.u32[word('flags')]).toBe(33);
    expect(uniforms.mirror.f32[word('grid_pitch')]).toBe(8);
    expect(uniforms.mirror.f32[W_GRID_PITCH]).toBe(8);
    expect(uniforms.mirror.f32[word('flow_rate')]).toBe(0.5);
    expect([uniforms.flags, uniforms.gridPitch, uniforms.flowRate]).toEqual([33, 8, 0.5]);
  });

  it('writes theme colors and palettes with their counts', () => {
    const uniforms = createUniforms();
    const { f32, u32 } = uniforms.mirror;
    uniforms.setColors({
      ...DEFAULT_OPTIONS,
      textColor: [0.1, 0.2, 0.3, 0.4],
      selectedColor: [1, 0, 0, 1],
      portColors: [
        [0, 0, 1, 1],
        [0, 1, 0, 1],
        [1, 0, 0, 1],
      ],
    });
    const rgba = (at: number) => Array.from(f32.subarray(at, at + 4));
    expect(rgba(word('block_base_color'))).toEqual(
      Array.from(Float32Array.from(DEFAULT_OPTIONS.blockBaseColor)),
    );
    expect(rgba(word('text_color'))).toEqual(Array.from(Float32Array.of(0.1, 0.2, 0.3, 0.4)));
    expect(rgba(word('selected_color'))).toEqual([1, 0, 0, 1]);
    expect(rgba(word('port_colors') + 8)).toEqual([1, 0, 0, 1]);
    expect(rgba(word('port_colors') + 12)).toEqual([0, 0, 0, 0]);
    expect(u32[word('port_color_count')]).toBe(3);
    expect(u32[word('status_count')]).toBe(2);
    expect(rgba(word('status_colors') + 4)).toEqual(
      Array.from(Float32Array.from(DEFAULT_OPTIONS.statusColors[1]!)),
    );
  });

  it('writes counts and every base offset', () => {
    const uniforms = createUniforms();
    const { u32 } = uniforms.mirror;
    const prepared = prepareModule.prepare(
      { ...twoArea(), groupCount: 1, blockGroup: Uint32Array.of(0, 0, 0) },
      8,
    );
    uniforms.setCounts(prepared);
    const structure = buffers.structureBases(prepared);
    const layout = buffers.layoutBases(prepared);
    const focus = buffers.focusBases(prepared);
    const read = (...names: string[]) => names.map((name) => u32[word(name)]);
    expect(read('block_count', 'port_count', 'net_count', 'group_count')).toEqual([3, 7, 3, 1]);
    expect(read('port_base', 'net_base', 'group_base', 'anchor_base')).toEqual([
      structure.port,
      structure.net,
      layout.group,
      layout.anchor,
    ]);
    expect(read('focus_port', 'focus_net', 'focus_group')).toEqual([
      focus.port,
      focus.net,
      focus.group,
    ]);
    uniforms.setCounts(null);
    expect(read('block_count', 'port_base', 'focus_group')).toEqual([0, 0, 0]);
  });

  it('writes the atlas geometry', () => {
    const uniforms = createUniforms();
    const { f32, u32 } = uniforms.mirror;
    uniforms.setAtlas({
      cols: 25,
      fontPx: 40,
      sdfPx: 6,
      width: 1024,
      height: 256,
      cellWidth: 40,
      cellHeight: 62,
    });
    expect(u32[word('atlas_cols')]).toBe(25);
    expect([f32[word('atlas_font_px')], f32[word('atlas_sdf_px')]]).toEqual([40, 6]);
    expect([f32[word('atlas_size')], f32[word('atlas_size') + 1]]).toEqual([1024, 256]);
    expect([f32[word('atlas_cell')], f32[word('atlas_cell') + 1]]).toEqual([40, 62]);
  });

  it('writes a slot record as u32 offset and flag with f32 normalization', () => {
    const uniforms = createUniforms();
    const { f32, u32 } = uniforms.mirror;
    uniforms.setChannel(SLOT.netColor, 19, true, -1, 0.5);
    const at = word('channels') + 4 * SLOT.netColor;
    expect([u32[at], u32[at + 1], f32[at + 2], f32[at + 3]]).toEqual([19, 1, -1, 0.5]);
    uniforms.setChannel(SLOT.netColor, 19, false, 0, 0);
    expect(u32[at + 1]).toBe(0);
  });

  it('exposes the host block as a view of the uniform block', () => {
    const uniforms = createUniforms();
    expect(uniforms.host.length).toBe(SHADE_HOST_WORDS);
    expect(uniforms.host.buffer).toBe(uniforms.mirror.f32.buffer);
    uniforms.host[5] = 42;
    expect(uniforms.mirror.f32[W_HOST + 5]).toBe(42);
  });
});
