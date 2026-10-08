import { type Gpu, kit } from '@latkit/gpu';
import traceCode from './traces.wgsl';
import compositeCode from './composite.wgsl';
import axesCode from './axes.wgsl';
import { LAYER_FORMATS, type LayerKind } from './history.js';

const KINDS = ['color', 'coverage', 'value'] as const satisfies readonly LayerKind[];
/** Lines into a layer of each kind, and into a color layer in a look baked in. */
export interface Lines {
  readonly draw: Readonly<Record<LayerKind, GPURenderPipeline>>;
  /** Reads a colormap in group 3. */
  readonly bake: GPURenderPipeline;
}
export interface Pipelines extends Lines {
  /**
   * Selected lines, lit by their glow: built after the rest, so the first frame never waits on
   * them.
   */
  readonly focus: Promise<Lines>;
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
        kit.colormapShader({ group: 3 }) +
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
  // A color layer composes as it is; the others read a colormap and the shade.
  const drawn = d.createPipelineLayout({ bindGroupLayouts: [gpu.fieldLayout, view, effects] }),
    looked = d.createPipelineLayout({ bindGroupLayouts: [image, gpu.colormapLayout, effects] }),
    composed: Record<LayerKind, GPUPipelineLayout> = {
      color: d.createPipelineLayout({ bindGroupLayouts: [image] }),
      coverage: looked,
      value: looked,
    },
    target = { format, blend: kit.premultipliedBlend };
  const baked = d.createPipelineLayout({
    bindGroupLayouts: [gpu.fieldLayout, view, effects, gpu.colormapLayout],
  });
  /** Lines into a layer of a kind, or selected lines with their glow. */
  const lineInto = (kind: LayerKind, fragment: string, layout: GPUPipelineLayout, focus: boolean) =>
    gpu.renderPipeline({
      layout,
      vertex: { module, entryPoint: focus ? 'trace_focus' : 'trace_main' },
      fragment: {
        module,
        entryPoint: fragment + (focus ? '_focus' : '_main'),
        targets: [{ format: LAYER_FORMATS[kind], blend: kit.premultipliedBlend }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: msaa },
    });
  const linesOf = async (focus: boolean): Promise<Lines> => {
    const [color, coverage, value, bake] = await Promise.all([
      ...KINDS.map((kind) => lineInto(kind, kind, drawn, focus)),
      lineInto('color', 'bake', baked, focus),
    ]);
    return { draw: { color, coverage, value }, bake };
  };
  const [{ draw, bake }, compose, lines, text] = await Promise.all([
    linesOf(false),
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
  // Selected lines' pipelines build now, after the rest, so a selection rarely waits on them.
  const focus = linesOf(true);
  focus.catch(() => undefined);
  return {
    draw,
    bake,
    focus,
    compose: { color: compose[0], coverage: compose[1], value: compose[2] },
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
