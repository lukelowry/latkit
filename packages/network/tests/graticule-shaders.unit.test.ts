import { describe, expect, it } from 'vitest';
import globeBgSrc from '../src/shaders/projections/globe-background.wgsl?raw';
import graticuleSrc from '../src/shaders/common/graticule.wgsl?raw';
import daylightSrc from '../src/shaders/common/daylight.wgsl?raw';
import planeBgSrc from '../src/shaders/projections/plane-background.wgsl?raw';
import planeOverlaySrc from '../src/shaders/projections/plane-overlay.wgsl?raw';
import { PIPELINES } from '../src/projections.js';

describe('background graticule shader contract', () => {
  it('keeps the shared flag guard before derivative work', () => {
    const guard = graticuleSrc.indexOf('fn grid_enabled()');
    const cartesian = graticuleSrc.indexOf('fn cartesian_grid');
    const geographic = graticuleSrc.indexOf('fn geographic_graticule');
    const firstDerivative = graticuleSrc.indexOf('dpdx');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(cartesian).toBeGreaterThan(guard);
    expect(geographic).toBeGreaterThan(cartesian);
    expect(firstDerivative).toBeGreaterThan(guard);
  });

  it('keeps an orthographic Cartesian fast path at flat rest', () => {
    expect(planeBgSrc).toContain('if (u.depth_mix == 0.0) { return flat_sample(frag_pos); }');
    expect(planeBgSrc).toContain('cartesian_grid(p)');
  });

  it('keeps globe geographic and evaluates grid before sphere-edge discard', () => {
    const grid = globeBgSrc.indexOf('geographic_graticule(lon, lat)');
    const discard = globeBgSrc.indexOf('if (t < 0.0) { discard; }');

    expect(grid).toBeGreaterThanOrEqual(0);
    expect(discard).toBeGreaterThan(grid);
    expect(globeBgSrc).not.toContain('cartesian_grid');
  });

  it('keeps the oblique plane Cartesian and derivative-safe', () => {
    const grid = planeBgSrc.indexOf('cartesian_grid(p.xy)');
    const discard = planeBgSrc.indexOf('if (!descending) { discard; }');

    expect(grid).toBeGreaterThanOrEqual(0);
    expect(discard).toBeGreaterThan(grid);
    expect(planeBgSrc).not.toContain('fn decade_grid');
  });

  it('draws one ground palette in flat and tilt', () => {
    // Both branches compose the identical lit surface/grid tone; only the
    // inverse projection and the horizon fade differ. The tilt fade is the
    // sole alpha term left - the ground never fades in with camera pitch.
    expect(planeBgSrc).toContain('fn ground_color(p: vec3f, grid: f32) -> vec3f');
    expect(planeBgSrc).toContain('vec4f(ground_color(vec3f(p, 0.0), grid), 1.0)');
    expect(planeBgSrc).toContain('vec4f(ground_color(p, grid), fade)');
    expect(planeBgSrc).not.toContain('u.depth_mix;');
    expect(planeBgSrc).toContain('@builtin(frag_depth) depth: f32');
  });
});

describe('shared daylight shader contract', () => {
  it('keeps one terminator policy behind the per-family sun_normal seam', () => {
    expect(daylightSrc).toContain('fn daylight(world: vec3f) -> f32');
    expect(daylightSrc).toContain('fn surface_daylight(world: vec3f) -> f32');
    expect(daylightSrc).toContain('fn geo_to_xyz(lon: f32, lat: f32) -> vec3f');
    expect(daylightSrc).toContain('dot(sun_normal(world), u.light_dir)');
  });

  it('maps each family onto the planet through its registry sun_normal', () => {
    expect(PIPELINES.plane.sunWgsl).toContain('geo_to_xyz(world.x, world.y)');
    expect(PIPELINES.globe.sunWgsl).toContain('normalize(world)');
    // The plane family no longer stubs daylight out; the shared policy rules.
    expect(planeOverlaySrc).not.toContain('fn daylight');
  });

  it('lights both family surfaces with the shared surface policy', () => {
    expect(globeBgSrc).toContain('surface_daylight(normal)');
    expect(planeBgSrc).toContain('surface_daylight(p)');
  });
});
