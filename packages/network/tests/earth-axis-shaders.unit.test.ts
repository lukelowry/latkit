import { describe, expect, it } from 'vitest';
import earthAxisSrc from '../src/shaders/passes/earth-axis.wgsl?raw';

describe('earth axis shader contract', () => {
  it('renders from the globe Y axis without topology, segment, or channel storage', () => {
    expect(earthAxisSrc).toContain('vec3f(0.0, -1.0, 0.0)');
    expect(earthAxisSrc).toContain('vec3f(0.0, 1.0, 0.0)');
    expect(earthAxisSrc).toContain('GLOBE_SURFACE_OFFSET');

    expect(earthAxisSrc).not.toContain('vertex_coord');
    expect(earthAxisSrc).not.toContain('segment_record');
    expect(earthAxisSrc).not.toContain('vertex_norm_height');
    expect(earthAxisSrc).not.toContain('@group(1)');
    expect(earthAxisSrc).not.toContain('@group(2)');
  });
});
