import { describe, expect, it } from 'vitest';
import edgeSrc from '../src/shaders/passes/edge-segment.wgsl?raw';
import vertexSrc from '../src/shaders/passes/vertex-billboard.wgsl?raw';
import planeSrc from '../src/shaders/projections/plane-overlay.wgsl?raw';

describe('planar height shader contract', () => {
  it('moves height from flat depth into physical lift with one blend', () => {
    expect(planeSrc).toContain('z * u.plane_mix');
    expect(planeSrc).toContain('FLAT_HEIGHT_DEPTH_SPAN * (1.0 - u.plane_mix)');
    expect(vertexSrc).toContain('let clip = project_overlay(world, h);');
    expect(edgeSrc).toContain('var clip_a = project_overlay(wa, ha);');
    expect(edgeSrc).toContain('var clip_b = project_overlay(wb, hb);');
  });

  it('clips crossing segments to positive w before perspective division', () => {
    expect(edgeSrc).toContain('const MIN_EDGE_CLIP_W: f32 = 1e-4;');
    expect(edgeSrc).toContain('if (aw <= MIN_EDGE_CLIP_W && bw <= MIN_EDGE_CLIP_W)');
    expect(edgeSrc).toContain('clip_a = mix(clip_a, clip_b, t);');
    expect(edgeSrc).toContain('clip_b = mix(clip_a, clip_b, t);');
  });
});
