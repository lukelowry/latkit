import { type Gpu, kit } from '@latkit/gpu';
import traceCode from './traces.wgsl';
import compositeCode from './composite.wgsl';
import axesCode from './axes.wgsl';
export interface Pipelines {
  trace: GPURenderPipeline;
  background: GPURenderPipeline;
  composite: GPURenderPipeline;
  lines: GPURenderPipeline;
  text: GPURenderPipeline;
  view: GPUBindGroupLayout;
  shade: GPUBindGroupLayout;
  image: GPUBindGroupLayout;
  axis: GPUBindGroupLayout;
  sampler: GPUSampler;
}
/** Build the pipelines for one target format, MSAA, and shade; the view caches each variant. */
export async function pipelines(
  gpu: Gpu,
  format: GPUTextureFormat,
  msaa: 1 | 4,
  shade: string,
): Promise<Pipelines> {
  const d = gpu.device,
    both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const view = d.createBindGroupLayout({
    entries: [{ binding: 0, visibility: both, buffer: { type: 'uniform' } }],
  });
  const effects = d.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });
  const image = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ...[1, 2].map((binding) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' as const },
      })),
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const axis = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const [module, screen, axes] = await Promise.all([
    gpu.shaderModule(
      kit.fieldShader({ group: 0, colormap: 2 }) +
        kit.strokeShader() +
        kit.shadeShader({ group: 3 }) +
        kit.outputShader() +
        shade +
        traceCode,
      'monitor traces',
    ),
    gpu.shaderModule(compositeCode, 'monitor composite'),
    gpu.shaderModule(kit.textShader({ group: 0 }) + axesCode, 'monitor axes'),
  ]);
  const traceLayout = d.createPipelineLayout({
    bindGroupLayouts: [gpu.fieldLayout, view, gpu.colormapLayout, effects],
  });
  const traces = () =>
    gpu.renderPipeline({
      layout: traceLayout,
      vertex: { module, entryPoint: 'trace_main' },
      fragment: {
        module,
        entryPoint: 'fragment_main',
        targets: [{ format: 'rgba8unorm', blend: kit.premultipliedBlend }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: msaa },
    });
  const axesLayout = d.createPipelineLayout({ bindGroupLayouts: [gpu.textLayout, axis] });
  const [trace, background, composite, lines, text] = await Promise.all([
    traces(),
    ...['background', 'color'].map((entryPoint) =>
      gpu.renderPipeline({
        layout: d.createPipelineLayout({ bindGroupLayouts: [image] }),
        vertex: { module: screen, entryPoint: 'main' },
        fragment: {
          module: screen,
          entryPoint,
          targets: [{ format, blend: kit.premultipliedBlend }],
        },
      }),
    ),
    ...[
      ['line_main', 'line_color'],
      ['text_main', 'text_color'],
    ].map(([vertex, fragment]) =>
      gpu.renderPipeline({
        layout:
          vertex === 'line_main'
            ? d.createPipelineLayout({
                bindGroupLayouts: [d.createBindGroupLayout({ entries: [] }), axis],
              })
            : axesLayout,
        vertex: { module: axes, entryPoint: vertex },
        fragment: {
          module: axes,
          entryPoint: fragment,
          targets: [{ format, blend: kit.premultipliedBlend }],
        },
      }),
    ),
  ]);
  return {
    trace,
    background,
    composite,
    lines,
    text,
    view,
    shade: effects,
    image,
    axis,
    sampler: d.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
  };
}
