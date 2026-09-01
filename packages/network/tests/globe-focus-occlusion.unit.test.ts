import { describe, expect, it } from 'vitest';
import edgeSrc from '../src/shaders/passes/edge-segment.wgsl?raw';
import frameEncoderSrc from '../src/webgpu/frame-encoder.ts?raw';
import pipelinesSrc from '../src/webgpu/pipelines.ts?raw';
import rendererSrc from '../src/webgpu/renderer.ts?raw';
import vertexSrc from '../src/shaders/passes/vertex-billboard.wgsl?raw';

describe('globe focus and occlusion shader contract', () => {
  it('keeps base edge and vertex rendering independent from focus replacement', () => {
    expect(edgeSrc).not.toContain('role == ROLE_BASE && focus_state');
    expect(vertexSrc).not.toContain('role == ROLE_BASE && state');
    expect(edgeSrc).toContain('if (role == ROLE_FOCUS || role == ROLE_HALO)');
    expect(vertexSrc).toContain('if (role == ROLE_BASE) { state = 0u; }');
  });

  it('does not apply stricter role-specific globe horizon culling to focus overlays', () => {
    expect(edgeSrc).not.toContain('globe_horizon_cull');
    expect(edgeSrc).not.toContain('role == ROLE_HALO || role == ROLE_FOCUS');
  });

  it('routes globe edges through the direct segment shader path', () => {
    expect(edgeSrc).toContain('let seg = segment_record(inst);');
    expect(edgeSrc).toContain(
      'return edge_common(strip, seg.edge_id, endpoints, wa, wb, ha, hb, role);',
    );
    expect(frameEncoderSrc).toContain('rp.draw(4, inputs.topology.segmentCount)');
    expect(frameEncoderSrc).not.toContain('drawIndirect');
  });

  it('depth-tests halos against scene depth without writing it', () => {
    const halo = pipelinesSrc.slice(pipelinesSrc.indexOf('const dsHalo'));
    expect(halo).toContain('depthWriteEnabled: false');
    expect(halo).toContain("depthCompare: 'less-equal'");
  });

  it('keeps focus range misses non-catastrophic and observable', () => {
    expect(rendererSrc).toContain('base rendering remains active');
  });
});
