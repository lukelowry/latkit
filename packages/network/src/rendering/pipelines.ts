import { kit, type Gpu } from '@latkit/gpu';
import common from './common.wgsl';
import prepare from './prepare.wgsl';
import draw from './draw.wgsl';
import background from './background.wgsl';
import labels from './labels.wgsl';
import axis from './axis.wgsl';
import curve from './curve.wgsl';
import tessellate from './tessellate.wgsl';
export interface Pipelines {
  readonly compute: GPUBindGroupLayout;
  readonly tessellation: GPUBindGroupLayout;
  readonly tessellate: GPUComputePipeline;
  readonly draw: GPUBindGroupLayout;
  readonly label: GPUBindGroupLayout;
  readonly background: GPUBindGroupLayout;
  readonly vertex: GPUComputePipeline;
  readonly edge: GPUComputePipeline;
  readonly vertices: GPURenderPipeline;
  readonly edges: GPURenderPipeline;
  readonly curves: GPURenderPipeline;
  readonly poles: GPURenderPipeline;
  readonly surface: GPURenderPipeline;
  readonly text: GPURenderPipeline;
  readonly axis: GPURenderPipeline;
}
const caches = new WeakMap<Gpu, Map<string, Promise<Pipelines>>>();
export function pipelines(
  gpu: Gpu,
  format: GPUTextureFormat,
  msaa: 1 | 4,
  shade: string,
): Promise<Pipelines> {
  let cache = caches.get(gpu);
  if (!cache) {
    cache = new Map();
    caches.set(gpu, cache);
  }
  const key = format + ':' + msaa + ':' + shade;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = create(gpu, format, msaa, shade);
  cache.set(key, pending);
  void pending.catch(() => cache!.delete(key));
  if (cache.size > 12) cache.delete(cache.keys().next().value!);
  return pending;
}
async function create(
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
  const compute = d.createBindGroupLayout({
    entries: [uniform(0, C), uniform(1, C), storage(2, C, 'storage')],
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
  const tessModule = d.createShaderModule({
    label: 'network adaptive geodesics',
    code: common + curve + kit.strokeShader() + tessellate,
  });
  const label = d.createBindGroupLayout({ entries: [uniform(0, V), storage(1, V)] });
  const bg = d.createBindGroupLayout({ entries: [uniform(0, V | F)] });
  const prep = d.createShaderModule({
    label: 'network field preparation',
    code:
      common +
      kit.scaleShader() +
      kit.fieldShader({ group: 0 }) +
      kit.colormapShader({ group: 2 }) +
      prepare,
  });
  const shape = d.createShaderModule({
    label: 'network geometry',
    code:
      common +
      curve +
      kit.strokeShader() +
      kit.shadeShader({ group: 0, binding: 6 }) +
      kit.outputShader() +
      draw +
      shade,
  });
  const bgModule = d.createShaderModule({ label: 'network surface', code: common + background });
  const axisModule = d.createShaderModule({ label: 'network earth axis', code: common + axis });
  const text = d.createShaderModule({
    label: 'network shared text',
    code: common + kit.textShader({ group: 1 }) + labels,
  });
  for (const module of [prep, shape, bgModule, text, axisModule, tessModule]) {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length)
      throw new Error(
        errors
          .map((message) => String(message.lineNum) + ':' + message.linePos + ' ' + message.message)
          .join('; '),
      );
  }
  const computeLayout = d.createPipelineLayout({
    bindGroupLayouts: [gpu.fieldLayout, compute, gpu.colormapLayout],
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
  const [vertex, edge, vertices, edges, poles, surface, textPipeline, axisPipeline, curves] =
    await Promise.all([
      gpu.computePipeline({
        layout: computeLayout,
        compute: { module: prep, entryPoint: 'vertices' },
      }),
      gpu.computePipeline({
        layout: computeLayout,
        compute: { module: prep, entryPoint: 'edges' },
      }),
      render(shape, 'vertex_main', 'fragment_main', [drawLayout]),
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
    tessellation,
    tessellate: tessPipeline,
    compute,
    draw: drawLayout,
    label,
    background: bg,
    vertex,
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
