import { type Gpu, kit } from '@latkit/gpu';
import traceCode from './traces.wgsl';
import compositeCode from './composite.wgsl';
import axesCode from './axes.wgsl';
import { LAYER_FORMATS, type LayerKind } from './history.js';

const KINDS = ['color', 'value'] as const satisfies readonly LayerKind[];
export interface Pipelines {
  /** Lines into a layer of each kind. */
  readonly draw: Readonly<Record<LayerKind, GPURenderPipeline>>;
  /** A layer of each kind onto the screen. */
  readonly compose: Readonly<Record<LayerKind, GPURenderPipeline>>;
  readonly lines: GPURenderPipeline;
  readonly text: GPURenderPipeline;
  readonly view: GPUBindGroupLayout;
  readonly shade: GPUBindGroupLayout;
  readonly image: GPUBindGroupLayout;
  readonly axis: GPUBindGroupLayout;
  /** The empty group 0 that lines bind. */
  readonly none: GPUBindGroup;
  readonly sampler: GPUSampler;
}
/** Build the pipelines for one target format, MSAA, and shade; the view caches each variant. */
export async function pipelines(
  gpu: Gpu,
  format: GPUTextureFormat,
  msaa: 1 | 4,
  shade: string,
): Promise<Pipelines> {
  const d = gpu.device,
    both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    fragment = GPUShaderStage.FRAGMENT;
  const view = d.createBindGroupLayout({
    entries: [{ binding: 0, visibility: both, buffer: { type: 'uniform' } }],
  });
  const effects = d.createBindGroupLayout({
    entries: [{ binding: 0, visibility: fragment, buffer: { type: 'uniform' } }],
  });
  const image = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: fragment, buffer: { type: 'uniform' } },
      { binding: 1, visibility: fragment, texture: { sampleType: 'float' } },
      { binding: 2, visibility: fragment, sampler: { type: 'filtering' } },
    ],
  });
  const axis = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const empty = d.createBindGroupLayout({ entries: [] });
  const [module, screen, axes] = await Promise.all([
    gpu.shaderModule(
      kit.fieldShader({ group: 0 }) +
        kit.strokeShader() +
        kit.shadeShader({ group: 2 }) +
        kit.outputShader() +
        shade +
        traceCode,
      'monitor traces',
    ),
    gpu.shaderModule(
      kit.colormapShader({ group: 1 }) + kit.shadeShader({ group: 2 }) + shade + compositeCode,
      'monitor composite',
    ),
    gpu.shaderModule(kit.textShader({ group: 0 }) + axesCode, 'monitor axes'),
  ]);
  // A color layer composes as it is; only a value layer reads a colormap and the shade.
  const drawn = d.createPipelineLayout({ bindGroupLayouts: [gpu.fieldLayout, view, effects] }),
    composed: Record<LayerKind, GPUPipelineLayout> = {
      color: d.createPipelineLayout({ bindGroupLayouts: [image] }),
      value: d.createPipelineLayout({ bindGroupLayouts: [image, gpu.colormapLayout, effects] }),
    },
    target = { format, blend: kit.premultipliedBlend };
  const [draw, compose, lines, text] = await Promise.all([
    Promise.all(
      KINDS.map((kind) =>
        gpu.renderPipeline({
          layout: drawn,
          vertex: { module, entryPoint: 'trace_main' },
          fragment: {
            module,
            entryPoint: kind + '_main',
            targets: [{ format: LAYER_FORMATS[kind], blend: kit.premultipliedBlend }],
          },
          primitive: { topology: 'triangle-list' },
          multisample: { count: msaa },
        }),
      ),
    ),
    Promise.all(
      KINDS.map((kind) =>
        gpu.renderPipeline({
          layout: composed[kind],
          vertex: { module: screen, entryPoint: 'main' },
          fragment: { module: screen, entryPoint: kind + '_layer', targets: [target] },
        }),
      ),
    ),
    gpu.renderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [empty, axis] }),
      vertex: { module: axes, entryPoint: 'line_main' },
      fragment: { module: axes, entryPoint: 'line_color', targets: [target] },
    }),
    gpu.renderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [gpu.textLayout, axis] }),
      vertex: { module: axes, entryPoint: 'text_main' },
      fragment: { module: axes, entryPoint: 'text_color', targets: [target] },
    }),
  ]);
  return {
    draw: { color: draw[0], value: draw[1] },
    compose: { color: compose[0], value: compose[1] },
    lines,
    text,
    view,
    shade: effects,
    image,
    axis,
    none: d.createBindGroup({ layout: empty, entries: [] }),
    sampler: d.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
  };
}
