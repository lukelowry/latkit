import { kit, type Gpu } from '@latkit/gpu';
import commonSource from './common.wgsl';
import groundSource from './ground.wgsl';
import shapesSource from './shapes.wgsl';
import recordsSource from './records.wgsl';
import labelsSource from './labels.wgsl';

/** The kit's projection, then the geography's bindings over it, which every drawing module includes. */
const common = kit.projectionShader() + commonSource;
/** Floats of the geography's style block. */
export const STYLE_FLOATS = 40;
/** Floats of the style block's members. */
export const S = {
  surface: 0,
  graticule: 4,
  atmosphere: 8,
  hover: 12,
  selected: 16,
  glow: 20,
  halo: 24,
  axis: 28,
  flow: 32,
  motion: 36,
} as const;

/**
 * The geography's pipelines for a target format and MSAA: the ground and shapes every frame draws
 * build at once; the rest as a frame first needs them, so a view's first frame compiles the least.
 */
export interface Pipelines {
  readonly format: GPUTextureFormat;
  readonly msaa: 1 | 4;
  /** The scene, the shade, and the style, which every draw binds first. */
  readonly frame: GPUBindGroupLayout;
  /** A record's shapes: their vertices, origins, records, map, selection, strips, and draw. */
  readonly shapes: GPUBindGroupLayout;
  /** A page of a record's values, and the records it writes. */
  readonly page: GPUBindGroupLayout;
  /** A page of labels: the scene, their anchors, and the style. */
  readonly label: GPUBindGroupLayout;
  readonly ground: GPURenderPipeline;
  readonly areas: GPURenderPipeline;
  readonly lines: GPURenderPipeline;
  /** The globe's axis, which only a globe that shows it draws. */
  axis(): Promise<GPURenderPipeline>;
  /** Records from fields, which only channels that read a field compute. */
  records(): Promise<GPUComputePipeline>;
  text(): Promise<GPURenderPipeline>;
}

/** Build the geography's pipelines for a target format, MSAA, and shade; its view caches each. */
export async function pipelines(
  gpu: Gpu,
  format: GPUTextureFormat,
  msaa: 1 | 4,
  shade: string,
): Promise<Pipelines> {
  const d = gpu.device,
    V = GPUShaderStage.VERTEX,
    F = GPUShaderStage.FRAGMENT,
    C = GPUShaderStage.COMPUTE;
  const uniform = (binding: number, visibility: number) => ({
    binding,
    visibility,
    buffer: { type: 'uniform' as const },
  });
  const storage = (
    binding: number,
    visibility: number,
    type: GPUBufferBindingType = 'read-only-storage',
  ) => ({ binding, visibility, buffer: { type } });
  const frame = d.createBindGroupLayout({
    entries: [uniform(0, V | F), uniform(1, F), uniform(2, V | F)],
  });
  const shapes = d.createBindGroupLayout({
    entries: [
      storage(0, V),
      storage(1, V),
      storage(2, V),
      storage(3, V),
      storage(4, V),
      storage(5, V),
      storage(6, V),
      uniform(7, V | F),
    ],
  });
  const page = d.createBindGroupLayout({ entries: [uniform(0, C), storage(1, C, 'storage')] });
  const label = d.createBindGroupLayout({
    entries: [uniform(0, V | F), storage(1, V), uniform(2, V | F)],
  });
  const shading = kit.shadeShader({ group: 0, binding: 1 }) + kit.outputShader() + shade;
  const render = (
    module: GPUShaderModule,
    vertex: string,
    fragment: string,
    layouts: GPUBindGroupLayout[],
    options: {
      readonly topology?: GPUPrimitiveTopology;
      readonly depth?: 'write' | 'test' | 'none';
    } = {},
  ) =>
    gpu.renderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: { module, entryPoint: vertex },
      fragment: {
        module,
        entryPoint: fragment,
        targets: [{ format, blend: kit.premultipliedBlend }],
      },
      primitive: { topology: options.topology ?? 'triangle-list' },
      // The ground alone writes depth: the globe's, which hides what lies behind it. What lies on
      // the ground draws over it in order, and faces away where it turns past the horizon.
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: options.depth === 'write',
        depthCompare:
          options.depth === 'write' || options.depth === 'test' ? 'less-equal' : 'always',
      },
      multisample: { count: msaa },
    });
  const [groundModule, shapesModule] = await Promise.all([
    gpu.shaderModule(common + groundSource, 'geography ground'),
    gpu.shaderModule(common + kit.strokeShader() + shading + shapesSource, 'geography shapes'),
  ]);
  const [ground, areas, lines] = await Promise.all([
    render(groundModule, 'ground_vertex', 'ground_fragment', [frame], { depth: 'write' }),
    render(shapesModule, 'area_vertex', 'area_fragment', [frame, shapes]),
    render(shapesModule, 'line_vertex', 'line_fragment', [frame, shapes], {
      topology: 'triangle-strip',
    }),
  ]);
  /** A pipeline built once, when first asked for; a failed build tries again. */
  const later = <T>(build: () => Promise<T>): (() => Promise<T>) => {
    let built: Promise<T> | undefined;
    return () => {
      if (!built) {
        built = build();
        built.catch(() => (built = undefined));
      }
      return built;
    };
  };
  return {
    format,
    msaa,
    frame,
    shapes,
    page,
    label,
    ground,
    areas,
    lines,
    axis: later(() =>
      render(groundModule, 'axis_vertex', 'axis_fragment', [frame], { depth: 'test' }),
    ),
    records: later(async () =>
      gpu.computePipeline({
        layout: d.createPipelineLayout({
          bindGroupLayouts: [gpu.fieldLayout, page, gpu.colormapLayout],
        }),
        compute: {
          module: await gpu.shaderModule(
            kit.fieldShader({ group: 0, colormap: 2 }) + recordsSource,
            'geography records',
          ),
          entryPoint: 'records_main',
        },
      }),
    ),
    text: later(async () =>
      render(
        await gpu.shaderModule(
          common + kit.textShader({ group: 1 }) + labelsSource,
          'geography labels',
        ),
        'label_vertex',
        'label_fragment',
        [label, gpu.textLayout],
      ),
    ),
  };
}
