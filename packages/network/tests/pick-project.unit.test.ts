import { describe, expect, it } from 'vitest';

import { createGlobeProjection } from '../src/camera/globe.js';
import { createPlaneProjection } from '../src/camera/plane.js';
import type { Projection, Viewport } from '../src/camera/projection.js';
import { PIPELINES, PROJECTIONS, type ProjectionMode } from '../src/projections.js';
import { createUniforms, type Uniforms } from '../src/webgpu/uniforms.js';
import { createPoint, type Projector } from '../src/pick/project.js';
import { VISUAL } from '../src/visual.js';

const VP: Viewport = { w: 800, h: 600 };

interface Setup {
  uniforms: Uniforms;
  proj: Projection;
  state: Float64Array;
  projector: Projector;
}

function setup(mode: ProjectionMode, mutate?: (state: Float64Array) => void): Setup {
  const uniforms = createUniforms();
  const proj =
    mode === 'flat'
      ? createPlaneProjection('flat')
      : mode === 'tilt'
        ? createPlaneProjection('tilt')
        : createGlobeProjection();
  const bounds =
    mode === 'globe'
      ? { xMin: -40, xMax: 40, yMin: -30, yMax: 30 }
      : { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
  const state = proj.fit(bounds, VP) as Float64Array;
  mutate?.(state);
  proj.pack(state, uniforms.camera, VP);
  uniforms.frame.viewportX = VP.w;
  uniforms.frame.viewportY = VP.h;
  uniforms.frame.backingScale = 1;
  uniforms.geometry.vertexSize = 0.2;
  uniforms.geometry.baseEdgeWidth = 0.05;
  uniforms.geometry.vertexLod = 2;
  return {
    uniforms,
    proj,
    state,
    projector: PIPELINES[PROJECTIONS[mode].family].projector(uniforms),
  };
}

/** Project a coord at height h and return CSS screen px (dpr 1 here). */
function screenOf(s: Setup, x: number, y: number, h = 0): { sx: number; sy: number } {
  const p = createPoint();
  s.projector.project(p, x, y, h);
  expect(s.projector.visible(p)).toBe(true);
  s.projector.toScreen(p);
  return { sx: p.sx, sy: p.sy };
}

describe('pick projector parity', () => {
  it('scales visual clamps and pole floors from CSS into device pixels', () => {
    const s = setup('flat');
    s.uniforms.frame.viewportX = VP.w * 2;
    s.uniforms.frame.viewportY = VP.h * 2;
    s.uniforms.frame.backingScale = 2;
    s.uniforms.geometry.vertexSize = 100;
    const projector = s.projector;
    const p = createPoint();
    projector.project(p, 0, 0, 0);

    expect(projector.screenRadius(p)).toBe(VISUAL.maxVertexRadiusPx * 2);
    expect(projector.screenHalfWidth(p, 0)).toBe(VISUAL.minEdgeHalfWidthPx * 2);

    s.uniforms.geometry.vertexSize = 0;
    expect(projector.poleHalfWidth(p)).toBe(3);
  });

  it('flat roundtrips through the camera affine exactly', () => {
    const s = setup('flat');
    for (const [x, y] of [
      [0, 0],
      [-7.5, 3.25],
      [9, -9],
    ] as const) {
      const { sx, sy } = screenOf(s, x, y);
      const back = s.proj.screenToWorld(s.state, sx, sy, VP)!;
      expect(back[0]).toBeCloseTo(x, 5);
      expect(back[1]).toBeCloseTo(y, 5);
    }
  });

  it('flat keeps height out of xy while ordering it in depth', () => {
    const s = setup('flat');
    uniformsHeightScale(s.uniforms, 5);
    const low = createPoint();
    const high = createPoint();
    s.projector.project(low, 3, 4, 0);
    s.projector.project(high, 3, 4, 1);
    expect(high.cx).toBe(low.cx);
    expect(high.cy).toBe(low.cy);
    expect(high.cz).toBeCloseTo(low.cz - VISUAL.flatHeightDepthSpan, 6);
    expect(high.wz).toBe(0);
  });

  it('transitions height continuously from depth order to physical lift', () => {
    const s = setup('flat', (state) => {
      state[3] = 27.5;
    });
    uniformsHeightScale(s.uniforms, 2);
    const low = createPoint();
    const high = createPoint();
    s.projector.project(low, 0, 0, 0);
    s.projector.project(high, 0, 0, 1);

    expect(s.uniforms.camera.depthMix).toBeCloseTo(0.5, 6);
    expect(high.wz - low.wz).toBeCloseTo(1, 6);
    expect(high.cz).toBeLessThan(low.cz);
  });

  it('flat screen radius and half width follow the affine scale with caps', () => {
    const s = setup('flat');
    const p = createPoint();
    s.projector.project(p, 0, 0, 0);

    const sx = Math.abs(s.uniforms.camera.flatSx);
    const expectedRadius = Math.min(0.2 * sx * VP.w * 0.5, VISUAL.maxVertexRadiusPx);
    expect(s.projector.screenRadius(p)).toBeCloseTo(expectedRadius, 6);

    const expectedHw = Math.min(
      Math.max(0.05 * sx * VP.w * 0.5, VISUAL.minEdgeHalfWidthPx),
      VISUAL.maxEdgeHalfWidthPx,
    );
    expect(s.projector.screenHalfWidth(p, 0.05)).toBeCloseTo(expectedHw, 6);
    expect(s.projector.poleHalfWidth(p)).toBeCloseTo(Math.max(expectedRadius * 0.15, 1.5), 6);
  });

  it('tilt roundtrips through the camera ray cast', () => {
    const s = setup('tilt');
    s.uniforms.geometry.vertexSize = 0; // zero base lift for an exact roundtrip
    for (const [x, y] of [
      [0, 0],
      [-6, 2],
      [8, -8],
    ] as const) {
      const { sx, sy } = screenOf(s, x, y);
      const back = s.proj.screenToWorld(s.state, sx, sy, VP)!;
      expect(back[0]).toBeCloseTo(x, 3);
      expect(back[1]).toBeCloseTo(y, 3);
    }
  });

  it('tilt height displaces along +z and rejects points behind the camera', () => {
    const s = setup('tilt');
    uniformsHeightScale(s.uniforms, 2);
    const base = screenOf(s, 0, 0, 0);
    const lifted = screenOf(s, 0, 0, 1);
    // At the default pitch a lifted point rises on screen.
    expect(lifted.sy).toBeLessThan(base.sy);

    // A point far behind the camera projects with non-positive w. The tilt
    // camera sits south of its look point (bearing 0), so far south is
    // behind it.
    const p = createPoint();
    const behindY = s.state[1]! - s.state[2]! * 100;
    s.projector.project(p, s.state[0]!, behindY, 0);
    expect(s.projector.visible(p)).toBe(false);
  });

  it('globe roundtrips lon/lat through the camera ray cast', () => {
    const s = setup('globe');
    s.uniforms.geometry.vertexSize = 0;
    // f32 uniform quantization of the VP matrix costs a few hundredths of a
    // degree on the inverse ray; the picker's Jacobian safety absorbs it.
    for (const [lon, lat] of [
      [0, 0],
      [-30, 20],
      [35, -25],
    ] as const) {
      const { sx, sy } = screenOf(s, lon, lat);
      const back = s.proj.screenToWorld(s.state, sx, sy, VP)!;
      expect(back[0]).toBeCloseTo(lon, 0);
      expect(back[1]).toBeCloseTo(lat, 0);
    }
  });

  it('globe hides geometry behind the horizon', () => {
    const s = setup('globe');
    const near = createPoint();
    s.projector.project(near, 0, 0, 0);
    expect(s.projector.visible(near)).toBe(true);

    const far = createPoint();
    s.projector.project(far, 179, 0, 0);
    expect(s.projector.visible(far)).toBe(false);
  });

  it('globe converts vertex size through degrees of arc', () => {
    const s = setup('globe');
    const p = createPoint();
    s.projector.project(p, 0, 0, 0);
    const fov = s.uniforms.camera.fovScale;
    const expected = Math.min(
      ((0.2 * VISUAL.globeVertexScale) / (p.cw * fov)) * VP.h * 0.5,
      VISUAL.maxVertexRadiusPx,
    );
    expect(s.projector.screenRadius(p)).toBeCloseTo(expected, 6);
  });
});

/** Bind a synthetic normalized-height mapping: h in [0, 1] passes through. */
function uniformsHeightScale(uniforms: Uniforms, worldScale: number): void {
  uniforms.channel.vHeightMode = 1;
  uniforms.channel.heightOutMin = 0;
  uniforms.channel.heightOutScale = 1;
  uniforms.geometry.heightWorldScale = worldScale;
}
