import { describe, expect, it } from 'vitest';
import flatBgSrc from '../src/shaders/projections/flat-background.wgsl?raw';
import globeBgSrc from '../src/shaders/projections/globe-background.wgsl?raw';
import graticuleSrc from '../src/shaders/common/graticule.wgsl?raw';
import tiltBgSrc from '../src/shaders/projections/tilt-background.wgsl?raw';

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

  it('keeps flat as a transparent Cartesian grid-only background', () => {
    expect(flatBgSrc).toContain('if (!grid_enabled()) { discard; }');
    expect(flatBgSrc).toContain('cartesian_grid(coord)');
    expect(flatBgSrc).toContain('if (grid < 0.001) { discard; }');
    expect(flatBgSrc).not.toContain('DEG_TO_RAD');
  });

  it('keeps globe geographic and evaluates grid before sphere-edge discard', () => {
    const grid = globeBgSrc.indexOf('geographic_graticule(lon, lat)');
    const discard = globeBgSrc.indexOf('if (t < 0.0) { discard; }');

    expect(grid).toBeGreaterThanOrEqual(0);
    expect(discard).toBeGreaterThan(grid);
    expect(globeBgSrc).not.toContain('cartesian_grid');
  });

  it('keeps tilt Cartesian, shared, and surface-preserving', () => {
    const grid = tiltBgSrc.indexOf('cartesian_grid(p.xy)');
    const discard = tiltBgSrc.indexOf('if (!descending) { discard; }');

    expect(grid).toBeGreaterThanOrEqual(0);
    expect(discard).toBeGreaterThan(grid);
    expect(tiltBgSrc).not.toContain('fn decade_grid');
    expect(tiltBgSrc).not.toContain('grid < 0.001');
  });

  it('keeps tilt surface fade local and straight-alpha composed', () => {
    expect(tiltBgSrc).toContain('fn tilt_surface_alpha()');
    expect(tiltBgSrc).toContain('u.camera_pos - look');
    expect(tiltBgSrc).toContain('u.tilt_params.xy');
    expect(tiltBgSrc).toContain('let grid_alpha = grid;');
    expect(tiltBgSrc).toContain(
      'let layer_alpha = grid_alpha + surface_alpha * (1.0 - grid_alpha);',
    );
    expect(tiltBgSrc).toContain('out.color = vec4f(layer_rgb, layer_alpha * fade_alpha);');
    expect(tiltBgSrc).toContain('@builtin(frag_depth) depth: f32');
    expect(tiltBgSrc).not.toContain('mix(TILT_SURFACE, GRID_COLOR, grid)');
    expect(tiltBgSrc).not.toMatch(/vec4f\([^)]*\)\s*\*\s*fade/);
    expect(tiltBgSrc).not.toMatch(/const\s+FADE_START_HEIGHTS/);
  });
});
