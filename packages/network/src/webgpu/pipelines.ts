/// <reference types="@webgpu/types" />

import { BORDER_VERTEX_STRIDE_BYTES } from '../borders.js';
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
import coreVertexSrc from '../shaders/passes/vertex-billboard.wgsl?raw';
import coreEdgeSrc from '../shaders/passes/edge-segment.wgsl?raw';
import corePoleSrc from '../shaders/passes/height-pole.wgsl?raw';
import bordersSrc from '../shaders/passes/border-lines.wgsl?raw';

/** Fragment entry flavor used by overlay passes. */
type VisualFragmentKind = 'base' | 'underlay';

/** Render pipelines required to draw one projection mode. */
export interface VisualPipelines {
  /** Base vertex billboard pass. */
  vertex: GPURenderPipeline;
  /** Vertex focus underlay/halo pass. */
  vertexHalo: GPURenderPipeline;
  /** Vertex focus foreground pass. */
  vertexFocus: GPURenderPipeline;
  /** Base edge segment pass. */
  edge: GPURenderPipeline;
  /** Edge focus underlay/halo pass. */
  edgeHalo: GPURenderPipeline;
  /** Edge focus foreground pass. */
  edgeFocus: GPURenderPipeline;
  /** Height pole pass for non-flat projections. */
  pole: GPURenderPipeline;
  /** Geographic border line-strip pass. */
  borders: GPURenderPipeline;
  /** Projection background pass that also establishes depth. */
  bg: GPURenderPipeline;
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
  bgPipelineLayout: GPUPipelineLayout;
}

/** Builds a one-target color attachment list with optional alpha blending. */
function colorTargets(format: GPUTextureFormat, blend?: GPUBlendState): GPUColorTargetState[] {
  return [{ format, blend }];
}

/** Selects the fragment entry point for base overlays versus focus underlays. */
function visualFragmentEntry(kind: VisualFragmentKind): string {
  return kind === 'underlay' ? 'fs_underlay_color' : 'fs_color';
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
    bgPipelineLayout,
  } = options;
  const mod = (label: string, code: string) => device.createShaderModule({ label, code });
  // The shared solar terminator (daylight.wgsl) is universal; the family
  // supplies only sun_normal(), its position -> planet-center direction map.
  const projectionPrelude = VISUAL_WGSL + def.overlayWgsl + daylightSrc + def.sunWgsl;
  const topologyWgsl = WGSL_LAYOUT + topologySrc;
  const segmentsWgsl = SEGMENTS_WGSL_LAYOUT + segmentsSrc;
  const vertexGeometrySrc = topologyWgsl + def.vertexSurfaceWgsl;
  const segmentGeometrySrc = topologyWgsl + segmentsWgsl + def.segmentSurfaceWgsl;
  const vertSrc =
    projectionPrelude + uniformsSrc + channelVertexSrc + vertexGeometrySrc + coreVertexSrc;
  const edgeSrc =
    projectionPrelude +
    uniformsSrc +
    channelVertexSrc +
    segmentGeometrySrc +
    channelEdgeSrc +
    coreEdgeSrc;
  const vertM = mod('vert', vertSrc);
  const edgeM = mod('edge', edgeSrc);
  const poleM = mod(
    'pole',
    projectionPrelude + uniformsSrc + channelVertexSrc + vertexGeometrySrc + corePoleSrc,
  );
  // Every depth-writing pass tests against the bg-established depth the same
  // way; halos only differ in leaving the depth buffer untouched.
  const dsOpaque: GPUDepthStencilState = {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less-equal',
  };
  const dsHalo: GPUDepthStencilState = {
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
  const bgModule = mod(
    `${def.family}-bg`,
    VISUAL_WGSL +
      uniformsSrc +
      graticuleSrc +
      cameraRaySrc +
      daylightSrc +
      def.sunWgsl +
      def.bgWgsl,
  );
  const earthAxisModule = def.earthAxisWgsl
    ? mod(`${def.family}-earth-axis`, projectionPrelude + uniformsSrc + def.earthAxisWgsl)
    : null;

  // Dispatch every pipeline before the sole await so driver compilation overlaps.
  const pendingBorders = device.createRenderPipelineAsync({
    label: `${def.family}-borders`,
    layout: bgPipelineLayout,
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
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    multisample: ms,
  });

  const pendingBackground = device.createRenderPipelineAsync({
    label: `${def.family}-bg`,
    layout: bgPipelineLayout,
    vertex: { module: bgModule, entryPoint: 'vs', buffers: [] },
    fragment: {
      module: bgModule,
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
        layout: bgPipelineLayout,
        vertex: { module: earthAxisModule, entryPoint: 'vs', buffers: [] },
        fragment: {
          module: earthAxisModule,
          entryPoint: 'fs_color',
          targets: colorTargets(format, blend),
        },
        primitive: strip,
        depthStencil: {
          format: 'depth24plus',
          depthWriteEnabled: false,
          depthCompare: 'less-equal',
        },
        multisample: ms,
      })
    : Promise.resolve(undefined);

  const [vertex, vertexHalo, vertexFocus, edge, edgeHalo, edgeFocus, pole, borders, bg, earthAxis] =
    await Promise.all([
      rpl('vertex', vertM),
      rpl('vertex-halo', vertM, 'vs_halo', 'underlay', dsHalo),
      rpl('vertex-focus', vertM, 'vs_focus', 'base'),
      rpl('edge', edgeM, 'vs', 'base', dsOpaque, edgePipelineLayout),
      rpl('edge-halo', edgeM, 'vs_halo', 'underlay', dsHalo, edgePipelineLayout),
      rpl('edge-focus', edgeM, 'vs_focus', 'base', dsOpaque, edgePipelineLayout),
      rpl('pole', poleM),
      pendingBorders,
      pendingBackground,
      pendingEarthAxis,
    ]);

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
      bg,
      earthAxis,
    },
  };
}
