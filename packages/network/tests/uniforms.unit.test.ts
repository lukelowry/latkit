import { describe, it, expect } from 'vitest';
import {
  createUniforms,
  FLAG_DAYLIGHT,
  FLAG_GRATICULE,
  hasGraticuleFlag,
  UNIFORM_BUFFER_BYTES,
  W_PLANE_MIX,
} from '../src/webgpu/uniforms.js';

describe('createUniforms', () => {
  it('creates a raw buffer that matches the exported uniform layout size', () => {
    const u = createUniforms();
    expect(u.raw.byteLength).toBe(UNIFORM_BUFFER_BYTES);
  });

  it('projection region writes to bytes 0-111', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    u.projection.flatSx = 2.5;
    expect(view[24]).toBe(2.5);
    u.projection.fovScale = 0.33;
    expect(view[19]).toBeCloseTo(0.33);
  });

  it('packs the planar basis and blend into the final aligned block', () => {
    const u = createUniforms();
    u.projection.setPlaneParams(1, 2, 0.5, 0.75);
    u.projection.planeMix = 0.25;

    expect(u.rawF32).toBeInstanceOf(Float32Array);
    expect(u.rawF32.buffer).toBe(u.raw);
    expect(Array.from(u.rawF32.slice(92, 96))).toEqual([1, 2, 0.5, 0.75]);
    expect(u.rawF32[W_PLANE_MIX]).toBe(0.25);
    expect(u.rawF32.length).toBe(100);
  });

  it('reads the graticule bit from projection flags', () => {
    const u = createUniforms();
    u.projection.flags = FLAG_DAYLIGHT;
    expect(hasGraticuleFlag(u.rawU32)).toBe(false);
    u.projection.flags = FLAG_DAYLIGHT | FLAG_GRATICULE;
    expect(hasGraticuleFlag(u.rawU32)).toBe(true);
  });

  it('projection setVP copies 16 floats to bytes 0-63', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    const vp = new Float32Array(16);
    vp[0] = 1;
    vp[5] = 2;
    vp[10] = 3;
    vp[15] = 4;
    u.projection.setVP(vp);
    expect(view[0]).toBe(1);
    expect(view[5]).toBe(2);
    expect(view[10]).toBe(3);
    expect(view[15]).toBe(4);
  });

  it('frame region writes viewport, time, and presentation scale to their packed slots', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    u.frame.viewportX = 1920;
    u.frame.viewportY = 1080;
    expect(view[28]).toBe(1920);
    expect(view[29]).toBe(1080);
    u.frame.time = 1.5;
    expect(view[30]).toBe(1.5);
    u.frame.backingScale = 2;
    expect(view[88]).toBe(2);
  });

  it('geometry region writes to bytes 124-143', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    u.geometry.vertexSize = 0.08;
    expect(view[31]).toBeCloseTo(0.08);
    u.geometry.baseEdgeWidth = 0.012;
    expect(view[33]).toBeCloseTo(0.012);
    u.geometry.heightWorldScale = 0.25;
    expect(view[35]).toBeCloseTo(0.25);
  });

  it('highlight region writes ids and style values to their packed slots', () => {
    const u = createUniforms();
    const iview = new Int32Array(u.raw);
    const fview = new Float32Array(u.raw);
    u.focus.hoverVertex = 42;
    u.focus.hoverEdge = -1;
    u.focus.selectedVertex = 7;
    u.focus.selectedEdge = -1;
    expect(iview[36]).toBe(42);
    expect(iview[37]).toBe(-1);
    expect(iview[38]).toBe(7);
    expect(iview[39]).toBe(-1);
    u.focus.hoverColor = 0x06 | (0xb6 << 8) | (0xd4 << 16);
    u.focus.selectedColor = 0x9b | (0x23 << 8) | (0x35 << 16);
    u.focus.flags = 7;
    u.focus.hoverAlpha = 0.5;
    u.focus.selectedAlpha = 0.82;
    u.focus.vertexHoverUnderlayPx = 6;
    u.focus.vertexSelectedUnderlayPx = 7;
    u.focus.edgeHoverUnderlayPx = 3.5;
    u.focus.edgeSelectedUnderlayPx = 5;
    u.focus.setEndpointIds(1, 2, 3, 4);
    const uview = new Uint32Array(u.raw);
    expect(uview[57]).toBe(0x06 | (0xb6 << 8) | (0xd4 << 16));
    expect(uview[58]).toBe(0x9b | (0x23 << 8) | (0x35 << 16));
    expect(uview[59]).toBe(7);
    expect(fview[60]).toBeCloseTo(0.5);
    expect(fview[61]).toBeCloseTo(0.82);
    expect(fview[62]).toBeCloseTo(6);
    expect(fview[63]).toBeCloseTo(7);
    expect(fview[64]).toBeCloseTo(3.5);
    expect(fview[65]).toBeCloseTo(5);
    expect(iview[68]).toBe(1);
    expect(iview[69]).toBe(2);
    expect(iview[70]).toBe(3);
    expect(iview[71]).toBe(4);
  });

  it('highlight slots default to the absent-selection sentinel', () => {
    const u = createUniforms();
    expect(u.focus.hoverVertex).toBe(-1);
    expect(u.focus.hoverEdge).toBe(-1);
    expect(u.focus.selectedVertex).toBe(-1);
    expect(u.focus.selectedEdge).toBe(-1);
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
    expect(uview[40]).toBe(1000);
    expect(uview[41]).toBe(2000);
    expect(uview[42]).toBe(3000);
    expect(uview[43]).toBe(4000);
    u.channel.vColorMin = 0.5;
    expect(fview[45]).toBeCloseTo(0.5);
    u.channel.heightCenter = 1.5;
    u.channel.heightScale = 0.25;
    u.channel.heightOutMin = -1;
    u.channel.heightOutScale = 2;
    u.channel.vHeightMode = 1;
    u.channel.vSizeOffset = 5000;
    u.channel.vSizeMode = 1;
    u.channel.vSizeMin = 0.3;
    u.channel.vSizeScale = 0.4;
    expect(fview[50]).toBeCloseTo(1.5);
    expect(fview[51]).toBeCloseTo(0.25);
    expect(fview[66]).toBeCloseTo(-1);
    expect(fview[67]).toBeCloseTo(2);
    expect(uview[52]).toBe(1);
    expect(uview[53]).toBe(5000);
    expect(uview[54]).toBe(1);
    expect(fview[55]).toBeCloseTo(0.3);
    expect(fview[56]).toBeCloseTo(0.4);
  });

  it('base vertex color is a vec4 Float32Array view at byte 288', () => {
    const u = createUniforms();
    expect(u.baseVertexColor.byteOffset).toBe(288);
    expect(u.baseVertexColor.byteLength).toBe(16);
    expect(u.baseVertexColor.length).toBe(4);
  });

  it('regions share the same underlying buffer', () => {
    const u = createUniforms();
    const view = new Float32Array(u.raw);
    u.geometry.vertexSize = 99;
    expect(view[31]).toBe(99);
    u.baseVertexColor[0] = 0.55;
    expect(view[72]).toBeCloseTo(0.55);
  });

  it('reads back projection, frame, geometry, and channel accessors from packed storage', () => {
    const u = createUniforms();

    u.projection.nightFloor = 0.2;
    u.projection.terminatorWidth = 0.3;
    u.projection.surfaceNightFloor = 0.4;
    u.projection.flatSy = 1.2;
    u.projection.flatSx = 1.1;
    u.projection.flatTx = -3;
    u.projection.flatTy = 4;
    u.projection.fovScale = 0.9;
    u.frame.viewportX = 640;
    u.frame.viewportY = 480;
    u.frame.time = 12.5;
    u.geometry.vertexSize = 5;
    u.geometry.vertexLod = 5.5;
    u.geometry.baseEdgeWidth = 5.75;
    u.geometry.dashPeriod = 9;
    u.geometry.heightWorldScale = 6;
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
    u.channel.heightCenter = 0.31;
    u.channel.heightScale = 0.32;
    u.channel.heightOutMin = -0.5;
    u.channel.heightOutScale = 2.5;
    u.channel.vHeightMode = 1;
    u.channel.vSizeOffset = 11;
    u.channel.vSizeMode = 1;
    u.channel.vSizeMin = 0.41;
    u.channel.vSizeScale = 0.42;

    expect(u.projection.fovScale).toBeCloseTo(0.9);
    expect(u.projection.nightFloor).toBeCloseTo(0.2);
    expect(u.projection.terminatorWidth).toBeCloseTo(0.3);
    expect(u.projection.surfaceNightFloor).toBeCloseTo(0.4);
    expect(u.projection.flatSx).toBeCloseTo(1.1);
    expect(u.projection.flatSy).toBeCloseTo(1.2);
    expect(u.projection.flatTx).toBe(-3);
    expect(u.projection.flatTy).toBe(4);
    expect(u.frame.viewportX).toBe(640);
    expect(u.frame.viewportY).toBe(480);
    expect(u.frame.time).toBeCloseTo(12.5);
    expect(u.geometry.vertexSize).toBe(5);
    expect(u.geometry.vertexLod).toBeCloseTo(5.5);
    expect(u.geometry.baseEdgeWidth).toBeCloseTo(5.75);
    expect(u.geometry.dashPeriod).toBe(9);
    expect(u.geometry.heightWorldScale).toBe(6);
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
    expect(u.channel.heightCenter).toBeCloseTo(0.31);
    expect(u.channel.heightScale).toBeCloseTo(0.32);
    expect(u.channel.heightOutMin).toBeCloseTo(-0.5);
    expect(u.channel.heightOutScale).toBeCloseTo(2.5);
    expect(u.channel.vHeightMode).toBe(1);
    expect(u.channel.vSizeOffset).toBe(11);
    expect(u.channel.vSizeMode).toBe(1);
    expect(u.channel.vSizeMin).toBeCloseTo(0.41);
    expect(u.channel.vSizeScale).toBeCloseTo(0.42);
  });
});
