import {
  fieldShader,
  scaleShader,
  colormapShader,
  strokeShader,
  shadeShader,
  defaultShade,
  outputShader,
  textShader,
  premultipliedBlend,
  type Gpu,
} from '@latkit/gpu';
import traceCode from './traces.wgsl';
import compositeCode from './composite.wgsl';
import axesCode from './axes.wgsl';
export interface Pipelines {
  raw: GPURenderPipeline;
  envelope: GPURenderPipeline;
  seams: GPURenderPipeline;
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
export async function pipelines(
  gpu: Gpu,
  format: GPUTextureFormat,
  msaa: 1 | 4,
  shade = defaultShade,
): Promise<Pipelines> {
  const d = gpu.device,
    both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const view = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform' } },
      ...[1, 2, 3].map((binding) => ({
        binding,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' as const },
      })),
    ],
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
    ],
  });
  const compile = async (code: string) => {
    d.pushErrorScope('validation');
    const module = d.createShaderModule({ code });
    const validation = d.popErrorScope();
    const [info, error] = await Promise.all([module.getCompilationInfo(), validation]);
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length || error)
      throw new Error(errors.map((m) => m.message).join('\n') || error!.message);
    return module;
  };
  const module = await compile(
    fieldShader({ group: 0 }) +
      scaleShader() +
      colormapShader({ group: 2 }) +
      strokeShader() +
      shadeShader({ group: 3 }) +
      outputShader() +
      shade +
      traceCode,
  );
  const traceLayout = d.createPipelineLayout({
    bindGroupLayouts: [gpu.fieldLayout, view, gpu.colormapLayout, effects],
  });
  const trace = (entryPoint: string) =>
    gpu.renderPipeline({
      layout: traceLayout,
      vertex: { module, entryPoint },
      fragment: {
        module,
        entryPoint: 'fragment_main',
        targets: [{ format: 'rgba8unorm', blend: premultipliedBlend }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: msaa },
    });
  const screen = await compile(compositeCode),
    axes = await compile(textShader({ group: 0 }) + axesCode);
  const axesLayout = d.createPipelineLayout({ bindGroupLayouts: [gpu.textLayout, axis] });
  const [raw, envelope, seams, background, composite, lines, text] = await Promise.all([
    trace('raw_main'),
    trace('envelope_main'),
    trace('seam_main'),
    ...['background', 'color'].map((entryPoint) =>
      gpu.renderPipeline({
        layout: d.createPipelineLayout({ bindGroupLayouts: [image] }),
        vertex: { module: screen, entryPoint: 'main' },
        fragment: { module: screen, entryPoint, targets: [{ format, blend: premultipliedBlend }] },
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
          targets: [{ format, blend: premultipliedBlend }],
        },
      }),
    ),
  ]);
  return {
    raw,
    envelope,
    seams,
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
