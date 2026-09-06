import { describe, expect, it, vi } from 'vitest';
import { PIPELINES } from '../src/projections.js';
import { buildProjectionPipelines } from '../src/webgpu/pipelines.js';

describe('buildProjectionPipelines', () => {
  it('builds globe edge pipelines from direct segment entrypoints', async () => {
    const shaderModules: GPUShaderModuleDescriptor[] = [];
    const renderPipelines: GPURenderPipelineDescriptor[] = [];
    const device = {
      createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => {
        shaderModules.push(descriptor);
        return descriptor as unknown as GPUShaderModule;
      }),
      createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
        renderPipelines.push(descriptor);
        return descriptor as unknown as GPURenderPipeline;
      }),
    } as unknown as GPUDevice;

    const pipelines = await buildProjectionPipelines(PIPELINES.globe, {
      device,
      format: 'bgra8unorm',
      sampleCount: 1,
      overlayPipelineLayout: { label: 'overlay' } as unknown as GPUPipelineLayout,
      edgePipelineLayout: { label: 'edge-layout' } as unknown as GPUPipelineLayout,
      backgroundPipelineLayout: { label: 'background' } as unknown as GPUPipelineLayout,
    });

    // Edges and vertices write depth; halos only test it.
    expect(pipelines.visual.edge).toMatchObject({
      label: 'globe-edge',
      layout: { label: 'edge-layout' },
      vertex: { entryPoint: 'vs' },
      depthStencil: { depthWriteEnabled: true },
    });
    expect(pipelines.visual.edgeHalo).toMatchObject({
      label: 'globe-edge-halo',
      layout: { label: 'edge-layout' },
      vertex: { entryPoint: 'vs_halo' },
      fragment: { entryPoint: 'fs_halo' },
      depthStencil: { depthWriteEnabled: false },
    });
    expect(pipelines.visual.edgeFocus).toMatchObject({
      label: 'globe-edge-focus',
      layout: { label: 'edge-layout' },
      vertex: { entryPoint: 'vs_focus' },
      depthStencil: { depthWriteEnabled: true },
    });
    expect(pipelines.visual.vertex).toMatchObject({
      label: 'globe-vertex',
      layout: { label: 'overlay' },
      depthStencil: { depthWriteEnabled: true },
    });
    expect(pipelines.visual.vertexHalo).toMatchObject({
      label: 'globe-vertex-halo',
      fragment: { entryPoint: 'fs_halo' },
      depthStencil: { depthWriteEnabled: false },
    });
    expect(pipelines.visual.pole).toMatchObject({
      label: 'globe-pole',
      layout: { label: 'overlay' },
    });
    expect(pipelines.visual.background).toMatchObject({
      label: 'globe-background',
      layout: { label: 'background' },
      depthStencil: { depthWriteEnabled: true },
    });
    expect(pipelines.visual.borders).toMatchObject({
      label: 'globe-borders',
      depthStencil: { depthWriteEnabled: false },
    });
    expect(pipelines.visual.earthAxis).toMatchObject({
      label: 'globe-earth-axis',
      layout: { label: 'background' },
      vertex: { entryPoint: 'vs', buffers: [] },
      depthStencil: { depthWriteEnabled: false },
    });

    const edgeModule = shaderModules.find((module) => module.label === 'edge');
    expect(edgeModule?.code).toContain('fn vs_edge');
    expect(edgeModule?.code).toContain('@group(2) @binding(0)');
    expect(edgeModule?.code).toContain('fn segment_record');
    expect(edgeModule?.code).not.toContain('vs_arc');
    expect(edgeModule?.code).not.toContain('EdgeInstance');
    const earthAxisModule = shaderModules.find((module) => module.label === 'globe-earth-axis');
    expect(earthAxisModule?.code).toContain('fn vs(');
    expect(earthAxisModule?.code).toContain('GLOBE_SURFACE_OFFSET');
    expect(earthAxisModule?.code).not.toContain('@group(1)');
    expect(earthAxisModule?.code).not.toContain('@group(2)');
    expect(
      renderPipelines.every(
        (descriptor) => Array.from(descriptor.fragment?.targets ?? []).length === 1,
      ),
    ).toBe(true);
    expect(renderPipelines.some((descriptor) => String(descriptor.label).includes('tiered'))).toBe(
      false,
    );
  });

  it('does not build earth-axis pipelines outside the globe projection', async () => {
    const device = {
      createShaderModule: vi.fn(
        (descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule,
      ),
      createRenderPipelineAsync: vi.fn(
        async (descriptor: GPURenderPipelineDescriptor) =>
          descriptor as unknown as GPURenderPipeline,
      ),
    } as unknown as GPUDevice;
    const options = {
      device,
      format: 'bgra8unorm' as GPUTextureFormat,
      sampleCount: 1 as const,
      overlayPipelineLayout: { label: 'overlay' } as unknown as GPUPipelineLayout,
      edgePipelineLayout: { label: 'edge-layout' } as unknown as GPUPipelineLayout,
      backgroundPipelineLayout: { label: 'background' } as unknown as GPUPipelineLayout,
    };

    const flat = await buildProjectionPipelines(PIPELINES.plane, options);
    const tilt = await buildProjectionPipelines(PIPELINES.plane, options);

    expect(flat.visual.earthAxis).toBeUndefined();
    expect(tilt.visual.earthAxis).toBeUndefined();
    expect(device.createRenderPipelineAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ label: 'flat-earth-axis' }),
    );
    expect(device.createRenderPipelineAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ label: 'tilt-earth-axis' }),
    );
  });
});
