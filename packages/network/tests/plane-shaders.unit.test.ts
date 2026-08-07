import { describe, expect, it } from 'vitest';
import edgeSrc from '../src/shaders/passes/edge-segment.wgsl?raw';
import vertexSrc from '../src/shaders/passes/vertex-billboard.wgsl?raw';
import planeSrc from '../src/shaders/projections/plane-overlay.wgsl?raw';

describe('planar height shader contract', () => {
  it('moves height from flat depth into physical lift with one blend', () => {
    expect(planeSrc).toContain('z * u.plane_mix');
    expect(planeSrc).toContain('FLAT_HEIGHT_DEPTH_SPAN * (1.0 - u.plane_mix)');
    expect(vertexSrc).toContain('let clip = project_overlay(world, h);');
    expect(edgeSrc).toContain('let clip_a = project_overlay(wa, ha);');
    expect(edgeSrc).toContain('let clip_b = project_overlay(wb, hb);');
  });
});
