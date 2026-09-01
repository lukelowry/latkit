import { describe, expect, it } from 'vitest';
import globeBgSrc from '../src/shaders/projections/globe-background.wgsl?raw';
import graticuleSrc from '../src/shaders/common/graticule.wgsl?raw';
import planeBgSrc from '../src/shaders/projections/plane-background.wgsl?raw';

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

  it('keeps a transparent Cartesian fast path at flat rest', () => {
    expect(planeBgSrc).toContain('if (u.depth_mix == 0.0) { return flat_sample(frag_pos); }');
    expect(planeBgSrc).toContain('if (!grid_enabled()) { discard; }');
    expect(planeBgSrc).toContain('cartesian_grid(p)');
    expect(planeBgSrc).toContain('if (grid < 0.001) { discard; }');
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

  it('blends the ground surface from the live planar transition', () => {
    expect(planeBgSrc).toContain('let surface = u.depth_mix;');
    expect(planeBgSrc).toContain('let alpha = grid + surface * (1.0 - grid);');
    expect(planeBgSrc).toContain('vec4f(rgb, alpha * fade)');
    expect(planeBgSrc).toContain('@builtin(frag_depth) depth: f32');
  });
});
