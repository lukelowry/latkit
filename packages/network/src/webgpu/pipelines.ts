/// <reference types="@webgpu/types" />

import { BORDER_VERTEX_STRIDE_BYTES } from '../borders/index.js';
import type { PipelineDef } from '../projections.js';
import { VISUAL_WGSL } from '../visual.js';
import { WGSL_LAYOUT } from '../topology/wire.js';
import { WGSL_LAYOUT as SEGMENTS_WGSL_LAYOUT } from '../segments/wire.js';

import uniformsSrc from '../shaders/common/uniforms.wgsl?raw';
import channelVertexSrc from '../shaders/common/vertex-channels.wgsl?raw';
import channelEdgeSrc from '../shaders/common/edge-channels.wgsl?raw';
import topologySrc from '../shaders/common/topology-buffer.wgsl?raw';
import segmentsSrc from '../shaders/common/segment-buffer.wgsl?raw';
import graticuleSrc from '../shaders/common/graticule.wgsl?raw';
import cameraRaySrc from '../shaders/common/camera-ray.wgsl?raw';
import daylightSrc from '../shaders/common/daylight.wgsl?raw';
import shadeSrc from '../shaders/common/shade.wgsl?raw';
import coreVertexSrc from '../shaders/passes/vertex-billboard.wgsl?raw';
import coreEdgeSrc from '../shaders/passes/edge-segment.wgsl?raw';
import corePoleSrc from '../shaders/passes/height-pole.wgsl?raw';
import bordersSrc from '../shaders/passes/border-lines.wgsl?raw';

/** Fragment entry flavor used by overlay passes. */
type VisualFragmentKind = 'base' | 'halo';

/** Render pipelines required to draw one projection mode. */
export interface VisualPipelines {
  /** Base vertex billboard pass. */
  vertex: GPURenderPipeline;
  /** Vertex focus halo pass. */
  vertexHalo: GPURenderPipeline;
  /** Vertex focus foreground pass. */
  vertexFocus: GPURenderPipeline;
  /** Base edge segment pass. */
  edge: GPURenderPipeline;
  /** Edge focus halo pass. */
  edgeHalo: GPURenderPipeline;
  /** Edge focus foreground pass. */
  edgeFocus: GPURenderPipeline;
  /** Height pole pass for non-flat projections. */
  pole: GPURenderPipeline;
  /** Geographic border line-strip pass. */
  borders: GPURenderPipeline;
  /** Projection background pass that also establishes depth. */
  background: GPURenderPipeline;
  /** Earth-axis indicator pass for definitions that declare its shader. */
  earthAxis?: GPURenderPipeline;
}

/** Pipeline bundle cached by projection family. */
export interface ProjectionPipelineSet {
  /** Visual pipelines used by frame encoding. */
  visual: VisualPipelines;
}

/** Shared inputs needed to build projection-specific pipelines. */
export interface ProjectionPipelineFactoryOptions {
  /** Device that owns the resulting pipeline objects. */
  device: GPUDevice;
  /** Canvas texture format used by color targets. */
  format: GPUTextureFormat;
  /** MSAA sample count baked into every pipeline. */
  sampleCount: 1 | 4;
  /** Pipeline layout for vertex, pole, and focus overlay passes. */
  overlayPipelineLayout: GPUPipelineLayout;
  /** Pipeline layout for edge passes that also bind segment storage. */
  edgePipelineLayout: GPUPipelineLayout;
  /** Pipeline layout for background, borders, and axis passes. */
  backgroundPipelineLayout: GPUPipelineLayout;
  /** The host shade function, compiled after the shade prelude into the vertex and edge passes. */
  shade: string;
}

/** Builds a one-target color attachment list with optional alpha blending. */
function colorTargets(format: GPUTextureFormat, blend?: GPUBlendState): GPUColorTargetState[] {
  return [{ format, blend }];
}

/** Selects the fragment entry point for base overlays versus focus halos. */
function visualFragmentEntry(kind: VisualFragmentKind): string {
  return kind === 'halo' ? 'fs_halo' : 'fs_color';
}

/**
 * Compiles the complete pipeline set for one projection definition.
 *
 * The projection definition supplies WGSL snippets for coordinate projection,
 * background depth, borders, and mode-specific depth behavior.
 */
export async function buildProjectionPipelines(
  def: PipelineDef,
  options: ProjectionPipelineFactoryOptions,
): Promise<ProjectionPipelineSet> {
  const {
    device,
    format,
    sampleCount,
    overlayPipelineLayout,
    edgePipelineLayout,
    backgroundPipelineLayout,
    shade,
  } = options;
  const mod = (label: string, code: string) => device.createShaderModule({ label, code });
  // The shared solar terminator (daylight.wgsl) is universal; the family
  // supplies only sun_normal(), its position -> planet-center direction map.
  const projectionPrelude = VISUAL_WGSL + def.overlayWgsl + daylightSrc + def.sunWgsl;
  const topologyWgsl = WGSL_LAYOUT + topologySrc;
  const segmentsWgsl = SEGMENTS_WGSL_LAYOUT + segmentsSrc;
  const vertexGeometrySrc = topologyWgsl + def.vertexSurfaceWgsl;
  const segmentGeometrySrc = topologyWgsl + segmentsWgsl + def.segmentSurfaceWgsl;
  // The host shade follows the channel helpers it may call and precedes the pass that calls it.
  const shadeWgsl = `${shadeSrc}${shade}\n`;
  const vertSrc =
    projectionPrelude +
    uniformsSrc +
    channelVertexSrc +
    shadeWgsl +
    vertexGeometrySrc +
    coreVertexSrc;
  const edgeSrc =
    projectionPrelude +
    uniformsSrc +
    channelVertexSrc +
    segmentGeometrySrc +
    channelEdgeSrc +
    shadeWgsl +
    coreEdgeSrc;
  const vertM = mod('vert', vertSrc);
  const edgeM = mod('edge', edgeSrc);
  const poleM = mod(
    'pole',
    projectionPrelude + uniformsSrc + channelVertexSrc + vertexGeometrySrc + corePoleSrc,
  );
  // Every pass tests against the background-established depth the same way. Opaque passes also
  // write it; overlay passes (halos, borders, the earth axis) leave the depth buffer untouched, so
  // nothing behind them is ever hidden by them.
  const dsOpaque: GPUDepthStencilState = {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less-equal',
  };
  const dsOverlay: GPUDepthStencilState = {
    format: 'depth24plus',
    depthWriteEnabled: false,
    depthCompare: 'less-equal',
  };
  const blend: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  };
  const vbl: GPUVertexBufferLayout = {
    arrayStride: 8,
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }],
  };
  const ms: GPUMultisampleState = { count: sampleCount };
  const strip: GPUPrimitiveState = { topology: 'triangle-strip' };
  const rpl = (
    label: string,
    module: GPUShaderModule,
    vertexEntry = 'vs',
    fragmentKind: VisualFragmentKind = 'base',
    depthStencil = dsOpaque,
    layout: GPUPipelineLayout = overlayPipelineLayout,
  ) =>
    device.createRenderPipelineAsync({
      label: `${def.family}-${label}`,
      layout,
      vertex: { module, entryPoint: vertexEntry, buffers: [vbl] },
      fragment: {
        module,
        entryPoint: visualFragmentEntry(fragmentKind),
        targets: colorTargets(format, blend),
      },
      primitive: strip,
      depthStencil,
      multisample: ms,
    });

  const borderModule = device.createShaderModule({
    label: `${def.family}-borders`,
    code: projectionPrelude + uniformsSrc + def.borderWorldWgsl + bordersSrc,
  });
  const backgroundModule = mod(
    `${def.family}-background`,
    VISUAL_WGSL +
      uniformsSrc +
      graticuleSrc +
      cameraRaySrc +
      daylightSrc +
      def.sunWgsl +
      def.backgroundWgsl,
  );
  const earthAxisModule = def.earthAxisWgsl
    ? mod(`${def.family}-earth-axis`, projectionPrelude + uniformsSrc + def.earthAxisWgsl)
    : null;

  // Dispatch every pipeline before the sole await so driver compilation overlaps.
  const pendingBorders = device.createRenderPipelineAsync({
    label: `${def.family}-borders`,
    layout: backgroundPipelineLayout,
    vertex: {
      module: borderModule,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: BORDER_VERTEX_STRIDE_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
            { shaderLocation: 1, offset: 8, format: 'float32x3' as GPUVertexFormat },
            { shaderLocation: 2, offset: 20, format: 'uint32' as GPUVertexFormat },
          ],
        },
      ],
    },
    fragment: {
      module: borderModule,
      entryPoint: 'fs_color',
      targets: colorTargets(format, blend),
    },
    primitive: { topology: 'line-strip', stripIndexFormat: 'uint32' },
    depthStencil: dsOverlay,
    multisample: ms,
  });

  const pendingBackground = device.createRenderPipelineAsync({
    label: `${def.family}-background`,
    layout: backgroundPipelineLayout,
    vertex: { module: backgroundModule, entryPoint: 'vs', buffers: [] },
    fragment: {
      module: backgroundModule,
      entryPoint: 'fs_color',
      targets: colorTargets(format, blend),
    },
    primitive: { topology: 'triangle-list' },
    depthStencil: dsOpaque,
    multisample: ms,
  });

  const pendingEarthAxis = earthAxisModule
    ? device.createRenderPipelineAsync({
        label: `${def.family}-earth-axis`,
        layout: backgroundPipelineLayout,
        vertex: { module: earthAxisModule, entryPoint: 'vs', buffers: [] },
        fragment: {
          module: earthAxisModule,
          entryPoint: 'fs_color',
          targets: colorTargets(format, blend),
        },
        primitive: strip,
        depthStencil: dsOverlay,
        multisample: ms,
      })
    : Promise.resolve(undefined);

  const [
    vertex,
    vertexHalo,
    vertexFocus,
    edge,
    edgeHalo,
    edgeFocus,
    pole,
    borders,
    background,
    earthAxis,
  ] = await Promise.all([
    rpl('vertex', vertM),
    rpl('vertex-halo', vertM, 'vs_halo', 'halo', dsOverlay),
    rpl('vertex-focus', vertM, 'vs_focus', 'base'),
    rpl('edge', edgeM, 'vs', 'base', dsOpaque, edgePipelineLayout),
    rpl('edge-halo', edgeM, 'vs_halo', 'halo', dsOverlay, edgePipelineLayout),
    rpl('edge-focus', edgeM, 'vs_focus', 'base', dsOpaque, edgePipelineLayout),
    rpl('pole', poleM),
    pendingBorders,
    pendingBackground,
    pendingEarthAxis,
  ]).catch(async (cause: unknown) => {
    throw await shaderFailure([vertM, edgeM], cause);
  });

  return {
    visual: {
      vertex,
      vertexHalo,
      vertexFocus,
      edge,
      edgeHalo,
      edgeFocus,
      pole,
      borders,
      background,
      earthAxis,
    },
  };
}

/**
 * The pipeline failure with every shader compilation error it can find attached, so a host shade
 * fault names its line. Line numbers count from the top of the assembled module.
 */
async function shaderFailure(modules: readonly GPUShaderModule[], cause: unknown): Promise<Error> {
  const lines: string[] = [];
  for (const module of modules) {
    const info = await module.getCompilationInfo?.();
    for (const message of info?.messages ?? []) {
      if (message.type === 'error') {
        lines.push(`${module.label}:${message.lineNum}:${message.linePos} ${message.message}`);
      }
    }
  }
  const detail =
    lines.length > 0 ? lines.join('\n') : cause instanceof Error ? cause.message : String(cause);
  return new Error(`network shader build failed:\n${detail}`, { cause });
}
