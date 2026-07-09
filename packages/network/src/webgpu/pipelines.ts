/// <reference types="@webgpu/types" />

import { BORDER_VERTEX_STRIDE_BYTES } from '../borders.js';
import type { ProjectionDef } from '../projections.js';
import { VISUAL_WGSL } from '../visual.js';
import { WGSL_LAYOUT } from '../topology/wire.js';
import { WGSL_LAYOUT as SEGMENTS_WGSL_LAYOUT } from '../segments/wire.js';

import uniformsSrc from '../shaders/common/uniforms.wgsl?raw';
import channelVertexSrc from '../shaders/common/vertex-channels.wgsl?raw';
import channelEdgeSrc from '../shaders/common/edge-channels.wgsl?raw';
import topologySrc from '../shaders/common/topology-buffer.wgsl?raw';
import segmentsSrc from '../shaders/common/segment-buffer.wgsl?raw';
import graticuleSrc from '../shaders/common/graticule.wgsl?raw';
import coreVertexSrc from '../shaders/passes/vertex-billboard.wgsl?raw';
import coreEdgeSrc from '../shaders/passes/edge-segment.wgsl?raw';
import corePoleSrc from '../shaders/passes/height-pole.wgsl?raw';
import bordersSrc from '../shaders/passes/border-lines.wgsl?raw';
import earthAxisSrc from '../shaders/passes/earth-axis.wgsl?raw';

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
  /** Globe-only earth-axis indicator pass. */
  earthAxis?: GPURenderPipeline;
}

/** Pipeline bundle cached by projection mode. */
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
  def: ProjectionDef,
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
  const projectionPrelude = VISUAL_WGSL + def.overlayWgsl;
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
  const dsBg: GPUDepthStencilState = {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less-equal',
  };
  const dsOverlay: GPUDepthStencilState = {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less-equal',
  };
  const dsFocus: GPUDepthStencilState = {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less-equal',
  };
  const dsHalo: GPUDepthStencilState = {
    format: 'depth24plus',
    depthWriteEnabled: false,
    depthCompare: def.haloDepthCompare,
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
    depthStencil = dsOverlay,
    layout: GPUPipelineLayout = overlayPipelineLayout,
  ) =>
    device.createRenderPipelineAsync({
      label: `${def.mode}-${label}`,
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
    label: `${def.mode}-borders`,
    code: projectionPrelude + uniformsSrc + def.borderWorldWgsl + bordersSrc,
  });
  const bgModule = mod(
    `${def.mode}-bg`,
    VISUAL_WGSL + uniformsSrc + graticuleSrc + def.bgPreludeWgsl + def.bgWgsl,
  );
  const earthAxisModule =
    def.mode === 'globe'
      ? mod(`${def.mode}-earth-axis`, projectionPrelude + uniformsSrc + earthAxisSrc)
      : null;

  const [vertex, vertexHalo, vertexFocus, edge, edgeHalo, edgeFocus, pole] = await Promise.all([
    rpl('vertex', vertM),
    rpl('vertex-halo', vertM, 'vs_halo', 'underlay', dsHalo),
    rpl('vertex-focus', vertM, 'vs_focus', 'base', dsFocus),
    rpl('edge', edgeM, 'vs', 'base', dsOverlay, edgePipelineLayout),
    rpl('edge-halo', edgeM, 'vs_halo', 'underlay', dsHalo, edgePipelineLayout),
    rpl('edge-focus', edgeM, 'vs_focus', 'base', dsFocus, edgePipelineLayout),
    rpl('pole', poleM),
  ]);

  const borders = await device.createRenderPipelineAsync({
    label: `${def.mode}-borders`,
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

  const bg = await device.createRenderPipelineAsync({
    label: `${def.mode}-bg`,
    layout: bgPipelineLayout,
    vertex: { module: bgModule, entryPoint: 'vs', buffers: [] },
    fragment: {
      module: bgModule,
      entryPoint: 'fs_color',
      targets: colorTargets(format, blend),
    },
    primitive: { topology: 'triangle-list' },
    depthStencil: dsBg,
    multisample: ms,
  });

  const earthAxis = earthAxisModule
    ? await device.createRenderPipelineAsync({
        label: `${def.mode}-earth-axis`,
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
    : undefined;

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
