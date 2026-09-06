import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  createUniforms,
  DISPLAY_DAYLIGHT,
  DISPLAY_GRATICULE,
  ITEM_EDGE_VISIBLE,
  ITEM_VERTEX_VISIBLE,
  UNIFORM_BUFFER_BYTES,
  UNIFORM_LAYOUT,
  W_ITEM_FLAGS,
  W_DEPTH_MIX,
} from '../src/webgpu/uniforms.js';

describe('uniform layout table', () => {
  // The natural-layout validator runs at module load: importing uniforms.js
  // at all proves each declared offset is the one WGSL assigns. These tests
  // pin the two remaining degrees of freedom - the hand-written WGSL struct
  // text and a couple of raw literals as double-entry bookkeeping.

  it('matches the hand-written WGSL struct field for field', () => {
    const src = readFileSync(
      new URL('../src/shaders/common/uniforms.wgsl', import.meta.url),
      'utf8',
    );
    const body = src.slice(src.indexOf('struct Uniforms {'), src.indexOf('\n}'));
    const fields = [...body.matchAll(/^ {2}(\w+)\s*:\s*(\w+),/gm)].map((m) => ({
      name: m[1],
      type: m[2],
    }));
    expect(fields).toEqual(UNIFORM_LAYOUT.map(({ name, type }) => ({ name, type })));
  });

  it('keeps the pad-lane scalars and block anchors at their published offsets', () => {
    const wordOf = (name: string) => UNIFORM_LAYOUT.find((f) => f.name === name)?.word;
    expect(wordOf('fov_scale')).toBe(19);
    expect(wordOf('depth_mix')).toBe(95);
    expect(wordOf('item_flags')).toBe(99);
    expect(wordOf('graticule_color')).toBe(76);
    expect(wordOf('backing_scale')).toBe(88);
    expect(UNIFORM_BUFFER_BYTES).toBe(432);
  });
});

describe('createUniforms', () => {
  it('creates a raw buffer that matches the exported uniform layout size', () => {
    const u = createUniforms();
    expect(u.raw.byteLength).toBe(UNIFORM_BUFFER_BYTES);
  });

  it('camera region writes to bytes 0-111', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    u.camera.flatSx = 2.5;
    expect(view[24]).toBe(2.5);
    u.camera.fovScale = 0.33;
    expect(view[19]).toBeCloseTo(0.33);
  });

  it('packs the camera basis and depth blend into the final aligned block', () => {
    const u = createUniforms();
    const view = new Float32Array(16);
    view[0] = 1;
    view[4] = 2;
    view[8] = 3;
    view[1] = 4;
    view[5] = 5;
    view[9] = 6;
    u.camera.setCameraBasis(view);
    u.camera.depthMix = 0.25;

    expect(u.rawF32).toBeInstanceOf(Float32Array);
    expect(u.rawF32.buffer).toBe(u.raw);
    expect(Array.from(u.rawF32.slice(92, 95))).toEqual([1, 2, 3]);
    expect(Array.from(u.rawF32.slice(96, 99))).toEqual([4, 5, 6]);
    expect(u.rawF32[W_DEPTH_MIX]).toBe(0.25);
    expect(u.rawF32.length).toBe(108);
  });

  it('light region owns the sun direction and display flags', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    u.light.setDir(0.1, 0.2, 0.3);
    expect(view[20]).toBeCloseTo(0.1);
    expect(view[21]).toBeCloseTo(0.2);
    expect(view[22]).toBeCloseTo(0.3);
    u.display.flags = DISPLAY_DAYLIGHT | DISPLAY_GRATICULE;
    expect(u.rawU32[23]).toBe(DISPLAY_DAYLIGHT | DISPLAY_GRATICULE);
  });

  it('camera setViewProj copies 16 floats to bytes 0-63', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    const vp = new Float32Array(16);
    vp[0] = 1;
    vp[5] = 2;
    vp[10] = 3;
    vp[15] = 4;
    u.camera.setViewProj(vp);
    expect(view[0]).toBe(1);
    expect(view[5]).toBe(2);
    expect(view[10]).toBe(3);
    expect(view[15]).toBe(4);
  });

  it('frame region writes viewport and presentation scale to their packed slots', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    u.frame.viewportX = 1920;
    u.frame.viewportY = 1080;
    expect(view[28]).toBe(1920);
    expect(view[29]).toBe(1080);
    u.frame.backingScale = 2;
    expect(view[88]).toBe(2);
  });

  it('geometry region writes to bytes 120-135', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    u.geometry.vRadius = 0.08;
    expect(view[30]).toBeCloseTo(0.08);
    u.geometry.eHalfWidth = 0.012;
    expect(view[31]).toBeCloseTo(0.012);
    u.geometry.heightAmplitude = 0.25;
    expect(view[33]).toBeCloseTo(0.25);
  });

  it('highlight region writes ids and style values to their packed slots', () => {
    const u = createUniforms();
    const iview = new Int32Array(u.raw);
    const fview = new Float32Array(u.raw);
    u.focus.vHoverId = 42;
    u.focus.eHoverId = -1;
    u.focus.vSelectedId = 7;
    u.focus.eSelectedId = -1;
    expect(iview[34]).toBe(42);
    expect(iview[35]).toBe(-1);
    expect(iview[36]).toBe(7);
    expect(iview[37]).toBe(-1);
    u.focus.hoverColor = 0x06 | (0xb6 << 8) | (0xd4 << 16);
    u.focus.selectedColor = 0x9b | (0x23 << 8) | (0x35 << 16);
    u.focus.flags = 7;
    u.focus.hoverAlpha = 0.5;
    u.focus.selectedAlpha = 0.82;
    u.focus.vHoverPx = 6;
    u.focus.vSelectedPx = 7;
    u.focus.eHoverPx = 3.5;
    u.focus.eSelectedPx = 5;
    u.focus.setEndpoints(1, 2, 3, 4);
    const uview = new Uint32Array(u.raw);
    expect(uview[55]).toBe(0x06 | (0xb6 << 8) | (0xd4 << 16));
    expect(uview[56]).toBe(0x9b | (0x23 << 8) | (0x35 << 16));
    expect(uview[57]).toBe(7);
    expect(fview[58]).toBeCloseTo(0.5);
    expect(fview[59]).toBeCloseTo(0.82);
    expect(fview[60]).toBeCloseTo(6);
    expect(fview[61]).toBeCloseTo(7);
    expect(fview[62]).toBeCloseTo(3.5);
    expect(fview[63]).toBeCloseTo(5);
    expect(iview[68]).toBe(1);
    expect(iview[69]).toBe(2);
    expect(iview[70]).toBe(3);
    expect(iview[71]).toBe(4);
  });

  it('highlight slots default to the absent-selection sentinel', () => {
    const u = createUniforms();
    expect(u.focus.vHoverId).toBe(-1);
    expect(u.focus.eHoverId).toBe(-1);
    expect(u.focus.vSelectedId).toBe(-1);
    expect(u.focus.eSelectedId).toBe(-1);
    const iview = new Int32Array(u.raw);
    expect(Array.from(iview.slice(68, 72))).toEqual([-1, -1, -1, -1]);
  });

  it('channel region writes offset and mode values at correct packed positions', () => {
    const u = createUniforms();
    const uview = new Uint32Array(u.raw);
    const fview = new Float32Array(u.raw);
    u.channel.vColorOffset = 1000;
    u.channel.eColorOffset = 2000;
    u.channel.eDashOffset = 3000;
    u.channel.vHeightOffset = 4000;
    expect(uview[38]).toBe(1000);
    expect(uview[39]).toBe(2000);
    expect(uview[40]).toBe(3000);
    expect(uview[41]).toBe(4000);
    u.channel.vColorMin = 0.5;
    expect(fview[43]).toBeCloseTo(0.5);
    u.channel.vHeightMin = 1.5;
    u.channel.vHeightScale = 0.25;
    u.channel.vHeightOutMin = -1;
    u.channel.vHeightOutSpan = 2;
    u.channel.vHeightMode = 1;
    u.channel.vSizeOffset = 5000;
    u.channel.vSizeMode = 1;
    u.channel.vSizeMin = 0.3;
    u.channel.vSizeScale = 0.4;
    u.channel.vVisibleOffset = 6000;
    u.channel.eVisibleOffset = 7000;
    u.channel.itemFlags = ITEM_VERTEX_VISIBLE | ITEM_EDGE_VISIBLE;
    expect(fview[48]).toBeCloseTo(1.5);
    expect(fview[49]).toBeCloseTo(0.25);
    expect(fview[64]).toBeCloseTo(-1);
    expect(fview[65]).toBeCloseTo(2);
    expect(uview[50]).toBe(1);
    expect(uview[51]).toBe(5000);
    expect(uview[52]).toBe(1);
    expect(fview[53]).toBeCloseTo(0.3);
    expect(fview[54]).toBeCloseTo(0.4);
    expect(uview[100]).toBe(6000);
    expect(uview[101]).toBe(7000);
    expect(uview[W_ITEM_FLAGS]).toBe(ITEM_VERTEX_VISIBLE | ITEM_EDGE_VISIBLE);
  });

  it('base vertex color is a vec4 Float32Array view at byte 288', () => {
    const u = createUniforms();
    expect(u.vBaseColor.byteOffset).toBe(288);
    expect(u.vBaseColor.byteLength).toBe(16);
    expect(u.vBaseColor.length).toBe(4);
  });

  it('regions share the same underlying buffer', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    u.geometry.vRadius = 99;
    expect(view[30]).toBe(99);
    u.vBaseColor[0] = 0.55;
    expect(view[72]).toBeCloseTo(0.55);
  });

  it('reads back camera, light, frame, geometry, and channel accessors from packed storage', () => {
    const u = createUniforms();

    u.light.nightFloor = 0.2;
    u.light.terminatorWidth = 0.3;
    u.light.surfaceNightFloor = 0.4;
    u.camera.flatSy = 1.2;
    u.camera.flatSx = 1.1;
    u.camera.flatTx = -3;
    u.camera.flatTy = 4;
    u.camera.fovScale = 0.9;
    u.frame.viewportX = 640;
    u.frame.viewportY = 480;
    u.geometry.vRadius = 5;
    u.geometry.eHalfWidth = 5.75;
    u.geometry.eDashPeriodPx = 9;
    u.geometry.heightAmplitude = 6;
    u.channel.vColorOffset = 7;
    u.channel.eColorOffset = 8;
    u.channel.eDashOffset = 9;
    u.channel.vHeightOffset = 10;
    u.channel.vColorMode = 1;
    u.channel.vColorMin = 0.11;
    u.channel.vColorScale = 0.12;
    u.channel.eColorMode = 1;
    u.channel.eColorMin = 0.21;
    u.channel.eColorScale = 0.22;
    u.channel.vHeightMin = 0.31;
    u.channel.vHeightScale = 0.32;
    u.channel.vHeightOutMin = -0.5;
    u.channel.vHeightOutSpan = 2.5;
    u.channel.vHeightMode = 1;
    u.channel.vSizeOffset = 11;
    u.channel.vSizeMode = 1;
    u.channel.vSizeMin = 0.41;
    u.channel.vSizeScale = 0.42;
    u.channel.vVisibleOffset = 12;
    u.channel.eVisibleOffset = 13;
    u.channel.itemFlags = ITEM_VERTEX_VISIBLE | ITEM_EDGE_VISIBLE;

    expect(u.camera.fovScale).toBeCloseTo(0.9);
    expect(u.light.nightFloor).toBeCloseTo(0.2);
    expect(u.light.terminatorWidth).toBeCloseTo(0.3);
    expect(u.light.surfaceNightFloor).toBeCloseTo(0.4);
    expect(u.camera.flatSx).toBeCloseTo(1.1);
    expect(u.camera.flatSy).toBeCloseTo(1.2);
    expect(u.camera.flatTx).toBe(-3);
    expect(u.camera.flatTy).toBe(4);
    expect(u.frame.viewportX).toBe(640);
    expect(u.frame.viewportY).toBe(480);
    expect(u.geometry.vRadius).toBe(5);
    expect(u.geometry.eHalfWidth).toBeCloseTo(5.75);
    expect(u.geometry.eDashPeriodPx).toBe(9);
    expect(u.geometry.heightAmplitude).toBe(6);
    expect(u.channel.vColorOffset).toBe(7);
    expect(u.channel.eColorOffset).toBe(8);
    expect(u.channel.eDashOffset).toBe(9);
    expect(u.channel.vHeightOffset).toBe(10);
    expect(u.channel.vColorMode).toBe(1);
    expect(u.channel.vColorMin).toBeCloseTo(0.11);
    expect(u.channel.vColorScale).toBeCloseTo(0.12);
    expect(u.channel.eColorMode).toBe(1);
    expect(u.channel.eColorMin).toBeCloseTo(0.21);
    expect(u.channel.eColorScale).toBeCloseTo(0.22);
    expect(u.channel.vHeightMin).toBeCloseTo(0.31);
    expect(u.channel.vHeightScale).toBeCloseTo(0.32);
    expect(u.channel.vHeightOutMin).toBeCloseTo(-0.5);
    expect(u.channel.vHeightOutSpan).toBeCloseTo(2.5);
    expect(u.channel.vHeightMode).toBe(1);
    expect(u.channel.vSizeOffset).toBe(11);
    expect(u.channel.vSizeMode).toBe(1);
    expect(u.channel.vSizeMin).toBeCloseTo(0.41);
    expect(u.channel.vSizeScale).toBeCloseTo(0.42);
    expect(u.channel.vVisibleOffset).toBe(12);
    expect(u.channel.eVisibleOffset).toBe(13);
    expect(u.channel.itemFlags).toBe(ITEM_VERTEX_VISIBLE | ITEM_EDGE_VISIBLE);
  });
});
