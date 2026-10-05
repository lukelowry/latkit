import { kit, shape, type Gpu, type Marker } from '@latkit/gpu';
import common from './common.wgsl';
import prepare from './prepare.wgsl';
import draw from './draw.wgsl';
import background from './background.wgsl';
import labels from './labels.wgsl';
import axis from './axis.wgsl';
import curve from './curve.wgsl';
import tessellate from './tessellate.wgsl';
export interface Pipelines {
  readonly gpu: Gpu;
  readonly format: GPUTextureFormat;
  readonly msaa: 1 | 4;
  /** The shade's WGSL, which every vertex marker's module includes. */
  readonly shade: string;
  /** What a page's pass binds: the uniforms, its page, its bank's records, and what they were. */
  readonly compute: GPUBindGroupLayout;
  /** A marked vertex page's: those, its inputs' page, and its bank's rows and stepped inputs. */
  readonly markedCompute: GPUBindGroupLayout;
  readonly tessellation: GPUBindGroupLayout;
  readonly tessellate: GPUComputePipeline;
  readonly draw: GPUBindGroupLayout;
  readonly label: GPUBindGroupLayout;
  readonly background: GPUBindGroupLayout;
  readonly vertex: GPUComputePipeline;
  /** Vertices with their marker's inputs. */
  readonly marked: GPUComputePipeline;
  readonly edge: GPUComputePipeline;
  /** Vertices drawn as discs, the default marker. */
  readonly vertices: GPURenderPipeline;
  readonly edges: GPURenderPipeline;
  readonly curves: GPURenderPipeline;
  readonly poles: GPURenderPipeline;
  readonly surface: GPURenderPipeline;
  readonly text: GPURenderPipeline;
  readonly axis: GPURenderPipeline;
}
/** What a vertex draws without a marker of its own: a disc. */
export const DISC: Marker = shape('ellipse');
/** Where a marker's atlas and sampler bind, after the draw group's buffers. */
const ATLAS = 11;
/** The columns a marker's atlas holds its images in, as `kit.markerAtlas` lays them out. */
export function atlasColumns(marker: Marker): number {
  return Math.max(1, Math.ceil(Math.sqrt(marker.images?.length ?? 0)));
}
/** The module a marker draws with: its own WGSL first, then the network's shared geometry. */
function geometryModule(
  gpu: Gpu,
  marker: Marker,
  shade: string,
  label: string,
): Promise<GPUShaderModule> {
  return gpu.shaderModule(
    kit.markerShader(marker, { group: 0, binding: ATLAS, columns: atlasColumns(marker) }) +
      common +
      curve +
      kit.strokeShader() +
      kit.shadeShader({ group: 0, binding: 6 }) +
      kit.outputShader() +
      draw +
      shade,
    label,
  );
}
/** Build the network's pipelines; its view caches each variant. */
export async function pipelines(
  gpu: Gpu,
  format: GPUTextureFormat,
  msaa: 1 | 4,
  shade: string,
): Promise<Pipelines> {
  const d = gpu.device,
    C = GPUShaderStage.COMPUTE,
    V = GPUShaderStage.VERTEX,
    F = GPUShaderStage.FRAGMENT;
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
  const pageEntries = [uniform(0, C), uniform(1, C), storage(2, C, 'storage'), storage(3, C)];
  const compute = d.createBindGroupLayout({ entries: pageEntries });
  const markedCompute = d.createBindGroupLayout({
    entries: [...pageEntries, uniform(4, C), uniform(5, C)],
  });
  const drawLayout = d.createBindGroupLayout({
    entries: [
      uniform(0, V | F),
      storage(1, V),
      storage(2, V),
      storage(3, V),
      storage(4, V),
      uniform(5, V),
      uniform(6, F),
      storage(7, V),
      storage(8, V),
      storage(9, V),
      { binding: ATLAS, visibility: F, texture: { sampleType: 'float' as const } },
      { binding: ATLAS + 1, visibility: F, sampler: { type: 'filtering' as const } },
    ],
  });
  const tessellation = d.createBindGroupLayout({
    entries: [
      uniform(0, C),
      storage(1, C),
      storage(2, C),
      storage(3, C),
      storage(4, C, 'storage'),
      storage(5, C, 'storage'),
      uniform(6, C),
    ],
  });
  // Labels read the background in their fragments, for the halo over lines.
  const label = d.createBindGroupLayout({ entries: [uniform(0, V | F), storage(1, V)] });
  const bg = d.createBindGroupLayout({ entries: [uniform(0, V | F)] });
  const [tessModule, prep, shape, bgModule, axisModule, text] = await Promise.all([
    gpu.shaderModule(
      common + curve + kit.strokeShader() + tessellate,
      'network adaptive geodesics',
    ),
    gpu.shaderModule(
      common + kit.fieldShader({ group: 0, colormap: 2 }) + prepare,
      'network field preparation',
    ),
    geometryModule(gpu, DISC, shade, 'network geometry'),
    gpu.shaderModule(common + background, 'network surface'),
    gpu.shaderModule(common + axis, 'network earth axis'),
    gpu.shaderModule(common + kit.textShader({ group: 1 }) + labels, 'network shared text'),
  ]);
  const computeLayout = d.createPipelineLayout({
      bindGroupLayouts: [gpu.fieldLayout, compute, gpu.colormapLayout],
    }),
    markedLayout = d.createPipelineLayout({
      bindGroupLayouts: [gpu.fieldLayout, markedCompute, gpu.colormapLayout],
    });
  const target = { format, blend: kit.premultipliedBlend };
  const render = (
    module: GPUShaderModule,
    vertex: string,
    fragment: string,
    layouts: GPUBindGroupLayout[],
    depthWriteEnabled = true,
    curved = false,
  ) =>
    gpu.renderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: {
        module,
        entryPoint: vertex,
        ...(module === shape ? { constants: { NETWORK_CURVES: curved ? 1 : 0 } } : {}),
      },
      fragment: { module, entryPoint: fragment, targets: [target] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled, depthCompare: 'less-equal' },
      multisample: { count: msaa },
    });
  const [
    vertex,
    edge,
    marked,
    vertices,
    edges,
    poles,
    surface,
    textPipeline,
    axisPipeline,
    curves,
  ] = await Promise.all([
    gpu.computePipeline({
      layout: computeLayout,
      compute: { module: prep, entryPoint: 'vertices' },
    }),
    gpu.computePipeline({
      layout: computeLayout,
      compute: { module: prep, entryPoint: 'edges' },
    }),
    gpu.computePipeline({
      layout: markedLayout,
      compute: { module: prep, entryPoint: 'marked_vertices' },
    }),
    render(shape, 'marker_vertex', 'marker_fragment', [drawLayout]),
    render(shape, 'edge_main', 'fragment_main', [drawLayout]),
    render(shape, 'pole_main', 'fragment_main', [drawLayout]),
    render(bgModule, 'background_vertex', 'background_fragment', [bg]),
    render(text, 'label_vertex', 'label_fragment', [label, gpu.textLayout], false),
    render(axisModule, 'axis_vertex', 'axis_fragment', [bg]),
    render(shape, 'edge_main', 'fragment_main', [drawLayout], true, true),
  ]);
  const tessPipeline = await gpu.computePipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: [tessellation] }),
    compute: { module: tessModule, entryPoint: 'tessellate' },
  });
  return {
    gpu,
    format,
    msaa,
    shade,
    markedCompute,
    tessellation,
    tessellate: tessPipeline,
    compute,
    draw: drawLayout,
    label,
    background: bg,
    vertex,
    marked,
    edge,
    vertices,
    edges,
    curves,
    poles,
    surface,
    text: textPipeline,
    axis: axisPipeline,
  };
}

const markerPipelines = new WeakMap<Pipelines, Map<string, Promise<GPURenderPipeline>>>();
/**
 * The pipeline a marker draws vertices with, built once for each set of network pipelines: one per
 * distinct marker, sharing the draw group's layout so a bank switches only its pipeline.
 */
export function markerPipeline(pipelines: Pipelines, marker: Marker): Promise<GPURenderPipeline> {
  if (marker === DISC) return Promise.resolve(pipelines.vertices);
  let byKey = markerPipelines.get(pipelines);
  if (!byKey)
    markerPipelines.set(pipelines, (byKey = new Map<string, Promise<GPURenderPipeline>>()));
  const key = JSON.stringify([
    marker.wgsl,
    Object.keys(marker.inputs ?? {}),
    marker.images?.length ?? 0,
  ]);
  let found = byKey.get(key);
  if (!found) {
    const { gpu, format, msaa, shade } = pipelines;
    found = geometryModule(gpu, marker, shade, 'network marker').then((module) =>
      gpu.renderPipeline({
        layout: gpu.device.createPipelineLayout({ bindGroupLayouts: [pipelines.draw] }),
        vertex: { module, entryPoint: 'marker_vertex', constants: { NETWORK_CURVES: 0 } },
        fragment: {
          module,
          entryPoint: 'marker_fragment',
          targets: [{ format, blend: kit.premultipliedBlend }],
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'less-equal',
        },
        multisample: { count: msaa },
      }),
    );
    // A failed build is tried again with the next frame.
    found.catch(() => byKey.delete(key));
    byKey.set(key, found);
  }
  return found;
}
