import { describe, expect, it } from 'vitest';
import segmentSrc from '../src/shaders/common/segment-buffer.wgsl?raw';
import topologySrc from '../src/shaders/common/topology-buffer.wgsl?raw';
import vertexChannelsSrc from '../src/shaders/common/vertex-channels.wgsl?raw';
import edgeSrc from '../src/shaders/passes/edge-segment.wgsl?raw';
import poleSrc from '../src/shaders/passes/height-pole.wgsl?raw';
import vertexSrc from '../src/shaders/passes/vertex-billboard.wgsl?raw';
import planeSrc from '../src/shaders/projections/plane-overlay.wgsl?raw';
import { PIPELINES } from '../src/projections.js';
import { VISUAL_WGSL } from '../src/visual.js';

describe('vertex position shader contract', () => {
  it('places vertices and plane edge ends by the position channel; the globe keeps sphere data', () => {
    expect(vertexChannelsSrc).toContain('let o = u.v_position_offset + i * 2u;');
    expect(topologySrc).not.toContain('vertex_coord');
    expect(segmentSrc).toContain(
      'return vertex_coord(select(seg.from_vertex, seg.to_vertex, endpoint == 1u));',
    );
    expect(PIPELINES.plane.vertexSurfaceWgsl).toContain('return to_world(pos);');
    expect(PIPELINES.plane.segmentSurfaceWgsl).toContain(
      'return to_world(segment_endpoint_coord(seg, endpoint));',
    );
    expect(PIPELINES.globe.vertexSurfaceWgsl).toContain('return vertex_sphere(vertex_id);');
    expect(PIPELINES.globe.segmentSurfaceWgsl).not.toContain('segment_endpoint_coord');
  });
});

describe('planar height shader contract', () => {
  it('moves height from flat depth into physical lift with one blend', () => {
    expect(planeSrc).toContain('z * u.depth_mix');
    expect(planeSrc).toContain('FLAT_HEIGHT_DEPTH_SPAN * (1.0 - u.depth_mix)');
    expect(vertexSrc).toContain('let clip = project_overlay(world, h);');
    expect(edgeSrc).toContain('let clip_a = project_overlay(wa, ha);');
    expect(edgeSrc).toContain('let clip_b = project_overlay(wb, hb);');
  });

  it('clips camera-plane crossings to the shared positive-w floor before dividing', () => {
    expect(VISUAL_WGSL).toContain('const MIN_CLIP_W: f32 = 0.0001;');
    expect(edgeSrc).toContain('if (aw <= MIN_CLIP_W && bw <= MIN_CLIP_W)');
    expect(edgeSrc).toContain('clip_a = mix(clip_a, clip_b, t);');
    expect(edgeSrc).toContain('clip_b = mix(clip_a, clip_b, t);');
    expect(poleSrc).toContain('if (base_clip.w <= MIN_CLIP_W || tip_clip.w <= MIN_CLIP_W)');
  });
});
