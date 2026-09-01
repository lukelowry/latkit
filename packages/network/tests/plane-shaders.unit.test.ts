import { describe, expect, it } from 'vitest';
import edgeSrc from '../src/shaders/passes/edge-segment.wgsl?raw';
import poleSrc from '../src/shaders/passes/height-pole.wgsl?raw';
import vertexSrc from '../src/shaders/passes/vertex-billboard.wgsl?raw';
import planeSrc from '../src/shaders/projections/plane-overlay.wgsl?raw';
import { VISUAL_WGSL } from '../src/visual.js';

describe('planar height shader contract', () => {
  it('moves height from flat depth into physical lift with one blend', () => {
    expect(planeSrc).toContain('z * u.depth_mix');
    expect(planeSrc).toContain('FLAT_HEIGHT_DEPTH_SPAN * (1.0 - u.depth_mix)');
    expect(vertexSrc).toContain('let clip = project_overlay(world, h);');
    expect(edgeSrc).toContain('var clip_a = project_overlay(wa, ha);');
    expect(edgeSrc).toContain('var clip_b = project_overlay(wb, hb);');
  });

  it('clips camera-plane crossings to the shared positive-w floor before dividing', () => {
    expect(VISUAL_WGSL).toContain('const MIN_CLIP_W: f32 = 0.0001;');
    expect(edgeSrc).toContain('if (aw <= MIN_CLIP_W && bw <= MIN_CLIP_W)');
    expect(edgeSrc).toContain('clip_a = mix(clip_a, clip_b, t);');
    expect(edgeSrc).toContain('clip_b = mix(clip_a, clip_b, t);');
    expect(poleSrc).toContain('if (base_clip.w <= MIN_CLIP_W || tip_clip.w <= MIN_CLIP_W)');
  });
});
