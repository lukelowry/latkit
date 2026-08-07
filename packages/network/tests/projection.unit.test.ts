import { afterEach, describe, it, expect, vi } from 'vitest';
import { createFlatProjection } from '../src/camera/flat.js';
import { createGlobeProjection } from '../src/camera/globe.js';
import { createTiltProjection } from '../src/camera/tilt.js';
import { Camera } from '../src/camera/camera.js';
import { ProjectionRig } from '../src/camera/rig.js';
import { createUniforms } from '../src/webgpu/uniforms.js';
import { createTangent, MAX_ZOOM_RATIO } from '../src/camera/projection.js';
import type { CameraState, GraphBounds, Projection, Viewport } from '../src/camera/projection.js';
import { VISUAL } from '../src/visual.js';

const bounds: GraphBounds = { xMin: -5, xMax: 5, yMin: -3, yMax: 3 };
const vp: Viewport = { w: 800, h: 600 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('flat projection', () => {
  const proj = createFlatProjection();

  it('screenToWorld inverts at center', () => {
    const s = proj.clone(new Float64Array([0, 0, 100]));
    const [wx, wy] = proj.screenToWorld(s, 400, 300, vp)!;
    expect(wx).toBeCloseTo(0, 6);
    expect(wy).toBeCloseTo(0, 6);
  });

  it('screenToWorld inverts at offset', () => {
    const s = proj.clone(new Float64Array([0, 0, 100]));
    const [wx, wy] = proj.screenToWorld(s, 500, 200, vp)!;
    expect(wx).toBeCloseTo(1, 6);
    expect(wy).toBeCloseTo(1, 6);
  });

  it('zoom clamps at min (before fit)', () => {
    const s = proj.clone(new Float64Array([0, 0, 0.001]));
    proj.zoom(s, 0.5, null);
    expect(s[2]).toBe(0.001);
  });

  it('zoom clamps at max (after fit)', () => {
    const fit = proj.clone(new Float64Array([0, 0, 10]));
    const max = fit[2] * MAX_ZOOM_RATIO;
    const s = proj.clone(new Float64Array([0, 0, max]));
    proj.zoom(s, 2, fit);
    expect(s[2]).toBe(max);
  });

  it('zoom works in normal range', () => {
    const fit = proj.clone(new Float64Array([0, 0, 10]));
    const s = proj.clone(new Float64Array([0, 0, 50]));
    proj.zoom(s, 1.1, fit);
    expect(s[2]).toBeCloseTo(55, 6);
  });

  it('snapToAnchor keeps world point at screen point', () => {
    const s = proj.clone(new Float64Array([0, 0, 100]));
    const worldPt: [number, number] = [2, 3];
    const screenPt: [number, number] = [450, 250];
    proj.snapToAnchor(s, worldPt, screenPt, vp);
    const result = proj.screenToWorld(s, 450, 250, vp)!;
    expect(result[0]).toBeCloseTo(2, 6);
    expect(result[1]).toBeCloseTo(3, 6);
  });

  it('fit centers on bounds', () => {
    const s = proj.fit(bounds, vp);
    expect(s[0]).toBeCloseTo(0, 6);
    expect(s[1]).toBeCloseTo(0, 6);
    expect(s[2]).toBeGreaterThan(0);
  });

  it('isAtFit true at fit state', () => {
    const fit = proj.fit(bounds, vp);
    expect(proj.isAtFit(fit, fit)).toBe(true);
  });

  it('mix interpolates component-wise', () => {
    const a = proj.clone(new Float64Array([0, 0, 100]));
    const b = proj.clone(new Float64Array([10, 20, 200]));
    const out = new Float64Array(3);
    proj.mix(out, a, b, 0.5);
    expect(out[0]).toBeCloseTo(5, 6);
    expect(out[1]).toBeCloseTo(10, 6);
    expect(out[2]).toBeCloseTo(150, 6);
  });

  it('mix at t=0 returns a', () => {
    const a = proj.clone(new Float64Array([1, 2, 3]));
    const b = proj.clone(new Float64Array([4, 5, 6]));
    const out = new Float64Array(3);
    proj.mix(out, a, b, 0);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(2, 6);
    expect(out[2]).toBeCloseTo(3, 6);
  });

  it('delta computes per-axis rate', () => {
    const tangent = createTangent();
    const prev = proj.clone(new Float64Array([0, 0, 100]));
    const curr = proj.clone(new Float64Array([10, 0, 100]));
    proj.delta(tangent, prev, curr, 10);
    expect(tangent[0]).toBeCloseTo(1, 6);
    expect(tangent[1]).toBeCloseTo(0, 6);
  });

  it('advance integrates tangent', () => {
    const out = new Float64Array(3);
    const from = proj.clone(new Float64Array([0, 0, 100]));
    const tangent = createTangent();
    tangent[0] = 5;
    tangent[1] = -3;
    tangent[2] = 0;
    proj.advance(out, from, tangent, 2.0);
    expect(out[0]).toBeCloseTo(10, 6);
    expect(out[1]).toBeCloseTo(-6, 6);
    expect(out[2]).toBeCloseTo(100, 6);
  });

  it('tangentNorm returns pan magnitude, ignoring zoom', () => {
    const tangent = createTangent();
    tangent[0] = 3;
    tangent[1] = 4;
    tangent[2] = 99;
    expect(proj.tangentNorm(tangent)).toBeCloseTo(5, 6);
  });

  it('beginPan applies flat screen deltas in world units', () => {
    const s = proj.clone(new Float64Array([0, 0, 100]));
    const session = proj.beginPan(s, 400, 300, vp);

    session.apply(s, 50, -25, 450, 275, vp);

    expect(s[0]).toBeCloseTo(-0.5, 6);
    expect(s[1]).toBeCloseTo(-0.25, 6);
  });

  it('imports projection-independent poses', () => {
    const imported = proj.importPose!({ centerX: 3, centerY: -2, pxPerWorld: 40 }, vp);

    expect(Array.from(imported)).toEqual([3, -2, 40]);
  });

  it('near returns true when the residual motion is sub-pixel', () => {
    const a = proj.clone(new Float64Array([1, 2, 3]));
    const b = proj.clone(new Float64Array([1, 2, 3.0000001]));
    expect(proj.near(a, b, vp, 0.25)).toBe(true);
  });

  it('near returns false when states differ visibly', () => {
    const a = proj.clone(new Float64Array([1, 2, 3]));
    const b = proj.clone(new Float64Array([1, 2, 5]));
    expect(proj.near(a, b, vp, 0.25)).toBe(false);
  });

  it('near scales position tolerance with zoom', () => {
    // 0.01 world units is 1px at scale 100 (visible) but 0.01px at scale 1.
    const a = proj.clone(new Float64Array([0, 0, 100]));
    const b = proj.clone(new Float64Array([0.01, 0, 100]));
    expect(proj.near(a, b, vp, 0.25)).toBe(false);
    const c = proj.clone(new Float64Array([0, 0, 1]));
    const d = proj.clone(new Float64Array([0.01, 0, 1]));
    expect(proj.near(c, d, vp, 0.25)).toBe(true);
  });
});

describe('globe projection', () => {
  const proj = createGlobeProjection();
  const geoBounds: GraphBounds = { xMin: -98, xMax: -96, yMin: 30, yMax: 32 };

  it('fit returns [lon, lat, dist] with valid distance', () => {
    const s = proj.fit(geoBounds, vp);
    expect(s.length).toBe(3);
    expect(s[0]).toBeCloseTo(-97, 0);
    expect(s[1]).toBeCloseTo(31, 0);
    expect(s[2]).toBeGreaterThan(1 + VISUAL.globeSurfaceOffset);
    expect(s[2]).toBeLessThanOrEqual(5.0);
  });

  it('zoom: factor > 1 scales clearance above the surface', () => {
    const surfaceRadius = 1 + VISUAL.globeSurfaceOffset;
    const s = proj.clone(new Float64Array([0, 0, 2.5]));
    proj.zoom(s, 2, null);
    expect(s[2]).toBeCloseTo(surfaceRadius + (2.5 - surfaceRadius) / 2, 6);
  });

  it('zoom near the surface stays proportional instead of clamping', () => {
    const surfaceRadius = 1 + VISUAL.globeSurfaceOffset;
    const fit = proj.clone(new Float64Array([0, 0, 1.063]));
    const s = proj.clone(fit);

    proj.zoom(s, 1.1, fit);

    expect(s[2]).toBeCloseTo(surfaceRadius + (1.063 - surfaceRadius) / 1.1, 6);
    expect(s[2]).toBeGreaterThan(surfaceRadius + 0.05);
  });

  it('zoom clamps at the minimum effective distance', () => {
    const s = proj.clone(new Float64Array([0, 0, 1.1]));
    proj.zoom(s, 100, null);
    const surfaceRadius = 1 + VISUAL.globeSurfaceOffset;
    expect(s[2]).toBeGreaterThan(surfaceRadius);
    expect(s[2]).toBeLessThan(surfaceRadius + 0.001);
  });

  it('zoom clamps at MAX_DIST', () => {
    const s = proj.clone(new Float64Array([0, 0, 4.9]));
    proj.zoom(s, 0.01, null);
    expect(s[2]).toBe(5.0);
  });

  it('screenToWorld returns coords at center', () => {
    const s = proj.clone(new Float64Array([0, 0, 2.5]));
    const result = proj.screenToWorld(s, vp.w / 2, vp.h / 2, vp);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(0, 0);
    expect(result![1]).toBeCloseTo(0, 0);
  });

  it('fit round-trips through screenToWorld at center', () => {
    const s = proj.fit(geoBounds, vp);
    const center = proj.screenToWorld(s, vp.w / 2, vp.h / 2, vp);
    expect(center).not.toBeNull();
    expect(center![0]).toBeCloseTo(-97, 0);
    expect(center![1]).toBeCloseTo(31, 0);
  });

  it('screenToWorld returns null for off-sphere', () => {
    const s = proj.clone(new Float64Array([0, 0, 5.0]));
    const result = proj.screenToWorld(s, 0, 0, vp);
    expect(result).toBeNull();
  });

  it('mix interpolates lon/lat/dist', () => {
    const a = proj.clone(new Float64Array([-97, 31, 3.0]));
    const b = proj.clone(new Float64Array([-50, 10, 2.0]));
    const out = new Float64Array(3);
    proj.mix(out, a, b, 0);
    expect(out[0]).toBeCloseTo(-97, 6);
    expect(out[1]).toBeCloseTo(31, 6);
    expect(out[2]).toBeCloseTo(3, 6);
    proj.mix(out, a, b, 1);
    expect(out[0]).toBeCloseTo(-50, 6);
    expect(out[1]).toBeCloseTo(10, 6);
    expect(out[2]).toBeCloseTo(2, 6);
  });

  it('mix handles longitude wrapping', () => {
    const a = proj.clone(new Float64Array([170, 0, 2.0]));
    const b = proj.clone(new Float64Array([-170, 0, 2.0]));
    const out = new Float64Array(3);
    proj.mix(out, a, b, 0.5);
    expect(Math.abs(out[0])).toBeCloseTo(180, 0); // shortest path goes through 180
  });

  it('near returns true for identical states', () => {
    const s = proj.clone(new Float64Array([0, 0, 2.5]));
    expect(proj.near(s, s, vp, 0.25)).toBe(true);
  });

  it('near returns false across a visible orbit delta', () => {
    const a = proj.clone(new Float64Array([0, 0, 2.5]));
    const b = proj.clone(new Float64Array([5, 0, 2.5]));
    expect(proj.near(a, b, vp, 0.25)).toBe(false);
  });

  it('isAtFit true at fit state', () => {
    const fit = proj.fit(geoBounds, vp);
    expect(proj.isAtFit(fit, fit)).toBe(true);
  });

  it('tangentNorm returns pan magnitude', () => {
    const tangent = createTangent();
    tangent[0] = 0.3;
    tangent[1] = 0.4;
    tangent[2] = 0;
    expect(proj.tangentNorm(tangent)).toBeCloseTo(0.5, 6);
  });

  it('drag right decreases longitude', () => {
    const s = proj.clone(new Float64Array([0, 0, 2.5]));
    const session = proj.beginPan(s, 400, 300, vp);
    session.apply(s, 50, 0, 450, 300, vp);
    expect(s[0]).toBeLessThan(0);
  });

  it('drag down increases latitude', () => {
    const s = proj.clone(new Float64Array([0, 0, 2.5]));
    const session = proj.beginPan(s, 400, 300, vp);
    session.apply(s, 0, 50, 400, 350, vp);
    expect(s[1]).toBeGreaterThan(0);
  });

  it('drag clamps latitude at MAX_LAT', () => {
    const s = proj.clone(new Float64Array([0, 85, 2.5]));
    const session = proj.beginPan(s, 400, 300, vp);
    for (let i = 0; i < 200; i++) session.apply(s, 0, 10, 400, 300, vp);
    expect(s[1]).toBeLessThanOrEqual(89.9);
  });

  it('drag near pole is continuous', () => {
    const s = proj.fit({ xMin: -1, xMax: 1, yMin: 85, yMax: 89 }, vp);
    const session = proj.beginPan(s, 400, 300, vp);
    const lons: number[] = [];
    for (let i = 0; i < 20; i++) {
      session.apply(s, 2, 0, 402, 300, vp);
      lons.push(s[0]);
    }
    for (let i = 1; i < lons.length; i++) {
      expect(Math.abs(lons[i] - lons[i - 1])).toBeLessThan(10);
    }
  });

  it('snapToAnchor converges toward world point at screen position', () => {
    const s = proj.fit(geoBounds, vp);
    const sx = 500,
      sy = 250;
    const before = proj.screenToWorld(s, sx, sy, vp);
    expect(before).not.toBeNull();
    proj.zoom(s, 1.5, null);
    for (let i = 0; i < 3; i++) proj.snapToAnchor(s, before!, [sx, sy], vp);
    const after = proj.screenToWorld(s, sx, sy, vp);
    expect(after).not.toBeNull();
    expect(after![0]).toBeCloseTo(before![0], 0);
    expect(after![1]).toBeCloseTo(before![1], 0);
  });

  it('falls back to angular pan when the cursor ray misses the globe', () => {
    const s = proj.clone(new Float64Array([0, 0, 5]));
    const session = proj.beginPan(s, 0, 0, vp);

    session.apply(s, 10, 20, 0, 0, vp);

    expect(s[0]).toBeLessThan(0);
    expect(s[1]).toBeGreaterThan(0);
  });

  it('refreshes globe daylight while packing uniforms after the cache expires', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    const fresh = createGlobeProjection();
    const s = fresh.fit(geoBounds, vp);
    const region = makeProjectionRegion();
    fresh.pack(s, region, vp);
    const first = region.lightDir.slice();

    nowSpy.mockReturnValue(31_000);
    fresh.pack(s, region, vp);

    expect(region.lightDir).not.toEqual(first);
  });

  it('delta scales lon by cosLat for pole-uniform velocity', () => {
    const tangent = createTangent();
    // At lat=60, cosLat=0.5. A 10-deg lon move in 1 ms should store 5 as arc-rate.
    const prev = proj.clone(new Float64Array([0, 60, 2.5]));
    const curr = proj.clone(new Float64Array([10, 60, 2.5]));
    proj.delta(tangent, prev, curr, 1);
    expect(tangent[0]).toBeCloseTo(10 * Math.cos((60 * Math.PI) / 180), 3);
  });

  it('advance unscales lon by cosLat (inverse of delta)', () => {
    const out = new Float64Array(3);
    const from = proj.clone(new Float64Array([0, 60, 2.5]));
    const tangent = createTangent();
    tangent[0] = 5; // arc-rate (half cosLat)
    proj.advance(out, from, tangent, 1);
    // Should result in ~10 deg lon shift (unscaled).
    expect(out[0]).toBeCloseTo(10, 3);
  });
});

describe('tilt projection', () => {
  const proj = createTiltProjection();
  const FOV_SCALE = Math.tan((2 * Math.atan(1 / 3)) / 2);

  function fitState() {
    return proj.fit(bounds, vp);
  }

  it('fit rests at the default oblique pitch so selecting tilt actually tilts', () => {
    const s = fitState();
    expect(s.length).toBe(5);
    // Regression: a fit or reload must never flatten tilt to nadir (which is
    // pixel-identical to flat). The fit pitch equals the pitch an imported
    // flat pose settles to, so the fit-fallback path (globe→tilt) and the
    // import+settle path (flat→tilt) agree — both land tilted.
    expect(s[3]).toBeGreaterThan(0);
    expect(s[4]).toBe(0);
    const settled = proj.importPose!({ centerX: 0, centerY: 0, pxPerWorld: 1 }, vp);
    proj.settleImportedPose!(settled);
    expect(s[3]).toBe(settled[3]);
    // The look point still lands at screen center; the oblique unproject
    // round-trips to ~1e-5 world units (perspective, vs nadir's near-exact).
    const center = proj.screenToWorld(s, vp.w / 2, vp.h / 2, vp)!;
    expect(center[0]).toBeCloseTo(0, 4);
    expect(center[1]).toBeCloseTo(0, 4);
  });

  it('anchored zoom holds the grabbed world point in one closed-form step', () => {
    const s = fitState();
    const sx = 500,
      sy = 250;
    const before = proj.screenToWorld(s, sx, sy, vp)!;
    proj.zoom(s, 1.5, null);
    proj.snapToAnchor(s, before, [sx, sy], vp);
    const after = proj.screenToWorld(s, sx, sy, vp)!;
    // At the default oblique pitch the closed-form snap holds the point to
    // ~1e-6 world units — the perspective raycast's float precision.
    expect(after[0]).toBeCloseTo(before[0], 5);
    expect(after[1]).toBeCloseTo(before[1], 5);
  });

  it('rotate wraps bearing and clamps pitch', () => {
    const s = fitState();
    proj.rotate!(s, 1000, 0, vp); // 1000px × 0.4°/px = 400° → wraps
    expect(s[4]).toBeCloseTo(40, 6);
    proj.rotate!(s, 0, 10_000, vp); // drag down hard → pitch floor 0
    expect(s[3]).toBe(0);
    proj.rotate!(s, 0, -10_000, vp); // drag up hard → pitch ceiling
    expect(s[3]).toBe(85);
  });

  it('near is true for identical states and false across visible deltas', () => {
    const s = fitState();
    expect(proj.near(s, s, vp, 0.25)).toBe(true);
    const moved = proj.clone(s);
    moved[4] = s[4] + 5; // 5° of bearing at the screen edge is very visible
    expect(proj.near(s, moved, vp, 0.25)).toBe(false);
  });

  it('imports a flat pose pixel-identically and settles toward its default pitch', () => {
    const flat = createFlatProjection();
    const flatState = flat.clone(new Float64Array([3, -2, 40]));
    const pose = flat.exportPose!(flatState, vp)!;

    const imported = proj.importPose!(pose, vp);
    expect(imported[0]).toBe(3);
    expect(imported[1]).toBe(-2);
    expect(imported[3]).toBe(0); // pitch 0 — pixel-identical to flat
    // Scale round-trips: px-per-world at the look point matches the export.
    expect(vp.h / 2 / (imported[2] * FOV_SCALE)).toBeCloseTo(pose.pxPerWorld, 6);

    const target = proj.clone(imported);
    proj.settleImportedPose!(target);
    expect(target[3]).toBeGreaterThan(0); // eases over via the chase
  });

  it('mixes, differentiates, advances, and measures tilt manifold state', () => {
    const a = proj.clone(Float64Array.of(0, 0, 10, 40, 350) as CameraState);
    const b = proj.clone(Float64Array.of(10, -10, 20, 50, 10) as CameraState);
    const out = new Float64Array(5) as CameraState;
    const tangent = createTangent(5);

    proj.mix(out, a, b, 0.5);
    expect(out[0]).toBeCloseTo(5, 6);
    expect(out[4]).toBeCloseTo(360, 6);

    proj.delta(tangent, a, b, 2);
    expect(tangent[4]).toBeCloseTo(10, 6);

    tangent[0] = 3;
    tangent[1] = 4;
    tangent[3] = 10;
    tangent[4] = 20;
    proj.advance(out, a, tangent, 1);
    expect(out[3]).toBe(50);
    expect(out[4]).toBe(10);
    expect(proj.tangentNorm(tangent)).toBe(5);
  });

  it('tilt zoom ignores invalid factors and clamps by fit distance', () => {
    const fit = fitState();
    const s = proj.clone(fit);

    proj.zoom(s, 0, fit);
    expect(s[2]).toBe(fit[2]);

    proj.zoom(s, 1e9, fit);
    expect(s[2]).toBeCloseTo(fit[2] / MAX_ZOOM_RATIO, 6);
    proj.zoom(s, 1e-9, fit);
    expect(s[2]).toBe(fit[2]);
  });

  it('tilt isAtFit rejects visible pose differences', () => {
    const fit = fitState();
    const moved = proj.clone(fit);

    moved[0] += fit[2];
    expect(proj.isAtFit(moved, fit)).toBe(false);
    moved.set(fit);
    moved[3] += 1;
    expect(proj.isAtFit(moved, fit)).toBe(false);
    moved.set(fit);
    moved[4] += 1;
    expect(proj.isAtFit(moved, fit)).toBe(false);
  });

  it('tilt beginPan falls back to bearing-aware screen panning when rays miss the plane', () => {
    const s = fitState();
    s[3] = 85;
    const session = proj.beginPan(s, 400, -10_000, vp);
    const before = [s[0], s[1]];

    session.apply(s, 20, 10, 400, -10_000, vp);

    expect([s[0], s[1]]).not.toEqual(before);
  });

  it('tilt beginPan keeps the grabbed world point under the cursor when rays hit', () => {
    const s = fitState();
    const sx = 420;
    const sy = 280;
    const grabbed = proj.screenToWorld(s, sx, sy, vp)!;
    const session = proj.beginPan(s, sx, sy, vp);

    session.apply(s, 40, -20, sx + 40, sy - 20, vp);

    const after = proj.screenToWorld(s, sx + 40, sy - 20, vp)!;
    expect(after[0]).toBeCloseTo(grabbed[0], 4);
    expect(after[1]).toBeCloseTo(grabbed[1], 4);
  });

  it('exports tilt poses and packs matrix camera parameters', () => {
    const s = fitState();
    const pose = proj.exportPose!(s, vp)!;
    const region = makeProjectionRegion();

    proj.pack(s, region, vp);

    expect(pose.centerX).toBeCloseTo(s[0], 6);
    expect(pose.centerY).toBeCloseTo(s[1], 6);
    expect(pose.pxPerWorld).toBeGreaterThan(0);
    expect(region.vp.some((value) => value !== 0)).toBe(true);
    expect(region.cameraPos[2]).toBeGreaterThan(0);
    expect(region.tiltParams[3]).toBeCloseTo(1, 6);
  });
});

describe('Camera', () => {
  function make() {
    const proj = createFlatProjection();
    const uniforms = createUniforms();
    const camera = new Camera(proj, uniforms.projection);
    camera.init(bounds, vp);
    return { proj, camera, uniforms };
  }

  it('init sets fit state', () => {
    const { camera } = make();
    expect(camera.isAtFitView()).toBe(true);
  });

  it('initFrom defers zero-size placement and restores imported fit intent', () => {
    const { camera } = make();
    const pose = { centerX: 2, centerY: 3, pxPerWorld: 25 };

    expect(camera.initFrom(pose, false, bounds, { w: 0, h: 10 })).toBe(false);
    expect(camera.initFrom(pose, false, bounds, vp)).toBe(true);

    expect(camera.fitIntent).toBe(false);
    expect(camera.current[0]).toBe(2);
    expect(camera.current[1]).toBe(3);
    expect(camera.current[2]).toBe(25);
  });

  it('zoom changes state after ticks', () => {
    const { camera } = make();
    camera.zoomAt(2, 400, 300, vp);
    let now = performance.now();
    for (let i = 0; i < 60; i++) {
      now += 16.67;
      camera.tick(now, vp);
    }
    expect(camera.isAtFitView()).toBe(false);
  });

  it('zoom at cursor keeps anchor point stable', () => {
    const { camera } = make();
    const sx = 600,
      sy = 200;
    const before = camera.screenToWorld(sx, sy, vp)!;
    camera.zoomAt(2, sx, sy, vp);
    let now = performance.now();
    for (let i = 0; i < 120; i++) {
      now += 16.67;
      camera.tick(now, vp);
      const during = camera.screenToWorld(sx, sy, vp)!;
      expect(during[0]).toBeCloseTo(before[0], 2);
      expect(during[1]).toBeCloseTo(before[1], 2);
    }
  });

  it('rapid zoom accumulates without dropping', () => {
    const { camera } = make();
    for (let i = 0; i < 20; i++) camera.zoomAt(1.05, 400, 300, vp);
    let now = performance.now();
    for (let i = 0; i < 120; i++) {
      now += 16.67;
      camera.tick(now, vp);
    }
    expect(camera.isAtFitView()).toBe(false);
  });

  it('fitView transitions back', () => {
    const { camera } = make();
    camera.zoomAt(5, 400, 300, vp);
    let now = performance.now();
    for (let i = 0; i < 30; i++) {
      now += 16.67;
      camera.tick(now, vp);
    }
    expect(camera.isAtFitView()).toBe(false);
    camera.fitView(bounds, vp);
    for (let i = 0; i < 60; i++) {
      now += 16.67;
      camera.tick(now, vp);
    }
    expect(camera.isAtFitView()).toBe(true);
  });

  it('moveTo preserves the canonical fit reference and exact zoom clamp', () => {
    const { camera } = make();
    const fitScale = camera.current[2];
    const tiny = { xMin: 2, xMax: 2.000001, yMin: 1, yMax: 1.000001 };

    expect(camera.moveTo(tiny, vp, false)).toBe(true);
    expect(camera.current[0]).toBeCloseTo(2);
    expect(camera.current[1]).toBeCloseTo(1);
    expect(camera.current[2]).toBeCloseTo(fitScale * MAX_ZOOM_RATIO);
    expect(camera.fitIntent).toBe(false);
    expect(camera.isAtFitView()).toBe(false);

    expect(camera.zoomAt(1 / MAX_ZOOM_RATIO, vp.w / 2, vp.h / 2, vp)).toBe(true);
    let now = performance.now();
    for (let i = 0; i < 120; i++) {
      now += 16.67;
      camera.tick(now, vp);
    }
    expect(Math.abs(camera.current[2] / fitScale - 1)).toBeLessThan(0.001);
    // Zooming changes scale around the subset center; it must not silently
    // recenter onto the canonical fit pose.
    expect(camera.isAtFitView()).toBe(false);
    expect(camera.fitIntent).toBe(false);
  });

  it('moveTo supports animation and rejects unavailable placement', () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const fresh = new Camera(createFlatProjection(), createUniforms().projection);
    const target = { xMin: 1, xMax: 2, yMin: 3, yMax: 4 };

    expect(fresh.moveTo(target, vp, false)).toBe(false);
    fresh.init(bounds, vp);
    const before = [...fresh.current];
    expect(fresh.moveTo(target, { w: 0, h: vp.h }, true)).toBe(false);
    expect(fresh.moveTo(target, vp, true)).toBe(true);
    expect([...fresh.current]).toEqual(before);
    expect(fresh.isAnimating()).toBe(true);

    now += 500;
    fresh.tick(now, vp);
    expect(fresh.current[0]).toBeCloseTo(1.5);
    expect(fresh.current[1]).toBeCloseTo(3.5);
    expect(fresh.isAnimating()).toBe(false);
  });

  it('reveal recenters without changing zoom or projection-specific orientation', () => {
    const target = { xMin: 2, xMax: 4, yMin: 1, yMax: 3 };
    for (const proj of [createFlatProjection(), createTiltProjection(), createGlobeProjection()]) {
      const camera = new Camera(proj, createUniforms().projection);
      camera.init(bounds, vp);
      if (camera.current.length > 3) {
        camera.current[3] = 47;
        camera.target[3] = 47;
      }
      if (camera.current.length > 4) {
        camera.current[4] = 123;
        camera.target[4] = 123;
      }
      const before = [...camera.current];

      expect(camera.reveal(target, vp, false)).toBe('moved');
      expect(camera.current[0]).toBeCloseTo(3);
      expect(camera.current[1]).toBeCloseTo(2);
      expect(camera.current[2]).toBe(before[2]);
      expect([...camera.current].slice(3)).toEqual(before.slice(3));
      expect(camera.fitIntent).toBe(false);
    }
  });

  it('a newer reveal replaces an in-progress reveal', () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { camera } = make();

    expect(camera.reveal({ xMin: -4, xMax: -4, yMin: -2, yMax: -2 }, vp, true)).toBe('moved');
    now += 100;
    camera.tick(now, vp);
    expect(camera.reveal({ xMin: 4, xMax: 4, yMin: 2, yMax: 2 }, vp, true)).toBe('moved');
    now += 500;
    camera.tick(now, vp);

    expect(camera.current[0]).toBeCloseTo(4);
    expect(camera.current[1]).toBeCloseTo(2);
    expect(camera.isAnimating()).toBe(false);
  });

  it('claimCurrent cancels driven motion but leaves an idle fit view untouched', () => {
    const { camera } = make();
    expect(camera.claimCurrent()).toBe(false);
    expect(camera.fitIntent).toBe(true);

    expect(camera.reveal({ xMin: 4, xMax: 4, yMin: 2, yMax: 2 }, vp, true)).toBe('moved');
    expect(camera.claimCurrent()).toBe(true);
    expect(camera.isAnimating()).toBe(false);
    expect(camera.fitIntent).toBe(false);
  });

  it('preserves fit intent for an idle no-op reveal', () => {
    const { camera } = make();

    expect(camera.reveal(bounds, vp, false)).toBe('unchanged');
    expect(camera.fitIntent).toBe(true);
    expect(camera.isAnimating()).toBe(false);
  });

  it('claimCurrent cancels an idle residual chase', () => {
    const { camera } = make();
    camera.target[0] = camera.current[0]! + 1;

    expect(camera.claimCurrent()).toBe(true);
    expect(camera.target[0]).toBe(camera.current[0]);
    expect(camera.fitIntent).toBe(false);
    expect(camera.isAnimating()).toBe(false);
  });

  it('moveTo observes the original zoom limit in every projection', () => {
    const tiny = { xMin: 0, xMax: 0.000001, yMin: 0, yMax: 0.000001 };
    for (const proj of [createFlatProjection(), createTiltProjection(), createGlobeProjection()]) {
      const camera = new Camera(proj, createUniforms().projection);
      camera.init(bounds, vp);

      expect(camera.moveTo(tiny, vp, false)).toBe(true);
      expect(camera.zoomAt(2, vp.w / 2, vp.h / 2, vp)).toBe(false);
    }
  });

  it('panBy performs a one-shot drag and marks fit intent false', () => {
    const { camera } = make();
    const before = camera.current[0];

    camera.panBy(10, -20, vp);

    expect(camera.fitIntent).toBe(false);
    expect(camera.current[0]).not.toBe(before);
    expect(camera.isAnimating()).toBe(false);
  });

  it('panBy moves perspective projections without starting inertia', () => {
    for (const proj of [createTiltProjection(), createGlobeProjection()]) {
      const camera = new Camera(proj, createUniforms().projection);
      camera.init(bounds, vp);
      const before = [...camera.current];

      expect(camera.panBy(20, -10, vp)).toBe(true);
      expect([...camera.current]).not.toEqual(before);
      expect(camera.isAnimating()).toBe(false);
    }
  });

  it('rejects invalid and unit camera input without changing fit intent or state', () => {
    const { camera } = make();
    const current = [...camera.current];
    const target = [...camera.target];

    expect(camera.panBy(0, 0, vp)).toBe(false);
    expect(camera.panBy(Number.NaN, 1, vp)).toBe(false);
    expect(camera.zoomAt(1, 400, 300, vp)).toBe(false);
    expect(camera.zoomAt(0, 400, 300, vp)).toBe(false);
    expect(camera.zoomAt(Number.NaN, 400, 300, vp)).toBe(false);
    expect(camera.zoomAt(0.5, 400, 300, vp)).toBe(false); // clamped at fit-scale minimum
    expect(camera.rotateBy(1, 1, vp)).toBe(false);

    expect([...camera.current]).toEqual(current);
    expect([...camera.target]).toEqual(target);
    expect(camera.fitIntent).toBe(true);
    expect(camera.isAnimating()).toBe(false);
  });

  it('keeps fit motion for rejected input and interrupts it only for an actual zoom', () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { camera } = make();
    camera.panBy(100, 0, vp);
    camera.fitView(bounds, vp);
    now += 100;
    camera.tick(now, vp);

    expect(camera.zoomAt(1, 400, 300, vp)).toBe(false);
    now += 500;
    camera.tick(now, vp);
    expect(camera.isAtFitView()).toBe(true);

    camera.panBy(100, 0, vp);
    camera.fitView(bounds, vp);
    now += 100;
    camera.tick(now, vp);
    expect(camera.zoomAt(2, 400, 300, vp)).toBe(true);
    now += 1_000;
    camera.tick(now, vp);
    expect(camera.isAtFitView()).toBe(false);
  });

  it('samples a one-event flick from drag-start to crossing timestamps', () => {
    const { camera } = make();

    camera.beginDrag(400, 300, vp, 10);
    camera.drag(2_000, 0, 2_400, 300, vp, 20);
    camera.endDrag(true, 20);

    expect(camera.isAnimating()).toBe(true);
  });

  it('accumulates dense drag samples against the last accepted velocity baseline', () => {
    const { camera } = make();

    camera.beginDrag(400, 300, vp, 0);
    for (let i = 1; i <= 6; i++) {
      camera.drag(2, 0, 400 + i * 2, 300, vp, i * 0.1);
    }
    camera.endDrag(true, 0.6);

    expect(camera.isAnimating()).toBe(true);
  });

  it('decays retained drag velocity while held still before release', () => {
    const { camera } = make();

    camera.beginDrag(400, 300, vp, 10);
    camera.drag(1_000, 0, 1_400, 300, vp, 30);
    camera.endDrag(true, 2_030);

    expect(camera.isAnimating()).toBe(false);
  });

  it('never coasts a cancelled drag', () => {
    const { camera } = make();

    camera.beginDrag(400, 300, vp, 10);
    camera.drag(1_000, 0, 1_400, 300, vp, 30);
    camera.endDrag(false, 31);

    expect(camera.isAnimating()).toBe(false);
  });

  it('samples drag velocity, coasts, and lets zoom interrupt the coast', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { camera } = make();

    now = 10;
    camera.beginDrag(400, 300, vp);
    now = 30;
    camera.drag(1000, 0, 1400, 300, vp);
    now = 31;
    camera.endDrag();
    expect(camera.isAnimating()).toBe(true);

    const targetBefore = camera.target[0];
    camera.tick(60, vp);
    expect(camera.target[0]).not.toBe(targetBefore);

    camera.zoomAt(2, 400, 300, vp);
    expect(camera.isAnimating()).toBe(true);
    camera.tick(20_000, vp);
    expect(camera.isAnimating()).toBe(false);
  });

  it('stops applying coast once the sampled velocity decays below threshold', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { camera } = make();

    now = 10;
    camera.beginDrag(400, 300, vp);
    now = 30;
    camera.drag(1000, 0, 1400, 300, vp);
    now = 31;
    camera.endDrag();

    camera.tick(60, vp);
    camera.tick(20_000, vp);
    const targetAfterDecay = camera.target[0];
    camera.tick(20_100, vp);

    expect(camera.target[0]).toBe(targetAfterDecay);
  });

  it('refreshes a zoom anchor while dragging', () => {
    const { camera } = make();

    camera.beginDrag(400, 300, vp);
    camera.zoomAt(2, 450, 250, vp);
    camera.drag(10, 10, 460, 260, vp);
    camera.tick(performance.now() + 16, vp);

    expect(camera.isAnimating()).toBe(true);
  });

  it('isAnimating false when converged', () => {
    const { camera } = make();
    let now = performance.now();
    for (let i = 0; i < 10; i++) {
      now += 16.67;
      camera.tick(now, vp);
    }
    expect(camera.isAnimating()).toBe(false);
  });

  it('generalizes drag mirror, EMA, and convergence to projection-extra slots', () => {
    // Minimal 5-slot projection: linear algebra everywhere, near() in the
    // passed pixel tolerance. Exercises the R1 loops before any real
    // 5-slot projection exists.
    const proj: Projection = {
      stateSize: 5,
      fit: () => Float64Array.of(0, 0, 1, 10, 20) as CameraState,
      clone: (s) => new Float64Array(s) as CameraState,
      screenToWorld: () => [0, 0],
      mix(out, a, b, t) {
        for (let i = 0; i < 5; i++) out[i] = a[i] + (b[i] - a[i]) * t;
      },
      delta(out, a, b, dt) {
        for (let i = 0; i < 5; i++) out[i] = (b[i] - a[i]) / dt;
      },
      advance(out, s, tan, k) {
        for (let i = 0; i < 5; i++) out[i] = s[i] + tan[i] * k;
      },
      tangentNorm: (t) => Math.hypot(t[0], t[1]),
      near(a, b, _vp, epsPx) {
        for (let i = 0; i < 5; i++) if (Math.abs(a[i] - b[i]) > epsPx) return false;
        return true;
      },
      isAtFit: () => false,
      beginPan: () => ({
        apply(s, dx, dy) {
          s[0] -= dx;
          s[1] += dy;
        },
      }),
      zoom(s, factor) {
        s[2] *= factor;
      },
      snapToAnchor() {},
      rotate(state, dxPx, dyPx) {
        state[4] += dxPx;
        state[3] += dyPx;
      },
      pack() {},
    };
    const camera = new Camera(proj, createUniforms().projection);
    camera.init(bounds, vp);
    expect(camera.current.length).toBe(5);
    expect(camera.current[4]).toBe(20);

    // Drag mirrors every non-zoom slot into target; zoom stays owned by
    // the anchor machinery.
    camera.beginDrag(0, 0, vp);
    camera.current[3] = 33;
    camera.current[4] = 44;
    camera.target[2] = 99;
    camera.drag(5, 5, 5, 5, vp);
    expect(camera.target[3]).toBe(33);
    expect(camera.target[4]).toBe(44);
    expect(camera.target[2]).toBe(99);
    camera.endDrag();

    // rotateBy moves target extras; the chase converges and snaps exactly.
    camera.target.set(camera.current);
    camera.rotateBy(2, 1, vp);
    expect(camera.fitIntent).toBe(false);
    expect(camera.isAnimating()).toBe(true);
    let now = performance.now();
    let frames = 0;
    while (camera.isAnimating() && frames < 240) {
      now += 16.67;
      camera.tick(now, vp);
      frames++;
    }
    expect(frames).toBeLessThan(120);
    expect(camera.current[4]).toBe(camera.target[4]);
    expect(camera.current[3]).toBe(camera.target[3]);
  });

  it('chase terminates by snapping exactly onto the target', () => {
    const { camera } = make();
    camera.zoomAt(2, 400, 300, vp);
    let now = performance.now();
    let frames = 0;
    while (camera.isAnimating() && frames < 240) {
      now += 16.67;
      camera.tick(now, vp);
      frames++;
    }
    // The old absolute 1e-6 epsilon needed ~80+ frames of invisible
    // convergence; the screen-space snap lands within the visible motion.
    expect(frames).toBeLessThan(60);
    expect(camera.isAnimating()).toBe(false);
    expect(camera.current[0]).toBe(camera.target[0]);
    expect(camera.current[1]).toBe(camera.target[1]);
    expect(camera.current[2]).toBe(camera.target[2]);
  });
});

describe('ProjectionRig', () => {
  it('starts flat and switches projections with or without bounds', () => {
    const rig = new ProjectionRig(createUniforms().projection);

    expect(rig.mode).toBe('flat');
    expect(rig.switchTo('tilt', null, vp)).toBe(false);
    expect(rig.mode).toBe('tilt');
    expect(rig.switchTo('flat', bounds, vp)).toBe(true);
    expect(rig.mode).toBe('flat');
    expect(rig.camera.current.length).toBe(3);
  });
});

function makeProjectionRegion() {
  return {
    vp: new Float32Array(16),
    cameraPos: [0, 0, 0],
    lightDir: [0, 0, 0],
    tiltParams: [0, 0, 0, 0],
    fovScale: 0,
    nightFloor: 0,
    terminatorWidth: 0,
    surfaceNightFloor: 0,
    flags: 0,
    flatSx: 0,
    flatSy: 0,
    flatTx: 0,
    flatTy: 0,
    setVP(m: Float32Array) {
      this.vp.set(m);
    },
    setCameraPos(x: number, y: number, z: number) {
      this.cameraPos = [x, y, z];
    },
    setLightDir(x: number, y: number, z: number) {
      this.lightDir = [x, y, z];
    },
    setTiltParams(lookX: number, lookY: number, sinB: number, cosB: number) {
      this.tiltParams = [lookX, lookY, sinB, cosB];
    },
  };
}
